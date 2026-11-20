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
    node.setAttribute('data-file-src', source)
    for (const attribute of ['width', 'height']) if (!/^\d{1,4}%?$/.test(node.getAttribute(attribute) ?? '0')) node.removeAttribute(attribute)
  }
  if (node.nodeName === 'A') { node.removeAttribute('target'); node.setAttribute('rel', 'noreferrer noopener') }
})
const FORBIDDEN_TAGS = ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'label', 'fieldset', 'iframe', 'frame', 'frameset', 'object',
  'embed', 'audio', 'video', 'source', 'track', 'picture', 'link', 'meta', 'base', 'dialog', 'svg', 'math', 'template', 'slot', 'canvas', 'map', 'area', 'marquee', 'nav']
const FORBIDDEN_ATTRIBUTES = ['style', 'srcset', 'ping', 'action', 'formaction', 'autofocus', 'contenteditable', 'tabindex', 'draggable', 'background', 'poster', 'usemap', 'name', 'accesskey']

function markdown(text: string): string {
  return purify.sanitize(markdownIt.render(text), {
    USE_PROFILES: { html: true }, FORBID_TAGS: FORBIDDEN_TAGS, FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    // Ids get a prefix so a heading named "root" or "body" cannot stand in for one of the page's own elements.
    SANITIZE_NAMED_PROPS: true, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: true,
  })
}

const viewer: TextViewer = { highlight, markdown }
window.copilotFileViewers = { ...window.copilotFileViewers, text: viewer }
