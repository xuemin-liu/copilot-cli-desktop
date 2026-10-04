import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserWindowConstructorOptions, Session, WebContents, WebRequest } from 'electron'
import { browserControlPath } from '../cli/browser-control.js'
import { constantTimeTokenEqual } from '../cli/runtime-core.js'
import { writeFileAtomic } from './atomic-file.js'
import { parseSafeHttpUrl } from './external-targets.js'
import { parseBrowserAddress } from './browser-url.js'
import type { BrowserBounds, BrowserDebugState, BrowserNetworkEntry, BrowserViewMode } from './browser-debug-types.js'
import { restorableUrl, sanitizedHeaders, sanitizedText, sanitizedUrl } from './browser-privacy.js'

const MAX_ENTRIES = 300
const MAX_PAGES = 32

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
}

/** Own browser session, with native Chromium DevTools and read-only CLI telemetry.
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
  private state: BrowserDebugState = {
    activePageId: 0, pages: [], zoomFactor: 1, view: 'page',
    recordingConsole: true, recordingNetwork: true, preserveConsole: true, preserveNetwork: true,
    url: '', loading: false, canGoBack: false, canGoForward: false,
    devtools: false, error: null, console: [], network: [],
  }

  constructor(private owner: BrowserWindow, private readonly settingsPath: string,
    options: { endpointPath?: string; partition?: string; reportError?: (message: string) => void } = {}) {
    this.endpointPath = options.endpointPath ?? browserControlPath()
    this.reportError = options.reportError ?? (message => console.warn(message))
    const view = new WebContentsView({ webPreferences: {
      partition: options.partition ?? `browser-debug:${randomBytes(16).toString('hex')}`, sandbox: true, contextIsolation: true,
      nodeIntegration: false, devTools: true,
    } })
    this.addPage(view, true)
    const session = view.webContents.session
    session.setPermissionCheckHandler(() => false)
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.on('will-download', event => event.preventDefault())
    this.captureNetwork(session.webRequest)
  }

  /** The toolbar and DevTools act on the selected page; every page belongs to this terminal. */
  get view(): WebContentsView { return this.activePage.view }

  private get activePage(): BrowserPage { return this.pages.get(this.activePageId)! }

  private addPage(view: WebContentsView, activate: boolean): BrowserPage {
    const contents = view.webContents
    const storage = contents.session
    const page: BrowserPage = { contents, view, tools: null, attached: false, loading: false, error: null, lastUrl: '', devtools: false, panel: null }
    this.pages.set(contents.id, page)
    if (activate) { this.activePageId = contents.id; this.state.view = 'page' }
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
    contents.on('will-navigate', (event, url) => {
      try { parseSafeHttpUrl(url) } catch { event.preventDefault() }
    })
    contents.on('will-redirect', (event, url) => {
      try { parseSafeHttpUrl(url) } catch { event.preventDefault() }
    })
    contents.on('did-start-loading', () => { page.loading = true })
    contents.on('did-start-navigation', details => {
      if (!details.isMainFrame || details.isSameDocument) return
      if (!this.state.preserveConsole) this.state.console = this.state.console.filter(entry => entry.pageId !== contents.id)
      if (!this.state.preserveNetwork) {
        for (const entry of this.state.network) if (entry.pageId === contents.id) this.started.delete(entry.id)
        this.state.network = this.state.network.filter(entry => entry.pageId !== contents.id)
      }
    })
    contents.on('did-stop-loading', () => { page.loading = false })
    contents.on('did-fail-load', (_event, code, description, _url, main) => {
      if (main && code !== -3) page.error = sanitizedText(description)
    })
    contents.on('did-navigate', (_event, url) => this.rememberUrl(page, url))
    contents.on('console-message', details => {
      if (!this.state.recordingConsole) return
      this.state.console.push({ id: ++this.consoleSequence, pageId: contents.id, timestamp: new Date().toISOString(),
        level: details.level, message: sanitizedText(details.message), source: sanitizedUrl(details.sourceId).slice(0, 2048), line: details.lineNumber })
      if (this.state.console.length > MAX_ENTRIES) this.state.console.shift()
    })
    const id = contents.id
    contents.on('devtools-closed', () => {
      page.devtools = false
      if (id === this.activePageId && ['console', 'network', 'devtools'].includes(this.state.view)) this.state.view = 'page'
      if (this.pages.has(id)) this.layout()
    })
    contents.once('destroyed', () => this.removePage(id, storage))
    return page
  }

  private captureNetwork(request: WebRequest): void {
    const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
    request.onBeforeRequest(filter, (details, callback) => {
      if (this.state.recordingNetwork && details.webContentsId !== undefined && this.pages.has(details.webContentsId)) {
        const id = String(details.id)
        const previous = this.state.network.find(entry => entry.id === id)
        if (previous) previous.url = sanitizedUrl(details.url)
        else {
          this.started.set(id, Date.now())
          this.state.network.push({ id, pageId: details.webContentsId, timestamp: new Date().toISOString(), method: details.method,
            url: sanitizedUrl(details.url), resourceType: details.resourceType, status: null, durationMs: null, error: null,
            requestHeaders: {}, responseHeaders: {}, redirects: [] })
          if (this.state.network.length > MAX_ENTRIES) {
            const removed = this.state.network.shift()
            if (removed) this.started.delete(removed.id)
          }
        }
      }
      callback({})
    })
    request.onSendHeaders(filter, details => {
      const entry = this.networkEntry(details.id)
      if (entry) entry.requestHeaders = sanitizedHeaders(details.requestHeaders)
    })
    request.onHeadersReceived(filter, (details, callback) => {
      const entry = this.networkEntry(details.id)
      if (entry) {
        entry.status = details.statusCode
        entry.responseHeaders = sanitizedHeaders(details.responseHeaders ?? {})
      }
      callback({})
    })
    request.onBeforeRedirect(filter, details => {
      this.networkEntry(details.id)?.redirects.push(sanitizedUrl(details.redirectURL))
    })
    request.onCompleted(filter, details => {
      const entry = this.networkEntry(details.id)
      if (entry) { entry.status = details.statusCode; this.finishRequest(entry) }
    })
    request.onErrorOccurred(filter, details => {
      const entry = this.networkEntry(details.id)
      if (entry) { entry.error = details.error; this.finishRequest(entry) }
    })
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
      this.state.canGoBack = contents.navigationHistory.canGoBack()
      this.state.canGoForward = contents.navigationHistory.canGoForward()
    }
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

  action(action: string): BrowserDebugState {
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
    const pageAction = /^(select-page|close-page):(\d+)$/.exec(action)
    if (pageAction) {
      const id = Number(pageAction[2])
      const page = this.pages.get(id)
      if (!page) throw new Error('Unknown browser page')
      if (pageAction[1] === 'select-page') { this.activePageId = id; this.showView('page') }
      else if (this.pages.size > 1) page.view.webContents.close()
      return this.snapshot
    }
    const contents = this.view.webContents
    switch (action) {
      case 'back': if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break
      case 'forward': if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break
      case 'reload': this.activePage.error = null; contents.reload(); break
      case 'clear': this.state.console = []; this.state.network = []; this.started.clear(); break
      case 'clear-console': this.state.console = []; break
      case 'clear-network': this.state.network = []; this.started.clear(); break
      case 'devtools': this.showView(this.activePage.devtools && this.state.view !== 'page' ? 'page' : 'devtools'); break
      default: throw new Error('Unknown browser action')
    }
    return this.snapshot
  }

  private showView(view: BrowserViewMode): void {
    this.state.view = view
    const page = this.activePage
    page.devtools = ['console', 'network', 'devtools'].includes(view)
    if (!page.devtools) { this.layout(); return }
    page.panel = view === 'devtools' ? 'sources' : view as 'console' | 'network'
    if (!page.tools) {
      page.tools = new WebContentsView({ webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
      if (page.attached) this.owner.contentView.addChildView(page.tools)
      page.tools.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      page.tools.webContents.on('did-finish-load', () => this.selectDevtoolsPanel(page))
      page.contents.setDevToolsWebContents(page.tools.webContents)
      page.contents.openDevTools({ mode: 'detach', activate: false })
    } else if (!page.tools.webContents.isLoading()) {
      this.selectDevtoolsPanel(page)
    }
    this.layout()
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
    } else if (this.activePageId === id) { this.activePageId = this.pages.keys().next().value!; this.showView('page') }
    if (primary) this.rememberUrl(this.pages.values().next().value!, this.pages.values().next().value!.view.webContents.getURL())
    if (tools && !tools.isDestroyed()) tools.close()
    this.layout()
  }

  private async startControl(): Promise<void> {
    if (this.serverStart) return this.serverStart
    this.serverStart = this.listen().catch(error => { this.serverStart = null; throw error })
    return this.serverStart
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify(body))
      }
      const port = (server.address() as { port: number } | null)?.port
      // No CORS; reject browser-originated requests and DNS rebinding before authentication.
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) { send(403, { message: 'Forbidden' }); return }
      const authorization = request.headers.authorization ?? ''
      if (!constantTimeTokenEqual(authorization, `Bearer ${this.token}`)) { send(401, { message: 'Unauthorized' }); return }
      if (request.method !== 'GET') { send(405, { message: 'Read-only browser API' }); return }
      if (request.url === '/status') {
        this.refreshState()
        const { console, network, pages, ...state } = this.state
        send(200, { ...state, url: sanitizedUrl(state.url),
          // Chromium can synthesize titles from URLs without a scheme. Omit titles
          // from CLI metadata rather than exposing credentials in those strings.
          pages: pages.map(page => ({ id: page.id, url: sanitizedUrl(page.url) })),
          consoleCount: console.length, networkCount: network.length })
      } else if (request.url === '/console') send(200, this.state.console)
      else if (request.url === '/network') send(200, this.state.network)
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
