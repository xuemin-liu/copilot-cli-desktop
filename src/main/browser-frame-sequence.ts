/** Explicit application instrumentation, not inferred from paints, decode callbacks or console rate. */
export const FRAME_EVENT_PREFIX = 'desktop-test-frame '
export interface FrameEvent { version: 1; type: 'request' | 'commit'; viewport: string; epoch: string; revision: number; frame: number; timeMs: number }
export interface FrameSequenceSpec {
  viewport: string; epoch: string; since: number; minFrames?: number
  order?: 'any' | 'ascending' | 'descending'; wrapAt?: number
  maxRepeats?: number; maxSkipped?: number; maxStallMs?: number; maxLatencyMs?: number
}
const MAX_EVENTS = 5000
const fields = ['version', 'type', 'viewport', 'epoch', 'revision', 'frame', 'timeMs']
export const frameAlias = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v)

export class FrameEvents {
  private events: { event: FrameEvent; arrival: number; sequence: number }[] = []
  private sequence = 0
  private invalid: number[] = []
  private overflowAt?: number
  constructor(private readonly scopes: { viewport: string; epoch: string }[]) {}
  mark(): number { return this.sequence }
  add(message: string, arrival = Date.now()): void {
    if (!message.startsWith(FRAME_EVENT_PREFIX)) return
    const sequence = ++this.sequence
    let raw: any
    try { if (message.length > 1024) throw new Error(); raw = JSON.parse(message.slice(FRAME_EVENT_PREFIX.length)) } catch { raw = null }
    const valid = raw && !Array.isArray(raw) && Object.keys(raw).length === fields.length && Object.keys(raw).every(key => fields.includes(key))
      && raw.version === 1 && ['request', 'commit'].includes(raw.type) && frameAlias(raw.viewport) && frameAlias(raw.epoch)
      && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && Number.isInteger(raw.frame) && raw.frame >= 0 && raw.frame <= 10_000_000
      && Number.isFinite(raw.timeMs) && raw.timeMs >= 0 && raw.timeMs <= 1e15
    if (!valid) { if (this.invalid.length < MAX_EVENTS) this.invalid.push(sequence); else this.overflowAt ??= sequence; return }
    // Retain other epochs of a watched viewport too: otherwise an obsolete series commit would disappear from evidence.
    if (!this.scopes.some(scope => scope.viewport === raw.viewport)) return
    if (this.events.length >= MAX_EVENTS) { this.overflowAt ??= sequence; return }
    this.events.push({ event: raw as FrameEvent, arrival, sequence })
  }
  analyze(spec: FrameSequenceSpec, after: number, start: number, end = Date.now()) {
    const viewportEntries = this.events.filter(item => item.sequence > after && item.event.viewport === spec.viewport)
    let targetStarted = false, wrongEpochCommits = 0, epochChanges = 0
    for (const { event } of viewportEntries) {
      if (event.epoch === spec.epoch && event.type === 'request') targetStarted = true
      else if (targetStarted && event.epoch !== spec.epoch) {
        if (event.type === 'commit') wrongEpochCommits++
        else epochChanges++
      }
    }
    const entries = viewportEntries.filter(item => item.event.epoch === spec.epoch)
    const requests = new Map<number, FrameEvent>(), committed = new Set<number>()
    let latestRequested = -1, latestCommitted = -1, lastTime = -1
    let stale = 0, unmatched = 0, duplicates = 0, requestOrderErrors = 0, clockErrors = 0, orderErrors = 0, repeated = 0, skipped = 0
    const commits: typeof entries = [], latencies: number[] = [], intervals: number[] = []
    for (const item of entries) {
      const e = item.event
      if (e.timeMs < lastTime) clockErrors++
      lastTime = e.timeMs
      if (e.type === 'request') {
        if (e.revision <= latestRequested || requests.has(e.revision)) requestOrderErrors++
        latestRequested = Math.max(latestRequested, e.revision); requests.set(e.revision, e); continue
      }
      if (e.revision < latestRequested || e.revision < latestCommitted) stale++
      latestCommitted = Math.max(latestCommitted, e.revision)
      if (committed.has(e.revision)) duplicates++
      committed.add(e.revision)
      const request = requests.get(e.revision)
      if (!request || request.frame !== e.frame || e.timeMs < request.timeMs) unmatched++
      else latencies.push(e.timeMs - request.timeMs)
      const previous = commits.at(-1)?.event
      if (spec.wrapAt !== undefined && e.frame > spec.wrapAt) orderErrors++
      if (previous) {
        intervals.push(e.timeMs - previous.timeMs)
        if (e.frame === previous.frame) repeated++
        else if (spec.order && spec.order !== 'any') {
          let delta = spec.order === 'ascending' ? e.frame - previous.frame : previous.frame - e.frame
          if (delta < 0 && spec.wrapAt !== undefined) delta += spec.wrapAt + 1
          if (delta < 0) orderErrors++
          else skipped += Math.max(0, delta - 1)
        }
      }
      commits.push(item)
    }
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return sorted.length ? { count: sorted.length, min: sorted[0]!, median: sorted[Math.floor((sorted.length - 1) / 2)]!, p95: sorted[Math.ceil(sorted.length * .95) - 1]!, max: sorted.at(-1)! } : null
    }
    const arrivals = [start, ...commits.map(item => item.arrival), end]
    const longestSilenceMs = Math.max(0, ...arrivals.slice(1).map((time, i) => time - arrivals[i]!))
    const invalidEvents = this.invalid.filter(sequence => sequence > after).length
    // Once storage overflows, no later interval can claim complete evidence.
    const complete = this.overflowAt === undefined && invalidEvents === 0
    const intervalMs = stats(intervals), requestToCommitMs = stats(latencies)
    const violations = [!complete ? 'Event evidence is incomplete or malformed.' : '',
      commits.length < (spec.minFrames ?? 1) ? 'Too few committed frames.' : '',
      stale ? `${stale} stale commits.` : '', unmatched ? `${unmatched} commits without a matching request.` : '',
      wrongEpochCommits ? 'Another series epoch committed into the watched viewport.' : '', epochChanges ? 'The requested epoch changed during this sequence window.' : '',
      duplicates ? `${duplicates} duplicate revision commits.` : '', requestOrderErrors ? 'Request revisions are not strictly increasing.' : '',
      clockErrors ? 'Application event timestamps moved backwards.' : '', orderErrors ? 'Frame order is incorrect.' : '',
      repeated > (spec.maxRepeats ?? Infinity) ? 'Too many repeated frames.' : '', skipped > (spec.maxSkipped ?? Infinity) ? 'Too many skipped frames.' : '',
      longestSilenceMs > (spec.maxStallMs ?? Infinity) ? 'Commit arrival silence exceeded maxStallMs.' : '',
      (requestToCommitMs?.max ?? 0) > (spec.maxLatencyMs ?? Infinity) ? 'Request-to-commit latency exceeded maxLatencyMs.' : ''].filter(Boolean)
    return { passed: violations.length === 0, reason: violations.join(' '), data: { frameSequence: {
      viewport: spec.viewport, epoch: spec.epoch, since: spec.since, complete, invalidEvents, overflow: this.overflowAt !== undefined,
      requests: requests.size, frames: commits.length, staleCommits: stale, unmatchedCommits: unmatched, duplicateCommits: duplicates,
      wrongEpochCommits, epochChanges,
      requestOrderErrors, clockErrors, orderErrors, repeatedFrames: repeated, skippedFrames: skipped, longestSilenceMs, intervalMs, requestToCommitMs,
      commits: commits.slice(-100).map(({ event }) => ({ revision: event.revision, frame: event.frame, timeMs: event.timeMs })),
      evidenceTruncated: commits.length > 100, timingSource: 'Application monotonic timestamps; silence uses desktop arrival times. Commits are instrumented, not physical display presentation.' } } }
  }
}
