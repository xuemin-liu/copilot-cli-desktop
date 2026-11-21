/**
 * How many lines of a file the source view draws at once. Each line is three elements, and nothing about the view is
 * virtual: a 10 MB CSV or a 20 MB notebook shown as source is hundreds of thousands of lines, which freezes the window
 * or runs it out of memory. The size limits on reading a file do not help, because short lines make many lines.
 */
export const SOURCE_LINE_LIMIT = 20_000

export interface SourceWindow {
  /** Index of the first line drawn (0-based) and one past the last. */
  start: number
  end: number
  /** What to tell the person when not every line is drawn; null when all are. */
  note: string | null
}

/**
 * The lines to draw: all of them when they fit, otherwise the first ones, or the ones around the line a click pointed
 * at, so a link to line 150,000 still lands on its line.
 */
export function sourceWindow(total: number, target?: number, limit = SOURCE_LINE_LIMIT): SourceWindow {
  if (total <= limit) return { start: 0, end: total, note: null }
  const wanted = target !== undefined && Number.isInteger(target) && target >= 1 && target <= total ? target - 1 : 0
  const start = Math.max(0, Math.min(total - limit, wanted - Math.floor(limit / 2)))
  const end = start + limit
  const count = (value: number): string => value.toLocaleString('en-US')
  return { start, end, note: `Showing lines ${count(start + 1)} to ${count(end)} of ${count(total)}. The file is too long to show all at once; open it in an editor to see the rest.` }
}
