import { randomBytes } from 'node:crypto'
import { dialog, nativeImage } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { browserReadScript } from './browser-read-script.js'
import { CREDENTIAL_PATTERN_SOURCE } from './browser-read-credentials.js'
import { maskScreenshotBitmap, sameScreenshotLayout } from './browser-screenshot-mask.js'
import type { ScreenshotMaskGeometry, ScreenshotLayout } from './browser-screenshot-mask.js'
import { MAX_RESPONSE_BYTES, readableResponse, readableUrl, redactBrowserValue } from './browser-read-privacy.js'
import { browserTestScript } from './browser-test-script.js'
import { validateBrowserTestPlan } from './browser-test-plan.js'
import type { BrowserTestState, BrowserTestStep } from './browser-test-plan.js'
import { runBrowserTest, type TestObservation } from './browser-test-runner.js'

const MAX_RESPONSES = 100
const MAX_BODY_CACHE = 4 * 1024 * 1024
const MAX_FRAMES = 64
type Params = Record<string, any> // CDP's JSON events have domain-specific structures.
async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  let abort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Test stopped.'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}
interface Frame { id: string; parentId?: string; url: string; name?: string; securityOrigin?: string }
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
  private testPageId: number | null = null
  private testOrigin: string | null = null
  private testBlocked = false
  private testAbort: AbortController | null = null
  private testProgress: Omit<BrowserTestState, 'enabled'> = { running: false, step: 0, total: 0, label: '', report: null }

  constructor(private readonly options: BrowserReaderOptions) {}

  get testState(): BrowserTestState { return structuredClone({ enabled: this.testPageId === this.options.active(), ...this.testProgress }) }

  setTesting(enabled: boolean): void {
    const origin = enabled ? this.httpOrigin(this.page().contents.getURL()) : null
    if (enabled && !origin) throw new Error('Open an HTTP or HTTPS page before enabling Testing mode.')
    this.testAbort?.abort()
    this.testPageId = enabled ? this.options.active() : null
    this.testOrigin = origin
    this.testBlocked = false
  }

  private httpOrigin(url: string): string | null {
    try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.origin : null } catch { return null }
  }

  private checkTestOrigin(url: string): void {
    if (!this.testOrigin || this.httpOrigin(url) !== this.testOrigin) throw new Error('Test destination is outside the enabled origin. Stop testing, open that site yourself and enable Testing mode there.')
  }

  async test(value: unknown, signal: AbortSignal): Promise<unknown> {
    const plan = validateBrowserTestPlan(value)
    const page = this.page()
    if (this.testPageId !== page.contents.id) throw new Error('Enable Testing mode in the selected browser page first.')
    this.checkTestOrigin(page.contents.getURL())
    const origin = this.testOrigin!
    if (this.busy) throw new Error('Another browser inspection or test is in progress.')
    this.testBlocked = false
    this.busy = true
    this.testAbort = new AbortController()
    // Keep the last completed report so polling cannot resize the viewport when
    // a new run starts. The running-step indicator describes the current test.
    this.testProgress = { running: true, step: 0, total: plan.steps.length, label: '', report: this.testProgress.report }
    const active = (): boolean => !this.disposed && !page.contents.isDestroyed() && this.options.active() === page.contents.id && this.testPageId === page.contents.id
    try {
      const report = await runBrowserTest(plan, page.contents.id, { active,
        execute: (step, stop) => this.testStep(page, step, stop),
        progress: (step, total, label) => { Object.assign(this.testProgress, { step, total, label }) },
      }, AbortSignal.any([signal, this.testAbort.signal]))
      report.origin = origin
      const { screenshots: _screenshots, ...summary } = report
      this.testProgress.report = summary
      return report
    } finally { this.busy = false; this.testProgress.running = false; this.testAbort = null }
  }

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
    // Main-page navigation must obey the origin grant. Embedded pages may load
    // other origins; the separate frame and focus guards still reject their input.
    const restrictNavigation = (event: { preventDefault: () => void; isMainFrame: boolean }, url: string): void => {
      if (!event.isMainFrame || !this.testAbort || this.testPageId !== contents.id || this.httpOrigin(url) === this.testOrigin) return
      event.preventDefault(); this.testBlocked = true
    }
    contents.on('will-frame-navigate', event => restrictNavigation(event, event.url))
    contents.on('will-redirect', (event, url) => restrictNavigation(event, url))
    contents.on('did-navigate', (_event, url) => {
      if (this.testPageId === contents.id && this.httpOrigin(url) !== this.testOrigin) this.setTesting(false)
    })
    contents.on('did-finish-load', () => { void this.attach(page).catch(() => {}) })
    contents.once('destroyed', () => {
      this.readers.delete(contents.id)
      this.clear(contents.id)
    })
    // Attach before the first request to retain response bodies without replaying it.
    void this.attach(page).catch(() => {})
  }

  private async command(page: PageReader, method: string, params: Params = {}, sessionId?: string, timeoutMs = 10000, signal?: AbortSignal): Promise<Params> {
    if (signal?.aborted) throw new Error('Test stopped.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await abortable(Promise.race([
        page.contents.debugger.sendCommand(method, params, sessionId) as Promise<Params>,
        new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(new Error('Browser inspection timed out. Content may not be loaded.')), timeoutMs) }),
      ]), signal)
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

  private async frames(page: PageReader, signal?: AbortSignal): Promise<Frame[]> {
    await abortable(this.attach(page), signal)
    const result = await this.command(page, 'Page.getFrameTree', {}, undefined, 10000, signal)
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
        const child = await this.command(page, 'Page.getFrameTree', {}, session, 10000, signal)
        const start = frames.length
        if (child.frameTree) walk(child.frameTree as FrameTree)
        for (const frame of frames.slice(start)) page.sessions.set(frame.id, session)
      } catch (error) { if (signal?.aborted) throw error /* A child may have navigated or detached. */ }
    }
    return [...new Map(frames.map(frame => [frame.id, frame])).values()]
  }

  private async evaluate(page: PageReader, frameId: string, operation: string, args: Params, testing = false, signal?: AbortSignal): Promise<any> {
    const sessionId = page.sessions.get(frameId)
    let contextId = page.contexts.get(frameId)
    if (!contextId) {
      const world = await this.command(page, 'Page.createIsolatedWorld', { frameId, worldName: 'desktop-browser-reader', grantUniveralAccess: false }, sessionId, 10000, signal)
      contextId = Number(world.executionContextId)
      page.contexts.set(frameId, contextId)
    }
    const result = await this.command(page, 'Runtime.evaluate', {
      expression: `(${(testing ? browserTestScript : browserReadScript).toString()})(${JSON.stringify(operation)},${JSON.stringify({ ...args, deadline: Date.now() + 8000 })},${JSON.stringify(CREDENTIAL_PATTERN_SOURCE)})`,
      contextId, returnByValue: true, awaitPromise: operation === 'mask' || testing && operation === 'settle', userGesture: false,
    }, sessionId, operation === 'mask' || testing && operation === 'settle' ? 1500 : 10000, signal)
    if (result.exceptionDetails) throw new Error('Control or snapshot is stale or unavailable. Read the frame again.')
    return result.result?.value
  }

  private async testStep(page: PageReader, step: BrowserTestStep, signal: AbortSignal): Promise<TestObservation> {
    const check = (): void => {
      if (signal.aborted || this.disposed || page.contents.isDestroyed() || this.options.active() !== page.contents.id || this.testPageId !== page.contents.id) throw new Error('Test stopped or the selected page changed.')
      if (step.action === 'drag' && (!this.options.visible(page.contents.id) || this.options.owner().isDestroyed()
        || this.options.owner().isMinimized() || !this.options.owner().isVisible())) throw new Error('Show the selected page to run test interactions.')
      if (this.testBlocked) throw new Error('Test navigation outside the enabled origin was blocked.')
      this.checkTestOrigin(page.contents.getURL())
    }
    check()
    if (step.action === 'navigate') {
      this.checkTestOrigin(step.url!)
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { if (!page.contents.isDestroyed()) page.contents.stop(); reject(new Error('Test navigation stopped.')) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        else void page.contents.loadURL(step.url!).then(resolve, () => reject(new Error('Test navigation failed.')))
          .finally(() => signal.removeEventListener('abort', abort))
      })
      check(); return { passed: true }
    }
    if (step.action === 'screenshot') {
      const image = await this.run('screenshot', [String(page.contents.id)], signal, true) as Params
      check()
      return image.state === 'available' ? { passed: true, screenshot: { step: 0, imageBase64: image.imageBase64, redacted: Boolean(image.redacted) } }
        : { passed: false, reason: String(image.reason ?? 'Screenshot is unavailable.') }
    }
    const frames = await this.frames(page, signal)
    check()
    const frame = frames.find(frame => frame.id === (step.frame ?? frames[0]?.id))
    if (!frame) throw new Error('Frame is unavailable in the selected page.')
    const interaction = !['waitFor', 'assert'].includes(step.action)
    if (interaction && (frame.securityOrigin !== this.testOrigin || this.httpOrigin(frame.url) !== this.testOrigin)) throw new Error('Test input frame is outside the enabled origin.')
    let reference: string | undefined
    const evaluate = async (operation: string, args: Params = {}): Promise<Params> => {
      check()
      const result = await this.evaluate(page, frame.id, operation, { ...step, reference, requireReference: reference !== undefined,
        ...(interaction ? { allowedOrigin: this.testOrigin } : {}), ...args }, true, signal) as Params
      check()
      if (result?.error) throw new Error(String(result.error))
      return result
    }
    if (step.action === 'waitFor' || step.action === 'assert') {
      try { const result = await evaluate('probe'); return { passed: Boolean(result.passed), ...(result.reason ? { reason: String(result.reason) } : {}) } }
      catch (error) { check(); if (page.contents.isLoading()) return { passed: false, reason: 'Page is still loading.' }; throw error }
    }
    if (!this.options.visible(page.contents.id) || this.options.owner().isMinimized() || !this.options.owner().isVisible()) throw new Error('Show the selected page to run test interactions.')
    reference = randomBytes(16).toString('hex')
    let prepared = false
    const targetPoint = async (requireFocus = false, offset?: { x: number; y: number }, scroll = true): Promise<Params> => {
      const point = await evaluate('target', { selector: step.selector ?? 'html', requireReference: prepared, offset, scroll })
      prepared = true
      let current = frame
      // Check every embedding frame for overlays. Coordinates from each frame's
      // own viewport are mapped into its parent, including out-of-process frames.
      while (current.parentId) {
        const parent = frames.find(frame => frame.id === current.parentId)
        if (!parent) throw new Error('Frame parent is unavailable.')
        const session = page.sessions.get(parent.id)
        check()
        const owner = await this.command(page, 'DOM.getFrameOwner', { frameId: current.id }, session, 10000, signal)
        await this.evaluate(page, parent.id, 'viewport', {}, true, signal)
        const node = await this.command(page, 'DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: page.contexts.get(parent.id) }, session, 10000, signal)
        const objectId = node.object?.objectId
        if (!objectId) throw new Error('Frame position is unavailable.')
        try {
          const mapped = await this.command(page, 'Runtime.callFunctionOn', { objectId, returnByValue: true,
            functionDeclaration: `function(rx,ry,focused) {
              const win = this.ownerDocument.defaultView;
              if(focused&&this.getRootNode().activeElement!==this) return {error:'Input focus changed during the action.'};
              for (let el=this; el; el=el.parentElement) {
                const style=win.getComputedStyle(el);
                if(style.display==='none'||style.visibility==='hidden') return {error:'Embedding frame is hidden.'};
                if(style.transform!=='none') { const m=new win.DOMMatrixReadOnly(style.transform); if(!m.is2D||m.b||m.c||m.a<=0||m.d<=0) return {error:'Rotated or skewed frames cannot receive test input.'}; }
              }
              const r=this.getBoundingClientRect();
              const x=r.left+(this.clientLeft+rx*this.clientWidth)*r.width/this.offsetWidth;
              const y=r.top+(this.clientTop+ry*this.clientHeight)*r.height/this.offsetHeight;
              const hit=this.getRootNode().elementFromPoint(x,y);
              if(hit!==this&&!this.contains(hit)) return {error:'Embedding frame is covered or outside the viewport.'};
              return {x,y,width:win.innerWidth,height:win.innerHeight};
            }`, arguments: [{ value: Number(point.x) / Number(point.width) }, { value: Number(point.y) / Number(point.height) }, { value: requireFocus }],
          }, session, 10000, signal)
          if (mapped.exceptionDetails || !mapped.result?.value) throw new Error('Frame position is unavailable.')
          if (mapped.result.value.error) throw new Error(String(mapped.result.value.error))
          Object.assign(point, mapped.result.value)
        } finally { await this.command(page, 'Runtime.releaseObject', { objectId }, session, 1000).catch(() => {}) }
        current = parent
      }
      check()
      return point
    }
    if (step.action === 'drag') {
      const path = step.path!
      // Scroll once, then freeze geometry: moving/replaced/covered surfaces must
      // never redirect a held pointer into a different control or document.
      let start = await targetPoint(false, path[0])
      const stableUntil = Date.now() + 2000
      while (true) {
        check()
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y }, undefined, 10000, signal)
        if (!(await evaluate('settle')).painted) throw new Error('Page is not painting. Show the page and retry the test.')
        const fresh = await targetPoint(false, path[0], false)
        if (Math.abs(fresh.x - start.x) < 0.5 && Math.abs(fresh.y - start.y) < 0.5) { start = fresh; break }
        if (Date.now() >= stableUntil) throw new Error('Target did not stabilize before the drag.')
        start = fresh
      }
      const geometry = ['width', 'height', 'targetLeft', 'targetTop', 'targetWidth', 'targetHeight']
      const mapped: Params[] = []
      const stable = (point: Params): void => {
        if (geometry.some(key => Math.abs(Number(point[key]) - Number(start[key])) >= 0.5)) throw new Error('Target geometry changed during the drag.')
      }
      for (const offset of path) { const point = await targetPoint(false, offset, false); stable(point); mapped.push(point) }
      let last = start; let completed = false; let pressed = false
      try {
        check()
        const freshStart = await targetPoint(false, path[0], false); stable(freshStart)
        if (Math.abs(freshStart.x - start.x) >= 0.5 || Math.abs(freshStart.y - start.y) >= 0.5) throw new Error('Frame position changed before the drag.')
        pressed = true
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: start.x, y: start.y }, undefined, 10000, signal)
        const segmentMs = (step.durationMs ?? 500) / (path.length - 1)
        const samples = Math.max(1, Math.ceil(segmentMs / 16))
        for (let segment = 1; segment < path.length; segment++) for (let sample = 1; sample <= samples; sample++) {
          await abortable(new Promise<void>(resolve => setTimeout(resolve, segmentMs / samples)), signal)
          check()
          const fraction = sample / samples
          const offset = { x: path[segment - 1]!.x + (path[segment]!.x - path[segment - 1]!.x) * fraction,
            y: path[segment - 1]!.y + (path[segment]!.y - path[segment - 1]!.y) * fraction }
          const point = await targetPoint(false, offset, false); stable(point)
          if (Math.abs(point.x - (mapped[segment - 1]!.x + (mapped[segment]!.x - mapped[segment - 1]!.x) * fraction)) >= 0.5
            || Math.abs(point.y - (mapped[segment - 1]!.y + (mapped[segment]!.y - mapped[segment - 1]!.y) * fraction)) >= 0.5) throw new Error('Frame position changed during the drag.')
          check()
          await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: point.x, y: point.y }, undefined, 10000, signal)
          last = point
        }
        check(); completed = true
      } finally {
        if (pressed && !page.contents.isDestroyed()) {
          const stopped = !completed || signal.aborted || this.disposed || this.options.active() !== page.contents.id || this.testPageId !== page.contents.id
          const release = this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1,
            x: stopped ? -1 : last.x, y: stopped ? -1 : last.y }, undefined, 1000)
          if (stopped) await release.catch(() => {})
          else await release
        }
      }
      check(); return { passed: true }
    }
    let point = await targetPoint()
    if (step.action === 'scroll') return { passed: Boolean((await evaluate('scroll', { selector: step.selector ?? 'html' })).passed) }
    if (step.action === 'select') return { passed: Boolean((await evaluate('select')).passed) }
    if (step.action === 'fill' || step.action === 'press') {
      await evaluate(step.action)
      const key = async (name: string, code: number, text = '', modifiers = 0): Promise<void> => {
        check()
        await targetPoint(true)
        await evaluate('focused')
        try { await this.command(page, 'Input.dispatchKeyEvent', { type: 'keyDown', key: name, windowsVirtualKeyCode: code, text, modifiers }, undefined, 10000, signal) }
        finally {
          if (!page.contents.isDestroyed()) {
            const release = this.command(page, 'Input.dispatchKeyEvent', { type: 'keyUp', key: name, windowsVirtualKeyCode: code, modifiers }, undefined, 1000)
            if (signal.aborted || this.disposed || this.options.active() !== page.contents.id || this.testPageId !== page.contents.id) await release.catch(() => {})
            else await release
          }
        }
      }
      if (step.action === 'fill') {
        await key('a', 65, '', 2); await key('Backspace', 8)
        check(); await targetPoint(true); await evaluate('focused')
        if (step.value) await this.command(page, 'Input.insertText', { text: step.value }, undefined, 10000, signal)
      } else {
        const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Space: 32, Backspace: 8, Delete: 46,
          ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 }
        await key(step.key === 'Space' ? ' ' : step.key!, codes[step.key!]!, step.key === 'Enter' ? '\r' : step.key === 'Space' ? ' ' : '')
      }
      check(); return { passed: true }
    }
    check()
    if (![point.x, point.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 20000)) throw new Error('Target is outside the viewport.')
    const stableUntil = Date.now() + 2000
    while (true) {
      check()
      await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, undefined, 10000, signal)
      if (!(await evaluate('settle')).painted) throw new Error('Page is not painting. Show the page and retry the test.')
      const fresh = await targetPoint()
      if (Math.abs(fresh.x - point.x) < 0.5 && Math.abs(fresh.y - point.y) < 0.5) { point = fresh; break }
      if (Date.now() >= stableUntil) throw new Error('Target did not stabilize after pointer movement.')
      point = fresh
    }
    if (step.action === 'hover') { check(); return { passed: true } }
    for (let count = 1; count <= (step.action === 'doubleClick' ? 2 : 1); count++) {
      if (count === 2) {
        const fresh = await targetPoint()
        if (Math.abs(fresh.x - point.x) >= 0.5 || Math.abs(fresh.y - point.y) >= 0.5) throw new Error('Target moved during the double-click.')
      }
      check()
      try { await this.command(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: count, x: point.x, y: point.y }, undefined, 10000, signal) }
      finally {
        const stopped = signal.aborted || this.disposed || this.options.active() !== page.contents.id || this.testPageId !== page.contents.id
        if (!page.contents.isDestroyed()) {
          const release = this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: count,
            x: stopped ? -1 : point.x, y: stopped ? -1 : point.y }, undefined, 1000)
          if (stopped) await release.catch(() => {})
          else await release
        }
      }
    }
    check(); return { passed: true }
  }

  async read(command: string, args: string[], signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) throw new Error('Browser session has closed.')
    if (this.busy) throw new Error('Another browser inspection or approval is in progress. Retry after it finishes.')
    this.busy = true
    try { return await this.run(command, args, signal) }
    finally { this.busy = false }
  }

  private async run(command: string, args: string[], signal?: AbortSignal, testScreenshot = false): Promise<unknown> {
    if (command === 'test-targets') {
      const page = this.page()
      if (this.testPageId !== page.contents.id) throw new Error('Enable Testing mode before inspecting test targets.')
      const frames = await this.frames(page, signal)
      const frame = frames.find(frame => frame.id === (args[0] ?? frames[0]?.id))
      if (!frame) throw new Error('Test frame is unavailable.')
      const result = await this.evaluate(page, frame.id, 'inspect', {}, true, signal) as Params
      if (result.error) throw new Error(String(result.error))
      return { pageId: page.contents.id, frameId: frame.id, ...redactBrowserValue(result).value as Params }
    }
    if (command === 'tabs') return { tabs: this.options.pages().map(contents => ({ id: contents.id,
      url: readableUrl(contents.getURL()), active: contents.id === this.options.active(), loading: contents.isLoading() })), timestamp: new Date().toISOString() }
    if (command === 'responses') {
      const pageId = this.page(args[0]).contents.id
      return { recording: this.options.recording(), limit: MAX_RESPONSES, timestamp: new Date().toISOString(),
        capture: [...this.readers].filter(([id]) => id === pageId).map(([id, page]) => ({ pageId: id, state: page.capture })),
        responses: [...this.responses.values()].filter(record => record.pageId === pageId).map(({ data: _data, ...metadata }) => metadata),
        limitations: ['Only captured JSON is exported. Earlier, cleared, oversized, non-JSON and unretained responses are unavailable; requests are never replayed.'] }
    }
    if (command === 'response') {
      const record = this.responses.get(args[0]!)
      if (!record) return { state: 'unavailable', reason: 'Response not captured, no longer retained, or belongs to another session.' }
      return structuredClone(record)
    }
    const page = this.page(args[0])
    if (command === 'select') { this.options.select(page.contents.id); return { pageId: page.contents.id, state: 'selected' } }
    const frames = await this.frames(page, signal)
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
      const owner = this.options.owner()
      if (owner.isMinimized() || !owner.isVisible()) return { ...metadata, state: 'unavailable',
        reason: 'Restore and show this browser window before capturing a screenshot.' }
      if (!this.options.visible(page.contents.id)) return { ...metadata, state: 'unavailable',
        reason: 'Select this browser tab and show its Page view before capturing a screenshot. Hidden surfaces may contain stale pixels.' }
      // Screenshot is of the whole page viewport; frame content is masked and can
      // be inspected using its own filtered snapshot. Never capture shell/DevTools.
      const top = frames[0]!.id
      try {
        let mask: Params
        try { mask = await this.evaluate(page, top, 'mask', { includeCanvas: testScreenshot }) as Params }
        catch { return { ...metadata, state: 'unavailable', reason: 'Could not confirm the page is painting safely. Restore and show the window and retry.' } }
        if (mask.truncated) return { ...metadata, state: 'unavailable', reason: 'Page is too large to mask completely for a screenshot.', truncated: true }
        if (!mask.painted) return { ...metadata, state: 'unavailable', reason: 'The page is not painting. Restore and show the window and retry.' }
        const unchanged = async (): Promise<boolean> => sameScreenshotLayout(mask as ScreenshotLayout,
          await this.evaluate(page, top, 'mask-state', { includeCanvas: testScreenshot }) as ScreenshotLayout)
        if (!await unchanged()) return { ...metadata, state: 'unavailable', reason: 'Page layout changed while preparing screenshot masks. Wait for it to settle and retry.' }
        let image
        for (let attempt = 0; attempt < 3; attempt++) {
          try { image = await page.contents.capturePage(undefined, { stayHidden: true, stayAwake: true }); break }
          catch { if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150)) }
        }
        if (!image) return { ...metadata, state: 'unavailable', reason: 'No rendered display surface is available. Show this browser page and retry.' }
        if (image.isEmpty()) return { ...metadata, state: 'unavailable', reason: 'Page has no rendered screenshot yet.' }
        if (!await unchanged()) return { ...metadata, state: 'unavailable', reason: 'Page layout changed during screenshot capture. Wait for it to settle and retry.' }
        // Paint confirmation and stable geometry are required as well as opaque
        // pixel masks: a mask for the current layout cannot protect an old frame.
        const size = image.getSize(1)
        const bitmap = maskScreenshotBitmap(image.toBitmap({ scaleFactor: 1 }), size, mask as ScreenshotMaskGeometry)
        const masked = nativeImage.createFromBitmap(bitmap, { ...size, scaleFactor: 1 })
        const png = masked.resize({ width: Math.min(1600, size.width) }).toPNG()
        if (png.length > 2 * 1024 * 1024) return { ...metadata, state: 'unavailable', reason: 'Screenshot exceeds the 2 MiB limit.', truncated: true }
        return { ...metadata, frameId: top, state: 'available', mimeType: 'image/png', imageBase64: png.toString('base64'),
          redacted: Boolean(mask.redacted), size: image.getSize(), limitations: [testScreenshot
            ? 'Form controls, credential-marked elements and embedded frames are masked. Canvas pixels are included for the authorized test. Screenshot covers the viewport only.'
            : 'Form controls, credential-marked elements, embedded frames and canvases are masked. Screenshot covers the rendered viewport only.'] }
      } finally { await this.evaluate(page, top, 'unmask', {}).catch(() => {}) }
    }
    throw new Error('Unknown browser inspection command.')
  }

  dispose(): void {
    this.setTesting(false)
    this.disposed = true
    this.clear()
    for (const page of this.readers.values()) if (!page.contents.isDestroyed() && page.contents.debugger.isAttached()) page.contents.debugger.detach()
    this.readers.clear()
  }
}
