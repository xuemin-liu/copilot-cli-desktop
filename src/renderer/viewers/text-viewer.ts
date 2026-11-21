// Loaded only when a text or Markdown file is first opened (see ../file-viewers.ts), so the libraries below cost nothing
// at start-up. Everything here turns untrusted file text into HTML that is safe to put in the main window.
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import powershell from 'highlight.js/lib/languages/powershell'
import dos from 'highlight.js/lib/languages/dos'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import type { TextViewer } from '../file-viewers.js'

hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('dos', dos)
hljs.registerLanguage('dockerfile', dockerfile)

/** Above this, text is shown without colors: highlighting a very large file would freeze the window. */
const HIGHLIGHT_LIMIT = 400_000
const HIGHLIGHT_LINE_LIMIT = 10_000

const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const splitLines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n')

/** Cut highlighted HTML at line ends. A span that is open across a line end (a block comment) is closed and opened again,
 * so every line is well-formed on its own. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let line = ''
  let index = 0
  while (index < html.length) {
    const char = html[index]!
    if (char === '<') {
      const end = html.indexOf('>', index)
      if (end < 0) { line += escapeHtml(html.slice(index)); break }
      const tag = html.slice(index, end + 1)
      if (tag.startsWith('</')) open.pop()
      else open.push(tag)
      line += tag
      index = end + 1
    } else if (char === '\n') {
      lines.push(line + '</span>'.repeat(open.length))
      line = open.join('')
      index++
    } else { line += char; index++ }
  }
  lines.push(line + '</span>'.repeat(open.length))
  return lines
}

function highlight(text: string, language: string | null): string[] {
  const plain = splitLines(text)
  if (!language || text.length > HIGHLIGHT_LIMIT || plain.length > HIGHLIGHT_LINE_LIMIT || !hljs.getLanguage(language)) return plain.map(escapeHtml)
  try { return splitHighlightedLines(hljs.highlight(plain.join('\n'), { language, ignoreIllegals: true }).value) }
  catch { return plain.map(escapeHtml) }
}

const markdownIt = new MarkdownIt({
  html: true, linkify: true,
  highlight: (code, language) => {
    const known = language && hljs.getLanguage(language) && code.length <= HIGHLIGHT_LIMIT
    try { return `<pre class="hljs"><code>${known ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code)}</code></pre>` }
    catch { return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>` }
  },
})
// "- [ ] item" and "- [x] item" become a box in front of the item. No form control is ever produced.
markdownIt.core.ruler.after('inline', 'file-task-lists', state => {
  const tokens = state.tokens
  for (let index = 2; index < tokens.length; index++) {
    const inline = tokens[index]!
    if (inline.type !== 'inline' || tokens[index - 1]!.type !== 'paragraph_open' || tokens[index - 2]!.type !== 'list_item_open') continue
    const first = inline.children?.[0]
    const match = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null
    if (!first || !match) continue
    const done = match[1] !== ' '
    first.content = first.content.slice(match[0].length)
    const box = new state.Token('html_inline', '', 0)
    box.content = `<span class="file-task${done ? ' file-task-done' : ''}" role="img" aria-label="${done ? 'Done' : 'Not done'}">${done ? '☑' : '☐'}</span> `
    inline.children!.unshift(box)
    tokens[index - 2]!.attrJoin('class', 'file-task-item')
  }
})
/** The anchor a heading gets, as repository pages make them: lower case, spaces to hyphens, punctuation dropped. */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-')
}
markdownIt.core.ruler.push('file-heading-ids', state => {
  const used = new Map<string, number>()
  state.tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') return
    const slug = headingSlug(state.tokens[index + 1]?.children?.filter(child => child.type === 'text' || child.type === 'code_inline').map(child => child.content).join('') ?? '')
    if (!slug) return
    const count = used.get(slug) ?? 0
    used.set(slug, count + 1)
    token.attrSet('id', count ? `${slug}-${count}` : slug)
  })
})
// Table cells say their alignment with a style attribute. Styles are removed below, so say it with a class.
for (const name of ['th_open', 'td_open']) {
  markdownIt.renderer.rules[name] = (tokens, index, options, _env, self) => {
    const token = tokens[index]!
    const align = /text-align:\s*(left|right|center)/.exec(String(token.attrGet('style') ?? ''))
    if (token.attrs) token.attrs = token.attrs.filter(([attribute]) => attribute !== 'style')
    if (align) token.attrJoin('class', `file-align-${align[1]}`)
    return self.renderToken(tokens, index, options)
  }
}

/** Set while a Word document is being sanitized: its pictures are embedded data, not paths to load. */
let embeddedPictures = false
const EMBEDDED_PICTURE = /^data:image\/(?:png|jpeg|gif|bmp|webp);base64,[A-Za-z0-9+/=]+$/
const purify = DOMPurify(window)
purify.addHook('afterSanitizeAttributes', node => {
  // Only classes this viewer wrote are kept, so file content cannot borrow the look of the app's own controls.
  if (node.hasAttribute('class')) {
    const kept = (node.getAttribute('class') ?? '').split(' ').filter(name => /^(?:hljs|language-|file-)/.test(name))
    if (kept.length) node.setAttribute('class', kept.join(' '))
    else node.removeAttribute('class')
  }
  if (node.nodeName === 'IMG') {
    // Nothing is fetched while the HTML is put in the page. The panel loads local pictures itself and never loads remote ones.
    const source = node.getAttribute('src') ?? ''
    node.removeAttribute('src')
    // A Word document's pictures are inside it. They are kept only as raster data; anything else is dropped, not loaded.
    if (embeddedPictures) { if (EMBEDDED_PICTURE.test(source)) node.setAttribute('src', source); else node.remove() }
    else node.setAttribute('data-file-src', source)
    for (const attribute of ['width', 'height']) if (!/^\d{1,4}%?$/.test(node.getAttribute(attribute) ?? '0')) node.removeAttribute(attribute)
  }
  if (node.nodeName === 'A') { node.removeAttribute('target'); node.setAttribute('rel', 'noreferrer noopener') }
})
const FORBIDDEN_TAGS = ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'label', 'fieldset', 'iframe', 'frame', 'frameset', 'object',
  'embed', 'audio', 'video', 'source', 'track', 'picture', 'link', 'meta', 'base', 'dialog', 'svg', 'math', 'template', 'slot', 'canvas', 'map', 'area', 'marquee', 'nav']
const FORBIDDEN_ATTRIBUTES = ['style', 'srcset', 'ping', 'action', 'formaction', 'autofocus', 'contenteditable', 'tabindex', 'draggable', 'background', 'poster', 'usemap', 'name', 'accesskey']

function sanitize(html: string): string {
  return purify.sanitize(html, {
    USE_PROFILES: { html: true }, FORBID_TAGS: FORBIDDEN_TAGS, FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    // Ids get a prefix so a heading named "root" or "body" cannot stand in for one of the page's own elements.
    SANITIZE_NAMED_PROPS: true, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: true,
  })
}
const markdown = (text: string): string => sanitize(markdownIt.render(text))

function wordDocument(html: string): string {
  embeddedPictures = true
  // The data: scheme is allowed for this one call, and the hook above then keeps only raster pictures.
  try { return purify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: FORBIDDEN_TAGS, FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    SANITIZE_NAMED_PROPS: true, ALLOW_DATA_ATTR: false, ADD_DATA_URI_TAGS: ['img'] }) }
  finally { embeddedPictures = false }
}

// --- Notebooks -------------------------------------------------------------
const NOTEBOOK_LIMITS = { cells: 5_000, outputChars: 200_000, pictureChars: 14 * 1024 * 1024, htmlChars: 8 * 1024 * 1024 }
const joined = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part => typeof part === 'string').join('') : ''
// Tracebacks carry terminal color codes.
const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
function clipped(text: string): string {
  return text.length > NOTEBOOK_LIMITS.outputChars ? `${escapeHtml(text.slice(0, NOTEBOOK_LIMITS.outputChars))}\n<span class="file-nb-note">… output cut here</span>` : escapeHtml(text)
}

function outputHtml(output: unknown): string {
  const item = output as { output_type?: unknown; name?: unknown; text?: unknown; data?: Record<string, unknown>; ename?: unknown; evalue?: unknown; traceback?: unknown; png?: unknown; jpeg?: unknown } | null
  if (!item || typeof item !== 'object') return ''
  const kind = item.output_type
  if (kind === 'stream') return `<pre class="file-nb-stream${item.name === 'stderr' ? ' file-nb-stderr' : ''}">${clipped(joined(item.text))}</pre>`
  if (kind === 'error' || kind === 'pyerr') {
    const trace = Array.isArray(item.traceback) ? item.traceback.filter(line => typeof line === 'string').join('\n') : ''
    return `<pre class="file-nb-stream file-nb-stderr">${clipped(plain(trace || `${joined(item.ename)}: ${joined(item.evalue)}`))}</pre>`
  }
  // Version 3 notebooks keep an output's forms beside its type; version 4 keeps them under `data`.
  const data: Record<string, unknown> = item.data && typeof item.data === 'object' ? item.data
    : { 'text/plain': item.text, 'image/png': item.png, 'image/jpeg': item.jpeg }
  for (const type of ['image/png', 'image/jpeg'] as const) {
    const picture = joined(data[type]).replace(/\s+/g, '')
    if (picture && picture.length <= NOTEBOOK_LIMITS.pictureChars && /^[A-Za-z0-9+/]+=*$/.test(picture)) return `<img class="file-nb-picture" alt="Output picture" src="data:${type};base64,${picture}">`
  }
  if (typeof data['text/markdown'] !== 'undefined') return `<div class="file-nb-rich">${markdown(joined(data['text/markdown']))}</div>`
  const text = joined(data['text/plain'])
  // What a notebook saved as HTML, SVG or script is never put in the page. Its plain-text form is shown when it has one.
  const hidden = ['text/html', 'image/svg+xml', 'application/javascript', 'application/vnd.jupyter.widget-view+json'].some(type => type in data)
  if (text) return `<pre class="file-nb-stream">${clipped(text)}</pre>`
  return hidden ? '<p class="file-nb-note">This output is saved as HTML or a widget, which is not shown here.</p>' : ''
}

function notebook(text: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('This file is not a notebook: it is not valid JSON.') }
  const book = parsed as { cells?: unknown; worksheets?: unknown; metadata?: { kernelspec?: { language?: unknown }; language_info?: { name?: unknown } } } | null
  const sheets = Array.isArray(book?.worksheets) ? book.worksheets as { cells?: unknown }[] : []
  const cells = Array.isArray(book?.cells) ? book.cells : sheets.flatMap(sheet => Array.isArray(sheet?.cells) ? sheet.cells : [])
  if (!book || typeof book !== 'object' || (!Array.isArray(book.cells) && sheets.length === 0)) throw new Error('This file is not a notebook.')
  if (cells.length > NOTEBOOK_LIMITS.cells) throw new Error('This notebook has too many cells to show here.')
  const named = book.metadata?.language_info?.name ?? book.metadata?.kernelspec?.language
  const language = typeof named === 'string' && /^[\w+#-]{1,32}$/.test(named) ? named.toLowerCase() : 'python'
  let html = ''
  for (const entry of cells) {
    const cell = entry as { cell_type?: unknown; source?: unknown; input?: unknown; outputs?: unknown; execution_count?: unknown; prompt_number?: unknown; level?: unknown } | null
    if (!cell || typeof cell !== 'object') continue
    const source = joined(cell.source ?? cell.input)
    if (cell.cell_type === 'markdown') html += `<div class="file-nb-cell file-nb-markdown">${markdown(source)}</div>`
    else if (cell.cell_type === 'heading') html += `<div class="file-nb-cell file-nb-markdown">${markdown(`${'#'.repeat(Math.min(6, Math.max(1, Number(cell.level) || 1)))} ${source}`)}</div>`
    else if (cell.cell_type === 'code') {
      const count = cell.execution_count ?? cell.prompt_number
      const outputs = Array.isArray(cell.outputs) ? cell.outputs.map(outputHtml).join('') : ''
      html += `<div class="file-nb-cell file-nb-code"><div class="file-nb-prompt">In [${typeof count === 'number' ? count : ' '}]:</div>`
        + `<pre class="hljs"><code>${highlight(source, language).join('\n')}</code></pre>${outputs ? `<div class="file-nb-output">${outputs}</div>` : ''}</div>`
    } else if (source) html += `<div class="file-nb-cell"><pre class="file-nb-stream">${clipped(source)}</pre></div>`
    if (html.length > NOTEBOOK_LIMITS.htmlChars) throw new Error('This notebook is too large to show rendered.')
  }
  return html || '<p class="file-nb-note">This notebook has no cells.</p>'
}

const viewer: TextViewer = { highlight, markdown, notebook, document: wordDocument }
window.copilotFileViewers = { ...window.copilotFileViewers, text: viewer }
