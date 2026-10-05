/** Serialized fixed browser operations. Selectors and values are data, never source code. */
export function browserTestScript(operation: string, args: Record<string, any>): Record<string, any> | Promise<Record<string, any>> {
  if (Date.now() > args.deadline) return { error: 'Test operation expired.' }
  if (args.allowedOrigin && location.origin !== args.allowedOrigin) return { error: 'Test input frame is outside the enabled origin.' }
  const visible = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false
    }
    return element.getClientRects().length > 0
  }
  const name = (element: Element): string => {
    const label = element.getAttribute('aria-label')
    if (label) return label.slice(0, 200)
    const labels = (element as HTMLInputElement).labels
    if (labels) return [...labels].map(label => label.innerText).join(' ').slice(0, 200)
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text = ''; let visited = 0
    while (walker.nextNode() && text.length < 200 && ++visited < 1000) {
      let protectedText = false
      for (let parent: Element | null = walker.currentNode.parentElement; parent; parent = parent.parentElement ?? (parent.getRootNode() instanceof ShadowRoot ? (parent.getRootNode() as ShadowRoot).host : null)) {
        if (parent.matches('input,textarea,select,[contenteditable],[data-private]') || !visible(parent)) { protectedText = true; break }
      }
      if (!protectedText) text += walker.currentNode.textContent ?? ''
    }
    return text.trim().slice(0, 200)
  }
  const find = (selector: string): Element[] => {
    const matches: Element[] = []; let visited = 0
    const walk = (root: Document | ShadowRoot): void => {
      matches.push(...root.querySelectorAll(selector))
      if (matches.length > 10000) throw new Error('Too many matches.')
      for (const element of root.querySelectorAll('*')) {
        if (++visited > 30000 || Date.now() > args.deadline) throw new Error('Page inspection limit exceeded.')
        if (element.shadowRoot) walk(element.shadowRoot)
      }
    }
    walk(document)
    return matches.filter(element => !args.text || (element as HTMLElement).innerText?.includes(args.text))
  }
  try {
    if (operation === 'settle') return new Promise(resolve => {
      let done = false; let frame = 0
      const finish = (painted: boolean): void => { if (done) return; done = true; clearTimeout(timer); cancelAnimationFrame(frame); resolve({ painted }) }
      const timer = setTimeout(() => finish(false), 500)
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => finish(true)) })
    })
    if (operation === 'viewport') return { width: innerWidth, height: innerHeight }
    if (operation === 'inspect') {
      const matches = find('input,textarea,select,button,a,summary,[role="button"],[role="tab"],[contenteditable="true"],tr,img,canvas,[data-testid]')
      const targets = matches.filter(visible).slice(0, 200).map(element => ({
        selector: element.id ? `#${CSS.escape(element.id)}` : element.hasAttribute('data-testid') ? `[data-testid=${JSON.stringify(element.getAttribute('data-testid'))}]`
          : element.hasAttribute('name') ? `${element.tagName.toLowerCase()}[name=${JSON.stringify(element.getAttribute('name'))}]` : element.tagName.toLowerCase(),
        tag: element.tagName.toLowerCase(), type: element.getAttribute('type'),
        name: name(element),
        disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      }))
      return { targets, truncated: matches.length > 200 }
    }
    if (operation === 'probe' && args.condition === 'url') return { passed: location.href.includes(args.expected) }
    const matches = find(String(args.selector)).filter(visible)
    if (operation === 'probe') {
      if (args.condition === 'hidden') return { passed: matches.length === 0 }
      if (args.condition === 'count') return { passed: matches.length === args.expected }
      if (matches.length !== 1) return { passed: false, reason: matches.length ? 'Selector matches multiple visible elements.' : 'Expected element is not visible.' }
      const target = matches[0]!
      switch (args.condition) {
        case 'visible': return { passed: true }
        case 'text': return { passed: (target as HTMLElement).innerText?.includes(args.expected) === true }
        case 'value': return { passed: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ? target.value === args.expected : false }
        case 'checked': return { passed: target instanceof HTMLInputElement && /^(checkbox|radio)$/.test(target.type) && target.checked === args.expected }
        case 'imageLoaded': return { passed: target instanceof HTMLImageElement && target.complete && target.naturalWidth > 0 && target.naturalHeight > 0 }
        case 'canvasPainted': {
          if (!(target instanceof HTMLCanvasElement) || !target.width || !target.height) return { passed: false }
          if (target.width * target.height > 4000000) return { passed: false, reason: 'Canvas exceeds the pixel inspection limit.' }
          try {
            const context = target.getContext('2d')
            if (!context) return { passed: false, reason: 'For WebGL, assert the application ready state and inspect a test screenshot.' }
            return { passed: context.getImageData(0, 0, target.width, target.height).data.some(value => value !== 0) }
          } catch { return { passed: false, reason: 'Canvas pixels are unavailable. Assert the application ready state instead.' } }
        }
      }
      return { passed: false }
    }
    if (matches.length !== 1 || !(matches[0] instanceof HTMLElement)) return { error: 'Action needs exactly one visible element; refine the selector or text.' }
    const target = matches[0]
    if (args.reference) {
      const scope = globalThis as typeof globalThis & { __desktopTestTarget?: { token: string; element: Element } }
      const previous = scope.__desktopTestTarget
      if (args.requireReference && (!previous || previous.token !== args.reference)) return { error: 'Target document changed during the action. Inspect the page again.' }
      if (previous && previous.token === args.reference && previous.element !== target) return { error: 'Target was replaced during the action. Inspect the page again.' }
      scope.__desktopTestTarget = { token: args.reference, element: target }
    }
    if (target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true') return { error: 'Target is disabled.' }
    if (operation === 'focused') return (target.getRootNode() as Document | ShadowRoot).activeElement === target
      ? { passed: true } : { error: 'Input focus changed during the action.' }
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = target.getBoundingClientRect(); const x = Math.max(0, rect.left) + Math.min(rect.width, innerWidth - Math.max(0, rect.left)) / 2
    const y = Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2
    const root = target.getRootNode() as Document | ShadowRoot
    const hit = root.elementFromPoint(x, y)
    if (!hit || !(target === hit || target.contains(hit))) return { error: 'Target is covered or outside the viewport.' }
    if (operation === 'target') return { x, y, width: innerWidth, height: innerHeight }
    if (operation === 'scroll') { target.scrollBy({ top: args.pixels, behavior: 'instant' }); return { passed: true } }
    if (operation === 'select') {
      if (!(target instanceof HTMLSelectElement) || target.multiple || ![...target.options].some(option => option.value === args.value && !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled))) return { error: 'Select option is unavailable.' }
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(target, args.value)
      target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }))
      return { passed: true }
    }
    if (operation === 'fill') {
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(target.type)) {
        if (target.readOnly) return { error: 'Field is read-only.' }
      } else if (!target.isContentEditable) return { error: 'Target is not an editable text field.' }
    }
    target.focus()
    if (operation === 'fill' && target.isContentEditable) { const range = document.createRange(); range.selectNodeContents(target); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range) }
    return { passed: true }
  } catch { return { error: 'Invalid selector or page content unavailable within the inspection limit.' } }
}
