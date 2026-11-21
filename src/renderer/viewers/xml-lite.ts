// Just enough XML reading for spreadsheet parts, with no DOM (a worker has none). Tags, attributes and text are yielded
// in order. Document type declarations are skipped and no entity other than the five built-in ones and character
// references is ever expanded, so there is nothing for an "entity bomb" to expand.

export type XmlToken =
  | { type: 'open'; name: string; attributes: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string }

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-z]+));/g, (whole, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name] ?? whole
    const code = hex ? parseInt(hex, 16) : Number(decimal)
    // Characters XML does not allow, and anything outside Unicode, are dropped.
    return code > 0x10ffff || (code < 0x20 && code !== 9 && code !== 10 && code !== 13) ? '' : String.fromCodePoint(code)
  })
}

/** The part of a tag name after its namespace prefix: `x:row` and `row` are both `row`. */
const local = (name: string): string => { const colon = name.indexOf(':'); return colon < 0 ? name : name.slice(colon + 1) }

export function* xmlTokens(xml: string): Generator<XmlToken> {
  const attribute = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let at = 0
  while (at < xml.length) {
    const open = xml.indexOf('<', at)
    if (open < 0) { if (at < xml.length) yield { type: 'text', text: decodeXml(xml.slice(at)) }; return }
    if (open > at) yield { type: 'text', text: decodeXml(xml.slice(at, open)) }
    if (xml.startsWith('<!--', open)) { const end = xml.indexOf('-->', open + 4); if (end < 0) return; at = end + 3; continue }
    if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9)
      if (end < 0) return
      yield { type: 'text', text: xml.slice(open + 9, end) }
      at = end + 3
      continue
    }
    if (xml.startsWith('<?', open)) { const end = xml.indexOf('?>', open + 2); if (end < 0) return; at = end + 2; continue }
    if (xml.startsWith('<!', open)) {
      // A document type declaration, possibly with an internal subset in brackets: skipped whole, never read.
      let depth = 0, end = open + 2
      for (; end < xml.length; end++) { const char = xml[end]; if (char === '[') depth++; else if (char === ']') depth--; else if (char === '>' && depth <= 0) break }
      at = end + 1
      continue
    }
    const end = xml.indexOf('>', open + 1)
    if (end < 0) return
    const inside = xml.slice(open + 1, end)
    at = end + 1
    if (inside.startsWith('/')) { yield { type: 'close', name: local(inside.slice(1).trim()) }; continue }
    const selfClosing = inside.endsWith('/')
    const body = selfClosing ? inside.slice(0, -1) : inside
    const space = body.search(/\s/)
    const name = local(space < 0 ? body : body.slice(0, space))
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>
    if (space >= 0) {
      attribute.lastIndex = 0
      for (let match = attribute.exec(body); match; match = attribute.exec(body)) attributes[local(match[1]!)] = decodeXml(match[2] ?? match[3] ?? '')
    }
    yield { type: 'open', name, attributes, selfClosing }
  }
}
