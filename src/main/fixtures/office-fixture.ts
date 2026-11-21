// Builds small Word and Excel files (and plain ZIP archives) for tests and checks, so no document is checked in.
import yazl from 'yazl'

export const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMDEAAUAGxEBgQ8XrCQAAAAASUVORK5CYII=', 'base64')

const xmlEscape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** A ZIP archive of the given entries, in order. `store`: do not compress. */
export function makeZip(entries: Record<string, string | Buffer>, store = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    for (const [name, content] of Object.entries(entries)) zip.addBuffer(typeof content === 'string' ? Buffer.from(content, 'utf8') : content, name, { compress: !store })
    const chunks: Buffer[] = []
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk)).on('error', reject).on('end', () => resolve(Buffer.concat(chunks)))
    zip.end()
  })
}

const column = (index: number): string => { let name = ''; for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name; return name }

/** A cell: text, a number, true/false, `{ date }` (an Excel date number shown as a date), `{ inline }` text kept in the
 * cell itself, or `{ formula, value }` (a formula with the result Excel saved). */
export type FixtureCell = string | number | boolean | null | { date: number } | { inline: string } | { formula: string; value: number | string }

/** An .xlsx workbook with the given sheets. Text goes through the shared strings table, as Excel writes it. */
export function makeXlsx(sheets: { name: string; rows: FixtureCell[][] }[], options: { date1904?: boolean } = {}): Promise<Buffer> {
  const strings: string[] = []
  const shared = (text: string): number => { const found = strings.indexOf(text); return found >= 0 ? found : strings.push(text) - 1 }
  const sheetXml = sheets.map(sheet => {
    const rows = sheet.rows.map((cells, rowIndex) => {
      const body = cells.map((cell, columnIndex) => {
        const at = `${column(columnIndex)}${rowIndex + 1}`
        if (cell === null) return ''
        if (typeof cell === 'string') return `<c r="${at}" t="s"><v>${shared(cell)}</v></c>`
        if (typeof cell === 'number') return `<c r="${at}"><v>${cell}</v></c>`
        if (typeof cell === 'boolean') return `<c r="${at}" t="b"><v>${cell ? 1 : 0}</v></c>`
        if ('date' in cell) return `<c r="${at}" s="1"><v>${cell.date}</v></c>`
        if ('inline' in cell) return `<c r="${at}" t="inlineStr"><is><t>${xmlEscape(cell.inline)}</t></is></c>`
        return typeof cell.value === 'number' ? `<c r="${at}"><f>${xmlEscape(cell.formula)}</f><v>${cell.value}</v></c>`
          : `<c r="${at}" t="str"><f>${xmlEscape(cell.formula)}</f><v>${xmlEscape(cell.value)}</v></c>`
      }).join('')
      return `<row r="${rowIndex + 1}">${body}</row>`
    }).join('')
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
  })
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<workbookPr${options.date1904 ? ' date1904="1"' : ''}/><sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`,
    // Style 0 is General; style 1 is the built-in date format 14.
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  }
  sheetXml.forEach((xml, index) => { entries[`xl/worksheets/sheet${index + 1}.xml`] = xml })
  entries['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">`
    + `${strings.map(text => `<si><t xml:space="preserve">${xmlEscape(text)}</t></si>`).join('')}</sst>`
  return makeZip(entries)
}

/** One block of a Word document. */
export type FixtureBlock =
  | { heading: string }
  | { text: string; bold?: boolean }
  | { table: string[][] }
  | { link: string; to: string }
  | { picture: true }

/** A .docx document: headings, paragraphs, a table, links to anywhere (including addresses a viewer must not make live) and a picture. */
export function makeDocx(blocks: FixtureBlock[]): Promise<Buffer> {
  const relations: string[] = []
  const relate = (type: string, target: string, external: boolean): string => {
    relations.push(`<Relationship Id="rId${relations.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${xmlEscape(target)}"${external ? ' TargetMode="External"' : ''}/>`)
    return `rId${relations.length}`
  }
  const run = (text: string, bold = false): string => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`
  let picture = false
  const body = blocks.map(block => {
    if ('heading' in block) return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run(block.heading)}</w:p>`
    if ('text' in block) return `<w:p>${run(block.text, block.bold)}</w:p>`
    if ('link' in block) return `<w:p><w:hyperlink r:id="${relate('hyperlink', block.to, true)}">${run(block.link)}</w:hyperlink></w:p>`
    if ('table' in block) return `<w:tbl>${block.table.map(row => `<w:tr>${row.map(cell => `<w:tc><w:p>${run(cell)}</w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
    picture = true
    return `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="190500" cy="190500"/><wp:docPr id="1" name="Picture" descr="A small picture"/>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${relate('image', 'media/image1.png', false)}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  }).join('')
  const entries: Record<string, string | Buffer> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + `<w:body>${body}</w:body></w:document>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations.join('')}</Relationships>`,
  }
  if (picture) entries['word/media/image1.png'] = PIXEL_PNG
  return makeZip(entries)
}
