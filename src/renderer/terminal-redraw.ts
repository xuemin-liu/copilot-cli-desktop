/**
 * Copilot 1.0.80 sometimes leaves only its copy status line after the first
 * selected-text copy. Avoid disturbing a healthy viewport: request recovery
 * only when a previously substantial screen loses more than two thirds of
 * its visible text.
 */
export function clipboardCopyNeedsRedraw(before: number, after: number): boolean {
  return before >= 40 && after * 3 < before
}
