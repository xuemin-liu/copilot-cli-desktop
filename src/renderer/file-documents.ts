// Tables for CSV files and spreadsheets, and the hand-off of Word and Excel files to their worker.
import type { OfficeProblem, OfficeReply } from './viewers/office-worker.js'
import type { SheetData } from './viewers/xlsx-reader.js'

export type { OfficeProblem, OfficeReply, SheetData }

/** `cells`: most cells put in the page for one table, blanks included; rows beyond it are left out and counted in the note. */
export const TABLE_LIMITS = { rows: 5_000, columns: 200, cellChars: 2_000, cells: 50_000 }
/** A Word or Excel file that has not been read after this long is given up on, and its worker ended. */
export const OFFICE_TIMEOUT_MS = 30_000

const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** Which character separates the fields: the one that splits the first lines into the most, and the same number of, fields. */
export function guessDelimiter(text: string): string {
  const lines = text.split(/\r\n?|\n/, 6).filter(line => line.trim() !== '').slice(0, 5)
  let best = ',', bestScore = 0
  for (const candidate of [',', ';', '\t', '|']) {
    const counts = lines.map(line => parseDelimited(line, candidate).rows[0]?.length ?? 0)
    const fields = counts[0] ?? 0
    // Fields in every line, the same number each time, beats a character that merely appears somewhere.
    const score = fields > 1 ? fields * (counts.every(count => count === fields) ? 4 : 1) : 0
    if (score > bestScore) { best = candidate; bestScore = score }
  }
  return best
}

/**
 * Read comma-, semicolon- or tab-separated text into rows of cells. Quoted fields may hold the separator, line ends and
 * doubled quotes. At most the table limits are kept; `totalRows` and `totalColumns` say how large the text is.
 */
export function parseDelimited(text: string, delimiter: string): SheetData {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, started = false, totalRows = 0, totalColumns = 0, fields = 0
  const endField = (): void => {
    fields++
    if (row.length < TABLE_LIMITS.columns) row.push(field.length > TABLE_LIMITS.cellChars ? `${field.slice(0, TABLE_LIMITS.cellChars)}…` : field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    totalColumns = Math.max(totalColumns, fields)
    totalRows++
    if (rows.length < TABLE_LIMITS.rows) rows.push(row)
    row = []; fields = 0; started = false
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!
    if (quoted) {
      if (char === '"') { if (body[index + 1] === '"') { field += '"'; index++ } else quoted = false }
      else if (field.length <= TABLE_LIMITS.cellChars) field += char
    } else if (char === '"' && field === '') { quoted = true; started = true }
    else if (char === delimiter) endField()
    else if (char === '\n' || char === '\r') { if (char === '\r' && body[index + 1] === '\n') index++; endRow() }
    else if (field.length <= TABLE_LIMITS.cellChars) field += char
  }
  // The last line counts unless the text ended with a line end.
  // A quoted empty field ("") is a field too, so a last line holding only that is a row.
  if (field !== '' || fields > 0 || started) endRow()
  return { name: '', rows, totalRows, totalColumns }
}

/** "A", "B", ... "Z", "AA": the letters a spreadsheet gives its columns. */
export function columnName(index: number): string {
  let name = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name
  return name
}

/**
 * A sheet as an HTML table. Every cell is escaped text; nothing in a file becomes markup. `header`: the first row is
 * column titles (CSV), shown in the table head; otherwise the head is the column letters, as in a spreadsheet.
 */
export function sheetHtml(sheet: SheetData, header: boolean): string {
  if (sheet.note) return `<p class="file-sheet-note">${escapeHtml(sheet.note)}</p>`
  const width = Math.min(TABLE_LIMITS.columns, sheet.rows.reduce((most, row) => Math.max(most, row.length), 0))
  if (width === 0) return '<p class="file-sheet-note">This sheet is empty.</p>'
  const cells = (row: readonly string[], tag: 'td' | 'th'): string => {
    let html = ''
    for (let column = 0; column < width; column++) {
      const text = row[column] ?? ''
      const number = tag === 'td' && text !== '' && /^-?[\d.,]+%?$/.test(text)
      html += `<${tag}${number ? ' class="file-cell-number"' : ''}>${escapeHtml(text)}</${tag}>`
    }
    return html
  }
  const letters = Array.from({ length: width }, (_, column) => columnName(column))
  const head = header && sheet.rows.length > 0 ? cells(sheet.rows[0]!, 'th') : cells(letters, 'th')
  const first = header ? 1 : 0
  // A wide sheet shows fewer rows: the page holds a bounded number of cells however the sheet is shaped.
  const shown = Math.min(sheet.rows.length, Math.max(1, Math.floor(TABLE_LIMITS.cells / width)))
  let body = ''
  for (let index = first; index < shown; index++) body += `<tr><th class="file-row-number">${index + 1}</th>${cells(sheet.rows[index]!, 'td')}</tr>`
  const clipped = sheet.totalRows > shown || sheet.totalColumns > width
  const note = clipped ? `<p class="file-sheet-note">Showing ${shown.toLocaleString('en-US')} of ${sheet.totalRows.toLocaleString('en-US')} rows`
    + `${sheet.totalColumns > width ? ` and ${width} of ${sheet.totalColumns.toLocaleString('en-US')} columns` : ''}.</p>` : ''
  return `${note}<table class="file-sheet"><thead><tr><th class="file-row-number"></th>${head}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * Read a Word or Excel file in a worker of its own. `cancel` ends the worker at once: when the tab closes, when the file
 * changes, or when the answer is no longer wanted. The bytes are handed over to the worker and cannot be used again.
 */
export function convertOffice(kind: 'docx' | 'xlsx', bytes: Uint8Array, timeoutMs = OFFICE_TIMEOUT_MS): { result: Promise<OfficeReply>; cancel(): void } {
  const worker = new Worker('./viewer-office-worker.js')
  let done: (reply: OfficeReply) => void = () => undefined
  const result = new Promise<OfficeReply>(resolve => { done = resolve })
  const finish = (reply: OfficeReply): void => { clearTimeout(timer); worker.terminate(); done(reply) }
  const timer = setTimeout(() => finish({ ok: false, problem: 'too-large' }), timeoutMs)
  worker.onmessage = (event: MessageEvent<OfficeReply>) => finish(event.data)
  worker.onerror = () => finish({ ok: false, problem: 'failed' })
  worker.postMessage({ kind, bytes }, [bytes.buffer as ArrayBuffer])
  return { result, cancel: () => { clearTimeout(timer); worker.terminate() } }
}
