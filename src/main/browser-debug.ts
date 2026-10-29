import { randomBytes } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import { BrowserWindow, ClipboardItem, Menu, WebContentsView, clipboard, dialog, session as electronSession } from 'electron'
import type { BrowserWindowConstructorOptions, OnBeforeRequestListenerDetails, OnHeadersReceivedListenerDetails, OnSendHeadersListenerDetails, Session, WebContents } from 'electron'
import { browserControlPath, validateBrowserScreenshotPath } from '../cli/browser-control.js'
import { executeBrowserTest, parseBrowserTest } from '../cli/browser-test-client.js'
import { isFormType, isJsonType, parseFormFields, readBody } from './form-body.js'
import { constantTimeTokenEqual } from '../cli/runtime-core.js'
import { writeFileAtomic } from './atomic-file.js'
import { parseSafeHttpUrl } from './external-targets.js'
import { parseBrowserAddress } from './browser-url.js'
import type { BrowserBounds, BrowserDebugState, BrowserNetworkEntry, BrowserViewMode } from './browser-debug-types.js'
import { restorableUrl, sanitizedHeaders, sanitizedText, sanitizedUrl } from './browser-privacy.js'
import { BrowserReader } from './browser-reader.js'
import { BROWSER_READ_COMMANDS, browserReadMethod, validateBrowserReadCommand } from '../cli/browser-read-command.js'
import { MAX_TEST_BYTES } from './browser-test-plan.js'

/** A plan sent as form data, with its test inputs. */
const MAX_TEST_FORM_BYTES = 2 * MAX_TEST_BYTES + 64 * 1024

/** Save a screenshot in a new file and answer with its metadata and path, as `browser.ps1 screenshot -OutputPath` does. */
async function saveScreenshot(value: unknown, path: string): Promise<unknown> {
  const result = value as { imageBase64?: unknown } | null
  if (typeof result?.imageBase64 !== 'string') return value
  const { imageBase64, ...metadata } = result
  const file = await open(path, 'wx')
  try { await file.writeFile(Buffer.from(imageBase64, 'base64')) } finally { await file.close() }
  return { ...metadata, path }
}
import { SITE_PERMISSIONS, SitePermissions, sitePermissionTarget, type AskSitePermission } from './browser-permissions.js'
import { BrowserZoom, nextZoomFactor, zoomSite } from './browser-zoom.js'
import { contextMenuItems, type ContextMenuId, type ContextMenuInput } from './browser-context-menu.js'
import { BrowserHistory } from './browser-history.js'
import { OVERRIDES_SCRIPT, POPUP_OVERRIDES_LOADED_SCRIPT, POPUP_OVERRIDES_READY_SCRIPT, overridesFromDevtools, overridesFromPreferences, popupOverrideResponseScript, type OverridesSetting } from './browser-overrides.js'

const MAX_ENTRIES = 300
const MAX_PAGES = 32
const POPUP_OVERRIDES_DRAIN_MS = 2000
/** A popup response waiting on its override files fails only when the folder stops loading, however large it is. */
const POPUP_OVERRIDES_STALL_MS = 15000
const browsersBySession = new WeakMap<Session, Set<BrowserDebug>>()

interface BrowserPage {
  contents: WebContents
  view: WebContentsView
  tools: WebContentsView | null
  attached: boolean
  loading: boolean
  error: string | null
  lastUrl: string
  devtools: boolean
  panel: 'console' | 'network' | 'sources' | null
  /** Local Overrides as this page's running DevTools last reported it. */
  overrides: OverridesSetting | null
}

/** Own browser session, with native Chromium DevTools, scoped reading and CLI telemetry.
 * Capture uses Electron events, so opening DevTools cannot detach a CDP collector. */
export class BrowserDebug {
  private readonly pages = new Map<number, BrowserPage>()
  private activePageId = 0
  private server: Server | null = null
  private serverStart: Promise<void> | null = null
  private readonly token = randomBytes(32).toString('hex')
  private readonly endpointPath: string
  private readonly reportError: (message: string) => void
  private consoleSequence = 0
  private bounds: BrowserBounds | null = null
  private readonly started = new Map<string, number>()
  private disposed = false
  private settingsWrite = Promise.resolve()
  private readonly reader: BrowserReader
  private readonly sitePermissions: SitePermissions
  private readonly askPermission: AskSitePermission
  private readonly zoom: BrowserZoom
  private readonly unsubscribeZoom: () => void
  /** The Chromium partition this browser's pages use; with the shared browser profile, other browsers use it too. */
  readonly partition: string
  /** The partition its DevTools runs in when this session keeps Local Overrides to itself; null for the shared ones. */
  readonly devtoolsPartition: string | null
  private readonly tabId: string
  private readonly notifyShortcut: (name: 'find' | 'find-close') => void
  private readonly appShortcut: ((name: 'git-toggle') => void) | undefined
  private readonly showMenu: (menu: Menu) => void
  private readonly history: BrowserHistory
  private findQuery = ''
  private findResult: { matches: number; active: number } | null = null
  private overridesRead: Promise<void> | null = null
  private overridesReadAt = 0
  private savedOverrides: OverridesSetting | null = null
  private savedOverridesAt = 0
  private state: BrowserDebugState = {
    activePageId: 0, pages: [], zoomFactor: 1, view: 'page',
    recordingConsole: true, recordingNetwork: true, preserveConsole: true, preserveNetwork: true,
    url: '', loading: false, canGoBack: false, canGoForward: false,
    devtools: false, error: null, console: [], network: [], sitePermissions: [], history: [],
  }

  constructor(private owner: BrowserWindow, private readonly settingsPath: string,
    options: { endpointPath?: string; partition?: string; devtoolsPartition?: string; reportError?: (message: string) => void; approveInteraction?: (description: string) => Promise<boolean>; approvePermission?: (description: string) => Promise<boolean>; tabId?: string; history?: BrowserHistory; sitePermissions?: SitePermissions; zoom?: BrowserZoom; notify?: (name: 'find' | 'find-close') => void; onAppShortcut?: (name: 'git-toggle') => void; showMenu?: (menu: Menu) => void } = {}) {
    this.appShortcut = options.onAppShortcut
    this.history = options.history ?? new BrowserHistory()
    this.zoom = options.zoom ?? new BrowserZoom()
    this.partition = options.partition ?? `browser-debug:${randomBytes(16).toString('hex')}`
    this.devtoolsPartition = options.devtoolsPartition ?? null
    this.showMenu = options.showMenu ?? (menu => { if (!this.owner.isDestroyed()) menu.popup({ window: this.owner }) })
    this.tabId = options.tabId ?? ''
    this.notifyShortcut = options.notify ?? (name => { if (!this.owner.isDestroyed() && this.tabId) this.owner.webContents.send('desktop:browser-shortcut', this.tabId, name) })
    this.endpointPath = options.endpointPath ?? browserControlPath()
    this.reportError = options.reportError ?? (message => console.warn(message))
    this.sitePermissions = options.sitePermissions ?? new SitePermissions()
    this.askPermission = async (origin, permission, signal) => {
      const description = `${origin} wants to ${SITE_PERMISSIONS[permission]}.\n\nBlock keeps it off. Either answer is remembered for every session's browser until you remove it under Site permissions. Camera, microphone, location, screen capture and other permissions are always blocked.`
      if (this.disposed || signal.aborted) return null
      if (options.approvePermission) return options.approvePermission(description)
      const owner = this.owner
      if (owner.isDestroyed()) return null
      if (owner.isMinimized()) owner.restore()
      if (!owner.isVisible()) owner.show()
      owner.focus()
      const { response } = await dialog.showMessageBox(owner, { type: 'question', title: 'Allow site permission?', message: 'A page in the session browser is asking for permission.',
        detail: description, buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0, noLink: true, signal })
      return signal.aborted ? null : response === 1
    }
    this.reader = new BrowserReader({ pages: () => [...this.pages.values()].map(page => page.contents),
      active: () => this.activePageId, select: id => { this.action(`select-page:${id}`) }, owner: () => this.owner,
      recording: () => this.state.recordingNetwork, visible: id => this.pages.get(id)?.view.getVisible() ?? false,
      evidence: (pageId, startedAt) => ({ console: this.state.console.filter(entry => entry.pageId === pageId && entry.timestamp >= startedAt).slice(-100),
        capture: { recordingConsole: this.state.recordingConsole, recordingNetwork: this.state.recordingNetwork,
          limitations: ['Console evidence retains at most 100 entries from this run; activity retains at most 300. Capture settings, navigation, clearing and debugger attachment can make evidence incomplete. Arbitrary application text can contain sensitive data.'] } }),
      ...(options.approveInteraction ? { approve: options.approveInteraction } : {}) })
    const view = new WebContentsView({ webPreferences: {
      partition: this.partition, sandbox: true, contextIsolation: true,
      nodeIntegration: false, devTools: true,
    } })
    this.addPage(view, true)
    BrowserDebug.browsersOn(view.webContents.session).add(this)
    // Another browser changing a site's zoom changes it here too, as in one Chrome profile.
    this.unsubscribeZoom = this.zoom.subscribe((site, factor) => {
      for (const page of this.pages.values()) {
        if (!page.contents.isDestroyed() && zoomSite(page.contents.getURL()) === site && page.contents.getZoomFactor() !== factor) page.contents.setZoomFactor(factor)
      }
    })
  }

  /**
   * The browsers using a Chromium session, installing that session's hooks the first time. With the shared browser
   * profile several browsers use one session, and Electron keeps one permission handler and one listener per
   * webRequest event per session, so each hook is offered to every browser and each acts only on its own pages.
   */
  private static browsersOn(session: Session): Set<BrowserDebug> {
    const known = browsersBySession.get(session)
    if (known) return known
    const browsers = new Set<BrowserDebug>()
    browsersBySession.set(session, browsers)
    const owning = (contents: WebContents | null): BrowserDebug | undefined => contents ? [...browsers].find(browser => browser.pages.has(contents.id)) : undefined
    // Only a few permissions can be granted, only to http(s) main frames of these browsers' pages, and only after the user answered a native prompt.
    session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const target = sitePermissionTarget(permission, details.requestingUrl ?? requestingOrigin, details.isMainFrame)
      const browser = owning(contents)
      return Boolean(target && browser && browser.sitePermissions.allowed(target.origin, target.permission))
    })
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const target = sitePermissionTarget(permission, details.requestingUrl, details.isMainFrame)
      const browser = owning(contents)
      if (!target || !browser || browser.disposed) { callback(false); return }
      const closed = new AbortController()
      const abort = (): void => closed.abort()
      contents.once('destroyed', abort)
      void browser.sitePermissions.request(target.origin, target.permission, closed.signal, browser.askPermission)
        .finally(() => { contents.off('destroyed', abort) }).then(callback, () => callback(false))
    })
    session.on('will-download', event => event.preventDefault())
    // Request ids are unique within a session, so each browser records only requests from its own pages.
    const request = session.webRequest
    const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
    request.onBeforeRequest(filter, (details, callback) => { for (const browser of browsers) browser.requestStarted(details); callback({}) })
    request.onSendHeaders(filter, details => { for (const browser of browsers) browser.requestHeadersSent(details) })
    request.onHeadersReceived(filter, (details, callback) => { for (const browser of browsers) browser.responseHeadersReceived(details); callback({}) })
    request.onBeforeRedirect(filter, details => { for (const browser of browsers) browser.networkEntry(details.id)?.redirects.push(sanitizedUrl(details.redirectURL)) })
    request.onCompleted(filter, details => { for (const browser of browsers) browser.requestFinished(details.id, details.statusCode, null) })
    request.onErrorOccurred(filter, details => { for (const browser of browsers) browser.requestFinished(details.id, null, details.error) })
    return browsers
  }

  /** The toolbar and DevTools act on the selected page; every page belongs to this terminal. */
  get view(): WebContentsView { return this.activePage.view }

  private get activePage(): BrowserPage { return this.pages.get(this.activePageId)! }

  private addPage(view: WebContentsView, activate: boolean): BrowserPage {
    const contents = view.webContents
    const storage = contents.session
    const page: BrowserPage = { contents, view, tools: null, attached: false, loading: false, error: null, lastUrl: '', devtools: false, panel: null, overrides: null }
    this.pages.set(contents.id, page)
    this.reader.add(contents)
    if (activate) { this.endFind(); this.reader.setTesting(false); this.activePageId = contents.id; this.state.view = 'page' }
    contents.setWindowOpenHandler(details => {
      if (this.disposed) return { action: 'deny' }
      try { if (details.url && details.url !== 'about:blank') parseSafeHttpUrl(details.url) }
      catch {
        page.error = 'This browser opens HTTP and HTTPS links only.'
        return { action: 'deny' }
      }
      if (this.pages.size >= MAX_PAGES) {
        page.error = 'Close a browser page before opening another (32 pages maximum).'
        return { action: 'deny' }
      }
      return {
        action: 'allow', outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: { session: storage,
          sandbox: true, contextIsolation: true, nodeIntegration: false,
          nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
          webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, devTools: true,
        } },
        // Chromium handles the original request, referrer, POST body and opener relationship.
        // Using loadURL here would lose those semantics and replace the source page.
        createWindow: (options: BrowserWindowConstructorOptions) => {
          const { preload: _preload, partition: _partition, ...preferences } = options.webPreferences ?? {}
          // options also carries Chromium's pre-created webContents. Adopt it so
          // window.open's synchronous return and browsing context remain valid.
          const child = new WebContentsView({ ...options, webPreferences: {
            ...preferences, session: storage,
            sandbox: true, contextIsolation: true, nodeIntegration: false,
            nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
            webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, devTools: true,
          } })
          const childPage = this.addPage(child, details.disposition !== 'background-tab')
          this.startPopupOverrides(page, childPage)
          this.layout()
          // Electron supplies no guest for browser-initiated background links.
          // In that case createWindow is also responsible for the original load.
          if (!(options as BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents) {
            const post = details.postBody
            void child.webContents.loadURL(details.url || 'about:blank', {
              httpReferrer: details.referrer,
              ...(post ? { postData: post.data, extraHeaders: `content-type: ${post.contentType}${post.boundary ? `; boundary=${post.boundary}` : ''}` } : {}),
            }).catch(error => { childPage.error = sanitizedText(String(error)) })
          }
          return child.webContents
        },
      }
    })
    // The page has no application menu, so give it Chrome's hard-reload shortcuts.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt || this.activePageId !== contents.id) return
      const key = input.key.toLowerCase()
      if (key === 'escape' && this.reader.picking) { event.preventDefault(); this.reader.cancelPick(); return }
      // The page has no application menu, so give it the browser shortcuts people expect.
      const command = input.control || input.meta
      const handled = ((): boolean => {
        if (command && (key === '=' || key === '+')) { this.action('zoom-in'); return true }
        if (command && (key === '-' || key === '_')) { this.action('zoom-out'); return true }
        if (command && key === '0') { this.action('zoom-reset'); return true }
        if (command && !input.shift && key === 'f') { this.notifyShortcut('find'); return true }
        if (key === 'escape' && this.findQuery) { this.stopFind(); this.notifyShortcut('find-close'); return true }
        // Ctrl+Shift+G belongs to the app (the Git panel). Find-next is Ctrl+G and F3; find-previous is Shift+F3.
        if (command && input.shift && key === 'g' && this.appShortcut) { this.appShortcut('git-toggle'); return true }
        if (this.findQuery && (key === 'f3' || (command && !input.shift && key === 'g'))) { this.find(this.findQuery, !input.shift, true); return true }
        if (key === 'f12' || (command && input.shift && key === 'i')) { this.action('devtools'); return true }
        return false
      })()
      if (handled) { event.preventDefault(); return }
      const hard = (key === 'r' && input.shift && (input.control || input.meta)) || (key === 'f5' && (input.control || input.meta || input.shift))
      if (!hard) return
      event.preventDefault()
      page.error = null
      contents.reloadIgnoringCache()
    })
    contents.on('will-navigate', (event, url) => {
      try { parseSafeHttpUrl(url) } catch { event.preventDefault() }
    })
    contents.on('will-redirect', (event, url) => {
      try { parseSafeHttpUrl(url) } catch { event.preventDefault() }
    })
    contents.on('did-start-loading', () => { page.loading = true })
    contents.on('did-start-navigation', details => {
      if (!details.isMainFrame || details.isSameDocument) return
      if (this.findQuery && this.activePageId === contents.id) { this.stopFind(); this.notifyShortcut('find-close') }
      if (!this.state.preserveConsole) this.state.console = this.state.console.filter(entry => entry.pageId !== contents.id)
      if (!this.state.preserveNetwork) {
        this.reader.clear(contents.id)
        for (const entry of this.state.network) if (entry.pageId === contents.id) this.started.delete(entry.id)
        this.state.network = this.state.network.filter(entry => entry.pageId !== contents.id)
      }
    })
    contents.on('did-stop-loading', () => { page.loading = false })
    contents.on('did-fail-load', (_event, code, description, _url, main) => {
      if (main && code !== -3) page.error = sanitizedText(description)
    })
    contents.on('did-navigate', (_event, url) => {
      this.rememberUrl(page, url)
      this.history.record(url)
      const zoom = this.zoom.get(url)
      if (contents.getZoomFactor() !== zoom) contents.setZoomFactor(zoom)
    })
    contents.on('found-in-page', (_event, result) => {
      if (this.activePageId === contents.id && this.findQuery && result.finalUpdate) this.findResult = { matches: result.matches, active: result.activeMatchOrdinal }
    })
    contents.on('context-menu', (_event, params) => { if (this.activePageId === contents.id && !this.disposed) this.showContextMenu(page, params) })
    contents.on('console-message', details => {
      if (!this.state.recordingConsole) return
      this.state.console.push({ id: ++this.consoleSequence, pageId: contents.id, timestamp: new Date().toISOString(),
        level: details.level, message: sanitizedText(details.message), source: sanitizedUrl(details.sourceId).slice(0, 2048), line: details.lineNumber })
      if (this.state.console.length > MAX_ENTRIES) this.state.console.shift()
    })
    const id = contents.id
    contents.on('devtools-closed', () => {
      page.devtools = false
      page.overrides = null
      if (id === this.activePageId && ['console', 'network', 'devtools'].includes(this.state.view)) this.state.view = 'page'
      if (this.pages.has(id)) this.layout()
    })
    contents.once('destroyed', () => this.removePage(id, storage))
    return page
  }

  private requestStarted(details: OnBeforeRequestListenerDetails): void {
    if (!this.state.recordingNetwork || details.webContentsId === undefined || !this.pages.has(details.webContentsId)) return
    const id = String(details.id)
    const previous = this.state.network.find(entry => entry.id === id)
    if (previous) { previous.url = sanitizedUrl(details.url); return }
    this.started.set(id, Date.now())
    this.state.network.push({ id, pageId: details.webContentsId, timestamp: new Date().toISOString(), method: details.method,
      url: sanitizedUrl(details.url), resourceType: details.resourceType, status: null, durationMs: null, error: null,
      requestHeaders: {}, responseHeaders: {}, redirects: [] })
    if (this.state.network.length > MAX_ENTRIES) {
      const removed = this.state.network.shift()
      if (removed) this.started.delete(removed.id)
    }
  }

  /** Hold early responses until native DevTools is ready; enabling Fetch after a request starts misses its HTML. */
  private startPopupOverrides(opener: BrowserPage, popup: BrowserPage): void {
    const contents = popup.contents
    const debuggerClient = contents.debugger
    const pending = new Set<Promise<void>>()
    let phase: 'active' | 'draining' | 'disabling' | 'closed' = 'active'
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let finishDrain: (() => void) | undefined
    const handingOff = (): boolean => phase === 'disabling' || phase === 'closed'
    const intercepting = debuggerClient.sendCommand('Fetch.enable', { patterns: [
      { urlPattern: 'http://*/*', requestStage: 'Response' }, { urlPattern: 'https://*/*', requestStage: 'Response' },
    ] })
    const ready = Promise.all([intercepting, this.inheritPopupOverrides(opener, popup)]).then(([, applied]) => applied)
    const paused = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
      if (method !== 'Fetch.requestPaused') return
      if (phase !== 'active') {
        // Native DevTools owns new responses now, but this temporary Fetch session must still release its pause.
        if (phase !== 'closed') void debuggerClient.sendCommand('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {})
        return
      }
      const response = (async () => {
        if (!await ready) throw new Error('Popup overrides did not activate')
        if (handingOff()) return
        const tools = popup.tools?.webContents
        if (!tools || !popup.overrides?.enabled) {
          await debuggerClient.sendCommand('Fetch.continueRequest', { requestId: params.requestId })
          return
        }
        let action = await tools.executeJavaScript(popupOverrideResponseScript(params)) as { method: string; params: Record<string, unknown> }
        let loaded = -1
        let progressAt = Date.now()
        while (action.method === 'wait') {
          if (handingOff()) return
          if (Number(action.params.loaded) > loaded) { loaded = Number(action.params.loaded); progressAt = Date.now() }
          else if (Date.now() - progressAt > POPUP_OVERRIDES_STALL_MS) throw new Error('Local Overrides folder stopped loading')
          await new Promise(accept => setTimeout(accept, 100))
          if (handingOff()) return
          action = await tools.executeJavaScript(popupOverrideResponseScript(params)) as typeof action
        }
        if (handingOff()) return
        if (action.method === 'Fetch.getResponseBody') {
          const body = await debuggerClient.sendCommand(action.method, action.params).catch(error => ({ error: String(error) }))
          if (handingOff()) return
          action = await tools.executeJavaScript(popupOverrideResponseScript(params, body)) as typeof action
        }
        if (handingOff()) return
        if (!['Fetch.fulfillRequest', 'Fetch.continueRequest'].includes(action.method)) throw new Error('Unexpected popup override response')
        if (action.params.requestId !== params.requestId) throw new Error('Popup override response belongs to another request')
        await debuggerClient.sendCommand(action.method, action.params)
      })().catch(error => {
        if (!handingOff() && !contents.isDestroyed()) {
          popup.error ??= `Could not apply Local Overrides to this popup: ${sanitizedText(String(error))}`
          void debuggerClient.sendCommand('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }).catch(() => {})
        }
      })
      pending.add(response)
      void response.finally(() => pending.delete(response))
    }
    debuggerClient.on('message', paused)
    const detached = (): void => {
      phase = 'closed'
      finishDrain?.()
      if (drainTimer) clearTimeout(drainTimer)
      debuggerClient.off('message', paused)
      contents.off('did-finish-load', cleanup)
      contents.off('destroyed', detached)
      contents.off('did-fail-load', failed)
    }
    let settling = false
    const cleanup = (): void => {
      if (phase !== 'active' || settling) return
      settling = true
      contents.off('did-finish-load', cleanup)
      contents.off('did-fail-load', failed)
      // Requests made after load still go through the wait above until native DevTools has the whole folder.
      void ready.then(applied => applied ? this.popupFolderLoaded(popup, () => phase !== 'active') : undefined)
        .catch(() => {}).finally(drain)
    }
    const drain = (): void => {
      if (phase !== 'active') return
      phase = 'draining'
      const deadline = new Promise<void>(accept => {
        finishDrain = accept
        drainTimer = setTimeout(accept, POPUP_OVERRIDES_DRAIN_MS)
      })
      // A header-only stream can outlive the document indefinitely. Preserve finite early responses, then release
      // outstanding pauses with Fetch.disable; detach the handler only after that command has finished.
      void Promise.race([Promise.allSettled([...pending]), deadline]).then(async () => {
        if (drainTimer) clearTimeout(drainTimer)
        finishDrain = undefined
        if (phase === 'closed' || contents.isDestroyed()) return
        phase = 'disabling'
        await debuggerClient.sendCommand('Fetch.disable').catch(() => {})
      }).finally(detached)
    }
    const failed = (_event: Electron.Event, _code: number, _description: string, _url: string, main: boolean): void => { if (main) cleanup() }
    contents.once('did-finish-load', cleanup)
    contents.once('destroyed', detached)
    contents.on('did-fail-load', failed)
    void ready.then(applied => {
      if (!applied && !contents.isDestroyed()) { contents.stop(); cleanup() }
    }).catch(error => {
      if (!contents.isDestroyed()) { popup.error = `Could not activate popup overrides: ${sanitizedText(String(error))}`; contents.stop() }
      cleanup()
    })
  }

  /** Resolves once the popup's DevTools intercepts every file in its overrides folder, or the folder stops loading. */
  private async popupFolderLoaded(popup: BrowserPage, stopped: () => boolean): Promise<void> {
    let loaded = -1
    let progressAt = Date.now()
    for (;;) {
      const tools = popup.tools?.webContents
      if (stopped() || this.disposed || !tools || tools.isDestroyed() || !popup.overrides?.enabled) return
      const state = await tools.executeJavaScript(POPUP_OVERRIDES_LOADED_SCRIPT) as { done: boolean; loaded: number }
      if (state.done) return
      if (state.loaded > loaded) { loaded = state.loaded; progressAt = Date.now() }
      else if (Date.now() - progressAt > POPUP_OVERRIDES_STALL_MS) {
        if (!popup.contents.isDestroyed()) popup.error ??= 'Local Overrides folder stopped loading; later requests in this popup may not use their overrides.'
        return
      }
      await new Promise(accept => setTimeout(accept, 100))
    }
  }

  /** Electron's native auto-open-for-popups handler is a no-op. Keep its override engine alive without showing its UI. */
  private async inheritPopupOverrides(opener: BrowserPage, popup: BrowserPage): Promise<boolean> {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed: (() => void) | undefined
    const checkOpen = (): void => {
      if (stopped || this.disposed || popup.contents.isDestroyed()) throw new Error('Popup closed or overrides activation timed out')
    }
    try {
      await Promise.race([
        (async () => {
          // Query the opener live: a toggle changed just before window.open must not use the footer's cached value.
          await this.readOverrides(opener)
          checkOpen()
          const setting = opener.overrides ?? this.savedOverrides
          if (!setting?.enabled || !setting.folder) return
          const tools = this.ensureDevtools(popup)
          this.layout()
          for (;;) {
            checkOpen()
            if (!tools.isDestroyed() && !tools.isLoading() && tools.getURL().startsWith('devtools://devtools/')) {
              const ready = overridesFromDevtools(await tools.executeJavaScript(POPUP_OVERRIDES_READY_SCRIPT))
              checkOpen()
              if (ready) { popup.overrides = ready; return }
            }
            await new Promise(accept => setTimeout(accept, 25))
          }
        })(),
        new Promise<never>((_accept, reject) => {
          closed = () => { stopped = true; reject(new Error('Popup closed before overrides activated')) }
          popup.contents.once('destroyed', closed)
          timer = setTimeout(() => { stopped = true; reject(new Error('Local Overrides activation timed out')) }, 15000)
        }),
      ])
      return true
    } catch (error) {
      if (!this.disposed && !popup.contents.isDestroyed()) popup.error = `Could not activate Local Overrides for this popup: ${sanitizedText(String(error))}`
      // Do not silently load an unmodified document or replay a POST after a failed activation.
      return false
    } finally {
      if (timer) clearTimeout(timer)
      if (closed) popup.contents.off('destroyed', closed)
    }
  }

  private requestHeadersSent(details: OnSendHeadersListenerDetails): void {
    const entry = this.networkEntry(details.id)
    if (entry) entry.requestHeaders = sanitizedHeaders(details.requestHeaders)
  }

  private responseHeadersReceived(details: OnHeadersReceivedListenerDetails): void {
    const entry = this.networkEntry(details.id)
    if (!entry) return
    entry.status = details.statusCode
    entry.responseHeaders = sanitizedHeaders(details.responseHeaders ?? {})
  }

  /** A completed request carries its status; a failed one, its error. */
  private requestFinished(id: number, status: number | null, error: string | null): void {
    const entry = this.networkEntry(id)
    if (!entry) return
    if (status !== null) entry.status = status
    if (error !== null) entry.error = error
    this.finishRequest(entry)
  }

  private networkEntry(id: number): BrowserNetworkEntry | undefined {
    return this.state.network.find(entry => entry.id === String(id))
  }

  private finishRequest(entry: BrowserNetworkEntry): void {
    const start = this.started.get(entry.id)
    entry.durationMs = start === undefined ? null : Date.now() - start
    this.started.delete(entry.id)
  }

  private rememberUrl(page: BrowserPage, url: string): void {
    let saved: string | null
    try { saved = restorableUrl(url) } catch { return }
    page.lastUrl = url
    // Restore the primary page, not a transient popup or authentication child.
    if (page !== this.pages.values().next().value) return
    if (!saved) return
    this.settingsWrite = this.settingsWrite.catch(() => {}).then(() => writeFileAtomic(this.settingsPath, JSON.stringify({ url: saved })))
    void this.settingsWrite.catch(error => { page.error = `Could not save browser URL: ${String(error)}` })
  }

  private refreshState(): void {
    if (this.disposed) return
    this.state.testing = this.reader.testState
    const contents = this.view.webContents
    if (contents && !contents.isDestroyed()) {
      const page = this.activePage
      this.state.url = contents.getURL() || page.lastUrl
      this.state.loading = page.loading
      this.state.error = page.error
      this.state.devtools = page.devtools
      this.state.activePageId = this.activePageId
      this.state.zoomFactor = contents.getZoomFactor()
      this.state.pages = [...this.pages].map(([id, entry]) => ({ id,
        title: entry.view.webContents.getTitle().slice(0, 160) || 'New page',
        url: entry.view.webContents.getURL() || entry.lastUrl,
      }))
      this.state.sitePermissions = this.sitePermissions.list()
      const dialog = this.reader.pendingDialog
      if (dialog) this.state.dialog = dialog
      else delete this.state.dialog
      this.state.history = this.history.list()
      if (this.findQuery) this.state.find = { query: this.findQuery, ...(this.findResult ?? { matches: 0, active: 0 }) }
      else delete this.state.find
      this.state.canGoBack = contents.navigationHistory.canGoBack()
      this.state.canGoForward = contents.navigationHistory.canGoForward()
      const setting = page.overrides ?? this.savedOverrides
      if (setting) this.state.overrides = { ...setting, devtools: page.overrides !== null, scope: this.devtoolsPartition ? 'session' : 'shared' }
      else delete this.state.overrides
      this.refreshOverrides()
    }
  }

  /**
   * Keeps the Local Overrides status current without blocking a snapshot: the selected page's DevTools answers while it
   * runs, since only then do overrides apply to the page; before that, the saved preferences say what it will use.
   */
  private refreshOverrides(): void {
    if (this.overridesRead || Date.now() - this.overridesReadAt < 1000) return
    this.overridesRead = this.readOverrides(this.activePage).catch(() => {})
      .finally(() => { this.overridesRead = null; this.overridesReadAt = Date.now() })
  }

  private async readOverrides(page: BrowserPage): Promise<void> {
    const tools = page.tools?.webContents
    if (tools && !tools.isDestroyed() && !tools.isLoading() && tools.getURL().startsWith('devtools://devtools/')) {
      // A fixed, read-only query in the native DevTools frontend, never in the inspected page.
      page.overrides = overridesFromDevtools(await tools.executeJavaScript(OVERRIDES_SCRIPT).catch(() => null))
      if (page.overrides) return
    } else page.overrides = null
    if (Date.now() - this.savedOverridesAt < 3000) return
    // Chromium saves Preferences a few seconds after a change, which is soon enough for a page whose DevTools is not running.
    const preferences = async (directory: string | null): Promise<unknown> => {
      if (!directory) return undefined
      try { return JSON.parse(await readFile(join(directory, 'Preferences'), 'utf8')) as unknown } catch { return undefined }
    }
    const folders = this.devtoolsPartition ? electronSession.fromPartition(this.devtoolsPartition) : electronSession.defaultSession
    const [partition, defaults] = await Promise.all([preferences(page.contents.session.storagePath), preferences(folders.storagePath)])
    this.savedOverrides = overridesFromPreferences(partition, defaults)
    this.savedOverridesAt = Date.now()
  }

  get snapshot(): BrowserDebugState {
    this.refreshState()
    return structuredClone(this.state)
  }

  async open(): Promise<BrowserDebugState> {
    if (this.disposed) throw new Error('Browser has closed')
    await this.startControl()
    let target: string | null = null
    // Scrub legacy settings even if manual navigation has already started.
    // Serialize with rememberUrl writes so cleanup cannot delete a newer setting.
    this.settingsWrite = this.settingsWrite.catch(() => {}).then(async () => {
      let raw: string
      try { raw = await readFile(this.settingsPath, 'utf8') }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
        throw error
      }
      let saved: { url?: unknown } | null = null
      try {
        saved = JSON.parse(raw) as { url?: unknown } | null
        if (typeof saved?.url === 'string') target = restorableUrl(saved.url)
      } catch { /* Invalid legacy URLs must not remain on disk or be replayed. */ }
      if (!target) await rm(this.settingsPath, { force: true })
      else if (saved?.url !== target) await writeFileAtomic(this.settingsPath, JSON.stringify({ url: target }))
    })
    try {
      await this.settingsWrite
      // A manually entered URL wins if navigation started during disk I/O.
      if (target && !this.activePage.lastUrl && !this.disposed && !this.view.webContents.getURL()) await this.navigate(target)
    } catch { /* An unavailable saved site leaves the URL field editable. */ }
    return this.snapshot
  }

  async navigate(url: string): Promise<BrowserDebugState> {
    const target = parseBrowserAddress(url).href
    const page = this.activePage
    page.error = null
    page.lastUrl = target
    try { await this.view.webContents.loadURL(target) }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ERR_ABORTED')) {
        throw new Error(sanitizedText(error instanceof Error ? error.message : String(error)))
      }
    }
    return this.snapshot
  }

  /** User-initiated only (desktop IPC). Resolves to prompt text for the clicked element, or null if cancelled. */
  async pickElement(onElement?: (text: string) => void): Promise<string | null> {
    if (this.disposed) throw new Error('Browser has closed')
    if (this.state.view !== 'page') throw new Error('Show the Page view before selecting an element.')
    return this.reader.pick(onElement)
  }

  cancelPick(): void { this.reader.cancelPick() }

  /** User-initiated only: the selected page's viewport, masked exactly like an assistant screenshot, placed on the clipboard
   * as an image so it can be attached to the prompt. Throws a readable reason when a safe screenshot is not possible. */
  async screenshotToClipboard(): Promise<{ redacted: boolean }> {
    if (this.disposed) throw new Error('Browser has closed')
    const result = await this.reader.read('screenshot', [String(this.activePageId)]) as { state?: string; reason?: string; imageBase64?: string; redacted?: boolean }
    if (result.state !== 'available' || !result.imageBase64) throw new Error(result.reason ?? 'A screenshot is not available right now.')
    const png = Buffer.from(result.imageBase64, 'base64')
    if (png.length === 0) throw new Error('The screenshot could not be read.')
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
    return { redacted: Boolean(result.redacted) }
  }

  /** The user's answer to an alert, confirm or leave-page dialog. */
  async answerDialog(accept: boolean): Promise<BrowserDebugState> {
    if (this.disposed) throw new Error('Browser has closed')
    await this.reader.answerDialog(accept)
    return this.snapshot
  }

  /** Find text in the selected page. `next` continues the current search instead of starting a new one. */
  find(text: string, forward = true, next = false): BrowserDebugState {
    if (this.disposed) throw new Error('Browser has closed')
    if (!text) { this.stopFind(); return this.snapshot }
    const query = text.slice(0, 500)
    if (!next || query !== this.findQuery) this.findResult = { matches: 0, active: 0 }
    this.findQuery = query
    // A new search takes no options: Chromium drops the first result when they are passed on the first request.
    if (next) this.view.webContents.findInPage(query, { forward, findNext: true })
    else this.view.webContents.findInPage(query)
    return this.snapshot
  }

  stopFind(): BrowserDebugState {
    this.endFind(false)
    return this.snapshot
  }

  /** Ends the search on the selected page, clearing its highlights. Called before the selection changes so a search never
   * outlives its page: the find bar would otherwise show the old page's results for the new page. */
  private endFind(notify = true): void {
    if (!this.findQuery) return
    const page = this.pages.get(this.activePageId)
    this.findQuery = ''; this.findResult = null
    if (page && !page.contents.isDestroyed()) page.contents.stopFindInPage('clearSelection')
    if (notify) this.notifyShortcut('find-close')
  }

  private showContextMenu(page: BrowserPage, params: ContextMenuInput & { x: number; y: number }): void {
    const contents = page.contents
    const items = contextMenuItems(params, { canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() })
    const menu = Menu.buildFromTemplate(items.map(item => 'separator' in item ? { type: 'separator' as const }
      : { label: item.label, enabled: item.enabled, click: () => { this.runContextAction(page, item.id, params) } }))
    this.showMenu(menu)
  }

  /** Runs one entry of the page's right-click menu. */
  private runContextAction(page: BrowserPage, id: ContextMenuId, params: ContextMenuInput & { x: number; y: number }): void {
    const contents = page.contents
    if (this.disposed || contents.isDestroyed()) return
    switch (id) {
      case 'back': this.action('back'); break
      case 'forward': this.action('forward'); break
      case 'reload': this.action('reload'); break
      case 'hard-reload': this.action('hard-reload'); break
      case 'cut': contents.cut(); break
      case 'copy': contents.copy(); break
      case 'paste': contents.paste(); break
      case 'select-all': contents.selectAll(); break
      case 'copy-link': if (/^https?:\/\//i.test(params.linkURL)) void clipboard.writeText(params.linkURL); break
      case 'copy-image-address': if (/^https?:\/\//i.test(params.srcURL)) void clipboard.writeText(params.srcURL); break
      case 'open-link': this.openInNewPage(params.linkURL); break
      case 'inspect': {
        // A tools view that already exists was loaded earlier, even when the Page view was showing, and will not load again.
        const reused = page.tools !== null
        this.showView('devtools')
        const tools = page.tools?.webContents
        const inspect = (): void => { if (!contents.isDestroyed()) contents.inspectElement(params.x, params.y) }
        if (reused && tools && !tools.isLoading()) inspect()
        else tools?.once('did-finish-load', () => setTimeout(inspect, 300))
        break
      }
    }
  }

  private openInNewPage(url: string): void {
    const source = this.activePage
    try { parseSafeHttpUrl(url) } catch { source.error = 'This browser opens HTTP and HTTPS links only.'; return }
    if (this.pages.size >= MAX_PAGES) { source.error = 'Close a browser page before opening another (32 pages maximum).'; return }
    const page = this.addPage(new WebContentsView({ webPreferences: { session: source.contents.session,
      sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: true } }), true)
    this.layout()
    void page.contents.loadURL(url).catch(error => { page.error = sanitizedText(String(error)) })
  }

  get picking(): boolean { return this.reader.picking }

  action(action: string): BrowserDebugState {
    if (action === 'testing:on' || action === 'testing:off') {
      if (this.disposed) throw new Error('Browser has closed')
      if (action === 'testing:on') this.showView('page')
      this.reader.setTesting(action === 'testing:on')
      return this.snapshot
    }
    if (action === 'new-page') {
      if (this.disposed) throw new Error('Browser has closed')
      if (this.pages.size >= MAX_PAGES) throw new Error('Close a browser page before opening another (32 pages maximum).')
      this.addPage(new WebContentsView({ webPreferences: { session: this.activePage.contents.session,
        sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: true } }), true)
      this.layout()
      return this.snapshot
    }
    const setting = /^(record-console|record-network|preserve-console|preserve-network):(on|off)$/.exec(action)
    if (setting) {
      const enabled = setting[2] === 'on'
      switch (setting[1]) {
        case 'record-console': this.state.recordingConsole = enabled; break
        case 'record-network': this.state.recordingNetwork = enabled; break
        case 'preserve-console': this.state.preserveConsole = enabled; break
        case 'preserve-network': this.state.preserveNetwork = enabled; break
      }
      return this.snapshot
    }
    if (action.startsWith('view:')) {
      const view = action.slice(5)
      if (!['page', 'console', 'network', 'devtools', 'activity'].includes(view)) throw new Error('Unknown browser view')
      this.showView(view as BrowserViewMode)
      return this.snapshot
    }
    const forget = /^forget-permission:(\d+)$/.exec(action)
    if (forget) { this.sitePermissions.forget(Number(forget[1])); return this.snapshot }
    if (action === 'forget-permissions') { this.sitePermissions.clear(); return this.snapshot }
    const pageAction = /^(select-page|close-page):(\d+)$/.exec(action)
    if (pageAction) {
      const id = Number(pageAction[2])
      const page = this.pages.get(id)
      if (!page) throw new Error('Unknown browser page')
      if (pageAction[1] === 'select-page') { if (id !== this.activePageId) { this.endFind(); this.reader.setTesting(false); this.reader.cancelPick() } this.activePageId = id; this.showView('page') }
      else if (this.pages.size > 1) page.view.webContents.close()
      return this.snapshot
    }
    const contents = this.view.webContents
    switch (action) {
      case 'back': if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break
      case 'forward': if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break
      case 'reload': this.activePage.error = null; contents.reload(); break
      // Re-fetch every resource instead of trusting the HTTP cache, like Ctrl+Shift+R in Chrome.
      case 'hard-reload': this.activePage.error = null; contents.reloadIgnoringCache(); break
      case 'zoom-in': case 'zoom-out': case 'zoom-reset': {
        const factor = nextZoomFactor(contents.getZoomFactor(), action.slice(5) as 'in' | 'out' | 'reset')
        contents.setZoomFactor(factor)
        this.zoom.set(contents.getURL(), factor)
        break
      }
      case 'clear': this.state.console = []; this.state.network = []; this.started.clear(); this.reader.clear(); break
      case 'clear-console': this.state.console = []; break
      case 'clear-network': this.state.network = []; this.started.clear(); this.reader.clear(); break
      case 'devtools': this.showView(this.activePage.devtools && this.state.view !== 'page' ? 'page' : 'devtools'); break
      default: throw new Error('Unknown browser action')
    }
    return this.snapshot
  }

  private showView(view: BrowserViewMode): void {
    if (view !== 'page') { this.reader.setTesting(false); this.reader.cancelPick() }
    this.state.view = view
    const page = this.activePage
    page.devtools = ['console', 'network', 'devtools'].includes(view)
    if (!page.devtools) { this.layout(); return }
    page.panel = view === 'devtools' ? 'sources' : view as 'console' | 'network'
    this.ensureDevtools(page)
    this.layout()
  }

  /** Create a page's native DevTools independently of which page or panel is visible. */
  private ensureDevtools(page: BrowserPage): WebContents {
    if (!page.tools) {
      // DevTools keeps its added folders (the Local Overrides folder) in its own view's session: the default one, shared by
      // every session, or this session's own partition.
      page.tools = new WebContentsView({ webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true,
        ...(this.devtoolsPartition ? { partition: this.devtoolsPartition } : {}) } })
      page.tools.setVisible(false)
      if (page.attached) this.owner.contentView.addChildView(page.tools)
      page.tools.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      page.tools.webContents.on('did-finish-load', () => this.selectDevtoolsPanel(page))
      page.contents.setDevToolsWebContents(page.tools.webContents)
      page.contents.openDevTools({ mode: 'detach', activate: false })
    } else if (!page.tools.webContents.isLoading()) {
      this.selectDevtoolsPanel(page)
    }
    return page.tools.webContents
  }

  private selectDevtoolsPanel(page: BrowserPage): void {
    const tools = page.tools?.webContents
    if (!tools || tools.isDestroyed() || !page.panel || this.disposed) return
    if (!tools.getURL().startsWith('devtools://devtools/')) return
    // Only execute a fixed panel name in the native DevTools frontend, never in
    // the inspected page. Chromium queues showPanel until its frontend is ready.
    const panel = page.panel
    void tools.executeJavaScript(`globalThis.DevToolsAPI.showPanel(${JSON.stringify(panel)})`).catch(error => {
      if (!this.disposed && !page.contents.isDestroyed() && page.panel === panel) {
        page.error = `Could not select DevTools panel: ${sanitizedText(String(error))}`
      }
    })
  }

  setBounds(bounds: BrowserBounds | null): void {
    if (!bounds) { this.reader.setTesting(false); this.reader.cancelPick() }
    this.bounds = bounds
    this.layout()
  }

  /** Move the same page and DevTools when its terminal is popped out or docked. */
  setOwner(owner: BrowserWindow): void {
    if (this.owner === owner || this.disposed) return
    this.setBounds(null)
    if (!this.owner.isDestroyed()) {
      for (const page of this.pages.values()) {
        if (page.attached) {
          this.owner.contentView.removeChildView(page.view)
          if (page.tools) this.owner.contentView.removeChildView(page.tools)
        }
        page.attached = false
      }
    }
    this.owner = owner
  }

  private layout(): void {
    if (this.disposed || this.owner.isDestroyed()) return
    const b = this.bounds
    for (const [id, page] of this.pages) {
      if (!page.attached && b) {
        this.owner.contentView.addChildView(page.view)
        if (page.tools) this.owner.contentView.addChildView(page.tools)
        page.attached = true
      }
      page.view.setVisible(Boolean(b && id === this.activePageId && this.state.view === 'page'))
      page.tools?.setVisible(Boolean(b && id === this.activePageId && page.devtools && ['console', 'network', 'devtools'].includes(this.state.view)))
    }
    if (!b) return
    const zoom = this.owner.webContents.getZoomFactor()
    const [ownerWidth = 0, ownerHeight = 0] = this.owner.getContentSize()
    const x = Math.max(0, Math.min(ownerWidth, Math.round(b.x * zoom)))
    const y = Math.max(0, Math.min(ownerHeight, Math.round(b.y * zoom)))
    const width = Math.max(0, Math.min(ownerWidth - x, Math.round(b.width * zoom)))
    const height = Math.max(0, Math.min(ownerHeight - y, Math.round(b.height * zoom)))
    // Inspection replaces the visible surface while preserving the page's full
    // viewport, so opening Console/Network/DevTools doesn't resize the web app.
    this.view.setBounds({ x, y, width, height })
    this.activePage.tools?.setBounds({ x, y, width, height })
  }

  private removePage(id: number, storage: Session): void {
    const page = this.pages.get(id)
    if (!page) return
    const primary = page === this.pages.values().next().value
    if (page.attached && !this.owner.isDestroyed()) {
      this.owner.contentView.removeChildView(page.view)
      if (page.tools) this.owner.contentView.removeChildView(page.tools)
    }
    this.pages.delete(id)
    const tools = page.tools?.webContents
    if (this.disposed) { if (tools && !tools.isDestroyed()) tools.close(); return }
    if (this.pages.size === 0) {
      this.addPage(new WebContentsView({ webPreferences: { session: storage,
        sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: true } }), true)
    } else if (this.activePageId === id) { this.endFind(); this.reader.setTesting(false); this.activePageId = this.pages.keys().next().value!; this.showView('page') }
    if (primary) this.rememberUrl(this.pages.values().next().value!, this.pages.values().next().value!.view.webContents.getURL())
    if (tools && !tools.isDestroyed()) tools.close()
    this.layout()
  }

  private async startControl(): Promise<void> {
    if (this.serverStart) return this.serverStart
    this.serverStart = this.listen().catch(error => { this.serverStart = null; throw error })
    return this.serverStart
  }

  /**
   * A test sent by the macOS and Linux helper: the plan's text (read by `curl`), its `COPILOT_TEST_` inputs, and the new
   * report file to write. The files are reserved and written the way `copilot-desktop browser test` does it.
   */
  private async testFromForm(request: IncomingMessage, type: string, signal: AbortSignal): Promise<unknown> {
    const body = await readBody(request, MAX_TEST_FORM_BYTES)
    if (body === null) throw new Error('Test plan exceeds 128 KiB.')
    const fields = await parseFormFields(body, type)
    const text = fields?.get('plan')
    const output = fields?.get('output')
    if (text === undefined || output === undefined) throw new Error('Invalid test request.')
    if (Buffer.byteLength(text) > MAX_TEST_BYTES) throw new Error('Test plan exceeds 128 KiB.')
    const inputs: Record<string, string> = {}
    for (const [name, value] of fields!) if (name.startsWith('env:')) inputs[name.slice(4)] = value
    const plan = parseBrowserTest(text, inputs)
    return executeBrowserTest(plan, output, output, value => this.reader.test(value, signal))
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(body))
      }
      const port = (server.address() as { port: number } | null)?.port
      // No CORS; reject browser-originated requests and DNS rebinding before authentication.
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) { send(403, { message: 'Forbidden' }); return }
      const authorization = request.headers.authorization ?? ''
      if (!constantTimeTokenEqual(authorization, `Bearer ${this.token}`)) { send(401, { message: 'Unauthorized' }); return }
      if (request.url === '/test') {
        if (request.method !== 'POST') { send(405, { message: 'Tests require POST.' }); return }
        const type = request.headers['content-type']
        const cancelled = new AbortController()
        response.once('close', () => cancelled.abort())
        if (isFormType(type)) {
          void this.testFromForm(request, type!, cancelled.signal).then(result => { if (!response.destroyed) send(200, result) },
            error => { if (!response.destroyed && !response.headersSent) send(400, { message: sanitizedText(error instanceof Error ? error.message : 'Test unavailable.') }) })
          return
        }
        if (!isJsonType(type)) { send(415, { message: 'Tests require JSON.' }); return }
        void (async () => {
          const chunks: Buffer[] = []; let bytes = 0
          for await (const chunk of request) {
            bytes += chunk.length
            if (bytes > MAX_TEST_BYTES) { send(413, { message: 'Test plan exceeds 128 KiB.' }); return }
            chunks.push(Buffer.from(chunk))
          }
          let plan: unknown
          try { plan = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
          catch { send(400, { message: 'Invalid test JSON.' }); return }
          const result = await this.reader.test(plan, cancelled.signal)
          if (!response.destroyed) send(200, result)
        })().catch(error => { if (!response.destroyed && !response.headersSent) send(400, { message: sanitizedText(error instanceof Error ? error.message : 'Test unavailable.') }) })
        return
      }
      if (request.url?.startsWith('/read/')) {
        const url = new URL(request.url, `http://127.0.0.1:${port}`)
        const command = url.pathname.slice(6)
        if (!BROWSER_READ_COMMANDS.some(value => value === command)) { send(404, { message: 'Unknown browser read route' }); return }
        if (request.method !== browserReadMethod(command)) { send(405, { message: 'Incorrect browser read method' }); return }
        const args = url.searchParams.getAll('arg')
        try { validateBrowserReadCommand(command, args) }
        catch (error) { send(400, { message: error instanceof Error ? error.message : 'Invalid browser read arguments' }); return }
        // The macOS and Linux helper cannot decode the image itself, so it names a new file for the desktop to save it in.
        const save = command === 'screenshot' ? url.searchParams.get('save') : null
        if (save !== null) {
          try { validateBrowserScreenshotPath(save) }
          catch (error) { send(400, { message: error instanceof Error ? error.message : 'Invalid screenshot path' }); return }
        }
        const cancelled = new AbortController()
        response.once('close', () => cancelled.abort())
        void this.reader.read(command, args, cancelled.signal).then(value => save === null ? value : saveScreenshot(value, save)).then(value => { if (!response.destroyed) send(200, value) }, error => {
          if (!response.destroyed) send(400, { message: sanitizedText(error instanceof Error ? error.message : 'Browser content unavailable') })
        })
        return
      }
      if (request.method !== 'GET') { send(405, { message: 'Read-only browser API' }); return }
      if (request.url === '/status') {
        this.refreshState()
        const { console, network, pages, sitePermissions: _sitePermissions, history: _history, find: _find, overrides: _overrides, ...state } = this.state
        send(200, { ...state, url: sanitizedUrl(state.url),
          // Chromium can synthesize titles from URLs without a scheme. Omit titles
          // from CLI metadata rather than exposing credentials in those strings.
          pages: pages.map(page => ({ id: page.id, url: sanitizedUrl(page.url) })),
          consoleCount: console.filter(entry => entry.pageId === this.activePageId).length,
          networkCount: network.filter(entry => entry.pageId === this.activePageId).length })
      } else if (request.url === '/console') send(200, this.state.console.filter(entry => entry.pageId === this.activePageId))
      else if (request.url === '/network') send(200, this.state.network.filter(entry => entry.pageId === this.activePageId))
      else if (/^\/request\/\d+$/.test(request.url ?? '')) {
        const entry = this.state.network.find(entry => entry.id === request.url!.slice(9))
        send(entry ? 200 : 404, entry ?? { message: 'Request not found; activity retains the latest 300 requests.' })
      } else send(404, { message: 'Unknown browser route' })
    })
    this.server = server
    try {
      await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
      const port = (server.address() as { port: number }).port
      await writeFileAtomic(this.endpointPath, JSON.stringify({ pid: process.pid, port, token: this.token }))
    } catch (error) { server.close(); this.server = null; throw error }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    const storage = this.activePage.contents.session
    this.setBounds(null)
    if (!this.owner.isDestroyed()) {
      for (const page of this.pages.values()) {
        if (page.attached) {
          this.owner.contentView.removeChildView(page.view)
          if (page.tools) this.owner.contentView.removeChildView(page.tools)
          page.attached = false
        }
      }
    }
    this.disposed = true
    // Site permissions and zoom belong to every session's browser; closing this one only stops following them.
    browsersBySession.get(storage)?.delete(this)
    this.unsubscribeZoom()
    this.reader.dispose()
    await this.serverStart?.catch(() => {})
    if (this.server) { this.server.closeAllConnections(); this.server.close(); this.server = null }
    try {
      const saved = JSON.parse(await readFile(this.endpointPath, 'utf8')) as { token?: string }
      if (saved.token === this.token) await rm(this.endpointPath, { force: true })
    } catch { /* Already removed or not published. */ }
    await this.settingsWrite.catch(() => {})
    try {
      storage.flushStorageData()
      await storage.cookies.flushStore()
    } catch (error) {
      this.reportError(`Could not flush browser storage: ${sanitizedText(String(error))}`)
    } finally {
      for (const page of [...this.pages.values()]) {
        const tools = page.tools?.webContents
        if (!page.contents.isDestroyed()) page.contents.close()
        if (tools && !tools.isDestroyed()) tools.close()
      }
    }
  }
}
