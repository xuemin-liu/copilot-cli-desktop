/** Fixed code runs in a Chromium isolated world. Callers can only supply data;
 * no expression, selector, attribute dump, storage or credential API is exposed. */
export function browserReadScript(operation: string, args: Record<string, unknown>, credentialPatternSource: string): unknown {
  if (typeof args.deadline === 'number' && Date.now() > args.deadline) throw new Error('Browser operation expired; read the page again.')
  type Reader = { snapshotId: string; nodes: Map<string, Element>; masks: HTMLElement[]; pending: Map<string, string>; cancelPaint?: () => void }
  const scope = globalThis as typeof globalThis & { __desktopReader?: Reader }
  const reader = scope.__desktopReader ??= { snapshotId: '', nodes: new Map(), masks: [], pending: new Map() }
  const hidden = (element: Element): boolean => {
    const style = getComputedStyle(element)
    return style.display === 'none' || style.visibility === 'hidden' || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
  }
  const sensitive = (element: Element): boolean => /password|passwd|credential|secret|token|csrf|xsrf|api[-_]?key|cookie/i.test(
    ['id', 'name', 'autocomplete', 'type', 'data-private'].map(key => element.getAttribute(key) ?? '').join(' ')) || element.hasAttribute('data-private')
  const excluded = (element: Element): boolean => ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'HEAD'].includes(element.tagName)
  const valueControl = (element: Element): boolean => ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.hasAttribute('contenteditable')
  const name = (element: Element): string => (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '').slice(0, 2000)
  const visible = (element: Element): boolean => {
    for (let parent: Element | null = element; parent; parent = parent.parentElement) if (hidden(parent)) return false
    return element.getClientRects().length > 0
  }
  const resolve = (): Element => {
    if (args.snapshotId !== reader.snapshotId) throw new Error('Snapshot is stale; read the frame again.')
    const element = reader.nodes.get(String(args.nodeId))
    if (!element?.isConnected || !visible(element)) throw new Error('Control is unavailable; read the frame again.')
    return element
  }
  if (operation === 'snapshot') {
    reader.snapshotId = String(args.snapshotId)
    reader.nodes.clear()
    reader.pending.clear()
    const nodes: { id: string; parent: string | null; tag: string; role: string | null; name: string; text: string; href?: string; expanded?: string | null; selected?: string | null; checked?: boolean; disabled?: boolean; requiresApproval?: boolean }[] = []
    const text: string[] = []
    const offset = Number(args.offset ?? 0)
    let index = 0
    let bytes = 0
    let nextOffset: number | null = null
    let inspected = 0
    let truncated = false
    let redacted = false
    const emit = (entry: typeof nodes[number]): boolean => {
      const current = index++
      if (current < offset) return true
      const size = JSON.stringify(entry).length
      if (nodes.length >= 500 || bytes + size > 24000) { truncated = true; nextOffset = current; return false }
      bytes += size; nodes.push(entry)
      if (entry.tag === '#text') text.push(entry.text)
      return true
    }
    const walk = (node: Node, parent: string | null, depth: number): void => {
      if (nextOffset !== null) return
      if (++inspected > 20000 || depth > 80) { truncated = true; return }
      if (node.nodeType === Node.TEXT_NODE) {
        const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (!value) return
        const safe = value.length > 8000 ? '[unavailable oversized text]' : value
        if (value.length > 8000) truncated = true
        emit({ id: `text-${index}`, parent, tag: '#text', role: null, name: '', text: safe })
        return
      }
      if (!(node instanceof Element) || excluded(node) || hidden(node)) return
      const id = `n${index}`
      const protectedContent = sensitive(node) || valueControl(node)
      const role = node.getAttribute('role')
      const entry = { id, parent, tag: node.tagName.toLowerCase().slice(0, 80), role: role && /^[a-z ]{1,80}$/.test(role) ? role : null,
        name: protectedContent ? '[redacted form control]' : name(node), text: '' } as typeof nodes[number]
      if (protectedContent) {
        redacted = true; entry.text = '[redacted]'
        if (!sensitive(node) && node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)) entry.checked = node.checked
        emit(entry); return
      }
      reader.nodes.set(id, node)
      const actionable = node.matches('a,button,summary,[role="tab"],[aria-expanded],[role="button"]')
      if (actionable) {
        entry.requiresApproval = true
        entry.expanded = ['true', 'false'].includes(node.getAttribute('aria-expanded') ?? '') ? node.getAttribute('aria-expanded') : null
        entry.selected = ['true', 'false'].includes(node.getAttribute('aria-selected') ?? '') ? node.getAttribute('aria-selected') : null
        entry.disabled = node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true'
      }
      if (node instanceof HTMLAnchorElement) entry.href = node.href.length > 8000 ? '[redacted oversized URL]' : node.href
      if (!emit(entry)) return
      if (node instanceof HTMLIFrameElement) { entry.text = '[frame: use frames and snapshot to inspect separately]'; return }
      if (node instanceof HTMLDetailsElement && !node.open) {
        const summary = Array.from(node.children).find(child => child.tagName === 'SUMMARY')
        if (summary) walk(summary, id, depth + 1)
        return
      }
      for (const child of Array.from(node.childNodes)) walk(child, id, depth + 1)
      if (node.shadowRoot) for (const child of Array.from(node.shadowRoot.childNodes)) walk(child, id, depth + 1)
    }
    if (document.body) walk(document.body, null, 0)
    return { snapshotId: reader.snapshotId, readyState: document.readyState, text: text.join('\n'), dom: nodes,
      truncated, redacted, offset, nextOffset, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      limitations: ['Form values, hidden content, scripts, styles and arbitrary attributes are withheld.', 'Virtualized or collapsed content must be loaded before it can be read. Closed shadow roots are unavailable.'] }
  }
  if (operation === 'scroll') {
    const amount = Number(args.amount)
    if (!Number.isInteger(amount) || Math.abs(amount) > 2000) throw new Error('Scroll amount must be between -2000 and 2000 pixels.')
    const element = args.nodeId ? resolve() : document.scrollingElement
    if (!element) return { state: 'unavailable', reason: 'This frame has no scrolling surface yet.' }
    element.scrollBy({ top: amount, behavior: 'instant' })
    return { scrollX, scrollY, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, state: 'available' }
  }
  if (operation === 'describe' || operation === 'activate') {
    const element = resolve()
    if (!element.matches('a,button,summary,[role="tab"],[aria-expanded],[role="button"]') || sensitive(element) || valueControl(element)) throw new Error('This control is not available for activation.')
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') throw new Error('Control is disabled.')
    if (element.outerHTML.length > 32000) throw new Error('Control is too large to approve safely.')
    if (operation === 'describe') {
      reader.pending.set(String(args.nodeId), element.outerHTML)
      return { name: name(element) || (element.textContent ?? '').slice(0, 1000), tag: element.tagName.toLowerCase(),
        ...(element instanceof HTMLAnchorElement ? { href: element.href.length > 8000 ? '[redacted oversized URL]' : element.href } : {}) }
    }
    if (reader.pending.get(String(args.nodeId)) !== element.outerHTML) throw new Error('Control changed during approval. Read the frame again.')
    // This branch is only called by the main process after a native user approval.
    if (!(element instanceof HTMLElement)) throw new Error('Unsupported control.')
    element.click()
    reader.snapshotId = ''; reader.nodes.clear(); reader.pending.clear()
    return { state: 'activated', requiresNewSnapshot: true }
  }
  if (operation === 'mask' || operation === 'mask-state') {
    const install = operation === 'mask'
    if (install) {
      reader.cancelPaint?.()
      for (const mask of reader.masks) mask.remove()
      reader.masks = []
    }
    const overlays = new Set<Element>(reader.masks)
    const rectangles: { x: number; y: number; width: number; height: number }[] = []
    // Cross-origin frames are deliberately covered; their text is read separately.
    const cover = (element: Element): void => {
      const box = element.getBoundingClientRect()
      if (!box.width || !box.height) return
      rectangles.push({ x: box.x, y: box.y, width: box.width, height: box.height })
      if (!install) return
      const mask = document.createElement('div')
      mask.style.cssText = `position:fixed!important;left:${box.left}px!important;top:${box.top}px!important;width:${box.width}px!important;height:${box.height}px!important;background:#111!important;color:#fff!important;z-index:2147483647!important;pointer-events:none!important;opacity:1!important;`
      mask.textContent = '[redacted]'; document.documentElement.append(mask); reader.masks.push(mask)
    }
    let visited = 0
    let truncated = false
    const credentials = new RegExp(credentialPatternSource, 'i')
    const walk = (root: Document | ShadowRoot): void => {
      for (const element of Array.from(root.querySelectorAll('*'))) {
        if (overlays.has(element)) continue
        if (++visited > 20000) { truncated = true; return }
        const directText = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join(' ')
        const credentialText = credentials.test(directText) || /(?:password|token|secret|api[-_ ]?key|credential|cookie)\s*[:=]/i.test(directText)
        if (sensitive(element) || valueControl(element) || credentialText || element.matches('iframe,object,embed,canvas')) cover(element)
        if (element.shadowRoot) walk(element.shadowRoot)
      }
    }
    walk(document)
    const geometry = { viewport: { width: innerWidth, height: innerHeight }, rectangles, scrollX, scrollY, truncated }
    if (!install) return geometry
    // Current rectangles cannot cover secrets in an older layout. Require a paint
    // before capture, and fail closed if an occluded page cannot confirm it.
    return new Promise(resolve => {
      let settled = false
      let frame = 0
      const finish = (painted: boolean): void => {
        if (settled) return
        settled = true; clearTimeout(timer); cancelAnimationFrame(frame); delete reader.cancelPaint
        resolve({ ...geometry, redacted: reader.masks.length > 0, masks: reader.masks.length, painted })
      }
      const timer = setTimeout(() => finish(false), 500)
      reader.cancelPaint = () => finish(false)
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => finish(true)) })
    })
  }
  if (operation === 'unmask') { reader.cancelPaint?.(); for (const mask of reader.masks) mask.remove(); reader.masks = []; return null }
  throw new Error('Unknown browser read operation.')
}
