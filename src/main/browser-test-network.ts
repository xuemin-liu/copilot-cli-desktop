import { testRequestMatches, type TestNetworkConditions, type TestNetworkFailure, type TestRequestMatch } from './browser-test-plan.js'
import { readableUrl } from './browser-read-privacy.js'

type Params = Record<string, any>
type Send = (method: string, params: Params, session?: string) => Promise<unknown>
interface RequestRecord { id: string; frame: string; url: string; method: string; state: string; status?: number; timestamp: string; events: string[] }
/** Requests kept for matching and counting; reports list the latest of them. */
const KEPT_REQUESTS = 2000
const REPORTED_REQUESTS = 100

/** A per-WebContents, per-run observer/interceptor. Never installed on the storage Session. */
export class BrowserTestNetwork {
  private readonly requests = new Map<string, RequestRecord>()
  private readonly sessions = new Set<string | undefined>()
  private readonly affected: Record<string, unknown>[] = []
  private readonly intercepted = new Set<string>()
  private readonly rules: (TestNetworkFailure & { remaining: number; expires: number })[]
  private readonly timers: ReturnType<typeof setTimeout>[] = []
  /** Delayed requests not yet let through, by paused request ID. */
  private readonly held = new Map<string, { timer: ReturnType<typeof setTimeout>; session?: string; affected: Record<string, unknown> }>()
  private conditionsApplied = false
  private conditionsRemoved: boolean | null = null
  private observed = 0
  private stopped = false
  private truncated = false
  private cleanupFailed = false

  detached(): void {
    this.stopped = true; this.sessions.clear(); for (const timer of this.timers) clearTimeout(timer)
    // A detached debugger lets paused requests go and drops its network emulation.
    for (const held of this.held.values()) { clearTimeout(held.timer); held.affected.released = 'debugger detached' }
    this.held.clear(); if (this.conditionsApplied) this.conditionsRemoved = true
  }

  constructor(rules: TestNetworkFailure[], private readonly origin: string, private readonly frames: Set<string>, private readonly send: Send, private readonly active: () => boolean = () => true,
    private readonly conditions?: TestNetworkConditions) {
    const now = Date.now()
    this.rules = rules.map(rule => {
      if (new URL(rule.urlPattern.replaceAll('*', 'wildcard')).origin !== origin) throw new Error('Network failure rules must stay within the test run’s origin.')
      return { ...rule, remaining: rule.maxRequests, expires: now + rule.durationMs }
    })
  }

  async start(): Promise<void> {
    if (this.conditions) {
      // Kilobits per second to bytes per second; -1 leaves a direction unthrottled.
      const throughput = (kbps?: number): number => kbps === undefined ? -1 : kbps * 125
      // Marked as possibly in effect before sending: a lost or late acknowledgement can still have applied it, so stop()
      // always resets it, and detaching the debugger removes it if the reset fails too.
      this.conditionsApplied = true; this.conditionsRemoved = false
      await this.send('Network.emulateNetworkConditions', { offline: this.conditions.offline === true, latency: this.conditions.latencyMs ?? 0,
        downloadThroughput: throughput(this.conditions.downloadKbps), uploadThroughput: throughput(this.conditions.uploadKbps) })
    }
    if (!this.rules.length) return
    this.sessions.add(undefined)
    await this.send('Fetch.enable', { patterns: this.rules.map(rule => ({ urlPattern: rule.urlPattern, requestStage: 'Request' })) })
    for (const rule of this.rules) this.timers.push(setTimeout(() => { void this.expire().catch(() => { this.cleanupFailed = true }) }, rule.durationMs + 1))
  }

  private async expire(): Promise<void> {
    if (this.rules.every(rule => rule.remaining === 0 || rule.expires <= Date.now())
      && (this.intercepted.size === 0 || this.rules.every(rule => rule.expires <= Date.now()))) await this.removeInterception()
  }

  /** Lets every delayed request through now, as the run or its rules end. */
  private async release(reason: string): Promise<void> {
    for (const [requestId, held] of this.held) {
      clearTimeout(held.timer); this.held.delete(requestId)
      held.affected.released = reason
      await this.send('Fetch.continueRequest', { requestId }, held.session).catch(() => { held.affected.delivery = 'uncertain' })
    }
  }

  private async removeInterception(reason = 'rules ended'): Promise<void> {
    await this.release(reason)
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    for (const session of this.sessions) {
      try { await this.send('Fetch.disable', {}, session); this.sessions.delete(session) }
      catch { this.cleanupFailed = true }
    }
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
      if (rule.failure === 'delay') {
        // Held, then let through unchanged. The run's end lets any still held go at once.
        affected.delayMs = rule.delayMs
        const requestId = String(params.requestId)
        const timer = setTimeout(() => {
          this.held.delete(requestId); affected.released = 'after delay'
          void this.send('Fetch.continueRequest', { requestId }, session).catch(() => { affected.delivery = 'uncertain' })
        }, rule.delayMs)
        this.held.set(requestId, { timer, ...(session ? { session } : {}), affected })
        return
      }
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
      this.observed++
      if (this.observed > REPORTED_REQUESTS) this.truncated = true
      if (this.requests.size > KEPT_REQUESTS) this.requests.delete(this.requests.keys().next().value!)
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

  /** How many requests from this run match and have reached the state (and status). At most the latest 2000 are kept. */
  completed(match: TestRequestMatch & { state: string; status?: number }): number {
    let count = 0
    for (const request of this.requests.values()) if (testRequestMatches(match, request.url, request.method) && request.state === match.state
      && (match.status === undefined || request.status === match.status)) count++
    return count
  }

  async stop(): Promise<void> {
    await this.removeInterception('run ended')
    if (this.conditionsApplied && this.conditionsRemoved === false) {
      try {
        await this.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
        this.conditionsRemoved = true
      } catch { this.cleanupFailed = true }
    }
  }

  /** False while a rule or the slow network may still be in effect; the reader then detaches the debugger to remove it. */
  cleanedUp(): boolean { return this.sessions.size === 0 && this.conditionsRemoved !== false }

  evidence(): Record<string, unknown> {
    return { requests: [...this.requests.values()].slice(-REPORTED_REQUESTS).map(request => ({ ...request, url: readableUrl(request.url) })), affectedRequests: this.affected,
      truncated: this.truncated, failureRulesRemoved: this.sessions.size === 0, cleanupFailed: this.cleanupFailed,
      ...(this.conditions ? { networkConditions: { ...this.conditions, applied: this.conditionsApplied, removed: this.conditionsRemoved === true } } : {}),
      limitations: ['At most 100 requests from this run; no request/response bodies, headers, storage or replay. Completion does not imply application or rendering readiness.',
        'Failure simulation affects matching requests from known same-origin frames in this page only. Service-worker/cache paths may bypass interception. It cannot reproduce server-side partial success.'] }
  }
}
