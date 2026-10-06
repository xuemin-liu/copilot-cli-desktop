/** Runs in a Chromium isolated world with `this` set to the element the user clicked.
 * Returns a bounded description: no values of form controls, no scripts or styles,
 * and no attributes outside a fixed allow-list. The caller filters it again. */
export function browserPickScript(this: Element, credentialPatternSource: string): unknown {
  const target = this
  const credentials = new RegExp(credentialPatternSource, 'gi')
  const clean = (value: string, max: number): string => {
    const text = value.replace(/\s+/g, ' ').trim()
    if (text.length > 8192) return '[unavailable oversized text]'
    return text.replace(credentials, '[redacted]').slice(0, max)
  }
  const sensitive = (element: Element): boolean => /password|passwd|credential|secret|token|csrf|xsrf|api[-_]?key|cookie/i.test(
    ['id', 'name', 'autocomplete', 'type', 'data-private'].map(key => element.getAttribute(key) ?? '').join(' ')) || element.hasAttribute('data-private')
  const valueControl = (element: Element): boolean => ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.hasAttribute('contenteditable')
  const excluded = (element: Element): boolean => ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'HEAD'].includes(element.tagName)
  const identifier = /^[A-Za-z_][\w-]{0,60}$/
  const label = (element: Element): string => {
    const id = element.getAttribute('id') ?? ''
    const classes = Array.from(element.classList).filter(name => identifier.test(name)).slice(0, 3)
    return `${element.tagName.toLowerCase()}${id && identifier.test(id) && !sensitive(element) ? `#${id}` : ''}${classes.map(name => `.${name}`).join('')}`
  }

  const protectedControl = sensitive(target) || valueControl(target)
  const attributes: Record<string, string> = {}
  const allowed = protectedControl
    ? ['type', 'placeholder', 'aria-label', 'role']
    : ['id', 'class', 'role', 'aria-label', 'data-testid', 'data-test', 'data-cy', 'href', 'src', 'alt', 'title', 'type', 'name', 'placeholder', 'for', 'disabled']
  for (const name of allowed) {
    const value = target.getAttribute(name)
    if (value === null || sensitive(target) && ['id', 'name', 'type'].includes(name)) continue
    // URLs are made safe by the main process; the raw attribute is never resolved or fetched here.
    attributes[name] = (name === 'href' || name === 'src') && value.length > 8000 ? '[redacted oversized URL]' : clean(value, name === 'href' || name === 'src' ? 2000 : 200)
  }

  // Text comes only from text nodes that are not inside hidden, script-like or form-value content.
  let text = ''
  if (!protectedControl) {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let inspected = 0
    for (let node = walker.nextNode(); node && text.length < 600 && ++inspected < 2000; node = walker.nextNode()) {
      let skip = false
      for (let parent = node.parentElement; parent; parent = parent === target ? null : parent.parentElement) {
        if (excluded(parent) || sensitive(parent) || valueControl(parent)) { skip = true; break }
      }
      if (!skip) text += ` ${node.textContent ?? ''}`
    }
  }

  const path: string[] = []
  for (let parent = target.parentElement; parent && path.length < 5; parent = parent.parentElement) path.unshift(label(parent))

  // A short CSS path that identifies the element, preferring a unique id.
  const segments: string[] = []
  let unique = false
  for (let element: Element | null = target; element && segments.length < 8; element = element.parentElement) {
    const id = element.getAttribute('id') ?? ''
    if (id && identifier.test(id) && !sensitive(element) && document.querySelectorAll(`#${id}`).length === 1) { segments.unshift(`#${id}`); break }
    let segment = element.tagName.toLowerCase()
    if (element !== document.documentElement && element !== document.body) {
      const classes = Array.from(element.classList).filter(name => identifier.test(name)).slice(0, 2)
      segment += classes.map(name => `.${name}`).join('')
      const parent = element.parentElement
      if (parent && Array.from(parent.children).filter(child => child.tagName === element!.tagName).length > 1) {
        segment += `:nth-of-type(${Array.from(parent.children).filter(child => child.tagName === element!.tagName).indexOf(element) + 1})`
      }
    }
    segments.unshift(segment)
    if (element === document.body) break
  }
  const selector = segments.join(' > ')
  try { unique = document.querySelectorAll(selector).length === 1 } catch { unique = false }

  const box = target.getBoundingClientRect()
  const style = getComputedStyle(target)
  return {
    tag: target.tagName.toLowerCase(), label: label(target), selector: sensitive(target) ? target.tagName.toLowerCase() : selector, unique,
    page: location.href, protectedControl, attributes, text: protectedControl ? '[redacted form control]' : clean(text, 300), path,
    box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    styles: { display: style.display, position: style.position, color: style.color, background: style.backgroundColor,
      fontSize: style.fontSize, fontWeight: style.fontWeight },
  }
}
