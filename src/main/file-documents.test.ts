import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { makeXlsx, makeZip } from './fixtures/office-fixture.js'
import { classifyFile } from './file-view.js'
import { columnName, guessDelimiter, parseDelimited, sheetHtml, TABLE_LIMITS } from '../renderer/file-documents.js'
import { decodeXml, xmlTokens } from '../renderer/viewers/xml-lite.js'
import { columnIndex, formatSerialDate, readWorkbook, SHEET_LIMITS, timeKind } from '../renderer/viewers/xlsx-reader.js'
import { ZipError, ZipReader } from '../renderer/viewers/zip-reader.js'

const LIMITS = { entries: 100, totalBytes: 10 * 1024 * 1024 }
const refused = (reason: ZipError['reason']) => (error: unknown): boolean => error instanceof ZipError && error.reason === reason
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])

test('Word and Excel files are told from other archives and from text by bytes and name together', () => {
  assert.equal(classifyFile('report.docx', ZIP).kind, 'docx')
  assert.equal(classifyFile('budget.xlsx', ZIP).kind, 'xlsx')
  assert.equal(classifyFile('macros.xlsm', ZIP).kind, 'xlsx', 'shown, its macros never run')
  assert.deepEqual(classifyFile('bundle.zip', ZIP), { kind: 'other', language: null, mime: null, reason: 'unsupported' })
  assert.equal(classifyFile('slides.pptx', ZIP).kind, 'other')
  assert.equal(classifyFile('notes.docx', bytes('not an archive')).kind, 'text', 'the name alone does not make a Word file')
  assert.equal(classifyFile('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])).kind, 'other', 'the old binary formats have no viewer')
  assert.equal(classifyFile('data.csv', bytes('a,b\n1,2\n')).kind, 'csv')
  assert.equal(classifyFile('data.TSV', bytes('a\tb\n')).kind, 'csv')
  assert.equal(classifyFile('data.csv', new Uint8Array([1, 0, 2])).kind, 'other')
  assert.deepEqual(classifyFile('analysis.ipynb', bytes('{"cells":[]}')), { kind: 'notebook', language: 'json', mime: null })
})

test('an archive that lists a name twice is refused', async () => {
  const archive = Buffer.from(await makeZip({ 'a.xml': 'first', 'b.xml': 'other' }, true))
  // Rename b.xml to a.xml in its own header and in the directory.
  for (let at = archive.indexOf('b.xml'); at >= 0; at = archive.indexOf('b.xml', at + 1)) archive.write('a.xml', at, 'latin1')
  assert.throws(() => new ZipReader(archive, LIMITS), refused('invalid'))
})

test('a ZIP archive is read entry by entry, and only what its limits allow', async () => {
  const archive = await makeZip({ 'a.txt': 'alpha', 'folder/b.txt': 'beta '.repeat(1_000), 'stored.bin': Buffer.from([1, 2, 3]) })
  const zip = new ZipReader(archive, LIMITS)
  assert.deepEqual([...zip.entries.keys()], ['a.txt', 'folder/b.txt', 'stored.bin'])
  assert.equal(await zip.text('a.txt', 100), 'alpha')
  assert.equal((await zip.text('folder/b.txt', 10_000)).length, 5_000)
  assert.equal(zip.declaredBytes, 5 + 5_000 + 3)
  await assert.rejects(zip.read('missing.txt', 100), refused('invalid'))
  await assert.rejects(zip.read('folder/b.txt', 4_999), refused('too-large'), 'one byte under what the entry unpacks to')
  const stored = new ZipReader(await makeZip({ 'x.bin': Buffer.alloc(2_000, 9) }, true), LIMITS)
  assert.equal((await stored.read('x.bin', 2_000)).length, 2_000)
  await assert.rejects(stored.read('x.bin', 1_999), refused('too-large'))

  assert.throws(() => new ZipReader(bytes('this is not an archive at all'), LIMITS), refused('invalid'))
  assert.throws(() => new ZipReader(new Uint8Array(0), LIMITS), refused('invalid'))
  assert.throws(() => new ZipReader(archive, { entries: 2, totalBytes: 1_000 }), refused('too-large'), 'more entries than allowed')
  assert.throws(() => new ZipReader(archive.subarray(0, archive.length - 30), LIMITS), refused('invalid'), 'a cut-off archive')
})

test('an archive that lies about its sizes is stopped while it is unpacked', async () => {
  // 20 MB of zeros packs into a few kilobytes.
  const bomb = await makeZip({ 'big.xml': Buffer.alloc(20 * 1024 * 1024) })
  assert.ok(bomb.length < 100_000)
  const honest = new ZipReader(bomb, { entries: 10, totalBytes: 50 * 1024 * 1024 })
  await assert.rejects(honest.read('big.xml', 1024 * 1024), refused('too-large'))
  // Now make the directory claim the entry is 10 bytes. The claim is not what is trusted.
  const lying = Buffer.from(bomb)
  const directory = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  lying.writeUInt32LE(10, directory + 24)
  const fooled = new ZipReader(lying, { entries: 10, totalBytes: 50 * 1024 * 1024 })
  assert.equal(fooled.declaredBytes, 10)
  await assert.rejects(fooled.read('big.xml', 1024 * 1024), refused('too-large'))
  // With room to unpack it all, the false size itself is the reason to refuse.
  await assert.rejects(new ZipReader(lying, { entries: 10, totalBytes: 50 * 1024 * 1024 }).read('big.xml', 30 * 1024 * 1024), refused('invalid'))
  // The limit for the whole archive holds across entries.
  const several = new ZipReader(await makeZip({ 'one.bin': Buffer.alloc(600_000), 'two.bin': Buffer.alloc(600_000) }), { entries: 10, totalBytes: 1_000_000 })
  assert.equal((await several.read('one.bin', 700_000)).length, 600_000)
  await assert.rejects(several.read('two.bin', 700_000), refused('too-large'))
  // Entries unpacked at the same time share the one total: neither may spend what the other has taken.
  const together = new ZipReader(await makeZip({ 'one.bin': Buffer.alloc(600_000, 1), 'two.bin': Buffer.alloc(600_000, 2), 'three.bin': Buffer.alloc(600_000, 3) }), { entries: 10, totalBytes: 1_000_000 })
  const outcomes = await Promise.allSettled(['one.bin', 'two.bin', 'three.bin'].map(name => together.read(name, 700_000)))
  const unpacked = outcomes.reduce((sum, outcome) => sum + (outcome.status === 'fulfilled' ? outcome.value.length : 0), 0)
  assert.ok(unpacked <= 1_000_000, `${unpacked} bytes were handed out under a limit of 1,000,000`)
  assert.ok(outcomes.some(outcome => outcome.status === 'rejected' && refused('too-large')(outcome.reason)))
  // A damaged stream is "invalid", not a crash.
  const damaged = Buffer.from(await makeZip({ 'a.txt': 'alpha '.repeat(500) }))
  damaged.fill(0xff, 40, 60)
  await assert.rejects(new ZipReader(damaged, LIMITS).read('a.txt', 10_000), refused('invalid'))
  assert.ok(deflateRawSync(Buffer.alloc(10)).length > 0)
})

test('XML is read without a DOM, and nothing in it is expanded beyond the built-in entities', () => {
  const tokens = [...xmlTokens('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]><a:root one="1" r:id=\'x&amp;y\'><b/>text &lt;&#65;&#x42;&gt; &b; <![CDATA[<raw>&amp;]]><!-- gone --></a:root>')]
  assert.deepEqual(tokens, [
    { type: 'open', name: 'root', attributes: Object.assign(Object.create(null), { one: '1', id: 'x&y' }), selfClosing: false },
    { type: 'open', name: 'b', attributes: Object.create(null), selfClosing: true },
    { type: 'text', text: 'text <AB> &b; ' },
    { type: 'text', text: '<raw>&amp;' },
    { type: 'close', name: 'root' },
  ])
  assert.equal(decodeXml('&quot;&apos;&amp;&#0;&#x110000;&#9;'), '"\'&\t')
  assert.deepEqual([...xmlTokens('<a><b')], [{ type: 'open', name: 'a', attributes: Object.create(null), selfClosing: false }], 'a cut-off tag ends the reading quietly')
})

test('cell references, date formats and Excel date numbers', () => {
  assert.deepEqual(['A1', 'Z9', 'AA10', 'BC12', 'xfd1', '12', ''].map(columnIndex), [0, 25, 26, 54, 16_383, -1, -1])
  assert.deepEqual([0, 25, 26, 54, 701, 702].map(columnName), ['A', 'Z', 'AA', 'BC', 'ZZ', 'AAA'])
  assert.deepEqual(['yyyy-mm-dd', '[$-409]mmmm d, yyyy', 'mmm-yy', 'mmmm'].map(timeKind), ['date', 'date', 'date', 'date'])
  assert.deepEqual(['hh:mm:ss', 'h:mm AM/PM', 'mm:ss', 'mm:ss.0'].map(timeKind), ['time', 'time', 'time', 'time'])
  assert.deepEqual(['d/m/yy h:mm', 'yyyy-mm-dd hh:mm:ss'].map(timeKind), ['datetime', 'datetime'])
  assert.deepEqual(['[h]:mm:ss', '[mm]:ss', '[s]'].map(timeKind), ['elapsed', 'elapsed', 'elapsed'])
  for (const code of ['0.00', '#,##0', '0%', '"days" 0', 'General', '[Red]0.0', '0.00E+00', '0.0 "hours"']) assert.equal(timeKind(code), null, code)
  // The same number under each kind.
  assert.equal(formatSerialDate(1.5, false, 'elapsed'), '36:00:00')
  assert.equal(formatSerialDate(45_658.5, false, 'time'), '12:00')
  assert.equal(formatSerialDate(45_658.5, false, 'date'), '2025-01-01')
  assert.equal(formatSerialDate(45_658.5, false, 'datetime'), '2025-01-01 12:00')
  assert.equal(formatSerialDate(45_658, false, 'datetime'), '2025-01-01 00:00')
  assert.equal(formatSerialDate(0.000_011_574, false, 'elapsed'), '0:00:01')
  assert.equal(formatSerialDate(0.999_999_99, false, 'time'), '00:00', 'a time that rounds up to midnight')
  assert.equal(formatSerialDate(45_292), '2024-01-01')
  assert.equal(formatSerialDate(45_292.5), '2024-01-01 12:00')
  assert.equal(formatSerialDate(0.75), '18:00')
  assert.equal(formatSerialDate(45_292.000_011_574), '2024-01-01 00:00:01')
  assert.equal(formatSerialDate(43_830, true), '2024-01-01', 'a workbook that counts from 1904')
  assert.equal(formatSerialDate(-5), '-5')
  // Excel's 1900 system, as Excel shows it: day 1 is 1 January, day 60 the 29 February it invented, day 61 the 1 March.
  assert.deepEqual([1, 59, 60, 61, 62].map(serial => formatSerialDate(serial, false, 'date')), ['1900-01-01', '1900-02-28', '1900-02-29', '1900-03-01', '1900-03-02'])
  assert.equal(formatSerialDate(60.5, false, 'datetime'), '1900-02-29 12:00')
  assert.deepEqual([0, 1, 60].map(serial => formatSerialDate(serial, true, 'date')), ['1904-01-01', '1904-01-02', '1904-03-01'], 'the 1904 system has no such day')
})

test('a workbook is read sheet by sheet as text cells', async () => {
  const workbook = await makeXlsx([
    { name: 'Sales & costs', rows: [['Region', 'Amount', 'When', 'Paid'], ['North <1>', 1200.5, { date: 45_292 }, true], ['South', 0.1 + 0.2, { date: 45_293.25 }, false],
      [{ inline: 'kept in the cell' }, { formula: 'SUM(B2:B3)', value: 1200.8 }, null, { formula: 'A2&"!"', value: 'North <1>!' }]] },
    { name: 'Empty', rows: [] },
    { name: 'Sparse', rows: [[null, null, 'C1'], [], ['A3']] },
  ])
  const sheets = await readWorkbook(workbook)
  assert.deepEqual(sheets.map(sheet => sheet.name), ['Sales & costs', 'Empty', 'Sparse'])
  assert.deepEqual(sheets[0]!.rows, [
    ['Region', 'Amount', 'When', 'Paid'],
    ['North <1>', '1200.5', '2024-01-01', 'TRUE'],
    ['South', '0.3', '2024-01-02', 'FALSE'],
    ['kept in the cell', '1200.8', '', 'North <1>!'],
  ])
  assert.equal(sheets[0]!.totalRows, 4)
  assert.equal(sheets[0]!.totalColumns, 4)
  assert.deepEqual(sheets[1]!.rows, [])
  assert.deepEqual(sheets[2]!.rows, [['', '', 'C1'], [], ['A3']])
  assert.deepEqual((await readWorkbook(await makeXlsx([{ name: 'Old Mac', rows: [[{ date: 43_830 }]] }], { date1904: true })))[0]!.rows, [['2024-01-01']])
  // A cell's format says whether its number is a date, a time of day, both, or an amount of time.
  const timed = await readWorkbook(await makeXlsx([{ name: 'Times', rows: [[{ number: 45_658.5, style: 2 }, { number: 1.5, style: 3 }, { number: 45_658.5, style: 4 },
    { number: 45_658.5, style: 5 }, { number: 1.5, style: 6 }, { number: 1.5, style: 7 }, { number: 45_658.75, style: 8 }, { number: 45_658.5, style: 1 }]] }]))
  assert.deepEqual(timed[0]!.rows, [['12:00', '36:00:00', '2025-01-01 12:00', '2025-01-01', '36:00:00', '1.5', '18:00', '2025-01-01']])

  await assert.rejects(readWorkbook(await makeZip({ 'word/document.xml': '<w:document/>' })), refused('invalid'), 'a ZIP that is not a workbook')
  await assert.rejects(readWorkbook(bytes('not a zip')), refused('invalid'))
  // More rows and columns than are shown: the extra ones are counted, not kept.
  const wide = Array.from({ length: SHEET_LIMITS.columns + 5 }, (_, index) => index)
  const tall = await readWorkbook(await makeXlsx([{ name: 'Big', rows: Array.from({ length: SHEET_LIMITS.rows + 7 }, (_, index) => index === 0 ? wide : [index]) }]))
  assert.equal(tall[0]!.rows.length, SHEET_LIMITS.rows)
  assert.equal(tall[0]!.totalRows, SHEET_LIMITS.rows + 7)
  assert.equal(tall[0]!.rows[0]!.length, SHEET_LIMITS.columns)
  assert.equal(tall[0]!.totalColumns, SHEET_LIMITS.columns + 5)
})

test('a workbook part that names a path outside the archive is not followed', async () => {
  const workbook = await makeZip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Out" sheetId="1" r:id="rId1"/><sheet name="In" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="../../../secret.xml"/><Relationship Id="rId2" Target="/xl/worksheets/in.xml"/></Relationships>',
    'xl/worksheets/in.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>inside</t></is></c></row></sheetData></worksheet>',
    'secret.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>outside</t></is></c></row></sheetData></worksheet>',
  })
  const sheets = await readWorkbook(workbook)
  assert.deepEqual(sheets.map(sheet => [sheet.name, sheet.rows.flat().join()]), [['Out', ''], ['In', 'inside']])
})

test('separated text becomes rows of cells, with quotes, separators and line ends inside quotes', () => {
  const rows = (text: string, delimiter = ','): string[][] => parseDelimited(text, delimiter).rows
  assert.deepEqual(rows('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']])
  assert.deepEqual(rows('a,b\r\n1,2'), [['a', 'b'], ['1', '2']], 'Windows line ends, no line end at the end')
  assert.deepEqual(rows('name,note\n"Smith, J","said ""hi""\nand left"\n'), [['name', 'note'], ['Smith, J', 'said "hi"\nand left']])
  assert.deepEqual(rows('a,,c\n,,\n'), [['a', '', 'c'], ['', '', '']])
  assert.deepEqual(rows('\ufeffa;b\n1;2\n', ';'), [['a', 'b'], ['1', '2']], 'a byte order mark is not part of the first cell')
  assert.deepEqual(rows('a\tb c\n', '\t'), [['a', 'b c']])
  assert.deepEqual(rows(''), [])
  assert.deepEqual(rows('"open quote, never closed\nstill the same cell'), [['open quote, never closed\nstill the same cell']])
  // A last line that holds only a quoted empty field is a row, with or without a line end after it.
  assert.deepEqual(rows('Value\n""'), [['Value'], ['']])
  assert.deepEqual(rows('Value\n""\n'), [['Value'], ['']])
  assert.deepEqual(rows('a,b\n1,""'), [['a', 'b'], ['1', '']])
  assert.deepEqual(rows('Value\n'), [['Value']], 'a line end at the end starts no row')
  assert.equal(guessDelimiter('a,b,c\n1,2,3\n'), ',')
  assert.equal(guessDelimiter('a;b;c\n1,5;2;3\n'), ';')
  assert.equal(guessDelimiter('a\tb\n1\t2\n'), '\t')
  assert.equal(guessDelimiter('just one column\nof text\n'), ',')
  const big = parseDelimited(Array.from({ length: TABLE_LIMITS.rows + 10 }, (_, index) => `${index},x`).join('\n'), ',')
  assert.equal(big.rows.length, TABLE_LIMITS.rows)
  assert.equal(big.totalRows, TABLE_LIMITS.rows + 10)
  const wide = parseDelimited(Array.from({ length: TABLE_LIMITS.columns + 3 }, (_, index) => index).join(','), ',')
  assert.equal(wide.rows[0]!.length, TABLE_LIMITS.columns)
  assert.equal(wide.totalColumns, TABLE_LIMITS.columns + 3)
  assert.equal(parseDelimited('x'.repeat(TABLE_LIMITS.cellChars + 50), ',').rows[0]![0]!.length, TABLE_LIMITS.cellChars + 1, 'a very long cell is cut')
})

test('a table is escaped text only: nothing in a cell becomes markup', () => {
  const html = sheetHtml(parseDelimited('name,"<img src=x onerror=alert(1)>"\n"<script>alert(1)</script>",12.5\n"a & b",-3%\n', ','), true)
  assert.ok(!/<script|<img/.test(html), html)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('<th>name</th>'), 'the first row of a CSV is the head')
  assert.ok(html.includes('<td class="file-cell-number">12.5</td>'))
  assert.ok(html.includes('<td>a &amp; b</td>'))
  assert.ok(html.includes('<th class="file-row-number">2</th>'))
  const lettered = sheetHtml({ name: 'S', rows: [['x', 'y'], ['1']], totalRows: 2, totalColumns: 2 }, false)
  assert.ok(lettered.includes('<th>A</th><th>B</th>'), 'a spreadsheet gets column letters')
  assert.ok(lettered.includes('<th class="file-row-number">1</th><td>x</td><td>y</td>'))
  assert.ok(lettered.includes('<td class="file-cell-number">1</td><td></td>'), 'short rows are filled out')
  assert.match(sheetHtml({ name: 'S', rows: [['a']], totalRows: 9_000, totalColumns: 1 }, false), /Showing 1 of 9,000 rows\./)
  assert.match(sheetHtml({ name: 'S', rows: [], totalRows: 0, totalColumns: 0 }, false), /This sheet is empty/)
  // The page holds a bounded number of cells, blanks included: a sheet with two cells at opposite corners is still a
  // full grid, and a wide one shows fewer rows and says so.
  const corners = Array.from({ length: 5_000 }, (_, row) => row === 0 ? ['first'] : row === 4_999 ? [...Array.from({ length: 199 }, () => ''), 'last'] : [])
  const grid = sheetHtml({ name: 'S', rows: corners, totalRows: 5_000, totalColumns: 200 }, false)
  const mounted = (grid.match(/<td/g) ?? []).length
  assert.equal(mounted, TABLE_LIMITS.cells, `${mounted} cells`)
  assert.match(grid, /Showing 250 of 5,000 rows\./)
  const narrow = sheetHtml({ name: 'S', rows: Array.from({ length: 5_000 }, (_, row) => [String(row), 'x']), totalRows: 5_000, totalColumns: 2 }, false)
  assert.equal((narrow.match(/<td/g) ?? []).length, 10_000, 'a narrow sheet still shows all its rows')
  assert.ok(!narrow.includes('Showing'))
  assert.match(sheetHtml({ name: 'S', rows: [], totalRows: 0, totalColumns: 0, note: 'Too <big>' }, false), /Too &lt;big&gt;/)
})
