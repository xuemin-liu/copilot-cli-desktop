export interface DetectedLink {
  type: 'url' | 'path'
  text: string
  start: number
  end: number
}

export interface ScreenBounds {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * The terminal's container includes the `.xterm` padding and scrollbar
 * gutter around the actual character grid (`.xterm-screen`). A drag
 * selection wants pointer coordinates clamped to the nearest cell even
 * there, but a link hit-test should not: a click in that padding is not a
 * click on any text, and clamping it onto the nearest edge cell would let it
 * activate whatever link happens to sit at that edge.
 */
export function isWithinScreenBounds(clientX: number, clientY: number, bounds: ScreenBounds): boolean {
  return clientX >= bounds.left && clientX < bounds.right && clientY >= bounds.top && clientY < bounds.bottom
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g
const QUOTED_PATH_PATTERN = /"([^"\r\n]{1,4096})"|'([^'\r\n]{1,4096})'/g
// Matches an absolute Windows/UNC path or an explicit relative path (./, ../),
// or a bare relative path that has at least one separator and a file
// extension (the common shape of paths CLI tools print, e.g. "dist\app.js").
const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\[\w.-]+[\\/]|\.{1,2}[\\/])[^\s<>"'`|]+|(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,10}/g
// Trailing "path:line" or "path:line:column" location suffix many CLIs print
// (e.g. tsc, eslint) — the number(s) are not part of the filesystem path.
const LOCATION_SUFFIX = /:\d+(?::\d+)?$/

function stripLocationSuffix(candidate: string): string {
  return candidate.replace(LOCATION_SUFFIX, '')
}

function countChar(text: string, character: string): number {
  return text.split(character).length - 1
}

function trimTrailingPunctuation(text: string): string {
  let end = text.length
  while (end > 0) {
    const char = text[end - 1]
    if (char === undefined) break
    if (char === ')' || char === ']') {
      // Only trim a closing delimiter that has no matching opener in the
      // scanned text (e.g. the sentence-parenthesis around a URL, not the
      // URL's own balanced "(mathematics)" or an IPv6 host's "[::1]").
      const opener = char === ')' ? '(' : '['
      const scope = text.slice(0, end)
      if (countChar(scope, char) > countChar(scope, opener)) {
        end--
        continue
      }
      break
    }
    if (/[.,;:!?'"]/.test(char)) {
      end--
      continue
    }
    break
  }
  return text.slice(0, end)
}

function pushIfClear(links: DetectedLink[], candidate: DetectedLink): void {
  if (candidate.text.length === 0) return
  if (links.some((existing) => candidate.start < existing.end && candidate.end > existing.start)) return
  links.push(candidate)
}

export function scanLineForLinks(line: string): DetectedLink[] {
  const links: DetectedLink[] = []
  for (const match of line.matchAll(URL_PATTERN)) {
    const text = trimTrailingPunctuation(match[0])
    if (text.length > 0) pushIfClear(links, { type: 'url', text, start: match.index, end: match.index + text.length })
  }
  // Quoted paths are checked before the bare pattern so a path containing
  // spaces (e.g. "C:\Program Files\Git\bin\git.exe") is treated as one link
  // instead of splitting at the first space.
  for (const match of line.matchAll(QUOTED_PATH_PATTERN)) {
    const inner = match[1] ?? match[2] ?? ''
    if (!/[\\/]/.test(inner)) continue
    const text = stripLocationSuffix(inner)
    if (text.length < 3) continue
    pushIfClear(links, { type: 'path', text, start: match.index, end: match.index + match[0].length })
  }
  for (const match of line.matchAll(PATH_PATTERN)) {
    const text = stripLocationSuffix(trimTrailingPunctuation(match[0]))
    const start = match.index
    const end = start + text.length
    if (text.length < 3) continue
    pushIfClear(links, { type: 'path', text, start, end })
  }
  return links.sort((left, right) => left.start - right.start)
}

export function linkAtColumn(line: string, column: number): DetectedLink | null {
  return scanLineForLinks(line).find((link) => column >= link.start && column < link.end) ?? null
}

/**
 * The subset of xterm's `IBufferLine` this module needs. Kept minimal (and
 * declared here rather than imported from `@xterm/xterm`) so the coordinate
 * math below can be unit-tested with plain mock objects.
 */
export interface BufferLineLike {
  isWrapped: boolean
  getCell(column: number): { getChars(): string; getWidth(): number } | undefined
}

export interface LineCellRef {
  row: number
  column: number
  /** Display columns this cell occupies (2 for a wide/CJK character, 1 otherwise). */
  width: number
}

/**
 * xterm soft-wraps long lines across multiple physical rows, and a link can
 * span that wrap boundary. Reassemble the full logical line containing
 * `clickedRow` (walking backward/forward over `isWrapped` rows) and record,
 * for every character in the resulting string, which buffer cell it came
 * from — so a string-index match can be mapped back to screen coordinates.
 */
export function buildLogicalLine(
  getLine: (row: number) => BufferLineLike | undefined,
  cols: number,
  clickedRow: number,
): { text: string; cells: LineCellRef[] } {
  let firstRow = clickedRow
  while (firstRow > 0 && getLine(firstRow)?.isWrapped) firstRow--
  let text = ''
  const cells: LineCellRef[] = []
  let row = firstRow
  // A bound, not an expected depth: guards against an unexpected isWrapped
  // cycle turning this into an infinite loop.
  for (let guard = 0; guard < 200; guard++) {
    const line = getLine(row)
    if (!line) break
    for (let column = 0; column < cols; column++) {
      const cell = line.getCell(column)
      // A width-0 cell is the second half of the previous (wide) cell.
      if (!cell || cell.getWidth() === 0) continue
      const width = cell.getWidth()
      const chars = cell.getChars() || ' '
      // A cell can hold more than one UTF-16 unit (a combining-mark grapheme);
      // every unit still occupies the same on-screen cell, so each shares
      // this entry's column/width for range math to stay correct either way.
      for (let index = 0; index < chars.length; index++) cells.push({ row, column, width })
      text += chars
    }
    const next = getLine(row + 1)
    if (next?.isWrapped) {
      row += 1
      continue
    }
    break
  }
  return { text, cells }
}

/** Cell coordinates are display columns; `DetectedLink` ranges are string
 * indices into the reassembled logical line. This converts a click's
 * (row, column) into the matching string index, respecting wide characters
 * and soft-wrapped rows. A click anywhere within a wide cell's span
 * (its start column or its width-2 continuation column) resolves to the
 * same string index, since both name the same underlying character. */
export function cellIndexAt(cells: LineCellRef[], row: number, column: number): number {
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index]
    if (cell && cell.row === row && column >= cell.column && column < cell.column + cell.width) return index
  }
  return -1
}

export interface LinkSegment {
  row: number
  startColumn: number
  endColumn: number
}

/** Maps a link's string range back to one or more per-row column ranges, so
 * a link that happens to straddle a soft-wrap boundary renders (and hit-tests)
 * as two segments instead of one that's silently wrong on the second row. */
export function segmentsForLink(cells: LineCellRef[], link: DetectedLink): LinkSegment[] {
  const segments: LinkSegment[] = []
  for (let index = link.start; index < link.end; index++) {
    const cell = cells[index]
    if (!cell) continue
    const endColumn = cell.column + cell.width
    const last = segments[segments.length - 1]
    if (last && last.row === cell.row && cell.column >= last.startColumn && cell.column < last.endColumn) {
      // Another UTF-16 unit of the same on-screen cell (a combining-mark
      // grapheme) — already covered, not a second, overlapping segment.
      continue
    }
    if (last && last.row === cell.row && last.endColumn === cell.column) last.endColumn = endColumn
    else segments.push({ row: cell.row, startColumn: cell.column, endColumn })
  }
  return segments
}

export interface RowTextMatch {
  row: number
  column: number
  /** Display columns the match spans — not `targetText.length` (a UTF-16
   * count), since a wide/CJK character in the match counts double and a
   * combining-mark grapheme counts once despite being multiple code units. */
  length: number
}

/** Sums the on-screen width of `cells[start, end)`, counting each distinct
 * buffer cell once — consecutive entries can share one cell when a grapheme
 * spans multiple UTF-16 units (see `buildLogicalLine`), and double-counting
 * those would overstate the selection's display-cell span. */
function cellSpanWidth(cells: LineCellRef[], start: number, end: number): number {
  let width = 0
  let lastCell: LineCellRef | undefined
  for (let index = start; index < end; index++) {
    const cell = cells[index]
    if (!cell) break
    if (lastCell && lastCell.row === cell.row && lastCell.column === cell.column) continue
    width += cell.width
    lastCell = cell
  }
  return width
}

/**
 * A TUI that scrolls its own content (e.g. a diff/log panel) typically
 * redraws the same text at a different row rather than making it vanish —
 * xterm has no "moved" signal for this, but the text is usually still
 * visible somewhere in the viewport. Search for it there before giving up
 * on a retained selection, so scrolling by a modest amount keeps the
 * highlight following the text instead of dropping it. Only handles a
 * single-row (no embedded newline) selection; a multi-row block is left to
 * the caller's own fallback, since relocating a whole block reliably is a
 * different, harder problem than relocating one line of text.
 *
 * "Single-row" means the selected text itself has no line break — it can
 * still have been captured across a soft wrap (xterm joins wrapped rows with
 * no separator in `getSelection()`), so this reassembles each candidate row
 * into its full logical line via `buildLogicalLine` rather than searching
 * physical rows in isolation, or a wrapped match could never be found.
 *
 * A wrapped logical line can contain the target text more than once, and
 * `buildLogicalLine` reconstructs the *whole* line regardless of which of
 * its physical rows are actually on screen (it walks back to the start of
 * the wrap group, which can be above the viewport) — so every occurrence is
 * checked. An occurrence is eligible as long as *any* of the rows it spans
 * is in the given viewport — `renderRetainedSelection` already clips a
 * range to the visible rows, so a wrapped match starting just above the
 * viewport but continuing into it is still worth relocating to, not just
 * one that starts on an in-viewport row.
 */
export function findTextRow(
  getLine: (row: number) => BufferLineLike | undefined,
  cols: number,
  targetText: string,
  preferredRow: number,
  preferredColumn: number,
  viewportStart: number,
  viewportRows: number,
): RowTextMatch | null {
  if (targetText.length === 0 || targetText.includes('\n')) return null
  const viewportEnd = viewportStart + viewportRows - 1
  let best: RowTextMatch | null = null
  let bestDistance = Infinity
  let bestColumnDistance = Infinity
  for (let row = viewportStart; row < viewportStart + viewportRows; row++) {
    const logical = buildLogicalLine(getLine, cols, row)
    for (let from = 0; ; ) {
      const index = logical.text.indexOf(targetText, from)
      if (index === -1) break
      from = index + 1
      const startCell = logical.cells[index]
      const endCell = logical.cells[index + targetText.length - 1]
      if (!startCell || !endCell) continue
      if (endCell.row < viewportStart || startCell.row > viewportEnd) continue
      const distance = Math.abs(startCell.row - preferredRow)
      // Two occurrences on the same (relocated) row are equally near
      // preferredRow — prefer whichever is closer to where the selection
      // actually was, not just the leftmost one, so a scroll doesn't jump
      // the highlight to an unrelated same-text occurrence on that row.
      const columnDistance = Math.abs(startCell.column - preferredColumn)
      const improves = !best
        || distance < bestDistance
        || (distance === bestDistance && columnDistance < bestColumnDistance)
      if (improves) {
        best = {
          row: startCell.row,
          column: startCell.column,
          length: cellSpanWidth(logical.cells, index, index + targetText.length),
        }
        bestDistance = distance
        bestColumnDistance = columnDistance
      }
    }
  }
  return best
}
