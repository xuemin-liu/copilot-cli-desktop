export interface DetectedLink {
  type: 'url' | 'path'
  text: string
  start: number
  end: number
  /** Where in the file a path link points, from a `path:line:column` or `path(line,column)` suffix. */
  line?: number
  column?: number
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g
const QUOTED_PATH_PATTERN = /"([^"\r\n]{1,4096})"|'([^'\r\n]{1,4096})'/g
const BACKTICK_PATH_PATTERN = /`([^`\r\n]{1,4096})`/g
// Matches an absolute Windows/UNC path or an explicit relative path (./, ../),
// an absolute macOS/Linux path of two or more names ("/usr/bin/git", not a
// lone "/tmp" or the "/or" of "and/or"), or a bare relative path that has at
// least one separator and a file extension (the common shape of paths CLI
// tools print, e.g. "dist\app.js"). The bare form may only begin where a name
// begins: without that, on a long run of name characters with no separator
// (base64, hex, a minified line) the match is retried from every character and
// each try reads to the end of the run, which takes a second at 40,000
// characters.
const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\[\w.-]+[\\/]|\.{1,2}[\\/])[^\s<>"'`|]+|(?<![\w.-])\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?(?::\d+(?::\d+)?)?|(?<![\w.-])(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))?/g
// Trailing "path:line" or "path:line:column" location suffix many CLIs print
// (e.g. tsc, eslint) — the number(s) are not part of the filesystem path, but
// say where in the file the link points. tsc also prints "path(line,column)".
const LOCATION_SUFFIX = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))$/
const WHOLE_PATH_PATTERN = new RegExp(`^(?:${PATH_PATTERN.source})$`)
const EXPLICIT_PATH_PREFIX = /^(?:[A-Za-z]:[\\/]|\\\\[\w.-]+[\\/]|\.{1,2}[\\/]|\/[^\s/])/

function isBacktickPath(text: string): boolean {
  if (/[<>"'`|*?\r\n]/.test(text)) return false
  // Inline code also contains commands. Spaced paths need an explicit root
  // (C:\, ./, ../) so "node dist/app.js" still links only "dist/app.js".
  return /\s/.test(text) ? EXPLICIT_PATH_PREFIX.test(text) : WHOLE_PATH_PATTERN.test(text)
}

function splitLocation(candidate: string): { text: string; line?: number; column?: number } {
  const match = LOCATION_SUFFIX.exec(candidate)
  if (!match) return { text: candidate }
  const line = Number(match[1] ?? match[3]), column = Number(match[2] ?? match[4])
  return { text: candidate.slice(0, match.index), ...(line > 0 ? { line, ...(column > 0 ? { column } : {}) } : {}) }
}

/** A ratio, a version or a date written with slashes ("3.5/4.0", "v1.2/3.4", "10/11/2026.5"): every part is a number. */
function isNumbersOnly(text: string): boolean {
  return text.split(/[\\/]/).every((part) => /^v?\d[\d.]*$/i.test(part))
}

function trimTrailingPunctuation(text: string): string {
  // Counted once and kept up to date while trimming. Counting again for every closing bracket made a link followed by
  // thousands of brackets take seconds.
  const count: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0 }
  for (const char of text) if (char in count) count[char]!++
  let end = text.length
  while (end > 0) {
    const char = text[end - 1]
    if (char === undefined) break
    if (char === ')' || char === ']') {
      // Only trim a closing delimiter that has no matching opener in the
      // scanned text (e.g. the sentence-parenthesis around a URL, not the
      // URL's own balanced "(mathematics)" or an IPv6 host's "[::1]").
      const opener = char === ')' ? '(' : '['
      if (count[char]! > count[opener]!) {
        count[char]!--
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
  // Scan quotes separately so rejecting a backtick command doesn't consume
  // an embedded quoted filename, such as `node "./folder name/app.js"`.
  for (const pattern of [QUOTED_PATH_PATTERN, BACKTICK_PATH_PATTERN]) {
    for (const match of line.matchAll(pattern)) {
      const inner = match[1] ?? match[2] ?? ''
      if (!/[\\/]/.test(inner)) continue
      const { text, ...location } = splitLocation(inner)
      if (text.length < 3) continue
      if (pattern === BACKTICK_PATH_PATTERN && !isBacktickPath(text)) continue
      pushIfClear(links, { type: 'path', text, start: match.index, end: match.index + match[0].length, ...location })
    }
  }
  for (const match of line.matchAll(PATH_PATTERN)) {
    const { text, ...location } = splitLocation(trimTrailingPunctuation(match[0]))
    const start = match.index
    const end = start + text.length
    if (text.length < 3) continue
    // Only the bare form can be made of numbers alone; a path with a root (C:\, ./, /usr) is a path whatever its names.
    if (!EXPLICIT_PATH_PREFIX.test(text) && isNumbersOnly(text)) continue
    pushIfClear(links, { type: 'path', text, start, end, ...location })
  }
  return links.sort((left, right) => left.start - right.start)
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
export const LOGICAL_LINE_ROWS = 200

export function buildLogicalLine(
  getLine: (row: number) => BufferLineLike | undefined,
  cols: number,
  clickedRow: number,
): { text: string; cells: LineCellRef[] } {
  // At most this many rows are read, with the row asked about inside them. Counting from the first row of the line
  // instead left every row past the 200th without links, on a line that long.
  let firstRow = clickedRow
  while (firstRow > 0 && clickedRow - firstRow < LOGICAL_LINE_ROWS / 2 && getLine(firstRow)?.isWrapped) firstRow--
  let text = ''
  const cells: LineCellRef[] = []
  let row = firstRow
  // A bound, not an expected depth: guards against an unexpected isWrapped
  // cycle turning this into an infinite loop.
  for (let guard = 0; guard < LOGICAL_LINE_ROWS; guard++) {
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
