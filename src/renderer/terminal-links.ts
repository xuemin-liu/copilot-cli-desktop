export interface DetectedLink {
  type: 'url' | 'path'
  text: string
  start: number
  end: number
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
