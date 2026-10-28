/** Serialized fixed browser operations. Selectors and values are data, never source code. */
export function browserTestScript(operation: string, args: Record<string, any>): Record<string, any> | Promise<Record<string, any>> {
  if (Date.now() > args.deadline) return { error: 'Test operation expired.' }
  if (args.allowedOrigin && location.origin !== args.allowedOrigin) return { error: 'Test input frame is outside the enabled origin.' }
  const parent = (element: Element): Element | null => element.parentElement
    ?? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null)
  const contains = (ancestor: Element, element: Element | null): boolean => {
    for (let node = element; node; node = parent(node)) if (node === ancestor) return true
    return false
  }
  const visible = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false
    }
    return element.getClientRects().length > 0
  }
  const name = (element: Element, depth = 0): string => {
    for (let node: Element | null = element; node; node = parent(node)) if (node.hasAttribute('data-private')) return '[private]'
    const label = element.getAttribute('aria-label')
    if (label) return label.slice(0, 200)
    if (!depth && element.hasAttribute('aria-labelledby')) {
      const root = element.getRootNode() as Document | ShadowRoot
      const labels = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).slice(0, 10)
        .map(id => root.getElementById(id)).filter((label): label is HTMLElement => label instanceof HTMLElement && visible(label))
      if (labels.length) return labels.map(label => name(label, 1)).join(' ').slice(0, 200)
    }
    const labels = (element as HTMLInputElement).labels
    if (labels?.length) return [...labels].map(label => label.innerText).join(' ').slice(0, 200)
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
  const find = (selector: string, filterText = true): Element[] => {
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
    return matches.filter(element => !filterText || !args.text || (element as HTMLElement).innerText?.includes(args.text))
  }
  const scope = globalThis as typeof globalThis & { __desktopTestDiscovery?: { generation: string; nodes: Map<string, Element> } }
  const fromRef = (ref: string): Element => {
    const element = scope.__desktopTestDiscovery?.nodes.get(ref)
    if (!element || !element.isConnected || element.ownerDocument !== document) throw new Error('Target reference is stale, replaced, or belongs to another page, frame, document or discovery generation. Discover targets again.')
    return element
  }
  const metadata = (element: Element | null): Record<string, any> | null => element ? {
    tag: element.localName, id: element.id.slice(0, 120),
    classes: [...element.classList].slice(0, 8).map(value => value.slice(0, 80)), role: element.getAttribute('role')?.slice(0, 80) ?? null,
  } : null
  const hitAt = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y)
    while (hit?.shadowRoot) { const deep = hit.shadowRoot.elementFromPoint(x, y); if (!deep || deep === hit) break; hit = deep }
    return hit
  }
  const disabled = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = parent(node)) if (node.matches(':disabled,[inert]') || node.getAttribute('aria-disabled') === 'true') return true
    return false
  }
  try {
    if (operation === 'invalidate') { delete scope.__desktopTestDiscovery; return { passed: true } }
    if (operation === 'settle') return new Promise(resolve => {
      let done = false; let frame = 0
      const finish = (painted: boolean): void => { if (done) return; done = true; clearTimeout(timer); cancelAnimationFrame(frame); resolve({ painted }) }
      const timer = setTimeout(() => finish(false), 500)
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => finish(true)) })
    })
    if (operation === 'viewport') return { width: innerWidth, height: innerHeight }
    if (operation === 'inspect') {
      const all = find('*')
      const primary = (element: Element): boolean => element.matches('input,textarea,select,button,a,summary,[role],[tabindex],[title],[aria-label],[aria-labelledby],[aria-haspopup],[aria-controls],[onclick],[contenteditable="true"],tr,img,canvas,svg,[data-testid]')
        || typeof (element as HTMLElement).onclick === 'function' || getComputedStyle(element).cursor === 'pointer'
      // Delegated listeners cannot be inferred from DOM metadata. Include leaf
      // div/span candidates too, after explicit controls, so they remain addressable
      // by references without pretending they have a known click behavior.
      const explicit = all.filter(primary)
      const explicitSet = new Set(explicit)
      const candidates = [...explicit, ...all.filter(element => !explicitSet.has(element) && element.matches('div,span') && !element.children.length)]
      const matches = candidates.filter(visible).filter(element => {
        if (element.localName !== 'svg') return true
        // Decorative icons should not consume slots already used by their control.
        for (let node = parent(element); node; node = parent(node)) {
          if (node.matches('button,a,summary,[role="button"],[role="tab"],svg')) return false
        }
        return true
      })
      const generation = String(args.generation)
      const nodes = new Map<string, Element>()
      const targets = matches.slice(0, 200).map((element, index) => {
        const ref = `${generation}-t${index + 1}`; nodes.set(ref, element)
        const rect = element.getBoundingClientRect()
        const x = Math.max(0, rect.left) + Math.min(rect.width, innerWidth - Math.max(0, rect.left)) / 2
        const y = Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2
        const hit = hitAt(x, y)
        const reason = disabled(element) ? 'disabled' : rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight ? 'offscreen'
          : !contains(element, hit) ? 'covered at inspected point' : null
        const selector = element.id ? `#${CSS.escape(element.id)}` : element.hasAttribute('data-testid') ? `[data-testid=${JSON.stringify(element.getAttribute('data-testid'))}]`
          : element.hasAttribute('name') ? `${element.tagName.toLowerCase()}[name=${JSON.stringify(element.getAttribute('name'))}]` : element.tagName.toLowerCase()
        return {
        ref, selectorUnique: find(selector, false).filter(visible).length === 1, reason, hit: metadata(hit),
        selector: element.id ? `#${CSS.escape(element.id)}` : element.hasAttribute('data-testid') ? `[data-testid=${JSON.stringify(element.getAttribute('data-testid'))}]`
          : element.hasAttribute('name') ? `${element.tagName.toLowerCase()}[name=${JSON.stringify(element.getAttribute('name'))}]` : element.tagName.toLowerCase(),
        tag: element.tagName.toLowerCase(), type: element.getAttribute('type'),
        name: name(element),
        title: element.getAttribute('title')?.slice(0, 200) ?? null, role: element.getAttribute('role')
          ?? ({ button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', summary: 'button' } as Record<string, string>)[element.localName] ?? null,
        expanded: element.getAttribute('aria-expanded'), selected: element.getAttribute('aria-selected'),
        bounds: (() => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })(),
        disabled: disabled(element),
      } })
      scope.__desktopTestDiscovery = { generation, nodes }
      return { generation, targets, unavailable: candidates.filter(element => !visible(element)).slice(0, 50).map(element => ({ ...metadata(element), reason: 'hidden by styles, an ancestor, aria-hidden, or no rendered box' })),
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, timestamp: new Date().toISOString(), truncated: matches.length > 200,
        limitations: ['References are valid only in this page/frame/document and latest discovery generation. Coverage is sampled at the visible center; every input point is hit-tested again.'] }
    }
    if (operation === 'probe' && args.condition === 'url') return { passed: location.href.includes(args.expected) }
    const found = args.targetRef ? [fromRef(String(args.targetRef))] : find(String(args.selector))
    const matches = found.filter(visible)
    if (operation === 'probe') {
      if (args.condition === 'hidden') return { passed: matches.length === 0 }
      if (args.condition === 'count') return { passed: matches.length === args.expected }
      if (matches.length !== 1) return { passed: false, reason: matches.length ? 'Selector matches multiple visible elements.' : 'Expected element is not visible.' }
      const target = matches[0]!
      switch (args.condition) {
        case 'visible': return { passed: true }
        case 'enabled': return { passed: !disabled(target), reason: disabled(target) ? 'Control is disabled or inert.' : undefined }
        case 'attribute': return { passed: target.getAttribute(args.attribute) === args.expected }
        case 'numericValue': {
          const value = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement ? target.value : (target as HTMLElement).innerText
          return { passed: Boolean(value?.trim()) && Number.isFinite(Number(value)) && Math.abs(Number(value) - args.expected) <= (args.tolerance ?? 0) }
        }
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
    const dragging = args.action === 'drag'
    const pointer = ['drag', 'click', 'doubleClick', 'hover'].includes(args.action)
    const coordinate = dragging || Boolean(args.point)
    if (matches.length !== 1 || (!pointer && !(matches[0] instanceof HTMLElement))) return { error: `Action needs exactly one visible element; ${matches.length > 1 ? 'selector is ambiguous' : found.length ? 'target is hidden' : 'no matching target exists'}. Refine the selector or discover a reference.` }
    const target = matches[0]!
    const inputs = coordinate && args.inputRef ? [fromRef(String(args.inputRef))].filter(visible) : coordinate && args.inputSelector ? find(String(args.inputSelector), false).filter(visible) : [target]
    if (inputs.length !== 1) return { error: 'Drag inputSelector needs exactly one visible element; refine the selector.' }
    const input = inputs[0]!
    if (coordinate && input !== target && contains(input, target)) return { error: 'Drag/pointer input surface must not be an ancestor of the target. Select the actual input surface.' }
    if (args.reference) {
      const scope = globalThis as typeof globalThis & { __desktopTestTarget?: { token: string; element: Element; input: Element } }
      const previous = scope.__desktopTestTarget
      if (args.requireReference && (!previous || previous.token !== args.reference)) return { error: 'Target document changed during the action. Inspect the page again.' }
      if (previous && previous.token === args.reference && previous.element !== target) return { error: 'Target was replaced during the action. Inspect the page again.' }
      if (previous && previous.token === args.reference && previous.input !== input) return { error: 'Drag input surface was replaced during the action. Inspect the page again.' }
      scope.__desktopTestTarget = { token: args.reference, element: target, input }
    }
    if ([target, input].some(disabled)) return { error: 'Target is disabled or inert.' }
    if (operation === 'focused') return (target.getRootNode() as Document | ShadowRoot).activeElement === target
      ? { passed: true } : { error: 'Input focus changed during the action.' }
    const pointAt = (rect: DOMRect): { x: number; y: number } => ({
      x: args.offset ? rect.left + args.offset.x : Math.max(0, rect.left) + Math.min(rect.width, innerWidth - Math.max(0, rect.left)) / 2,
      y: args.offset ? rect.top + args.offset.y : Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2,
    })
    let rect = target.getBoundingClientRect()
    let { x, y } = pointAt(rect)
    let hit = hitAt(x, y)
    const pointVisible = coordinate && args.offset && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && contains(input, hit)
    // A viewport point may still be clipped by a scroll panel. Nearest scrolling
    // exposes it without centering an oversized canvas that is already onscreen.
    if (args.scroll !== false && !pointVisible) {
      target.scrollIntoView({ block: coordinate ? 'nearest' : 'center', inline: coordinate ? 'nearest' : 'center', behavior: 'instant' })
      rect = target.getBoundingClientRect(); ({ x, y } = pointAt(rect)); hit = hitAt(x, y)
    }
    const failPoint = (error: string): Record<string, any> => ({ error:
      `${dragging ? 'Drag' : 'Pointer'} ${args.dragPoint ?? 'point'} at viewport (${x}, ${y}): ${error} Hit element: ${JSON.stringify(metadata(hit))}.` })
    if (args.offset && (![args.offset.x, args.offset.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      || args.offset.x >= rect.width || args.offset.y >= rect.height)) return failPoint('Drag point is outside the target bounds.')
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return failPoint('Target is outside the viewport.')
    if (!contains(input, hit)) return failPoint('Target is covered or outside the viewport.')
    const inputRect = input.getBoundingClientRect()
    if (operation === 'target') return { x, y, width: innerWidth, height: innerHeight, hit: metadata(hit), devicePixelRatio,
      targetLeft: rect.left, targetTop: rect.top, targetWidth: rect.width, targetHeight: rect.height,
      inputLeft: inputRect.left, inputTop: inputRect.top, inputWidth: inputRect.width, inputHeight: inputRect.height }
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
      } else if (!(target instanceof HTMLElement) || !target.isContentEditable) return { error: 'Target is not an editable text field.' }
    }
    if (!(target instanceof HTMLElement)) return { error: 'Target is not an HTML control.' }
    target.focus()
    if (operation === 'fill' && target.isContentEditable) { const range = document.createRange(); range.selectNodeContents(target); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range) }
    return { passed: true }
  } catch (error) { return { error: error instanceof Error && /^(Target reference|Too many matches|Page inspection)/.test(error.message) ? error.message : 'Invalid selector or page content unavailable within the inspection limit.' } }
}
