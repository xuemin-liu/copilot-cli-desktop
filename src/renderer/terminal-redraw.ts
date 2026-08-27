/**
 * Copilot 1.0.80 sometimes leaves only its copy status line after the first
 * selected-text copy. Avoid disturbing a healthy viewport: request recovery
 * only when a previously substantial screen loses more than two thirds of
 * its visible text.
 */
export function clipboardCopyNeedsRedraw(before: number, after: number): boolean {
  return before >= 40 && after * 3 < before
}

/** Whether public xterm CSI parameters address the top-left cell. */
export function isCursorHome(params: (number | number[])[]): boolean {
  if (params.length > 2) return false
  return params.every((value) => !Array.isArray(value) && (value === 0 || value === 1))
}
