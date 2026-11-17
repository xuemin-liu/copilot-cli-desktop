import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { dialog, nativeImage } from 'electron'
import type { BaseWindow, WebContents } from 'electron'
import { browserReadScript } from './browser-read-script.js'
import { CREDENTIAL_PATTERN_SOURCE } from './browser-read-credentials.js'
import { maskAndCrop, sameScreenshotLayout, type Rectangle } from './browser-screenshot-mask.js'
import type { ScreenshotMaskGeometry, ScreenshotLayout } from './browser-screenshot-mask.js'
import { MAX_RESPONSE_BYTES, capturableBody, readableResponse, readableUrl, redactBrowserValue } from './browser-read-privacy.js'
import { browserTestScript } from './browser-test-script.js'
import { browserPickScript } from './browser-pick-script.js'
import { formatPickedElement } from './browser-pick-format.js'
import { validateBrowserTestPlan } from './browser-test-plan.js'
import type { BrowserTestState, BrowserTestStep, TestDelivery } from './browser-test-plan.js'
import { BrowserTestNetwork } from './browser-test-network.js'
import { redactTestEvidence, runBrowserTest, type TestObservation } from './browser-test-runner.js'
import { TestConsoleWatch, type ConsoleSource } from './browser-test-console.js'
import { testKey, type KeyInfo } from './browser-test-keys.js'
import { sanitizedText } from './browser-privacy.js'

const MAX_RESPONSES = 100
const MAX_BODY_CACHE = 4 * 1024 * 1024
const MAX_FRAMES = 64
const MAX_MULTI_PICKS = 10
const PICK_IDLE_MS = 120_000
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
/** A JavaScript dialog (alert, confirm, prompt, beforeunload) that is holding the page until someone answers it. */
export interface PendingDialog { type: string; message: string; sessionId?: string }
interface DialogRule { spec?: NonNullable<BrowserTestStep['dialog']>; handled: { type: string; message: string; accepted: boolean } | null }
interface PageReader {
  testNetwork: BrowserTestNetwork | null
  dialog: PendingDialog | null; dialogRule: DialogRule | null
  /** Set while a test drag intercepts HTML5 drag-and-drop, so no OS drag follows the real cursor. */
  dragIntercepted: ((data: Params) => void) | null
  contents: WebContents; sessions: Map<string, string>; contexts: Map<string, number>; ready: Promise<void> | null
  capture: 'starting' | 'ready' | 'unavailable'
  requests: Map<string, { requestId: string; sessionId?: string; resourceType: string; response: ResponseRecord }>
}
export interface BrowserCursor {
  active(): number
  select(id: number): void
  validate(): void
}
export interface BrowserReaderOptions {
  pages: () => WebContents[]
  active: () => number
  select: (id: number) => void
  /** The window that shows a page: its own popup window, or the one the browser is in. */
  owner: (pageId: number) => BaseWindow
  recording: () => boolean
  visible: (id: number) => boolean
  /** Main-process dependency used by isolated fixtures. Never accepted from HTTP. */
  approve?: (description: string) => Promise<boolean>
  /** Console evidence for a run; `after` is the console sequence number when the run started. */
  evidence?: (pageId: number, startedAt: string, after?: number) => Record<string, unknown>
  /** The browser's console stream, for per-step slices, the error latch and consoleMessage. */
  console?: ConsoleSource
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
  private testUnexpectedDialog: string | null = null
  private testAbort: AbortController | null = null
  private testDelivery: TestDelivery = 'not-attempted'
  private testConsole: TestConsoleWatch | null = null
  private testInputUncertain = false
  private testDiagnostics: Params = {}
  private picker: { pageId: number; choose: (backendNodeId: number | null) => void; next: () => Promise<number | null> } | null = null
  private pickAbort: AbortController | null = null
  private testProgress: Omit<BrowserTestState, 'enabled'> = { running: false, step: 0, total: 0, label: '', report: null }

  private readonly closeGuards = new Map<number, { confirm(): Promise<boolean>; cancelled(): void; failed(error: unknown): void }>()
  async closePage(id: number, confirm: () => Promise<boolean>): Promise<boolean> {
    const page = this.page(String(id))
    // A never-navigated WebContents has no renderer document to enable CDP on or edits to guard.
    if (!page.contents.getURL() && !page.contents.isLoading()) {
      return new Promise<boolean>(resolve => {
        page.contents.once('destroyed', () => resolve(true))
        page.contents.close({ waitForBeforeUnload: false })
      })
    }
    await this.attach(page)
    return new Promise<boolean>((resolve, reject) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return; settled = true
        this.closeGuards.delete(id); page.contents.off('destroyed', destroyed); resolve(value)
      }
      const destroyed = (): void => finish(true)
      const failed = (error: unknown): void => { if (settled) return; settled = true; this.closeGuards.delete(id); page.contents.off('destroyed', destroyed); reject(error) }
      this.closeGuards.set(id, { confirm, cancelled: () => finish(false), failed })
      page.contents.once('destroyed', destroyed)
      void this.command(page, 'Page.close').catch(error => {
        if (page.contents.isDestroyed()) finish(true)
        else failed(error)
      })
    })
  }
  private readonly cursor = new AsyncLocalStorage<BrowserCursor>()
  withCursor<T>(cursor: BrowserCursor, action: () => T): T { return this.cursor.run(cursor, action) }
  private activeId(): number { this.cursor.getStore()?.validate(); return this.cursor.getStore()?.active() ?? this.options.active() }
  private selectId(id: number): void { const cursor = this.cursor.getStore(); if (cursor) { cursor.validate(); cursor.select(id) } else this.options.select(id) }
  constructor(private readonly options: BrowserReaderOptions) {}

  get testState(): BrowserTestState {
    const id = this.activeId(), page = this.readers.get(id)
    const enabled = Boolean(page && !page.contents.isDestroyed() && this.options.visible(id) && this.httpOrigin(page.contents.getURL()))
    return structuredClone({ enabled, ...this.testProgress })
  }

  stopTest(): void {
    this.testAbort?.abort()
    this.testPageId = null
    this.testOrigin = null
    this.testBlocked = false
  }

  private httpOrigin(url: string): string | null {
    try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.origin : null } catch { return null }
  }

  private checkTestOrigin(url: string): void {
    if (!this.testOrigin || this.httpOrigin(url) !== this.testOrigin) throw new Error('Test destination is outside this run’s origin. Open the intended site and start a new test there.')
  }

  async test(value: unknown, signal: AbortSignal): Promise<unknown> {
    const plan = validateBrowserTestPlan(value)
    const page = this.page()
    const origin = this.httpOrigin(page.contents.getURL())
    if (!origin) throw new Error('Open an HTTP or HTTPS page before starting a test.')
    if (!this.options.visible(page.contents.id)) throw new Error('Show the selected browser page before starting a test.')
    if (this.busy) throw new Error('Another browser inspection or test is in progress.')
    this.testPageId = page.contents.id
    this.testOrigin = origin
    this.testBlocked = false
    this.testUnexpectedDialog = null
    this.busy = true
    this.testAbort = new AbortController()
    // Keep the last completed report so polling cannot resize the viewport when
    // a new run starts. The running-step indicator describes the current test.
    this.testProgress = { running: true, step: 0, total: plan.steps.length, label: '', report: this.testProgress.report, lastCompletedAction: this.testProgress.lastCompletedAction ?? null }
    const active = (): boolean => !this.disposed && !page.contents.isDestroyed() && this.activeId() === page.contents.id && this.testPageId === page.contents.id
    let executionStarted = false
    try {
      const frames = await this.frames(page, this.testAbort.signal)
      page.testNetwork = new BrowserTestNetwork(plan.networkFailures ?? [], origin,
        new Set(frames.filter(frame => this.httpOrigin(frame.url) === origin).map(frame => frame.id)),
        (method, params, session) => this.command(page, method, params, session, 3000), () => active() && !signal.aborted && !this.testAbort?.signal.aborted)
      await page.testNetwork.start()
      executionStarted = true
      const consoleStart = this.options.console?.mark()
      this.testConsole = this.options.console ? new TestConsoleWatch(plan, page.contents.id, this.options.console) : null
      const report = await runBrowserTest(plan, page.contents.id, { active,
        ...(this.testConsole ? { console: this.testConsole } : {}),
        execute: (step, stop) => this.testStep(page, step, stop),
        progress: (step, total, label) => { Object.assign(this.testProgress, { step, total, label }) },
        checkpoint: (report, currentAction) => {
          const { screenshots: _screenshots, ...summary } = report
          this.testProgress.journal = structuredClone(summary)
          this.testProgress.runId = report.runId!
          this.testProgress.currentAction = currentAction
          const completed = report.steps.findLast(step => step.outcome === 'delivered' || step.delivery === 'delivered')
          if (completed) this.testProgress.lastCompletedAction = structuredClone(completed)
        },
      }, AbortSignal.any([signal, this.testAbort.signal]))
      report.origin = origin
      report.testingEnabled = this.testState.enabled
      await page.testNetwork.stop()
      // If the transport cannot remove interception, detaching Chromium's
      // debugger removes Fetch interception rather than leaving a live rule.
      if (page.testNetwork.evidence().failureRulesRemoved === false && !page.contents.isDestroyed() && page.contents.debugger.isAttached()) page.contents.debugger.detach()
      report.evidence = redactTestEvidence(plan, { network: page.testNetwork.evidence(), ...this.options.evidence?.(page.contents.id, report.startedAt, consoleStart),
        ...(plan.failOnConsoleError ? { consoleErrors: { failOnConsoleError: true, ignorePatterns: plan.consoleErrorIgnore?.length ?? 0,
          observed: 'every console message of the test page, including same-origin frames, while the run is open, recorded or not. Messages arrive asynchronously and are attributed to the step during which they arrive; workers and messages after the last step are not observed.' } } : {}),
        visibilityRequired: true, screenshotRegionComparison: 'unsupported; screenshots require separate visual inspection' }) as Params
      const { screenshots: _screenshots, ...summary } = report
      this.testProgress.report = summary
      this.testProgress.journal = summary
      return report
    } catch (error) {
      // A helper keeps its reserved report only when a step can have run; a request rejected before
      // the run began leaves no evidence, so it must not look like an interrupted run.
      if (executionStarted && typeof error === 'object' && error !== null) {
        Object.assign(error, { executionStarted: true, ...(this.testProgress.runId ? { runId: this.testProgress.runId } : {}) })
      }
      throw error
    } finally {
      await page.testNetwork?.stop()
      if (page.testNetwork?.evidence().failureRulesRemoved === false && !page.contents.isDestroyed() && page.contents.debugger.isAttached()) page.contents.debugger.detach()
      page.testNetwork = null
      this.testConsole?.dispose(); this.testConsole = null
      this.busy = false; this.testProgress.running = false; this.testProgress.currentAction = null; this.testAbort = null
      this.testPageId = null; this.testOrigin = null
    }
  }

  add(contents: WebContents): void {
    const page: PageReader = { testNetwork: null, dialog: null, dialogRule: null, dragIntercepted: null, contents, sessions: new Map(), contexts: new Map(), requests: new Map(), ready: null, capture: 'starting' }
    this.readers.set(contents.id, page)
    contents.debugger.on('detach', () => {
      page.testNetwork?.detached()
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
      if (this.testPageId === contents.id && this.httpOrigin(url) !== this.testOrigin) this.stopTest()
    })
    contents.on('did-finish-load', () => { void this.attach(page).catch(() => {}) })
    contents.once('destroyed', () => {
      this.readers.delete(contents.id)
      this.clear(contents.id)
    })
    // Attach before the first request to retain response bodies without replaying it.
    void this.attach(page).catch(() => {})
  }

  /** Resolves once a page's capture is enabled; rejects when it cannot be. */
  async capturing(contents: WebContents): Promise<void> {
    const page = this.readers.get(contents.id)
    if (!page) throw new Error('Page is unavailable in this session.')
    await this.attach(page)
  }

  private async command(page: PageReader, method: string, params: Params = {}, sessionId?: string, timeoutMs = 10000, signal?: AbortSignal): Promise<Params> {
    this.cursor.getStore()?.validate()
    if (signal?.aborted) throw new Error('Test stopped.')
    const delivery = Boolean(this.testProgress.currentAction && this.testAbort && (method.startsWith('Input.') && method !== 'Input.setInterceptDrags' || method === 'Page.reload' || method === 'Page.navigate'))
    if (delivery) {
      this.testDelivery = 'uncertain'
      if (this.testProgress.currentAction) this.testProgress.currentAction.delivery = 'uncertain'
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await abortable(Promise.race([
        page.contents.debugger.sendCommand(method, params, sessionId) as Promise<Params>,
        new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(new Error('Browser inspection timed out. Content may not be loaded.')), timeoutMs) }),
      ]), signal)
      if (delivery) {
        this.testDelivery = this.testInputUncertain ? 'uncertain' : 'partial'
        if (this.testProgress.currentAction) this.testProgress.currentAction.delivery = this.testDelivery
      }
      this.cursor.getStore()?.validate()
      return result
    } catch (error) { if (delivery) this.testInputUncertain = true; throw error }
    finally { if (timer) clearTimeout(timer) }
  }

  // Sent together, in order: a page with no document yet answers none of them until its first load starts, and
  // Page.enable must already be queued then, or a dialog that page opens while loading bypasses the pane and the page hangs.
  private async enable(page: PageReader, sessionId?: string): Promise<void> {
    await Promise.all([
      this.command(page, 'Network.enable', { maxTotalBufferSize: MAX_BODY_CACHE, maxResourceBufferSize: MAX_RESPONSE_BYTES, maxPostDataSize: 0 }, sessionId),
      this.command(page, 'Page.enable', {}, sessionId),
      this.command(page, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, sessionId),
    ])
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
    await page.testNetwork?.message(method, params, sessionId)
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
      if (page.sessions.size >= MAX_FRAMES) { await this.command(page, 'Target.detachFromTarget', { sessionId: String(params.sessionId) }); return }
      page.sessions.set(String(params.targetInfo.targetId), String(params.sessionId))
      await this.enable(page, String(params.sessionId)); return
    }
    if (method === 'Target.detachedFromTarget') {
      for (const [frameId, session] of page.sessions) if (session === params.sessionId) { page.sessions.delete(frameId); page.contexts.delete(frameId) }
      return
    }
    if (method === 'Overlay.inspectNodeRequested' && !sessionId && this.picker?.pageId === page.contents.id) {
      this.picker.choose(Number.isInteger(params.backendNodeId) ? Number(params.backendNodeId) : null); return
    }
    // Chromium reports Esc in its inspect overlay this way, and the keystroke never reaches the page.
    if (method === 'Overlay.inspectModeCanceled' && !sessionId && this.picker?.pageId === page.contents.id) { this.picker.choose(null); return }
    if (method === 'Input.dragIntercepted') { if (params.data) page.dragIntercepted?.(params.data as Params); return }
    if (method === 'Page.javascriptDialogOpening') { await this.dialogOpened(page, params, sessionId); return }
    if (method === 'Page.javascriptDialogClosed') { if (page.dialog?.sessionId === sessionId) page.dialog = null; return }
    if (method === 'Runtime.executionContextsCleared' || method === 'Page.frameNavigated') page.contexts.clear()
    const key = `${sessionId ?? ''}:${String(params.requestId)}`
    if (method === 'Network.responseReceived' && this.options.recording()) {
      const response = params.response as Params
      if (!response || !/^https?:\/\//.test(String(response.url))) return
      const record: ResponseRecord = { id: `b${page.contents.id}-${++this.sequence}`, pageId: page.contents.id,
        frameId: String(params.frameId ?? ''), url: readableUrl(String(response.url)), status: Number(response.status),
        mimeType: String(response.mimeType), timestamp: new Date().toISOString(), state: 'loading', redacted: false, truncated: false }
      this.responses.set(record.id, record)
      const resourceType = String(params.type ?? '')
      if (capturableBody(record.mimeType, resourceType)) {
        page.requests.set(key, { requestId: String(params.requestId), ...(sessionId ? { sessionId } : {}), resourceType, response: record })
      } else Object.assign(record, readableResponse('', record.mimeType, resourceType))
      this.trim()
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const pending = page.requests.get(key)
      page.requests.delete(key)
      if (!pending || !this.responses.has(pending.response.id)) return
      const record = pending.response
      if (method === 'Network.loadingFailed') { record.state = 'unavailable'; record.reason = 'Request failed or was cancelled.'; return }
      if (!this.options.recording()) { record.state = 'unavailable'; record.reason = 'Capture was paused before the response completed.'; return }
      if (Number(params.encodedDataLength) > MAX_RESPONSE_BYTES) { record.state = 'unavailable'; record.reason = 'Response exceeds capture limit.'; record.truncated = true; return }
      // Avoid even retrieving other bodies (login HTML, page scripts, binary attachments).
      if (!capturableBody(record.mimeType, pending.resourceType)) {
        Object.assign(record, readableResponse('', record.mimeType, pending.resourceType)); return
      }
      try {
        const body = await this.command(page, 'Network.getResponseBody', { requestId: pending.requestId }, pending.sessionId)
        if (this.disposed || !this.responses.has(record.id)) return
        if (!this.options.recording()) { record.state = 'unavailable'; record.reason = 'Capture was paused before the body was retained.'; return }
        const raw = body.base64Encoded ? Buffer.from(String(body.body), 'base64').toString('utf8') : String(body.body)
        Object.assign(record, readableResponse(raw, record.mimeType, pending.resourceType))
        this.trim()
      } catch { record.state = 'unavailable'; record.reason = 'Body was not retained by Chromium, was too large, or the debugger disconnected. No request was replayed.' }
    }
  }

  /** While a test runs, a dialog is answered by the step that expected it, or dismissed and reported. Otherwise it waits for the user. */
  private async dialogOpened(page: PageReader, params: Params, sessionId?: string): Promise<void> {
    const type = String(params.type ?? 'alert')
    const raw = String(params.message ?? '')
    const message = sanitizedText(raw).slice(0, 500)
    const close = type === 'beforeunload' ? this.closeGuards.get(page.contents.id) : undefined
    if (close) {
      try {
      const accept = await close.confirm().catch(() => false)
      if (page.contents.isDestroyed()) return
      await this.command(page, 'Page.handleJavaScriptDialog', { accept }, sessionId)
      if (!accept) {
        // The renderer must finish cancelling before another close can be sent.
        await this.command(page, 'Runtime.evaluate', { expression: 'void 0', returnByValue: true }, sessionId)
        close.cancelled()
      }
      } catch (error) { close.failed(error) }
      return
    }
    const testing = this.testAbort !== null && this.testPageId === page.contents.id
    const rule = page.dialogRule
    if (!testing && !rule) {
      page.dialog = { type, message, ...(sessionId ? { sessionId } : {}) }
      return
    }
    const spec = rule?.spec
    const matches = Boolean(spec && (!spec.message || raw.includes(spec.message)))
    if (!spec) this.testUnexpectedDialog = `The page opened a ${type} dialog (“${message}”) that no step expected, so it was dismissed. Add a dialog field to the step that triggers it.`
    else if (!matches) this.testUnexpectedDialog = `The page opened a ${type} dialog (“${message}”) whose text does not contain the expected message, so it was dismissed.`
    const accept = Boolean(spec && matches && spec.accept)
    if (rule && spec && matches) rule.handled = { type, message, accepted: accept }
    await this.command(page, 'Page.handleJavaScriptDialog', { accept }, sessionId)
  }

  /** The selected page when a dialog holds it, else another page a dialog holds: no waiting dialog stays out of sight. */
  private dialogPage(): PageReader | undefined {
    const active = this.readers.get(this.activeId())
    if (active?.dialog) return active
    const pages = this.options.pages()
    return [...this.readers.values()].find(page => page.dialog && pages.includes(page.contents))
  }

  /** The dialog waiting for the user, and the page it holds. */
  get pendingDialog(): { type: string; message: string; pageId: number } | null {
    const page = this.dialogPage()
    return page?.dialog ? { type: page.dialog.type, message: page.dialog.message, pageId: page.contents.id } : null
  }

  async answerDialog(accept: boolean): Promise<void> {
    const page = this.dialogPage() ?? this.page()
    const dialog = page.dialog
    if (!dialog) throw new Error('No page dialog is waiting.')
    page.dialog = null
    await this.command(page, 'Page.handleJavaScriptDialog', { accept }, dialog.sessionId)
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
    const page = this.readers.get(id === undefined ? this.activeId() : Number(id))
    if (!page || page.contents.isDestroyed() || !this.options.pages().includes(page.contents)) throw new Error('Page is unavailable in this session.')
    return page
  }

  private assertNoDialog(page: PageReader): void {
    if (page.dialog) throw new Error(`A page dialog is waiting for the user: ${page.dialog.type} “${page.dialog.message}”. Ask them to answer it in the browser pane, then retry.`)
  }

  private async frames(page: PageReader, signal?: AbortSignal): Promise<Frame[]> {
    this.assertNoDialog(page)
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

  private async isolatedContext(page: PageReader, frameId: string, signal?: AbortSignal): Promise<number> {
    let contextId = page.contexts.get(frameId)
    if (!contextId) {
      const world = await this.command(page, 'Page.createIsolatedWorld', { frameId, worldName: 'desktop-browser-reader', grantUniveralAccess: false }, page.sessions.get(frameId), 10000, signal)
      contextId = Number(world.executionContextId)
      page.contexts.set(frameId, contextId)
    }
    return contextId
  }

  private async evaluate(page: PageReader, frameId: string, operation: string, args: Params, testing = false, signal?: AbortSignal): Promise<any> {
    this.assertNoDialog(page)
    const sessionId = page.sessions.get(frameId)
    const contextId = await this.isolatedContext(page, frameId, signal)
    const result = await this.command(page, 'Runtime.evaluate', {
      expression: `(${(testing ? browserTestScript : browserReadScript).toString()})(${JSON.stringify(operation)},${JSON.stringify({ ...args, deadline: Date.now() + 8000 })},${JSON.stringify(CREDENTIAL_PATTERN_SOURCE)})`,
      contextId, returnByValue: true, awaitPromise: operation === 'mask' || testing && operation === 'settle', userGesture: false,
    }, sessionId, operation === 'mask' || testing && operation === 'settle' ? 1500 : 10000, signal)
    if (result.exceptionDetails) throw new Error('Control or snapshot is stale or unavailable. Read the frame again.')
    return result.result?.value
  }

  private async testStep(page: PageReader, step: BrowserTestStep, signal: AbortSignal): Promise<TestObservation> {
    this.testDelivery = 'not-attempted'; this.testInputUncertain = false; this.testDiagnostics = {}
    const rule: DialogRule = { ...(step.dialog ? { spec: step.dialog } : {}), handled: null }
    page.dialogRule = rule
    const held: { key: string; code: number; bit: number }[] = []
    const modifiers = { Alt: { key: 'Alt', code: 18, bit: 1 }, Control: { key: 'Control', code: 17, bit: 2 }, Meta: { key: 'Meta', code: 91, bit: 4 }, Shift: { key: 'Shift', code: 16, bit: 8 } }
    try {
      if (step.modifiers?.length && (!this.options.visible(page.contents.id) || this.options.owner(page.contents.id).isMinimized() || !this.options.owner(page.contents.id).isVisible())) throw new Error('Show the selected page to run test interactions.')
      for (const modifier of step.modifiers ?? []) {
        const key = modifiers[modifier]; held.push(key)
        await this.command(page, 'Input.dispatchKeyEvent', { type: 'keyDown', key: key.key, windowsVirtualKeyCode: key.code, modifiers: held.reduce((mask, key) => mask | key.bit, 0) }, undefined, 10000, signal)
      }
      const result = await this.testStepAction(page, step, signal)
      if (step.dialog && !rule.handled && !this.testUnexpectedDialog) {
        // The dialog may open a moment after the action, from a timer or a promise.
        const end = Date.now() + 1500
        while (!rule.handled && !this.testUnexpectedDialog && Date.now() < end && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (this.testUnexpectedDialog) throw new Error(this.testUnexpectedDialog)
      if (step.dialog && !rule.handled) throw new Error('The step was expected to open a page dialog, but none opened within 1.5 seconds.')
      const observation = ['assert', 'waitFor', 'discover', 'screenshot'].includes(step.action)
      const output = { ...result, delivery: observation ? 'not-attempted' as const : result.passed ? 'delivered' as const : this.testDelivery,
        data: { ...this.testDiagnostics, ...result.data } }
      return rule.handled ? { ...output, detail: [result.detail, `${rule.handled.type} dialog “${rule.handled.message}” was ${rule.handled.accepted ? 'accepted' : 'dismissed'}.`].filter(Boolean).join(' ') } : output
    } catch (error) {
      throw Object.assign(new Error(this.testUnexpectedDialog ?? (error instanceof Error ? error.message : 'Test step failed.')), { delivery: this.testDelivery, data: this.testDiagnostics })
    } finally {
      let cleanupFailed = false
      while (held.length) {
        const key = held.pop()!
        if (!page.contents.isDestroyed()) await this.command(page, 'Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, windowsVirtualKeyCode: key.code, modifiers: held.reduce((mask, key) => mask | key.bit, 0) }, undefined, 1000).catch(() => { cleanupFailed = true })
      }
      page.dialogRule = null
      if (cleanupFailed) throw Object.assign(new Error('Modifier release could not be confirmed; input delivery is uncertain. Inspect the journal before retrying.'), { delivery: 'uncertain', data: this.testDiagnostics })
    }
  }

  private async testStepAction(page: PageReader, step: BrowserTestStep, signal: AbortSignal, conditionKey = 'c1'): Promise<TestObservation> {
    const modifiers = (step.modifiers ?? []).reduce((mask, key) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[key]), 0)
    const button = step.button ?? 'left'
    const buttons = { left: 1, middle: 4, right: 2 }[button]
    const check = (): void => {
      if (this.testUnexpectedDialog) throw new Error(this.testUnexpectedDialog)
      if (signal.aborted || this.disposed || page.contents.isDestroyed() || this.activeId() !== page.contents.id || this.testPageId !== page.contents.id) throw new Error('Test stopped or the selected page changed.')
      if (!['assert', 'waitFor', 'discover'].includes(step.action) && (!this.options.visible(page.contents.id) || this.options.owner(page.contents.id).isDestroyed()
        || this.options.owner(page.contents.id).isMinimized() || !this.options.owner(page.contents.id).isVisible())) throw new Error('Show the selected page to run test interactions.')
      if (this.testBlocked) throw new Error('Test navigation outside the enabled origin was blocked.')
      this.checkTestOrigin(page.contents.getURL())
    }
    check()
    if (['waitFor', 'assert'].includes(step.action) && step.all) {
      const results: { passed: boolean; reason?: string }[] = []
      for (const [index, condition] of step.all.entries()) results.push(await this.testStepAction(page, { action: step.action, label: step.label, ...condition }, signal, `c${index + 1}`))
      return { passed: results.every(result => result.passed), reason: results.find(result => !result.passed)?.reason ?? 'Combined readiness conditions are not all satisfied.', data: { conditions: results.map(result => ({ passed: result.passed, reason: result.reason })) } }
    }
    if (['waitFor', 'assert'].includes(step.action) && step.condition === 'consoleMessage') return {
      passed: this.testConsole?.matched(String(step.expected), step.level) ?? false, reason: `No ${step.level ? `${step.level} ` : ''}console message from this run matches the pattern.` }
    if (['waitFor', 'assert'].includes(step.action) && step.condition === 'requestComplete') return {
      passed: page.testNetwork?.completed(step.request!) ?? false, reason: 'No matching request from this run has completed with the expected state/status.' }
    if (step.action === 'reload') {
      Object.assign(this.testDiagnostics, { navigation: 'pending', loading: page.contents.isLoading(), testingEnabled: this.testState.enabled,
        applicationReadiness: step.all ? 'waiting' : 'not requested' })
      const before = await this.frames(page, signal)
      for (const frame of before) {
        try { await this.evaluate(page, frame.id, 'invalidate', {}, true, signal) }
        catch (error) { if (signal.aborted || frame.id === before[0]?.id) throw error /* An unavailable child cannot retain usable references. */ }
      }
      let loaded = false; let failed = false
      const complete = (): void => { loaded = true }
      const failure = (_event: unknown, code: number, _description: string, _url: string, main: boolean): void => { if (main && code !== -3) failed = true }
      page.contents.on('did-finish-load', complete)
      page.contents.on('did-fail-load', failure)
      const end = Date.now() + (step.timeoutMs ?? 30000)
      try {
        await this.command(page, 'Page.reload', {}, undefined, 10000, signal)
        while (!loaded && !(page.dialogRule?.handled?.type === 'beforeunload' && !page.dialogRule.handled.accepted)) {
          check()
          if (failed) { this.testDiagnostics.navigation = 'failed'; throw new Error('Reload navigation failed.') }
          if (Date.now() >= end) throw new Error('Reload navigation timed out.')
          await abortable(new Promise<void>(resolve => setTimeout(resolve, 50)), signal)
        }
        const cancelled = !loaded
        this.testDiagnostics.navigation = cancelled ? 'cancelled' : 'completed'
        if (!cancelled && step.all) {
          while (!(await this.testStepAction(page, { action: 'waitFor', label: 'Reload application readiness', all: step.all }, signal, 'readiness')).passed) {
            check()
            if (Date.now() >= end) { this.testDiagnostics.applicationReadiness = 'timed out'; throw new Error('Reload completed but application readiness timed out.') }
            await abortable(new Promise<void>(resolve => setTimeout(resolve, 100)), signal)
          }
        }
        check()
        const frames = await this.frames(page, signal)
        return { passed: true, data: { navigation: cancelled ? 'cancelled' : 'completed', loading: page.contents.isLoading(), testingEnabled: this.testState.enabled,
          applicationReadiness: cancelled ? 'not checked; reload cancelled' : step.all ? 'satisfied' : 'not requested; navigation completion alone is not application readiness',
          discovery: await this.discoverTargets(page, frames[0]!.id, signal) } }
      } finally {
        this.testDiagnostics.loading = !page.contents.isDestroyed() && page.contents.isLoading()
        this.testDiagnostics.testingEnabled = this.testState.enabled
        page.contents.removeListener('did-finish-load', complete)
        page.contents.removeListener('did-fail-load', failure)
      }
    }
    if (step.action === 'navigate') {
      this.checkTestOrigin(step.url!)
      this.testDelivery = 'uncertain'
      if (this.testProgress.currentAction) this.testProgress.currentAction.delivery = 'uncertain'
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { if (!page.contents.isDestroyed()) page.contents.stop(); reject(new Error('Test navigation stopped.')) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        else void page.contents.loadURL(step.url!).then(resolve, () => reject(new Error('Test navigation failed.')))
          .finally(() => signal.removeEventListener('abort', abort))
      })
      check(); this.testDelivery = 'partial'; return { passed: true }
    }
    if (step.action === 'screenshot') {
      // An element crop reads its bounds in the top frame before and after the capture.
      const targeted = step.selector !== undefined || step.targetRef !== undefined
      const top = targeted ? (await this.frames(page, signal))[0]?.id : undefined
      const bounds = async (): Promise<Rectangle> => {
        const result = await this.evaluate(page, top!, 'bounds', { selector: step.selector, targetRef: step.targetRef, text: step.text, action: 'screenshot' }, true, signal) as Params
        if (!result || result.error) throw new Error(String(result?.error ?? 'Screenshot target is unavailable.'))
        return { x: Number(result.x), y: Number(result.y), width: Number(result.width), height: Number(result.height) }
      }
      if (targeted && !top) throw new Error('Frame is unavailable in the selected page.')
      const region = targeted ? await bounds() : step.region
      const image = await this.run('screenshot', [String(page.contents.id)], signal, true, region) as Params
      check()
      if (image.state !== 'available') return { passed: false, reason: String(image.reason ?? 'Screenshot is unavailable.') }
      if (targeted) {
        const after = await bounds()
        if ((['x', 'y', 'width', 'height'] as const).some(key => Math.abs(after[key] - region![key]) >= 0.5)) return { passed: false,
          reason: 'Screenshot target moved or resized during capture; no image was kept. Wait for it to settle (for example with a stable condition) and retry.' }
      }
      return { passed: true, ...(region ? { data: { region: image.region, pixels: image.pixels } } : {}),
        screenshot: { step: 0, imageBase64: image.imageBase64, redacted: Boolean(image.redacted), ...(region ? { region: image.region } : {}) } }
    }
    const frames = await this.frames(page, signal)
    check()
    const frame = frames.find(frame => frame.id === (step.frame ?? frames[0]?.id))
    if (!frame) throw new Error('Frame is unavailable in the selected page.')
    if (step.action === 'discover') return { passed: true, data: { discovery: await this.discoverTargets(page, frame.id, signal) } }
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
      // A stable condition keeps samples per run step and condition, across the runner's polls.
      const stableArgs = step.condition === 'stable' ? { stableScope: this.testProgress.currentAction?.id ?? 'manual', stableKey: conditionKey } : {}
      try { const result = await evaluate('probe', stableArgs); return { passed: Boolean(result.passed), ...(result.reason ? { reason: String(result.reason) } : {}) } }
      catch (error) { check(); if (page.contents.isLoading()) return { passed: false, reason: 'Page is still loading.' }; throw error }
    }
    if (!this.options.visible(page.contents.id) || this.options.owner(page.contents.id).isMinimized() || !this.options.owner(page.contents.id).isVisible()) throw new Error('Show the selected page to run test interactions.')
    reference = randomBytes(16).toString('hex')
    let prepared = false
    // A second target (dragTo's drop target) keeps its own reference, so replacing either element is detected.
    interface OtherTarget { args: Params; reference: string; prepared: boolean }
    const targetPoint = async (requireFocus = false, offset: { x: number; y: number } | null | undefined = step.point, scroll = true, dragPoint?: string, other?: OtherTarget): Promise<Params> => {
      const point = await evaluate('target', { ...(other ? { ...other.args, reference: other.reference } : step.targetRef ? {} : { selector: step.selector ?? 'html' }),
        requireReference: other ? other.prepared : prepared, offset, scroll, dragPoint })
      if (other) other.prepared = true; else prepared = true
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
            functionDeclaration: `function(rx,ry,focused,dragPoint) {
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
              let hit=this.ownerDocument.elementFromPoint(x,y);
              while(hit?.shadowRoot) { const deep=hit.shadowRoot.elementFromPoint(x,y); if(!deep||deep===hit) break; hit=deep; }
              if(x<0||y<0||x>=win.innerWidth||y>=win.innerHeight||hit!==this) {
                const metadata=hit?JSON.stringify({tag:hit.localName,id:hit.id.slice(0,120),classes:[...hit.classList].slice(0,8).map(value=>value.slice(0,80)),role:hit.getAttribute('role')?.slice(0,80)??null}):'null';
                return {error:(dragPoint?'Drag '+dragPoint+' at embedding viewport ('+x+', '+y+'): ':'')+'Embedding frame is covered or outside the viewport.'+(dragPoint?' Hit element: '+metadata+'.':'')};
              }
              return {x,y,width:win.innerWidth,height:win.innerHeight};
            }`, arguments: [{ value: Number(point.x) / Number(point.width) }, { value: Number(point.y) / Number(point.height) }, { value: requireFocus }, { value: dragPoint ?? null }],
          }, session, 10000, signal)
          if (mapped.exceptionDetails || !mapped.result?.value) throw new Error('Frame position is unavailable.')
          if (mapped.result.value.error) throw new Error(String(mapped.result.value.error))
          Object.assign(point, mapped.result.value)
        } finally { await this.command(page, 'Runtime.releaseObject', { objectId }, session, 1000).catch(() => {}) }
        current = parent
      }
      check()
      this.testDiagnostics.pointer = { x: point.x, y: point.y, hit: point.hit, frame: frame.id, devicePixelRatio: point.devicePixelRatio, zoomFactor: page.contents.getZoomFactor(), coordinateSystem: 'CSS pixels relative to target; mapped to top viewport' }
      return point
    }
    if (step.action === 'drag') {
      const path = step.path!
      // Scroll once, then freeze geometry: moving/replaced/covered surfaces must
      // never redirect a held pointer into a different control or document.
      const waypoint = (index: number): string => `path point ${index + 1}/${path.length}`
      let start = await targetPoint(false, path[0], true, waypoint(0))
      const stableUntil = Date.now() + 2000
      while (true) {
        check()
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', modifiers, x: start.x, y: start.y }, undefined, 10000, signal)
        if (!(await evaluate('settle')).painted) throw new Error('Page is not painting. Show the page and retry the test.')
        const fresh = await targetPoint(false, path[0], false, waypoint(0))
        if (Math.abs(fresh.x - start.x) < 0.5 && Math.abs(fresh.y - start.y) < 0.5) { start = fresh; break }
        if (Date.now() >= stableUntil) throw new Error('Target did not stabilize before the drag.')
        start = fresh
      }
      const geometry = ['width', 'height', 'targetLeft', 'targetTop', 'targetWidth', 'targetHeight', 'inputLeft', 'inputTop', 'inputWidth', 'inputHeight']
      const mapped: Params[] = []
      const stable = (point: Params): void => {
        if (geometry.some(key => Math.abs(Number(point[key]) - Number(start[key])) >= 0.5)) throw new Error('Target geometry changed during the drag.')
      }
      for (const [index, offset] of path.entries()) { const point = await targetPoint(false, offset, false, waypoint(index)); stable(point); mapped.push(point) }
      let last = start; let completed = false; let pressed = false
      // A draggable element on the path would otherwise start an OS drag that follows the real cursor.
      let html5: Params | null = null
      const html5Started = (): void => { if (html5) throw new Error('The drag started an HTML5 drag-and-drop session from a draggable element. Use dragTo to drop it on another element.') }
      try {
        page.dragIntercepted = data => { html5 ??= data }
        await this.command(page, 'Input.setInterceptDrags', { enabled: true }, undefined, 10000, signal)
        check()
        const freshStart = await targetPoint(false, path[0], false, waypoint(0)); stable(freshStart)
        if (Math.abs(freshStart.x - start.x) >= 0.5 || Math.abs(freshStart.y - start.y) >= 0.5) throw new Error('Frame position changed before the drag.')
        pressed = true
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', button, buttons, modifiers, clickCount: 1, x: start.x, y: start.y }, undefined, 10000, signal)
        const segmentMs = (step.durationMs ?? 500) / (path.length - 1)
        const samples = Math.max(1, Math.ceil(segmentMs / 16))
        for (let segment = 1; segment < path.length; segment++) for (let sample = 1; sample <= samples; sample++) {
          await abortable(new Promise<void>(resolve => setTimeout(resolve, segmentMs / samples)), signal)
          check()
          const fraction = sample / samples
          const offset = { x: path[segment - 1]!.x + (path[segment]!.x - path[segment - 1]!.x) * fraction,
            y: path[segment - 1]!.y + (path[segment]!.y - path[segment - 1]!.y) * fraction }
          const point = await targetPoint(false, offset, false, `segment ${segment}/${path.length - 1}, sample ${sample}/${samples} toward ${waypoint(segment)}`); stable(point)
          if (Math.abs(point.x - (mapped[segment - 1]!.x + (mapped[segment]!.x - mapped[segment - 1]!.x) * fraction)) >= 0.5
            || Math.abs(point.y - (mapped[segment - 1]!.y + (mapped[segment]!.y - mapped[segment - 1]!.y) * fraction)) >= 0.5) throw new Error('Frame position changed during the drag.')
          check()
          await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', button, buttons, modifiers, x: point.x, y: point.y }, undefined, 10000, signal)
          last = point
          html5Started()
        }
        check(); stable(await targetPoint(false, path.at(-1), false, waypoint(path.length - 1))); html5Started(); completed = true
      } finally {
        if (html5 && !page.contents.isDestroyed()) await this.command(page, 'Input.dispatchDragEvent', { type: 'dragCancel', x: last.x, y: last.y, data: html5, modifiers }, undefined, 1000).catch(() => {})
        if (pressed && !page.contents.isDestroyed()) {
          const stopped = !completed || signal.aborted || this.disposed || this.activeId() !== page.contents.id || this.testPageId !== page.contents.id
          const release = this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button, buttons: 0, modifiers, clickCount: 1,
            x: stopped ? -1 : last.x, y: stopped ? -1 : last.y }, undefined, 1000)
          if (stopped) await release.catch(() => {})
          else await release
        }
        page.dragIntercepted = null
        if (!page.contents.isDestroyed()) await this.command(page, 'Input.setInterceptDrags', { enabled: false }, undefined, 1000).catch(() => {})
      }
      check(); return { passed: true }
    }
    if (step.action === 'dragTo') {
      // HTML5 drag-and-drop between two elements of this frame. Chromium's drag interception keeps the drag
      // inside this page: the page's own dragstart data is delivered unchanged to the drop target, and no OS
      // drag follows the real cursor. Both ends are hit-tested; the drop target again just before the drop.
      const drop = { args: { selector: step.dropSelector, targetRef: step.dropRef, text: step.dropText }, reference: randomBytes(16).toString('hex'), prepared: false }
      const source = (scroll: boolean): Promise<Params> => targetPoint(false, step.point, scroll, 'source')
      const destination = (scroll: boolean): Promise<Params> => targetPoint(false, step.dropPoint ?? null, scroll, 'drop target', drop) // null, not undefined: no offset means the visible center, never the source's point
      const geometry = ['width', 'height', 'targetLeft', 'targetTop', 'targetWidth', 'targetHeight']
      const moved = (a: Params, b: Params): boolean => Math.abs(a.x - b.x) >= 0.5 || Math.abs(a.y - b.y) >= 0.5 || geometry.some(key => Math.abs(Number(a[key]) - Number(b[key])) >= 0.5)
      const pause = (ms: number): Promise<void> => abortable(new Promise<void>(resolve => setTimeout(resolve, ms)), signal)
      await source(true)
      let end = await destination(true)
      // Scrolling the drop target into view may move the source; it must still be reachable without scrolling.
      let start = await source(false)
      const stableUntil = Date.now() + 2000
      while (true) {
        check()
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', modifiers, x: start.x, y: start.y }, undefined, 10000, signal)
        if (!(await evaluate('settle')).painted) throw new Error('Page is not painting. Show the page and retry the test.')
        const freshStart = await source(false), freshEnd = await destination(false)
        if (!moved(freshStart, start) && !moved(freshEnd, end)) { start = freshStart; end = freshEnd; break }
        if (Date.now() >= stableUntil) throw new Error('Drag source or drop target did not stabilize before the drag.')
        start = freshStart; end = freshEnd
      }
      const at = (fraction: number): { x: number; y: number } => ({ x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction })
      const distance = Math.hypot(end.x - start.x, end.y - start.y)
      const durationMs = step.durationMs ?? 500
      let data: Params | null = null
      let pressed = false; let dropped = false; let watching = false; let last: { x: number; y: number } = { x: start.x, y: start.y }
      const result: Params = { dragstartFired: false }
      this.testDiagnostics.dragAndDrop = result
      try {
        await evaluate('dragWatch', { dropReference: drop.reference }); watching = true
        page.dragIntercepted = value => { data ??= value }
        await this.command(page, 'Input.setInterceptDrags', { enabled: true }, undefined, 10000, signal)
        check()
        if (moved(await source(false), start)) throw new Error('Drag source moved before the drag.')
        pressed = true
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, modifiers, clickCount: 1, x: start.x, y: start.y }, undefined, 10000, signal)
        // Chromium starts a drag once the held pointer passes a few pixels; move toward the drop target until it does.
        for (const pixels of [2, 4, 8, 12, 16]) {
          check()
          last = at(distance ? Math.min(1, pixels / distance) : 0)
          await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, modifiers, x: last.x, y: last.y }, undefined, 10000, signal)
          await pause(16)
          if (data) break
        }
        const startBy = Date.now() + 1000
        while (!data && Date.now() < startBy) { check(); await pause(16) }
        if (!data) {
          const report = await evaluate('dragReport')
          Object.assign(result, report)
          throw new Error(report.dragstartFired ? 'The source fired dragstart but cancelled it, so no drag-and-drop session started.'
            : 'The source did not start an HTML5 drag: no dragstart fired. Check that the source is draggable, or use drag for pointer gestures.')
        }
        const dragData: Params = data
        if (Array.isArray(dragData.files) && dragData.files.length) throw new Error('File drags are not supported.')
        result.dragstartFired = true
        const travelled = distance ? Math.min(1, Math.hypot(last.x - start.x, last.y - start.y) / distance) : 1
        const samples = Math.max(2, Math.ceil(durationMs / 16))
        for (let sample = 1; sample <= samples; sample++) {
          await pause(durationMs / samples)
          check()
          last = at(travelled + (1 - travelled) * sample / samples)
          await this.command(page, 'Input.dispatchDragEvent', { type: sample === 1 ? 'dragEnter' : 'dragOver', x: last.x, y: last.y, data: dragData, modifiers }, undefined, 10000, signal)
        }
        check()
        if (moved(await destination(false), end)) throw new Error('Drop target moved during the drag.')
        await this.command(page, 'Input.dispatchDragEvent', { type: 'drop', x: end.x, y: end.y, data: dragData, modifiers }, undefined, 10000, signal)
        dropped = true
      } finally {
        if (data && !dropped && !page.contents.isDestroyed()) await this.command(page, 'Input.dispatchDragEvent', { type: 'dragCancel', x: last.x, y: last.y, data, modifiers }, undefined, 1000).catch(() => {})
        if (pressed && !page.contents.isDestroyed()) {
          const stopped = !dropped || signal.aborted || this.disposed || this.activeId() !== page.contents.id || this.testPageId !== page.contents.id
          await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, modifiers, clickCount: 1,
            x: stopped ? -1 : end.x, y: stopped ? -1 : end.y }, undefined, 1000).catch(() => {})
        }
        page.dragIntercepted = null
        if (!page.contents.isDestroyed()) await this.command(page, 'Input.setInterceptDrags', { enabled: false }, undefined, 1000).catch(() => {})
        if (watching && !dropped) await this.evaluate(page, frame.id, 'dragReport', { reference, stop: true }, true).catch(() => {})
      }
      // dragend reaches the source after the drop is handled.
      const reportBy = Date.now() + 1000
      let report = await evaluate('dragReport')
      while (!report.dragendFired && Date.now() < reportBy) { await pause(25); report = await evaluate('dragReport') }
      await evaluate('dragReport', { stop: true })
      Object.assign(result, report)
      check()
      if (!report.dropFired) throw new Error(report.dragoverAccepted ? 'The drop was delivered but no drop event fired.'
        : 'The drop target did not accept the drop: no dragover handler called preventDefault, so no drop event fired.')
      if (report.dropOnTarget === false) throw new Error('The drop event reached an element outside the drop target.')
      return { passed: true, data: { dragAndDrop: result } }
    }
    if (step.action === 'press' && step.scope === 'page') {
      const focus = await evaluate('pageFocus')
      if (focus.inFrame) throw new Error('Keyboard focus is inside a frame. Press on an element in that frame instead of on the page.')
      this.testDiagnostics.keyboard = { scope: 'page', focus: focus.focus ?? 'document body' }
      const info = testKey(step.key!, modifiers)
      check()
      try { await this.command(page, 'Input.dispatchKeyEvent', { type: 'keyDown', ...info, modifiers }, undefined, 10000, signal) }
      finally {
        if (!page.contents.isDestroyed()) {
          const release = this.command(page, 'Input.dispatchKeyEvent', { type: 'keyUp', key: info.key, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers }, undefined, 1000)
          if (signal.aborted || this.disposed || this.activeId() !== page.contents.id || this.testPageId !== page.contents.id) await release.catch(() => {})
          else await release
        }
      }
      check(); return { passed: true, data: { keyboard: this.testDiagnostics.keyboard } }
    }
    let point = await targetPoint()
    if (step.action === 'scroll') return { passed: Boolean((await evaluate('scroll', { selector: step.selector ?? 'html' })).passed) }
    if (step.action === 'select') { this.testDelivery = 'uncertain'; const result = await evaluate('select'); this.testDelivery = 'partial'; return { passed: Boolean(result.passed) } }
    if (step.action === 'fill' || step.action === 'press') {
      await evaluate(step.action)
      const key = async (info: KeyInfo, keyModifiers = modifiers): Promise<void> => {
        check()
        await targetPoint(true)
        await evaluate('focused')
        try { await this.command(page, 'Input.dispatchKeyEvent', { type: 'keyDown', ...info, modifiers: keyModifiers }, undefined, 10000, signal) }
        finally {
          if (!page.contents.isDestroyed()) {
            const release = this.command(page, 'Input.dispatchKeyEvent', { type: 'keyUp', key: info.key, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers }, undefined, 1000)
            if (signal.aborted || this.disposed || this.activeId() !== page.contents.id || this.testPageId !== page.contents.id) await release.catch(() => {})
            else await release
          }
        }
      }
      if (step.action === 'fill') {
        const selectAll = process.platform === 'darwin' ? 4 : 2
        await key(testKey('a', selectAll), selectAll); await key(testKey('Backspace', 0))
        check(); await targetPoint(true); await evaluate('focused')
        if (step.value) await this.command(page, 'Input.insertText', { text: step.value }, undefined, 10000, signal)
      } else {
        await key(testKey(step.key!, modifiers))
      }
      check(); return { passed: true }
    }
    check()
    if (![point.x, point.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 20000)) throw new Error('Target is outside the viewport.')
    // Geometry failures report the phase in which the change was observed, never a cause:
    // timing alone cannot tell a mousedown handler from a timer or an animation.
    const geometry = ['x', 'y', 'targetLeft', 'targetTop', 'targetWidth', 'targetHeight', 'inputLeft', 'inputTop', 'inputWidth', 'inputHeight']
    const round = (value: unknown): number => Math.round(Number(value) * 100) / 100
    const bounds = (sample: Params): Params => ({ point: { x: round(sample.x), y: round(sample.y) },
      target: { left: round(sample.targetLeft), top: round(sample.targetTop), width: round(sample.targetWidth), height: round(sample.targetHeight) },
      input: { left: round(sample.inputLeft), top: round(sample.inputTop), width: round(sample.inputWidth), height: round(sample.inputHeight) } })
    const changed = (before: Params, after: Params, keys = geometry): string[] => keys.filter(key => Math.abs(Number(after[key]) - Number(before[key])) >= 0.5)
    const geometryFailure = (phase: string, before: Params, after: Params, keys: string[], extra: Params = {}): void => {
      this.testDiagnostics.geometry = { phase, ...extra, changed: keys, before: bounds(before), after: bounds(after), delivery: this.testDelivery,
        cause: 'not inferred; the phase says only when the change was observed' }
    }
    const pressless = step.action === 'hover' || step.action === 'wheel'
    const settling = pressless ? 'pointer settling' : 'pre-press settling'
    const first = point; let samples = 0
    const stableUntil = Date.now() + 2000
    while (true) {
      check()
      await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', modifiers, x: point.x, y: point.y }, undefined, 10000, signal)
      if (!(await evaluate('settle')).painted) throw new Error('Page is not painting. Show the page and retry the test.')
      const fresh = await targetPoint(false, step.point, false); samples++
      if (Math.abs(fresh.x - point.x) < 0.5 && Math.abs(fresh.y - point.y) < 0.5) { point = fresh; break }
      if (Date.now() >= stableUntil) {
        geometryFailure(settling, first, fresh, changed(first, fresh), { samples, windowMs: 2000 })
        throw new Error(`Target did not stabilize during ${settling}: it kept moving for 2 seconds of pointer movement over it.${pressless ? '' : ' No button press was sent.'} Changed: ${changed(first, fresh).join(', ') || 'point'}. See data.geometry; a stable condition before this step can wait for the layout to settle.`)
      }
      point = fresh
    }
    if (step.action === 'hover') { check(); return { passed: true } }
    if (step.action === 'wheel') {
      // Native wheel events at one point. Each is hit-tested first; a target that moved fails
      // rather than sending the rest of the wheel somewhere else.
      const events = step.repeat ?? 1
      const wheel = { deltaX: step.deltaX ?? 0, deltaY: step.deltaY ?? 0, requested: events, sent: 0 }
      this.testDiagnostics.wheel = wheel
      for (let event = 1; event <= events; event++) {
        check()
        let fresh: Params
        try { fresh = await targetPoint(false, step.point, false) }
        catch (error) {
          // After the first event, a target that scrolled away or under another element shows up here.
          if (event === 1) throw error
          this.testDiagnostics.geometry = { phase: 'between wheel events', eventsSent: wheel.sent, before: bounds(point), delivery: this.testDelivery,
            cause: 'not inferred; the phase says only when the change was observed' }
          throw new Error(`Target moved or was covered between wheel events after ${wheel.sent} of ${events} were sent: ${error instanceof Error ? error.message : 'target unavailable'} Wheel on the scrolling container or canvas, not on an item that scrolls with it.`)
        }
        const moved = changed(point, fresh, ['x', 'y'])
        if (moved.length) {
          geometryFailure('between wheel events', point, fresh, moved, { eventsSent: wheel.sent })
          throw new Error(`Target moved between wheel events after ${wheel.sent} of ${events} were sent. Changed: ${moved.join(', ')}. Wheel on the scrolling container or canvas, not on an item that scrolls with it.`)
        }
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: wheel.deltaX, deltaY: wheel.deltaY, modifiers }, undefined, 10000, signal)
        wheel.sent = event
        if (!(await evaluate('settle')).painted) throw new Error('Page is not painting. Show the page and retry the test.')
      }
      check(); return { passed: true, data: { wheel } }
    }
    const stable = (fresh: Params, phase: 'after press' | 'between double-click presses', press: number): void => {
      const keys = changed(point, fresh)
      if (!keys.length) return
      geometryFailure(phase, point, fresh, keys, { press, pressesSent: phase === 'after press' ? press : press - 1, released: phase === 'after press' ? 'away from the target' : 'on the target' })
      throw new Error(`Target moved or geometry changed ${phase === 'after press' ? `after press ${press}` : 'between double-click presses'} of the ${step.action === 'doubleClick' ? 'double-click' : 'click'}. Changed: ${keys.join(', ')}. See data.geometry for the bounds before and after; the cause is not inferred, and the step is never retried automatically.`)
    }
    for (let count = 1; count <= (step.action === 'doubleClick' ? 2 : 1); count++) {
      if (count === 2) {
        stable(await targetPoint(false, step.point, false), 'between double-click presses', count)
      }
      check()
      let releaseOnTarget = false
      try {
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', button, buttons, modifiers, clickCount: count, x: point.x, y: point.y }, undefined, 10000, signal)
        stable(await targetPoint(false, step.point, false), 'after press', count); releaseOnTarget = true
      }
      finally {
        const stopped = !releaseOnTarget || signal.aborted || this.disposed || this.activeId() !== page.contents.id || this.testPageId !== page.contents.id
        if (!page.contents.isDestroyed()) {
          const release = this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button, buttons: 0, modifiers, clickCount: count,
            x: stopped ? -1 : point.x, y: stopped ? -1 : point.y }, undefined, 1000)
          if (stopped) await release.catch(() => {})
          else await release
        }
      }
    }
    check(); return { passed: true }
  }

  /** The user clicks an element with Chromium's own inspect overlay and receives prompt text
   * for it. Only the desktop window can start this; the assistant's control server cannot.
   * With `onElement` the overlay stays on and every click is reported (up to ten) until it is cancelled or idle. */
  async pick(onElement?: (text: string) => void): Promise<string | null> {
    this.cursor.getStore()?.validate()
    if (this.disposed) throw new Error('Browser session has closed.')
    if (this.busy || this.pickAbort) throw new Error('Another browser inspection, test or element selection is in progress.')
    const page = this.page()
    if (!this.options.visible(page.contents.id)) throw new Error('Show the Page view before selecting an element.')
    const abort = new AbortController()
    this.pickAbort = abort
    this.busy = true
    const pageId = page.contents.id
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.attach(page)
      await this.command(page, 'DOM.enable')
      await this.command(page, 'Overlay.enable')
      // Clicks queue up while an element is being described; cancellation jumps the queue.
      const queued: (number | null)[] = []
      let waiting: ((backendNodeId: number | null) => void) | null = null
      const choose = (backendNodeId: number | null): void => {
        if (backendNodeId === null) queued.length = 0
        if (waiting) { const resolve = waiting; waiting = null; resolve(backendNodeId) } else queued.push(backendNodeId)
      }
      const next = (): Promise<number | null> => queued.length ? Promise.resolve(queued.shift()!) : new Promise(resolve => { waiting = resolve })
      this.picker = { pageId, choose, next }
      abort.signal.addEventListener('abort', () => this.picker?.choose(null), { once: true })
      // Cancellation can arrive while Chromium is still being prepared; an already-aborted signal fires no event.
      if (abort.signal.aborted) return null
      const idle = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(() => abort.abort(), PICK_IDLE_MS) }
      idle()
      await this.command(page, 'Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {
        showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.45 }, paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
        borderColor: { r: 255, g: 229, b: 153, a: 0.6 }, marginColor: { r: 246, g: 178, b: 107, a: 0.4 } } })
      let count = 0
      while (true) {
        const backendNodeId = await next()
        if (backendNodeId === null || abort.signal.aborted || this.disposed || page.contents.isDestroyed() || this.activeId() !== pageId) return null
        if (!onElement) return await this.describePicked(page, backendNodeId)
        // In a multi-selection one stale element must not end the others.
        const text = await this.describePicked(page, backendNodeId).catch(() => null)
        if (text === null) continue
        onElement(text)
        if (++count >= MAX_MULTI_PICKS) return null
        idle()
      }
    } finally {
      if (timer) clearTimeout(timer)
      this.picker = null; this.pickAbort = null; this.busy = false
      if (!page.contents.isDestroyed() && page.contents.debugger.isAttached()) {
        await this.command(page, 'Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, undefined, 1000).catch(() => {})
        await this.command(page, 'Overlay.hideHighlight', {}, undefined, 1000).catch(() => {})
        await this.command(page, 'Overlay.disable', {}, undefined, 1000).catch(() => {})
      }
    }
  }

  private async describePicked(page: PageReader, backendNodeId: number): Promise<string> {
    const node = await this.command(page, 'DOM.describeNode', { backendNodeId })
    const frames = await this.frames(page)
    const frameId = typeof node.node?.frameId === 'string' && frames.some(frame => frame.id === node.node.frameId) ? String(node.node.frameId) : frames[0]?.id
    if (!frameId) throw new Error('The selected element is no longer available.')
    const contextId = await this.isolatedContext(page, frameId)
    const resolved = await this.command(page, 'DOM.resolveNode', { backendNodeId, executionContextId: contextId }, page.sessions.get(frameId))
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error('The selected element is no longer available.')
    try {
      const result = await this.command(page, 'Runtime.callFunctionOn', { objectId, returnByValue: true, userGesture: false,
        functionDeclaration: browserPickScript.toString(), arguments: [{ value: CREDENTIAL_PATTERN_SOURCE }] }, page.sessions.get(frameId))
      if (result.exceptionDetails || !result.result?.value) throw new Error('The selected element could not be described. Select it again.')
      return formatPickedElement(result.result.value)
    } finally { await this.command(page, 'Runtime.releaseObject', { objectId }, page.sessions.get(frameId), 1000).catch(() => {}) }
  }

  cancelPick(): void { this.pickAbort?.abort() }

  get picking(): boolean { return this.pickAbort !== null }

  async read(command: string, args: string[], signal?: AbortSignal): Promise<unknown> {
    this.cursor.getStore()?.validate()
    if (this.disposed) throw new Error('Browser session has closed.')
    if (this.busy) throw new Error('Another browser inspection or approval is in progress. Retry after it finishes.')
    this.busy = true
    try { return await this.run(command, args, signal) }
    finally { this.busy = false }
  }

  private async discoverTargets(page: PageReader, frameId: string, signal?: AbortSignal): Promise<Params> {
    const result = await this.evaluate(page, frameId, 'inspect', { generation: randomBytes(16).toString('hex') }, true, signal) as Params
    if (result.error) throw new Error(String(result.error))
    return { pageId: page.contents.id, frameId, zoomFactor: page.contents.getZoomFactor(), ...redactBrowserValue(result).value as Params,
      targets: (redactBrowserValue(result.targets).value as Params[]).map(target => ({ ...target, pageId: page.contents.id, frameId })) }
  }

  private async run(command: string, args: string[], signal?: AbortSignal, testScreenshot = false, crop?: Rectangle): Promise<unknown> {
    if (command === 'test-targets') {
      const page = this.page()
      const frames = await this.frames(page, signal)
      const frame = frames.find(frame => frame.id === (args[0] ?? frames[0]?.id))
      if (!frame) throw new Error('Test frame is unavailable.')
      return this.discoverTargets(page, frame.id, signal)
    }
    if (command === 'tabs') return { tabs: this.options.pages().map(contents => ({ id: contents.id,
      url: readableUrl(contents.getURL()), active: contents.id === this.activeId(), loading: contents.isLoading() })), timestamp: new Date().toISOString() }
    if (command === 'responses') {
      const pageId = this.page(args[0]).contents.id
      return { recording: this.options.recording(), limit: MAX_RESPONSES, timestamp: new Date().toISOString(),
        capture: [...this.readers].filter(([id]) => id === pageId).map(([id, page]) => ({ pageId: id, state: page.capture })),
        responses: [...this.responses.values()].filter(record => record.pageId === pageId).map(({ data: _data, ...metadata }) => metadata),
        limitations: ['Only captured JSON is exported; XHR/fetch replies sent as script or text count when they are JSON or JSONP. Earlier, cleared, oversized, non-JSON and unretained responses are unavailable; requests are never replayed.'] }
    }
    if (command === 'response') {
      const record = this.responses.get(args[0]!)
      if (!record || this.cursor.getStore() && record.pageId !== this.activeId()) return { state: 'unavailable', reason: 'Response not captured, no longer retained, or belongs to another page.' }
      return structuredClone(record)
    }
    const page = this.page(args[0])
    if (command === 'select') { this.selectId(page.contents.id); return { pageId: page.contents.id, state: 'selected' } }
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
      if (!this.options.visible(page.contents.id)) throw new Error(`Show browser page ${page.contents.id} before requesting an interaction.`)
      const control = await this.evaluate(page, frameId, 'describe', { snapshotId: args[2], nodeId: args[3] }) as Params
      const filtered = redactBrowserValue(control).value as Params
      const label = String(filtered.name).replace(/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, 200)
      const destination = typeof filtered.href === 'string' ? `\nLink destination: ${readableUrl(filtered.href)}` : ''
      const description = `Activate ${String(filtered.tag)} “${label}” on ${metadata.url}${destination}\n\nThis control runs the web app's code and may change data or navigate. Approve only this specific action. Cancel keeps the page unchanged.`
      if (signal?.aborted || this.disposed) return { ...metadata, state: 'denied', reason: 'The interaction request was cancelled.' }
      const owner = this.options.owner(page.contents.id)
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
      if (!this.options.visible(page.contents.id)) throw new Error(`Show browser page ${page.contents.id} before requesting an interaction.`)
      return { ...metadata, ...await this.evaluate(page, frameId, 'activate', { snapshotId: args[2], nodeId: args[3] }) }
    }
    if (command === 'screenshot') {
      const owner = this.options.owner(page.contents.id)
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
        // Crop only after every mask is painted into the full bitmap.
        const cut = maskAndCrop(image.toBitmap({ scaleFactor: 1 }), size, mask as ScreenshotMaskGeometry, crop)
        if (!cut) return { ...metadata, state: 'unavailable', reason: 'Screenshot region is outside the visible viewport.' }
        const pixels = cut.pixels
        const masked = nativeImage.createFromBitmap(cut.bitmap, { ...cut.size, scaleFactor: 1 })
        const png = masked.resize({ width: Math.min(1600, cut.size.width) }).toPNG()
        if (png.length > 2 * 1024 * 1024) return { ...metadata, state: 'unavailable', reason: 'Screenshot exceeds the 2 MiB limit.', truncated: true }
        const viewport = (mask as ScreenshotMaskGeometry).viewport
        const region = crop && pixels ? { x: pixels.x * viewport.width / size.width, y: pixels.y * viewport.height / size.height,
          width: pixels.width * viewport.width / size.width, height: pixels.height * viewport.height / size.height } : undefined
        return { ...metadata, frameId: top, state: 'available', mimeType: 'image/png', imageBase64: png.toString('base64'),
          redacted: Boolean(mask.redacted), size: image.getSize(), ...(region ? { region, pixels } : {}), limitations: [testScreenshot
            ? 'Form controls, credential-marked elements and embedded frames are masked. Canvas pixels are included for the authorized test. Screenshot covers the viewport only.'
            : 'Form controls, credential-marked elements, embedded frames and canvases are masked. Screenshot covers the rendered viewport only.'] }
      } finally { await this.evaluate(page, top, 'unmask', {}).catch(() => {}) }
    }
    throw new Error('Unknown browser inspection command.')
  }

  dispose(): void {
    this.cancelPick()
    this.stopTest()
    this.disposed = true
    this.clear()
    for (const page of this.readers.values()) if (!page.contents.isDestroyed() && page.contents.debugger.isAttached()) page.contents.debugger.detach()
    this.readers.clear()
  }
}
