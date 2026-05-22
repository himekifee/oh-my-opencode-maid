import { Database } from "bun:sqlite"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { DISPLAY_ONLY_FALLBACK } from "./fallback"

export type ResponseKey = {
  directory: string
  sessionID: string
  messageID: string
  partID: string
}

export type SessionOriginal = {
  messageID: string
  partID: string
  visibleText: string
  originalText: string
}

export type PendingProviderOriginal = {
  originalText: string
  displayOnly: boolean
}

export type ResponseStore = {
  putOriginal(key: ResponseKey, visibleText: string, originalText: string): void
  putDisplayOriginal(key: ResponseKey, visibleText: string, originalText: string): void
  hasOriginal(key: ResponseKey, visibleText: string): boolean
  getOriginal(key: ResponseKey, visibleText: string): string | undefined
  getContextOriginal(key: ResponseKey, visibleText: string): string | undefined
  deleteOriginal(key: ResponseKey): void
  deleteSession(directory: string, sessionID: string): void
  putPendingProviderOriginal(directory: string, sessionID: string, visibleText: string, originalText: string): void
  consumePendingProviderOriginal(key: ResponseKey, visibleText: string): PendingProviderOriginal | undefined
  getSessionOriginals(directory: string, sessionID: string, limit: number): SessionOriginal[]
  close(): void
}

const PENDING_PROVIDER_ORIGINAL_TTL_SECONDS = 10 * 60
const MAX_PENDING_PROVIDER_ORIGINALS = 1_000

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function stateBase() {
  if (process.env.XDG_STATE_HOME) return path.resolve(process.env.XDG_STATE_HOME)
  if (process.env.HOME) return path.resolve(process.env.HOME, ".local", "state")
  throw new Error("oh-my-opencode-maid requires XDG_STATE_HOME or HOME for persistent response storage")
}

export function responseDatabasePath() {
  return path.join(stateBase(), "opencode", "oh-my-opencode-maid", "responses.sqlite")
}

export async function createResponseStore(): Promise<ResponseStore> {
  const file = responseDatabasePath()
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // The 0700 parent directory is the real access guarantee. Pre-creating the DB
  // file with 0600 (and re-chmod'ing below for pre-existing files) closes the
  // window where the original assistant text would otherwise be readable at the
  // process umask between file creation and chmod.
  try {
    await writeFile(file, "", { flag: "wx", mode: 0o600 })
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
  }
  const db = new Database(file, { create: true })
  await chmod(file, 0o600)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS responses (
      directory TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      visible_text TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      display_only INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (directory, session_id, message_id, part_id)
    ) WITHOUT ROWID
  `)
  ensureColumn(db, "responses", "visible_text", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "responses", "display_only", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "responses", "updated_at", "INTEGER NOT NULL DEFAULT 0")
  db.query(`
    UPDATE responses
    SET display_only = 1
    WHERE visible_text = $visible_text
  `).run({ $visible_text: DISPLAY_ONLY_FALLBACK })
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_provider_originals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      directory TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      visible_text TEXT NOT NULL,
      original_text TEXT NOT NULL,
      display_only INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  ensureColumn(db, "pending_provider_originals", "session_id", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "pending_provider_originals", "display_only", "INTEGER NOT NULL DEFAULT 0")
  db.query(`
    UPDATE pending_provider_originals
    SET display_only = 1
    WHERE visible_text = $visible_text
  `).run({ $visible_text: DISPLAY_ONLY_FALLBACK })
  db.exec(`
    CREATE INDEX IF NOT EXISTS pending_provider_originals_lookup
    ON pending_provider_originals (directory, session_id, visible_text, id)
  `)

  const upsert = db.query(`
    INSERT INTO responses (directory, session_id, message_id, part_id, visible_text, text, display_only, created_at, updated_at)
    VALUES ($directory, $session_id, $message_id, $part_id, $visible_text, $text, $display_only, unixepoch(), unixepoch())
    ON CONFLICT(directory, session_id, message_id, part_id) DO UPDATE SET
      visible_text = excluded.visible_text,
      text = excluded.text,
      display_only = excluded.display_only,
      updated_at = unixepoch()
  `)
  const select = db.query(`
    SELECT text FROM responses
    WHERE directory = $directory
      AND session_id = $session_id
      AND message_id = $message_id
      AND part_id = $part_id
      AND visible_text = $visible_text
    LIMIT 1
  `)
  const selectExists = db.query(`
    SELECT 1 AS found FROM responses
    WHERE directory = $directory
      AND session_id = $session_id
      AND message_id = $message_id
      AND part_id = $part_id
      AND visible_text = $visible_text
    LIMIT 1
  `)
  const selectContext = db.query(`
    SELECT text FROM responses
    WHERE directory = $directory
      AND session_id = $session_id
      AND message_id = $message_id
      AND part_id = $part_id
      AND visible_text = $visible_text
      AND display_only = 0
    LIMIT 1
  `)
  const insertPending = db.query(`
    INSERT INTO pending_provider_originals (directory, session_id, visible_text, original_text, display_only, created_at)
    VALUES ($directory, $session_id, $visible_text, $original_text, $display_only, unixepoch())
  `)
  const deleteOriginalByKey = db.query(`
    DELETE FROM responses
    WHERE directory = $directory
      AND session_id = $session_id
      AND message_id = $message_id
      AND part_id = $part_id
  `)
  const deleteResponsesBySession = db.query(`
    DELETE FROM responses
    WHERE directory = $directory
      AND session_id = $session_id
  `)
  const deletePendingBySession = db.query(`
    DELETE FROM pending_provider_originals
    WHERE directory = $directory
      AND session_id = $session_id
  `)
  const selectPending = db.query(`
    SELECT id, original_text, display_only FROM pending_provider_originals
    WHERE directory = $directory
      AND session_id = $session_id
      AND visible_text = $visible_text
      AND created_at >= unixepoch() - $ttl
    ORDER BY id
    LIMIT 1
  `)
  const deletePending = db.query(`
    DELETE FROM pending_provider_originals
    WHERE id = $id
  `)
  const pruneExpiredPending = db.query(`
    DELETE FROM pending_provider_originals
    WHERE created_at < unixepoch() - $ttl
  `)
  const pruneOverflowPending = db.query(`
    DELETE FROM pending_provider_originals
    WHERE id <= COALESCE((
      SELECT id FROM pending_provider_originals
      ORDER BY id DESC
      LIMIT 1 OFFSET $max
    ), 0)
  `)
  const selectSession = db.query(`
    SELECT message_id, part_id, visible_text, text FROM responses
    WHERE directory = $directory
      AND session_id = $session_id
      AND display_only = 0
    ORDER BY updated_at DESC, created_at DESC, message_id DESC, part_id DESC
    LIMIT $limit
  `)

  function params(key: ResponseKey) {
    return {
      $directory: key.directory,
      $session_id: key.sessionID,
      $message_id: key.messageID,
      $part_id: key.partID,
    }
  }

  function writeOriginal(key: ResponseKey, visibleText: string, originalText: string, displayOnly = false) {
    upsert.run({ ...params(key), $visible_text: visibleText, $text: originalText, $display_only: displayOnly ? 1 : 0 })
  }

  const consumePending = db.transaction((key: ResponseKey, visibleText: string) => {
    pruneExpiredPending.run({ $ttl: PENDING_PROVIDER_ORIGINAL_TTL_SECONDS })
    const row = selectPending.get({ $directory: key.directory, $session_id: key.sessionID, $visible_text: visibleText, $ttl: PENDING_PROVIDER_ORIGINAL_TTL_SECONDS })
    if (!record(row) || typeof row.id !== "number" || typeof row.original_text !== "string") return undefined
    writeOriginal(key, visibleText, row.original_text, true)
    deletePending.run({ $id: row.id })
    return { originalText: row.original_text, displayOnly: true }
  })

  const deleteSessionRows = db.transaction((directory: string, sessionID: string) => {
    deleteResponsesBySession.run({ $directory: directory, $session_id: sessionID })
    deletePendingBySession.run({ $directory: directory, $session_id: sessionID })
  })

  pruneExpiredPending.run({ $ttl: PENDING_PROVIDER_ORIGINAL_TTL_SECONDS })

  return {
    putOriginal(key, visibleText, originalText) {
      writeOriginal(key, visibleText, originalText)
    },
    putDisplayOriginal(key, visibleText, originalText) {
      writeOriginal(key, visibleText, originalText, true)
    },
    hasOriginal(key, visibleText) {
      return Boolean(selectExists.get({ ...params(key), $visible_text: visibleText }))
    },
    getOriginal(key, visibleText) {
      const row = select.get({ ...params(key), $visible_text: visibleText })
      if (!record(row) || typeof row.text !== "string") return undefined
      return row.text
    },
    getContextOriginal(key, visibleText) {
      const row = selectContext.get({ ...params(key), $visible_text: visibleText })
      if (!record(row) || typeof row.text !== "string") return undefined
      return row.text
    },
    deleteOriginal(key) {
      deleteOriginalByKey.run(params(key))
    },
    deleteSession(directory, sessionID) {
      deleteSessionRows(directory, sessionID)
    },
    putPendingProviderOriginal(directory, sessionID, visibleText, originalText) {
      insertPending.run({ $directory: directory, $session_id: sessionID, $visible_text: visibleText, $original_text: originalText, $display_only: 1 })
      pruneExpiredPending.run({ $ttl: PENDING_PROVIDER_ORIGINAL_TTL_SECONDS })
      pruneOverflowPending.run({ $max: MAX_PENDING_PROVIDER_ORIGINALS })
    },
    consumePendingProviderOriginal(key, visibleText) {
      return consumePending(key, visibleText)
    },
    getSessionOriginals(directory, sessionID, limit) {
      const rows = selectSession.all({ $directory: directory, $session_id: sessionID, $limit: limit }).reverse()
      return rows.flatMap((row) => {
        if (!record(row)) return []
        if (typeof row.message_id !== "string") return []
        if (typeof row.part_id !== "string") return []
        if (typeof row.visible_text !== "string") return []
        if (typeof row.text !== "string") return []
        return [{ messageID: row.message_id, partID: row.part_id, visibleText: row.visible_text, originalText: row.text }]
      })
    },
    close() {
      db.close()
    },
  }
}

// SQLite cannot bind identifiers, so table/column/definition are interpolated.
// This is injection-safe only because every argument is a hardcoded literal
// from this module (no user/config/network input ever reaches it). Keep it that
// way: never pass caller-derived values here.
function ensureColumn(db: Database, table: string, column: string, definition: string) {
  const exists = db.query(`PRAGMA table_info(${table})`).all().some((row) => record(row) && row.name === column)
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
