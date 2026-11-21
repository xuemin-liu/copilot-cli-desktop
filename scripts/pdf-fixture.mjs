// Builds small PDF files for checks, by hand, so no document is checked in and no PDF writer is a dependency.
// Each page is a list of lines. A line is drawn with the standard Helvetica font (never embedded, so showing it needs the
// viewer's standard font data), or, as { gbk: 'D6D0CEC4' } (the GBK bytes of the text, in hex), with a predefined Chinese
// font and the GBK character map, which is not Unicode (so reading its text
// needs the viewer's character map files), or, as { fax: true }, is a black square stored as a fax-compressed image (so
// showing it needs the viewer's image decoder, which is WebAssembly).

const literal = text => text.replace(/[\\()]/g, char => `\\${char}`)

/**
 * @param {(string | { gbk: string } | { fax: true })[][]} pages
 * @param {{ encrypt?: boolean }} [options] `encrypt`: mark the document as protected with a password nobody knows.
 * @returns {Buffer}
 */
export function makePdf(pages, options = {}) {
  const objects = []
  const add = body => { objects.push(body); return objects.length }
  const catalog = add(''), tree = add('')
  const helvetica = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const descendant = add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 '
    + '/FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >> >>')
  const song = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /GBK-EUC-H /DescendantFonts [${descendant} 0 R] >>`)
  // Eight rows of eight white pixels, each row one "same as the row above" bit; /Decode turns white into black.
  const square = add('<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0] '
    + '/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 8 /Rows 8 >> /Length 1 >>\nstream\n\xff\nendstream')
  const kids = pages.map(lines => {
    const text = lines.map((line, index) => {
      if (typeof line !== 'string' && 'fax' in line) return ''
      const at = `1 0 0 1 72 ${720 - index * 28} Tm`
      return typeof line === 'string' ? `/F1 18 Tf ${at} (${literal(line)}) Tj` : `/F2 18 Tf ${at} <${line.gbk}> Tj`
    }).join('\n')
    const image = lines.some(line => typeof line !== 'string' && 'fax' in line) ? 'q 300 0 0 300 150 200 cm /Im1 Do Q\n' : ''
    const stream = `${image}BT\n${text}\nET`
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
    return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${helvetica} 0 R /F2 ${song} 0 R >> /XObject << /Im1 ${square} 0 R >> >> /Contents ${content} 0 R >>`)
  })
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`
  objects[tree - 1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map(kid => `${kid} 0 R`).join(' ')}] >>`
  const key = '00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF'
  const encrypt = options.encrypt ? add(`<< /Filter /Standard /V 1 /R 2 /O <${key}> /U <${key.split('').reverse().join('')}> /P -44 >>`) : null
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => { const offset = Buffer.byteLength(out, 'latin1'); out += `${index + 1} 0 obj\n${body}\nendobj\n`; return offset })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>]${encrypt ? ` /Encrypt ${encrypt} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
