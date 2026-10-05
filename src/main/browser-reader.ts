import { randomBytes } from 'node:crypto'
import { dialog, nativeImage } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { browserReadScript } from './browser-read-script.js'
import { CREDENTIAL_PATTERN_SOURCE } from './browser-read-credentials.js'
import { maskScreenshotBitmap } from './browser-screenshot-mask.js'
import type { ScreenshotMaskGeometry } from './browser-screenshot-mask.js'
import { MAX_RESPONSE_BYTES, readableResponse, readableUrl, redactBrowserValue } from './browser-read-privacy.js'

const MAX_RESPONSES = 100
const MAX_BODY_CACHE = 4 * 1024 * 1024
const MAX_FRAMES = 64
type Params = Record<string, any> // CDP's JSON events have domain-specific structures.
interface Frame { id: string; parentId?: string; url: string; name?: string }
interface FrameTree { frame: Frame; childFrames?: FrameTree[] }
interface ResponseRecord {
  id: string; pageId: number; frameId: string; url: string; status: number; mimeType: string; timestamp: string
  state: string; reason?: string; redacted: boolean; truncated: boolean; data?: unknown
}
interface PageReader {
  contents: WebContents; sessions: Map<string, string>; contexts: Map<string, number>; ready: Promise<void> | null
  capture: 'starting' | 'ready' | 'unavailable'
  requests: Map<string, { requestId: string; sessionId?: string; response: ResponseRecord }>
}
export interface BrowserReaderOptions {
  pages: () => WebContents[]
  active: () => number
  select: (id: number) => void
  owner: () => BrowserWindow
  recording: () => boolean
  visible: (id: number) => boolean
  /** Main-process dependency used by isolated fixtures. Never accepted from HTTP. */
  approve?: (description: string) => Promise<boolean>
}

/** A fixed-function broker. The private transport never accepts CDP commands,
 * JavaScript, cookies, storage, headers, fetch URLs or arbitrary file paths. */
export class BrowserReader {
  private readonly readers = new Map<number, PageReader>()
  private readonly responses = new Map<string, ResponseRecord>()
  private sequence = 0
  private busy = false
  private disposed = false

  constructor(private readonly options: BrowserReaderOptions) {}

  add(contents: WebContents): void {
    const page: PageReader = { contents, sessions: new Map(), contexts: new Map(), requests: new Map(), ready: null, capture: 'starting' }
    this.readers.set(contents.id, page)
    contents.debugger.on('detach', () => {
      page.ready = null; page.capture = 'unavailable'; page.sessions.clear(); page.contexts.clear()
      for (const pending of page.requests.values()) { pending.response.state = 'unavailable'; pending.response.reason = 'Debugger disconnected before the body was captured.' }
      page.requests.clear()
    })
    contents.debugger.on('message', (_event, method, params: Params, sessionId) => {
      void this.message(page, method, params, sessionId || undefined).catch(() => {})
    })
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) page.contexts.clear()
    })
    contents.on('did-finish-load', () => { void this.attach(page).catch(() => {}) })
    contents.once('destroyed', () => {
      this.readers.delete(contents.id)
      this.clear(contents.id)
    })
    // Attach before the first request to retain response bodies without replaying it.
    void this.attach(page).catch(() => {})
  }

  private async command(page: PageReader, method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        page.contents.debugger.sendCommand(method, params, sessionId) as Promise<Params>,
        new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(new Error('Browser inspection timed out. Content may not be loaded.')), 10000) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  private async enable(page: PageReader, sessionId?: string): Promise<void> {
    await this.command(page, 'Network.enable', { maxTotalBufferSize: MAX_BODY_CACHE, maxResourceBufferSize: MAX_RESPONSE_BYTES, maxPostDataSize: 0 }, sessionId)
    await this.command(page, 'Page.enable', {}, sessionId)
    await this.command(page, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, sessionId)
  }

  private async attach(page: PageReader): Promise<void> {
    if (this.disposed || page.contents.isDestroyed()) throw new Error('This browser page has closed.')
    if (page.ready) return page.ready
    page.capture = 'starting'
    page.ready = (async () => {
      if (!page.contents.debugger.isAttached()) page.contents.debugger.attach('1.3')
      await this.enable(page)
      page.capture = 'ready'
    })().catch(() => { page.ready = null; page.capture = 'unavailable'; throw new Error('Browser inspection is unavailable. If native DevTools owns the debugger, close DevTools and retry; earlier response bodies may be unavailable.') })
    return page.ready
  }

  private async message(page: PageReader, method: string, params: Params, sessionId?: string): Promise<void> {
    if (this.disposed) return
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
      if (page.sessions.size >= MAX_FRAMES) { await this.command(page, 'Target.detachFromTarget', { sessionId: String(params.sessionId) }); return }
      page.sessions.set(String(params.targetInfo.targetId), String(params.sessionId))
      await this.enable(page, String(params.sessionId)); return
    }
    if (method === 'Target.detachedFromTarget') {
      for (const [frameId, session] of page.sessions) if (session === params.sessionId) { page.sessions.delete(frameId); page.contexts.delete(frameId) }
      return
    }
    if (method === 'Runtime.executionContextsCleared' || method === 'Page.frameNavigated') page.contexts.clear()
    const key = `${sessionId ?? ''}:${String(params.requestId)}`
    if (method === 'Network.responseReceived' && this.options.recording()) {
      const response = params.response as Params
      if (!response || !/^https?:\/\//.test(String(response.url))) return
      const record: ResponseRecord = { id: `b${page.contents.id}-${++this.sequence}`, pageId: page.contents.id,
        frameId: String(params.frameId ?? ''), url: readableUrl(String(response.url)), status: Number(response.status),
        mimeType: String(response.mimeType), timestamp: new Date().toISOString(), state: 'loading', redacted: false, truncated: false }
      this.responses.set(record.id, record)
      if (/^(application\/(?:[\w.-]+\+)?json|text\/json)(?:;|$)/i.test(record.mimeType)) {
        page.requests.set(key, { requestId: String(params.requestId), ...(sessionId ? { sessionId } : {}), response: record })
      } else Object.assign(record, readableResponse('', record.mimeType))
      this.trim()
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const pending = page.requests.get(key)
      page.requests.delete(key)
      if (!pending || !this.responses.has(pending.response.id)) return
      const record = pending.response
      if (method === 'Network.loadingFailed') { record.state = 'unavailable'; record.reason = 'Request failed or was cancelled.'; return }
      if (!this.options.recording()) { record.state = 'unavailable'; record.reason = 'Capture was paused before the response completed.'; return }
      if (Number(params.encodedDataLength) > MAX_RESPONSE_BYTES) { record.state = 'unavailable'; record.reason = 'Response exceeds capture limit.'; record.truncated = true; return }
      // Avoid even retrieving non-JSON bodies (login HTML, scripts, binary attachments).
      if (!/^(application\/(?:[\w.-]+\+)?json|text\/json)(?:;|$)/i.test(record.mimeType)) {
        Object.assign(record, readableResponse('', record.mimeType)); return
      }
      try {
        const body = await this.command(page, 'Network.getResponseBody', { requestId: pending.requestId }, pending.sessionId)
        if (this.disposed || !this.responses.has(record.id)) return
        if (!this.options.recording()) { record.state = 'unavailable'; record.reason = 'Capture was paused before the body was retained.'; return }
        const raw = body.base64Encoded ? Buffer.from(String(body.body), 'base64').toString('utf8') : String(body.body)
        Object.assign(record, readableResponse(raw, record.mimeType))
        this.trim()
      } catch { record.state = 'unavailable'; record.reason = 'Body was not retained by Chromium, was too large, or the debugger disconnected. No request was replayed.' }
    }
  }

  private trim(): void {
    let bytes = 0
    for (const record of this.responses.values()) bytes += JSON.stringify(record).length * 2
    while (this.responses.size > MAX_RESPONSES || bytes > MAX_BODY_CACHE) {
      const id = this.responses.keys().next().value
      if (!id) break
      bytes -= JSON.stringify(this.responses.get(id)).length * 2
      this.responses.delete(id)
      for (const page of this.readers.values()) for (const [key, pending] of page.requests) if (pending.response.id === id) page.requests.delete(key)
    }
  }

  clear(pageId?: number): void {
    for (const [id, record] of this.responses) if (pageId === undefined || record.pageId === pageId) this.responses.delete(id)
    for (const [id, page] of this.readers) if (pageId === undefined || id === pageId) page.requests.clear()
  }

  private page(id?: string): PageReader {
    if (id !== undefined && !/^[1-9]\d*$/.test(id)) throw new Error('Invalid browser page ID.')
    const page = this.readers.get(id === undefined ? this.options.active() : Number(id))
    if (!page || page.contents.isDestroyed() || !this.options.pages().includes(page.contents)) throw new Error('Page is unavailable in this session.')
    return page
  }

  private async frames(page: PageReader): Promise<Frame[]> {
    await this.attach(page)
    const result = await this.command(page, 'Page.getFrameTree')
    const frames: Frame[] = []
    const walk = (tree: FrameTree): void => {
      if (frames.length >= MAX_FRAMES) return
      frames.push(tree.frame)
      for (const child of tree.childFrames ?? []) walk(child)
    }
    if (result.frameTree) walk(result.frameTree as FrameTree)
    // OOPIFs have their own CDP session. Include their frame trees as well.
    for (const session of new Set(page.sessions.values())) {
      try {
        const child = await this.command(page, 'Page.getFrameTree', {}, session)
        const start = frames.length
        if (child.frameTree) walk(child.frameTree as FrameTree)
        for (const frame of frames.slice(start)) page.sessions.set(frame.id, session)
      } catch { /* A child may have navigated or detached while inspecting. */ }
    }
    return [...new Map(frames.map(frame => [frame.id, frame])).values()]
  }

  private async evaluate(page: PageReader, frameId: string, operation: string, args: Params): Promise<any> {
    const sessionId = page.sessions.get(frameId)
    let contextId = page.contexts.get(frameId)
    if (!contextId) {
      const world = await this.command(page, 'Page.createIsolatedWorld', { frameId, worldName: 'desktop-browser-reader', grantUniveralAccess: false }, sessionId)
      contextId = Number(world.executionContextId)
      page.contexts.set(frameId, contextId)
    }
    const result = await this.command(page, 'Runtime.evaluate', {
      expression: `(${browserReadScript.toString()})(${JSON.stringify(operation)},${JSON.stringify({ ...args, deadline: Date.now() + 8000 })},${JSON.stringify(CREDENTIAL_PATTERN_SOURCE)})`,
      contextId, returnByValue: true, awaitPromise: operation === 'mask', userGesture: false,
    }, sessionId)
    if (result.exceptionDetails) throw new Error('Control or snapshot is stale or unavailable. Read the frame again.')
    return result.result?.value
  }

  async read(command: string, args: string[], signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) throw new Error('Browser session has closed.')
    if (this.busy) throw new Error('Another browser inspection or approval is in progress. Retry after it finishes.')
    this.busy = true
    try { return await this.run(command, args, signal) }
    finally { this.busy = false }
  }

  private async run(command: string, args: string[], signal?: AbortSignal): Promise<unknown> {
    if (command === 'tabs') return { tabs: this.options.pages().map(contents => ({ id: contents.id,
      url: readableUrl(contents.getURL()), active: contents.id === this.options.active(), loading: contents.isLoading() })), timestamp: new Date().toISOString() }
    if (command === 'responses') {
      const pageId = args[0] ? this.page(args[0]).contents.id : undefined
      return { recording: this.options.recording(), limit: MAX_RESPONSES, timestamp: new Date().toISOString(),
        capture: [...this.readers].filter(([id]) => pageId === undefined || id === pageId).map(([id, page]) => ({ pageId: id, state: page.capture })),
        responses: [...this.responses.values()].filter(record => pageId === undefined || record.pageId === pageId).map(({ data: _data, ...metadata }) => metadata),
        limitations: ['Only captured JSON is exported. Earlier, cleared, oversized, non-JSON and unretained responses are unavailable; requests are never replayed.'] }
    }
    if (command === 'response') {
      const record = this.responses.get(args[0]!)
      if (!record) return { state: 'unavailable', reason: 'Response not captured, no longer retained, or belongs to another session.' }
      return structuredClone(record)
    }
    const page = this.page(args[0])
    if (command === 'select') { this.options.select(page.contents.id); return { pageId: page.contents.id, state: 'selected' } }
    const frames = await this.frames(page)
    if (command === 'frames') return { pageId: page.contents.id, frames: frames.map(frame => ({ id: frame.id,
      parentId: frame.parentId ?? null, url: readableUrl(frame.url) })), loading: page.contents.isLoading(), timestamp: new Date().toISOString(),
      limit: MAX_FRAMES, truncated: frames.length >= MAX_FRAMES }
    const frameId = args[1] ?? frames[0]?.id
    if (!frameId || !frames.some(frame => frame.id === frameId)) throw new Error('Frame is unavailable in this session page.')
    const metadata = { pageId: page.contents.id, frameId, url: readableUrl(frames.find(frame => frame.id === frameId)!.url),
      loading: page.contents.isLoading(), timestamp: new Date().toISOString() }
    if (command === 'snapshot') {
      const raw = await this.evaluate(page, frameId, 'snapshot', { snapshotId: randomBytes(16).toString('hex'), offset: Number(args[2] ?? 0) }) as Params
      // The text is derived from the same individually filtered DOM text nodes.
      const { text: _text, ...rest } = raw
      const filtered = redactBrowserValue(rest)
      const snapshot = filtered.value as Params
      const dom = Array.isArray(snapshot.dom) ? snapshot.dom as Params[] : []
      return { ...metadata, ...snapshot, state: raw.readyState === 'loading' ? 'loading' : 'available',
        text: dom.filter(node => node.tag === '#text').map(node => node.text).join('\n'),
        offset: Number(raw.offset), nextOffset: raw.nextOffset === null ? null : Number(raw.nextOffset),
        truncated: Boolean(raw.truncated || filtered.truncated), redacted: Boolean(raw.redacted || filtered.redacted) }
    }
    if (command === 'scroll') {
      const amount = Number(args[2])
      if (!Number.isInteger(amount) || Math.abs(amount) > 2000) throw new Error('Scroll amount must be between -2000 and 2000 pixels.')
      return { ...metadata, ...await this.evaluate(page, frameId, 'scroll', { amount, snapshotId: args[3], nodeId: args[4] }) }
    }
    if (command === 'activate') {
      const control = await this.evaluate(page, frameId, 'describe', { snapshotId: args[2], nodeId: args[3] }) as Params
      const filtered = redactBrowserValue(control).value as Params
      const label = String(filtered.name).replace(/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, 200)
      const destination = typeof filtered.href === 'string' ? `\nLink destination: ${readableUrl(filtered.href)}` : ''
      const description = `Activate ${String(filtered.tag)} “${label}” on ${metadata.url}${destination}\n\nThis control runs the web app's code and may change data or navigate. Approve only this specific action. Cancel keeps the page unchanged.`
      if (signal?.aborted || this.disposed) return { ...metadata, state: 'denied', reason: 'The interaction request was cancelled.' }
      const owner = this.options.owner()
      if (owner.isMinimized()) owner.restore()
      if (!owner.isVisible()) owner.show()
      owner.focus()
      if (!owner.isFocused()) owner.flashFrame(true)
      const approved = this.options.approve ? await this.options.approve(description) : (await dialog.showMessageBox(owner, {
        type: 'question', title: 'Approve browser interaction', message: 'The assistant wants to activate a page control.',
        detail: description, buttons: ['Cancel', 'Approve this action'], defaultId: 0, cancelId: 0, noLink: true,
        ...(signal ? { signal } : {}),
      })).response === 1
      if (!approved || signal?.aborted || this.disposed) return { ...metadata, state: 'denied', reason: 'User did not approve the interaction, or the request was cancelled.' }
      return { ...metadata, ...await this.evaluate(page, frameId, 'activate', { snapshotId: args[2], nodeId: args[3] }) }
    }
    if (command === 'screenshot') {
      if (!this.options.visible(page.contents.id)) return { ...metadata, state: 'unavailable',
        reason: 'Select this browser tab and show its Page view before capturing a screenshot. Hidden surfaces may contain stale pixels.' }
      // Screenshot is of the whole page viewport; frame content is masked and can
      // be inspected using its own filtered snapshot. Never capture shell/DevTools.
      const top = frames[0]!.id
      try {
        const mask = await this.evaluate(page, top, 'mask', {}) as Params
        if (mask.truncated) return { ...metadata, state: 'unavailable', reason: 'Page is too large to mask completely for a screenshot.', truncated: true }
        let image
        for (let attempt = 0; attempt < 3; attempt++) {
          try { image = await page.contents.capturePage(undefined, { stayHidden: true, stayAwake: true }); break }
          catch { if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150)) }
        }
        if (!image) return { ...metadata, state: 'unavailable', reason: 'No rendered display surface is available. Show this browser page and retry.' }
        if (image.isEmpty()) return { ...metadata, state: 'unavailable', reason: 'Page has no rendered screenshot yet.' }
        // DOM overlays alone are insufficient: capturePage can return an older
        // compositor frame. Apply the same masks to opaque pixels before export.
        const size = image.getSize(1)
        const bitmap = maskScreenshotBitmap(image.toBitmap({ scaleFactor: 1 }), size, mask as ScreenshotMaskGeometry)
        const masked = nativeImage.createFromBitmap(bitmap, { ...size, scaleFactor: 1 })
        const png = masked.resize({ width: Math.min(1600, size.width) }).toPNG()
        if (png.length > 2 * 1024 * 1024) return { ...metadata, state: 'unavailable', reason: 'Screenshot exceeds the 2 MiB limit.', truncated: true }
        return { ...metadata, frameId: top, state: 'available', mimeType: 'image/png', imageBase64: png.toString('base64'),
          redacted: Boolean(mask.redacted), size: image.getSize(), limitations: ['Form controls, credential-marked elements, embedded frames and canvases are masked. Screenshot covers the rendered viewport only.'] }
      } finally { await this.evaluate(page, top, 'unmask', {}).catch(() => {}) }
    }
    throw new Error('Unknown browser inspection command.')
  }

  dispose(): void {
    this.disposed = true
    this.clear()
    for (const page of this.readers.values()) if (!page.contents.isDestroyed() && page.contents.debugger.isAttached()) page.contents.debugger.detach()
    this.readers.clear()
  }
}
