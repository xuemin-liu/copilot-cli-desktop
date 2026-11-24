export interface TerminalLinkTarget {
  type: 'url' | 'path'
  text: string
  /** Where in the file a path link points. */
  line?: number
  column?: number
}

export interface DetectedLink extends TerminalLinkTarget {
  start: number
  end: number
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g
const QUOTED_PATH_PATTERN = /"([^"\r\n]{1,4096})"|'([^'\r\n]{1,4096})'/g
const BACKTICK_PATH_PATTERN = /`([^`\r\n]{1,4096})`/g
// Matches an absolute Windows/UNC path or an explicit relative path (./, ../),
// an absolute macOS/Linux path of two or more names ("/usr/bin/git", not a
// lone "/tmp" or the "/or" of "and/or"), or a bare relative path that has at
// least one separator and a file extension (the common shape of paths CLI
// tools print, e.g. "dist\app.js"). The bare form may only begin where a path
// begins, which is neither inside a name nor after a separator: without that, on a long run of name characters with no separator
// (base64, hex, a minified line) the match is retried from every character and
// each try reads to the end of the run, which takes a second at 40,000
// characters.
const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\[\w.-]+[\\/]|\.{1,2}[\\/])[^\s<>"'`|]+|(?<![\w.-])\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?(?::\d+(?::\d+)?)?|(?<![\w.\\/-])(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))?/g
// Trailing "path:line" or "path:line:column" location suffix many CLIs print
// (e.g. tsc, eslint) — the number(s) are not part of the filesystem path, but
// say where in the file the link points. tsc also prints "path(line,column)".
const LOCATION_SUFFIX = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))$/
const WHOLE_PATH_PATTERN = new RegExp(`^(?:${PATH_PATTERN.source})$`)
const EXPLICIT_PATH_PREFIX = /^(?:[A-Za-z]:[\\/]|\\\\[\w.-]+[\\/]|\.{1,2}[\\/]|\/[^\s/])/

function isBacktickPath(text: string): boolean {
  if (/[<>"'`|*?\r\n]/.test(text)) return false
  // Inline code holds ratios and versions too.
  if (!EXPLICIT_PATH_PREFIX.test(text) && isNumbersOnly(text)) return false
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

const MAX_OSC8_SEQUENCE_CHARS = 16_384

/** Format a parsed link destination for the hover preview overlay. */
export function formatTerminalLinkPreview(link: TerminalLinkTarget): string {
  if (link.type === 'url') return link.text
  return `${link.text}${link.line ? `:${link.line}${link.column ? `:${link.column}` : ''}` : ''}`
}

/**
 * Interpret the OSC 8 destination independently of its displayed label.
 */
export function parseTerminalHyperlink(uri: string): TerminalLinkTarget | null {
  if (uri.length > 8_192 || /[\x00-\x1f\x7f]/.test(uri)) return null
  if (/^https?:\/\//i.test(uri)) return { type: 'url', text: uri }

  const { text: encodedPath, ...location } = splitLocation(uri.split(/[?#]/, 1)[0] ?? '')
  let text = encodedPath
  try { text = decodeURIComponent(text) } catch { /* Allow literal percent signs in CLI paths. */ }
  if (!text.trim() || /[\x00-\x1f\x7f]|^[\\/]{2}/.test(text)) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return null

  const fragmentLine = /#L([1-9]\d*)(?:-L?[1-9]\d*)?$/i.exec(uri)
  return { type: 'path', text, ...(fragmentLine ? { line: Number(fragmentLine[1]) } : {}), ...location }
}

/** Whether an OSC 8 payload (`<params>;<uri>`) should pass through to xterm. Closing sequences always pass through. */
export function isSupportedOsc8Payload(data: string): boolean {
  const separator = data.indexOf(';')
  if (separator === -1) return false
  const uri = data.slice(separator + 1)
  return uri === '' || parseTerminalHyperlink(uri) !== null
}

/**
 * Strip unsupported OSC 8 hyperlink openers before xterm registers them, replacing each with an OSC 8 close sequence so
 * any prior link ends cleanly while the visible label stays plain text for the text link scanner.
 */
export class Osc8LinkFilter {
  private pending = ''
  private discarding = false

  filter(chunk: string): string {
    const text = this.pending + chunk
    this.pending = ''
    let output = ''
    let index = 0

    while (index < text.length) {
      if (this.discarding) {
        const terminated = findOscTerminator(text, index)
        if (terminated === null) {
          // A trailing ESC may be the first byte of ST (`\x1b\\`).
          if (text.endsWith('\u001b')) this.pending = '\u001b'
          return output
        }
        this.discarding = false
        output += '\u001b]8;;\u001b\\'
        index = terminated.next
        continue
      }

      const start = text.indexOf('\u001b]8;', index)
      if (start === -1) {
        const tail = trailingOsc8PrefixLength(text, index)
        output += text.slice(index, text.length - tail)
        if (tail > 0) this.pending = text.slice(text.length - tail)
        return output
      }

      output += text.slice(index, start)
      const terminated = findOscTerminator(text, start + 4)
      if (terminated === null) {
        if (text.length - start <= MAX_OSC8_SEQUENCE_CHARS) {
          this.pending = text.slice(start)
        } else {
          this.discarding = true
          if (text.endsWith('\u001b')) this.pending = '\u001b'
        }
        return output
      }

      if (terminated.aborted) {
        // An unclosed OSC interrupted by CAN/SUB or another escape: leave the aborted bytes as-is and continue from the interrupt.
        output += text.slice(start, terminated.next)
        index = terminated.next
        continue
      }

      const payload = text.slice(start + 4, terminated.payloadEnd)
      output += isSupportedOsc8Payload(payload) ? text.slice(start, terminated.next) : '\u001b]8;;\u001b\\'
      index = terminated.next
    }

    return output
  }

  reset(): void {
    this.pending = ''
    this.discarding = false
  }
}

function findOscTerminator(text: string, from: number): { payloadEnd: number; next: number; aborted: boolean } | null {
  for (let pos = from; pos < text.length; pos++) {
    const code = text.charCodeAt(pos)
    if (code === 0x07) return { payloadEnd: pos, next: pos + 1, aborted: false }
    if (code === 0x18 || code === 0x1a) return { payloadEnd: pos, next: pos, aborted: true }
    if (code === 0x1b) {
      if (pos + 1 >= text.length) return null
      if (text.charCodeAt(pos + 1) === 0x5c) return { payloadEnd: pos, next: pos + 2, aborted: false }
      return { payloadEnd: pos, next: pos, aborted: true }
    }
  }
  return null
}

function trailingOsc8PrefixLength(text: string, from: number): number {
  const remaining = text.length - from
  for (const prefix of ['\u001b]8', '\u001b]', '\u001b']) {
    if (remaining >= prefix.length && text.endsWith(prefix)) return prefix.length
  }
  return 0
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
