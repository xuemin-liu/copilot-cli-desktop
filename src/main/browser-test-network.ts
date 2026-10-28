import { testRequestMatches, type TestNetworkFailure, type TestRequestMatch } from './browser-test-plan.js'
import { readableUrl } from './browser-read-privacy.js'

type Params = Record<string, any>
type Send = (method: string, params: Params, session?: string) => Promise<unknown>
interface RequestRecord { id: string; frame: string; url: string; method: string; state: string; status?: number; timestamp: string; events: string[] }

/** A per-WebContents, per-run observer/interceptor. Never installed on the storage Session. */
export class BrowserTestNetwork {
  private readonly requests = new Map<string, RequestRecord>()
  private readonly sessions = new Set<string | undefined>()
  private readonly affected: Record<string, unknown>[] = []
  private readonly intercepted = new Set<string>()
  private readonly rules: (TestNetworkFailure & { remaining: number; expires: number })[]
  private readonly timers: ReturnType<typeof setTimeout>[] = []
  private stopped = false
  private truncated = false
  private cleanupFailed = false

  detached(): void { this.stopped = true; this.sessions.clear(); for (const timer of this.timers) clearTimeout(timer) }

  constructor(rules: TestNetworkFailure[], private readonly origin: string, private readonly frames: Set<string>, private readonly send: Send, private readonly active: () => boolean = () => true) {
    const now = Date.now()
    this.rules = rules.map(rule => {
      if (new URL(rule.urlPattern.replaceAll('*', 'wildcard')).origin !== origin) throw new Error('Network failure rules must stay within the Testing mode origin.')
      return { ...rule, remaining: rule.maxRequests, expires: now + rule.durationMs }
    })
  }

  async start(): Promise<void> {
    if (!this.rules.length) return
    this.sessions.add(undefined)
    await this.send('Fetch.enable', { patterns: this.rules.map(rule => ({ urlPattern: rule.urlPattern, requestStage: 'Request' })) })
    for (const rule of this.rules) this.timers.push(setTimeout(() => { void this.expire().catch(() => { this.cleanupFailed = true }) }, rule.durationMs + 1))
  }

  private async expire(): Promise<void> {
    if (this.rules.every(rule => rule.remaining === 0 || rule.expires <= Date.now())
      && (this.intercepted.size === 0 || this.rules.every(rule => rule.expires <= Date.now()))) await this.stop()
  }

  async message(method: string, params: Params, session?: string): Promise<void> {
    if (method === 'Page.frameNavigated') {
      const frame = params.frame
      if (frame && new URL(String(frame.url), this.origin).origin !== this.origin) this.frames.delete(String(frame.id))
    }
    const key = `${session ?? ''}:${String(params.requestId)}`
    if (method === 'Fetch.requestPaused') {
      // Only the top-level CDP target is intercepted. New child targets and other
      // pages/sessions are never enrolled. Unknown/foreign frames pass through.
      const rule = !this.stopped && this.active() && this.frames.has(String(params.frameId)) && this.rules.find(rule => rule.remaining > 0 && rule.expires > Date.now()
        && new URL(String(params.request.url)).origin === this.origin && testRequestMatches(rule, String(params.request.url), String(params.request.method)))
      if (!rule) { await this.send('Fetch.continueRequest', { requestId: params.requestId }, session).catch(() => {}); return }
      rule.remaining--
      if (params.networkId) this.intercepted.add(`${session ?? ''}:${String(params.networkId)}`)
      const affected: Record<string, unknown> = { rule: this.rules.indexOf(rule) + 1, url: readableUrl(String(params.request.url)), method: params.request.method,
        failure: rule.failure, networkIdAvailable: Boolean(params.networkId), ...(rule.status ? { status: rule.status } : {}), timestamp: new Date().toISOString() }
      this.affected.push(affected)
      try {
        if (rule.failure === 'transport') await this.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' }, session)
        else await this.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: rule.status,
          responseHeaders: [{ name: 'Content-Length', value: '0' }, { name: 'Content-Type', value: 'text/plain' }], body: '' }, session)
      } catch {
        affected.delivery = 'uncertain'
        await this.send('Fetch.continueRequest', { requestId: params.requestId }, session).catch(() => {})
      }
      // Disabling Fetch immediately after fulfillRequest can truncate the body
      // after the page received its status. Wait for the terminal Network event.
      return
    }
    if (method === 'Network.requestWillBeSent' && /^https?:\/\//.test(String(params.request?.url))) {
      // Keep raw URLs only inside the run for matching, never bodies or headers.
      this.requests.set(key, { id: key, frame: String(params.frameId), url: String(params.request.url), method: String(params.request.method), state: 'loading', timestamp: new Date().toISOString(), events: ['requestWillBeSent'] })
      if (this.requests.size > 100) { this.requests.delete(this.requests.keys().next().value!); this.truncated = true }
    }
    const request = this.requests.get(key)
    if (!request) return
    if (['Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method) && request.events.length < 8) request.events.push(method === 'Network.loadingFailed' ? `loadingFailed:${String(params.errorText).slice(0, 120)}` : method.slice(8))
    if (method === 'Network.responseReceived') request.status = Number(params.response?.status)
    if (method === 'Network.loadingFinished') request.state = 'finished'
    if (method === 'Network.loadingFailed') request.state = 'failed'
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.intercepted.delete(key)
      await this.expire()
    }
  }

  completed(match: TestRequestMatch & { state: string; status?: number }): boolean {
    return [...this.requests.values()].some(request => testRequestMatches(match, request.url, request.method) && request.state === match.state
      && (match.status === undefined || request.status === match.status))
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    for (const session of this.sessions) {
      try { await this.send('Fetch.disable', {}, session); this.sessions.delete(session) }
      catch { this.cleanupFailed = true }
    }
  }

  evidence(): Record<string, unknown> {
    return { requests: [...this.requests.values()].map(request => ({ ...request, url: readableUrl(request.url) })), affectedRequests: this.affected,
      truncated: this.truncated, failureRulesRemoved: this.sessions.size === 0, cleanupFailed: this.cleanupFailed,
      limitations: ['At most 100 requests from this run; no request/response bodies, headers, storage or replay. Completion does not imply application or rendering readiness.',
        'Failure simulation affects matching requests from known same-origin frames in this page only. Service-worker/cache paths may bypass interception. It cannot reproduce server-side partial success.'] }
  }
}
