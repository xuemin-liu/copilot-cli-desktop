// Reads the cell values of an Excel workbook (.xlsx). Values only: formulas are shown by the result Excel saved with
// them, nothing is calculated, and charts, pictures and macros are ignored. No DOM and no network.
import { xmlTokens } from './xml-lite.js'
import { ZipError, ZipReader } from './zip-reader.js'

/** One sheet as text cells. `rows` holds at most the row and column limits; the totals say how much the sheet has. */
export interface SheetData { name: string; rows: string[][]; totalRows: number; totalColumns: number; note?: string }

export const SHEET_LIMITS = {
  sheets: 50, rows: 5_000, columns: 200, cellChars: 2_000,
  /** Unpacked size of one sheet's XML, of the shared strings, and of the whole workbook. */
  sheetBytes: 64 * 1024 * 1024, stringsBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, entries: 5_000,
  sharedStrings: 500_000,
}

/**
 * What a number format makes of a number: a calendar date, a time of day, both, or an amount of time that may pass 24
 * hours (`[h]:mm:ss`). The same number is 1 January, 12:00, or 36:00:00 depending on this.
 */
export type TimeKind = 'date' | 'time' | 'datetime' | 'elapsed'

/** Number formats Excel defines itself. 14-17 and the East Asian ones are dates, 18-21 and 45, 47 times, 22 both, 46 elapsed. */
const BUILT_IN: Record<number, TimeKind> = { 22: 'datetime', 45: 'time', 46: 'elapsed', 47: 'time' }
for (const id of [14, 15, 16, 17, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 57, 58]) BUILT_IN[id] = 'date'
for (const id of [18, 19, 20, 21, 32, 33, 34, 35, 55, 56]) BUILT_IN[id] = 'time'

/** The kind of a custom format, read from its letters outside quoted text; null when it shows a plain number. */
export function timeKind(code: string): TimeKind | null {
  const unquoted = code.replace(/"[^"]*"/g, '').replace(/\\./g, '')
  if (/\[(?:h+|m+|s+)\]/i.test(unquoted)) return 'elapsed'
  // Brackets otherwise hold colors, conditions and locales, not parts of the date.
  const bare = unquoted.replace(/\[[^\]]*\]/g, '')
  if (/^\s*general\s*$/i.test(bare)) return null
  const day = /[dy]/i.test(bare), clock = /[hs]/i.test(bare) || /AM\/PM|A\/P/i.test(bare)
  // An "m" is a month next to days and years and minutes next to hours and seconds; alone it is a month.
  if (day) return clock ? 'datetime' : 'date'
  if (clock) return 'time'
  return /m/i.test(bare) ? 'date' : null
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * An Excel date number as text, for the kind its format gives it. Without a kind, a whole number is a date, a fraction a
 * time, and anything else both. `date1904`: the workbook counts from 1904 (old Mac files).
 */
export function formatSerialDate(serial: number, date1904 = false, kind?: TimeKind): string {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465.999) return String(serial)
  const total = Math.round(serial * 86_400)
  const days = Math.floor(total / 86_400), seconds = total - days * 86_400
  const clock = `${pad(Math.floor(seconds / 3_600))}:${pad(Math.floor(seconds % 3_600 / 60))}${seconds % 60 ? `:${pad(seconds % 60)}` : ''}`
  if (kind === 'elapsed') return `${days * 24 + Math.floor(seconds / 3_600)}:${pad(Math.floor(seconds % 3_600 / 60))}:${pad(seconds % 60)}`
  if (kind === 'time') return clock
  // Day 0 of the 1900 system is 30 December 1899 (Excel counts a 29 February 1900 that never was; this matches from March 1900 on).
  const date = new Date(Date.UTC(1899, 11, 30) + (days + (date1904 ? 1_462 : 0)) * 86_400_000)
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  if (kind === 'date') return day
  if (kind === 'datetime') return `${day} ${clock}`
  return days === 0 && !date1904 ? clock : seconds === 0 ? day : `${day} ${clock}`
}

/** "BC12" to the column's index, 0-based; -1 when it is not a cell reference. */
export function columnIndex(reference: string): number {
  let column = 0, index = 0
  for (; index < reference.length; index++) {
    const code = reference.charCodeAt(index) & ~32
    if (code < 65 || code > 90) break
    column = column * 26 + (code - 64)
  }
  return index === 0 ? -1 : column - 1
}

function tidyNumber(raw: string): string {
  const value = Number(raw)
  // Excel stores binary fractions: 0.1 + 0.2 is saved as 0.30000000000000004. Fifteen digits is what Excel shows.
  return raw.trim() === '' || !Number.isFinite(value) ? raw : String(Number(value.toPrecision(15)))
}

async function readSharedStrings(zip: ZipReader, path: string): Promise<string[]> {
  if (!zip.entries.has(path)) return []
  const strings: string[] = []
  let current: string | null = null, inText = false, phonetic = 0
  for (const token of xmlTokens(await zip.text(path, SHEET_LIMITS.stringsBytes))) {
    if (token.type === 'open') {
      if (token.name === 'si') { current = token.selfClosing ? null : ''; if (token.selfClosing) strings.push('') }
      // Phonetic guides (for Japanese) repeat the text in another script; they are not part of the value.
      else if (token.name === 'rPh' && !token.selfClosing) phonetic++
      else if (token.name === 't' && !token.selfClosing) inText = true
    } else if (token.type === 'close') {
      if (token.name === 'si' && current !== null) {
        if (strings.length >= SHEET_LIMITS.sharedStrings) throw new ZipError('too-large', 'The workbook has too many different texts')
        strings.push(current); current = null
      } else if (token.name === 'rPh') phonetic = Math.max(0, phonetic - 1)
      else if (token.name === 't') inText = false
    } else if (inText && current !== null && phonetic === 0 && current.length < SHEET_LIMITS.cellChars) current += token.text
  }
  return strings
}

async function readDateStyles(zip: ZipReader, path: string): Promise<(TimeKind | null)[]> {
  if (!zip.entries.has(path)) return []
  const custom = new Map<number, TimeKind | null>()
  const styles: (TimeKind | null)[] = []
  let inCellFormats = false
  for (const token of xmlTokens(await zip.text(path, SHEET_LIMITS.stringsBytes))) {
    if (token.type === 'open') {
      if (token.name === 'numFmt') custom.set(Number(token.attributes.numFmtId), timeKind(token.attributes.formatCode ?? ''))
      else if (token.name === 'cellXfs') inCellFormats = !token.selfClosing
      else if (token.name === 'xf' && inCellFormats) { const id = Number(token.attributes.numFmtId ?? 0); styles.push(custom.has(id) ? custom.get(id)! : BUILT_IN[id] ?? null) }
    } else if (token.type === 'close' && token.name === 'cellXfs') inCellFormats = false
  }
  return styles
}

function readSheet(name: string, xml: string, strings: readonly string[], dateStyles: readonly (TimeKind | null)[], date1904: boolean): SheetData {
  const rows: string[][] = []
  let totalRows = 0, totalColumns = 0
  let rowIndex = -1, row: string[] | null = null
  let cell: { column: number; type: string; time: TimeKind | null } | null = null
  let collecting: 'v' | 't' | null = null, value = ''
  let nextColumn = 0
  for (const token of xmlTokens(xml)) {
    if (token.type === 'open') {
      if (token.name === 'row') {
        const numbered = Number(token.attributes.r)
        rowIndex = Number.isInteger(numbered) && numbered > 0 ? numbered - 1 : rowIndex + 1
        totalRows = Math.max(totalRows, rowIndex + 1)
        row = rowIndex < SHEET_LIMITS.rows ? [] : null
        nextColumn = 0
        if (row && token.selfClosing) row = null
      } else if (token.name === 'c') {
        const column = token.attributes.r ? columnIndex(token.attributes.r) : nextColumn
        nextColumn = (column < 0 ? nextColumn : column) + 1
        totalColumns = Math.max(totalColumns, nextColumn)
        cell = token.selfClosing || column < 0 ? null : { column, type: token.attributes.t ?? 'n', time: dateStyles[Number(token.attributes.s ?? -1)] ?? null }
        value = ''
      } else if (cell && !token.selfClosing && (token.name === 'v' || (token.name === 't' && cell.type === 'inlineStr'))) collecting = token.name
    } else if (token.type === 'text') {
      if (collecting && value.length < SHEET_LIMITS.cellChars) value += token.text
    } else if (token.name === 'v' || token.name === 't') collecting = null
    else if (token.name === 'c') {
      if (cell && row && cell.column < SHEET_LIMITS.columns && value !== '') {
        let text = value
        if (cell.type === 's') text = strings[Number(value)] ?? ''
        else if (cell.type === 'b') text = value === '1' ? 'TRUE' : 'FALSE'
        else if (cell.type === 'n') text = cell.time ? formatSerialDate(Number(value), date1904, cell.time) : tidyNumber(value)
        row[cell.column] = text.length > SHEET_LIMITS.cellChars ? `${text.slice(0, SHEET_LIMITS.cellChars)}…` : text
      }
      cell = null; collecting = null
    } else if (token.name === 'row') {
      if (row && rowIndex >= 0) { while (rows.length < rowIndex) rows.push([]); rows[rowIndex] = Array.from(row, text => text ?? '') }
      row = null
    }
  }
  return { name, rows, totalRows, totalColumns }
}

/** Every sheet of a workbook, in the order of its tabs. Throws `ZipError` when the file is not a readable workbook or is over a limit. */
export async function readWorkbook(bytes: Uint8Array): Promise<SheetData[]> {
  const zip = new ZipReader(bytes, { entries: SHEET_LIMITS.entries, totalBytes: SHEET_LIMITS.totalBytes })
  if (!zip.entries.has('xl/workbook.xml')) throw new ZipError('invalid', 'Not an Excel workbook')
  const targets = new Map<string, string>()
  if (zip.entries.has('xl/_rels/workbook.xml.rels')) {
    for (const token of xmlTokens(await zip.text('xl/_rels/workbook.xml.rels', 4 * 1024 * 1024))) {
      if (token.type !== 'open' || token.name !== 'Relationship') continue
      const target = token.attributes.Target ?? ''
      // Targets are relative to xl/, or start at the archive root. Anything that would leave the archive is not a part of it.
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
      if (token.attributes.Id && !path.split('/').includes('..')) targets.set(token.attributes.Id, path)
    }
  }
  const listed: { name: string; path: string }[] = []
  let date1904 = false
  for (const token of xmlTokens(await zip.text('xl/workbook.xml', 16 * 1024 * 1024))) {
    if (token.type !== 'open') continue
    if (token.name === 'workbookPr') date1904 = token.attributes.date1904 === '1' || token.attributes.date1904 === 'true'
    else if (token.name === 'sheet') {
      const path = targets.get(token.attributes.id ?? '') ?? `xl/worksheets/sheet${listed.length + 1}.xml`
      listed.push({ name: (token.attributes.name ?? `Sheet ${listed.length + 1}`).slice(0, 64), path })
    }
  }
  if (listed.length === 0) throw new ZipError('invalid', 'The workbook has no sheets')
  const strings = await readSharedStrings(zip, 'xl/sharedStrings.xml')
  const dateStyles = await readDateStyles(zip, 'xl/styles.xml')
  const sheets: SheetData[] = []
  for (const { name, path } of listed.slice(0, SHEET_LIMITS.sheets)) {
    // Chart sheets and the like are not grids of cells.
    if (!path.startsWith('xl/worksheets/') || !zip.entries.has(path)) { sheets.push({ name, rows: [], totalRows: 0, totalColumns: 0, note: 'This sheet has no cells to show.' }); continue }
    try { sheets.push(readSheet(name, await zip.text(path, SHEET_LIMITS.sheetBytes), strings, dateStyles, date1904)) }
    catch (error) {
      // One oversized sheet does not hide the others, unless the whole workbook is over its limit.
      if (!(error instanceof ZipError) || error.reason !== 'too-large' || sheets.length + 1 === listed.length && sheets.length === 0) throw error
      sheets.push({ name, rows: [], totalRows: 0, totalColumns: 0, note: 'This sheet is too large to show here.' })
    }
  }
  return sheets
}
