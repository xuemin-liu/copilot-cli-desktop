import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { BrowserWindow, WebContentsView } from 'electron'
import type { WebRequest } from 'electron'
import { browserControlPath } from '../cli/browser-control.js'
import { constantTimeTokenEqual } from '../cli/runtime-core.js'
import { writeFileAtomic } from './atomic-file.js'
import { parseSafeHttpUrl } from './external-targets.js'
import type { BrowserBounds, BrowserDebugState, BrowserNetworkEntry } from './browser-debug-types.js'

const MAX_ENTRIES = 300
const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie)$/i

function sanitizedHeaders<T extends string | string[]>(headers: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name,
    SENSITIVE_HEADERS.test(name) ? (Array.isArray(value) ? ['[redacted]'] : '[redacted]') : value,
  ])) as Record<string, T>
}

/** Own browser session, with native Chromium DevTools and read-only CLI telemetry.
 * Capture uses Electron events, so opening DevTools cannot detach a CDP collector. */
export class BrowserDebug {
  readonly view: WebContentsView
  private tools: WebContentsView | null = null
  private server: Server | null = null
  private serverStart: Promise<void> | null = null
  private readonly token = randomBytes(32).toString('hex')
  private readonly endpointPath = browserControlPath()
  private consoleSequence = 0
  private bounds: BrowserBounds | null = null
  private readonly started = new Map<string, number>()
  private attached = false
  private disposed = false
  private settingsWrite = Promise.resolve()
  private lastUrl = ''
  private state: BrowserDebugState = {
    url: '', loading: false, canGoBack: false, canGoForward: false,
    devtools: false, error: null, console: [], network: [],
  }

  constructor(private readonly owner: BrowserWindow, private readonly settingsPath: string) {
    this.view = new WebContentsView({ webPreferences: {
      partition: 'persist:browser-debug', sandbox: true, contextIsolation: true,
      nodeIntegration: false, devTools: true,
    } })
    const contents = this.view.webContents
    const session = contents.session
    session.setPermissionCheckHandler(() => false)
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.on('will-download', event => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      try { parseSafeHttpUrl(url) } catch { event.preventDefault() }
    })
    contents.on('will-redirect', (event, url) => {
      try { parseSafeHttpUrl(url) } catch { event.preventDefault() }
    })
    contents.on('did-start-loading', () => { this.state.loading = true })
    contents.on('did-stop-loading', () => { this.state.loading = false })
    contents.on('did-fail-load', (_event, code, description, _url, main) => {
      if (main && code !== -3) this.state.error = description
    })
    contents.on('did-navigate', (_event, url) => this.rememberUrl(url))
    contents.on('did-navigate-in-page', (_event, url, main) => { if (main) this.rememberUrl(url) })
    contents.on('console-message', details => {
      this.state.console.push({ id: ++this.consoleSequence, timestamp: new Date().toISOString(),
        level: details.level, message: details.message.slice(0, 8192), source: details.sourceId.slice(0, 2048), line: details.lineNumber })
      if (this.state.console.length > MAX_ENTRIES) this.state.console.shift()
    })
    contents.on('devtools-closed', () => { this.state.devtools = false; this.layout() })
    this.captureNetwork(session.webRequest)
  }

  private captureNetwork(request: WebRequest): void {
    const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
    request.onBeforeRequest(filter, (details, callback) => {
      if (details.webContentsId === this.view.webContents.id) {
        const id = String(details.id)
        const previous = this.state.network.find(entry => entry.id === id)
        if (previous) previous.url = details.url
        else {
          this.started.set(id, Date.now())
          this.state.network.push({ id, timestamp: new Date().toISOString(), method: details.method,
            url: details.url, resourceType: details.resourceType, status: null, durationMs: null, error: null,
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
      this.networkEntry(details.id)?.redirects.push(details.redirectURL)
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

  private rememberUrl(url: string): void {
    try { parseSafeHttpUrl(url) } catch { return }
    this.lastUrl = url
    this.settingsWrite = this.settingsWrite.catch(() => {}).then(() => writeFileAtomic(this.settingsPath, JSON.stringify({ url })))
    void this.settingsWrite.catch(error => { this.state.error = `Could not save browser URL: ${String(error)}` })
  }

  get snapshot(): BrowserDebugState {
    const contents = this.view.webContents
    if (contents && !contents.isDestroyed()) {
      this.state.url = contents.getURL() || this.lastUrl
      this.state.canGoBack = contents.navigationHistory.canGoBack()
      this.state.canGoForward = contents.navigationHistory.canGoForward()
    }
    return structuredClone(this.state)
  }

  async open(): Promise<BrowserDebugState> {
    if (this.disposed) throw new Error('Browser has closed')
    await this.startControl()
    if (!this.lastUrl && !this.view.webContents.getURL()) {
      try {
        const saved = JSON.parse(await readFile(this.settingsPath, 'utf8')) as { url?: unknown }
        // A manually entered URL wins if navigation started during disk I/O.
        if (typeof saved.url === 'string' && !this.lastUrl && !this.disposed && !this.view.webContents.getURL()) await this.navigate(saved.url)
      } catch { /* A first launch or unavailable saved site leaves the URL field editable. */ }
    }
    return this.snapshot
  }

  async navigate(url: string): Promise<BrowserDebugState> {
    const target = parseSafeHttpUrl(url).href
    this.state.error = null
    this.lastUrl = target
    await this.view.webContents.loadURL(target)
    return this.snapshot
  }

  action(action: string): BrowserDebugState {
    const contents = this.view.webContents
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    else if (action === 'reload') { this.state.error = null; contents.reload() }
    else if (action === 'clear') { this.state.console = []; this.state.network = []; this.started.clear() }
    else if (action === 'devtools') this.toggleDevtools()
    else if (!['back', 'forward'].includes(action)) throw new Error('Unknown browser action')
    return this.snapshot
  }

  private toggleDevtools(): void {
    // Custom DevTools contents do not emit the managed-window close events.
    // Hide the view while retaining its interception session and overrides.
    if (this.state.devtools) { this.state.devtools = false; this.layout(); return }
    if (!this.tools) {
      this.tools = new WebContentsView({ webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
      this.owner.contentView.addChildView(this.tools)
      this.view.webContents.setDevToolsWebContents(this.tools.webContents)
      this.view.webContents.openDevTools({ mode: 'detach', activate: false })
    }
    this.state.devtools = true
    this.layout()
  }

  setBounds(bounds: BrowserBounds | null): void {
    this.bounds = bounds
    this.layout()
  }

  private layout(): void {
    if (this.disposed || this.owner.isDestroyed()) return
    if (!this.attached && this.bounds) { this.owner.contentView.addChildView(this.view); this.attached = true }
    const b = this.bounds
    this.view.setVisible(Boolean(b))
    this.tools?.setVisible(Boolean(b && this.state.devtools))
    if (!b) return
    const zoom = this.owner.webContents.getZoomFactor()
    const [ownerWidth = 0, ownerHeight = 0] = this.owner.getContentSize()
    const x = Math.max(0, Math.min(ownerWidth, Math.round(b.x * zoom)))
    const y = Math.max(0, Math.min(ownerHeight, Math.round(b.y * zoom)))
    const width = Math.max(0, Math.min(ownerWidth - x, Math.round(b.width * zoom)))
    const height = Math.max(0, Math.min(ownerHeight - y, Math.round(b.height * zoom)))
    const pageHeight = this.state.devtools ? Math.floor(height * 0.45) : height
    this.view.setBounds({ x, y, width, height: pageHeight })
    this.tools?.setBounds({ x, y: y + pageHeight, width, height: height - pageHeight })
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
      const snapshot = this.snapshot
      if (request.url === '/status') {
        const { console, network, ...state } = snapshot
        send(200, { ...state, consoleCount: console.length, networkCount: network.length })
      } else if (request.url === '/console') send(200, snapshot.console)
      else if (request.url === '/network') send(200, snapshot.network)
      else if (/^\/request\/\d+$/.test(request.url ?? '')) {
        const entry = snapshot.network.find(entry => entry.id === request.url!.slice(9))
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
    this.disposed = true
    await this.serverStart?.catch(() => {})
    if (this.server) { this.server.closeAllConnections(); this.server.close(); this.server = null }
    try {
      const saved = JSON.parse(await readFile(this.endpointPath, 'utf8')) as { token?: string }
      if (saved.token === this.token) await rm(this.endpointPath, { force: true })
    } catch { /* Already removed or not published. */ }
    await this.settingsWrite.catch(() => {})
    const contents = this.view.webContents
    const tools = this.tools?.webContents
    if (contents && !contents.isDestroyed()) contents.close()
    if (tools && !tools.isDestroyed()) tools.close()
  }
}
