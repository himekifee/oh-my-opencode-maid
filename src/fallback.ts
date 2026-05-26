export const DISPLAY_ONLY_FALLBACK = "Rewrite could not be applied safely."
export const LEGACY_DISPLAY_ONLY_FALLBACK = "Rewrite failed; original reply was withheld because it could not be safely rewritten."

export function isDisplayOnlyFallback(text: string) {
  return text === DISPLAY_ONLY_FALLBACK || text === LEGACY_DISPLAY_ONLY_FALLBACK
}
