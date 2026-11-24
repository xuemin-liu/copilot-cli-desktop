import type { ConsoleSlice } from './browser-console-buffer.js'
import { globMatches, type BrowserTestPlan, type BrowserTestStep, type ConsoleLevel, type TestStepConsole } from './browser-test-plan.js'
import { redactBrowserValue } from './browser-read-privacy.js'
import { redactInputs, testInputs } from './browser-test-runner.js'
import { FrameEvents } from './browser-frame-sequence.js'

export interface ConsoleMessage { level: string; message: string; source: string; line: number }
export interface ConsoleSource {
  mark(): number
  slice(pageId: number, after: number, through: number, max: number): ConsoleSlice
  /** Called for every message of the page, recorded or not. */
  watch(pageId: number, listener: (message: ConsoleMessage) => void): () => void
}
export interface ConsoleErrorRecord { message: string; source: string; line: number; count: number }

const STEP_ENTRIES = 10
/** Recent arrival times kept per timed pattern. Matches are always counted, and the first is always kept. */
const TIMES_KEPT = 5000

/** Arrivals of one pattern a measure step times. */
interface Arrivals { count: number; first?: number; recent: number[]; lastDropped?: number }
const MESSAGE_CHARS = 500
const PENDING_ERRORS = 20

/** One run's view of the test page's console. It listens to every message as it arrives, so the
 * error latch and consoleMessage matches do not depend on what the bounded buffer still holds. */
export class TestConsoleWatch {
  readonly frames: FrameEvents
  private readonly patterns = new Map<string, { pattern: string; level?: ConsoleLevel; matched: boolean; times?: Arrivals }>()
  private readonly ignore: string[]
  private pending: ConsoleErrorRecord[] = []
  private overflow = 0
  private readonly stop: () => void
  /** Redacts supplied inputs and credentials, then bounds the text. Never the other way round:
   * a value cut in half before redaction is no longer recognized. */
  private readonly bound: (text: string, max: number) => string

  constructor(plan: BrowserTestPlan, private readonly pageId: number, private readonly source: ConsoleSource) {
    const commits = plan.steps.flatMap(step => [step, ...step.all ?? []]).filter(condition => condition.condition === 'frameCommitted').map(condition => condition.commit!)
    this.frames = new FrameEvents([...plan.steps.filter(step => step.action === 'frameSequence').map(step => step.sequence!), ...commits])
    const add = (pattern: string, level: ConsoleLevel | undefined, timed: boolean): void => {
      const entry = this.patterns.get(key(pattern, level)) ?? { pattern, ...(level ? { level } : {}), matched: false }
      if (timed) entry.times ??= { count: 0, recent: [] }
      this.patterns.set(key(pattern, level), entry)
    }
    for (const step of plan.steps) {
      for (const condition of [step, ...step.all ?? []] as BrowserTestStep[]) if (condition.condition === 'consoleMessage') add(String(condition.expected), condition.level, false)
      // A measure times its console events by when each message arrived.
      if (step.action === 'measure') {
        if (step.from?.consoleMessage !== undefined) add(step.from.consoleMessage, step.from.level, true)
        if (step.to?.condition === 'consoleMessage') add(String(step.to.expected), step.to.level, true)
        if (step.rateOf) add(step.rateOf.consoleMessage, step.rateOf.level, true)
      }
    }
    const inputs = testInputs(plan)
    this.bound = (text, max) => String(redactBrowserValue(redactInputs(text, inputs)).value).slice(0, max)
    this.ignore = plan.failOnConsoleError ? plan.consoleErrorIgnore ?? [] : []
    const latch = plan.failOnConsoleError === true
    const watchFrames = commits.length > 0 || plan.steps.some(step => step.action === 'frameSequence')
    this.stop = source.watch(pageId, message => {
      const now = Date.now()
      if (watchFrames) this.frames.add(message.message, now)
      for (const entry of this.patterns.values()) {
        if ((entry.matched && !entry.times) || (entry.level && entry.level !== message.level) || !globMatches(entry.pattern, message.message)) continue
        entry.matched = true
        const times = entry.times
        if (!times) continue
        times.count++; times.first ??= now; times.recent.push(now)
        // Oldest first out, in batches; the newest dropped time says which later questions can still be answered.
        if (times.recent.length > TIMES_KEPT + 1000) times.lastDropped = times.recent.splice(0, 1000).at(-1)!
      }
      if (!latch || message.level !== 'error' || this.ignore.some(pattern => globMatches(pattern, message.message))) return
      const text = this.bound(message.message, MESSAGE_CHARS); const source = this.bound(message.source, 500)
      const last = this.pending.at(-1)
      if (last && last.message === text && last.source === source && last.line === message.line) last.count++
      else if (this.pending.length < PENDING_ERRORS) this.pending.push({ message: text, source, line: message.line, count: 1 })
      else this.overflow++
    })
  }

  mark(): number { return this.source.mark() }

  /** The page's messages after `after` up to now, capped, with errors kept first. */
  slice(after: number): TestStepConsole {
    const slice = this.source.slice(this.pageId, after, this.source.mark(), STEP_ENTRIES)
    return { entries: slice.entries.map(entry => ({ level: entry.level, message: this.bound(entry.message, MESSAGE_CHARS), source: this.bound(entry.source, 500), line: entry.line,
      ...(entry.count && entry.count > 1 ? { count: entry.count } : {}) })), total: slice.total, truncated: slice.truncated, complete: slice.complete }
  }

  /** Errors latched since the last call, and how many more did not fit. */
  takeErrors(): { errors: ConsoleErrorRecord[]; more: number } {
    const result = { errors: this.pending, more: this.overflow }
    this.pending = []; this.overflow = 0
    return result
  }

  /** How many messages matching a timed pattern have arrived since the run started. Never capped. */
  matchCount(pattern: string, level?: ConsoleLevel): number { return this.patterns.get(key(pattern, level))?.times?.count ?? 0 }

  /** When the first message matching a timed pattern arrived. */
  firstArrival(pattern: string, level?: ConsoleLevel): number | undefined { return this.patterns.get(key(pattern, level))?.times?.first }

  /**
   * When the first message matching a timed pattern arrived at or after `since`. `complete` is false when arrivals that
   * late were dropped from the bounded history, so the first one cannot be known.
   */
  firstArrivalSince(pattern: string, level: ConsoleLevel | undefined, since: number): { time?: number; complete: boolean } {
    const times = this.patterns.get(key(pattern, level))?.times
    if (!times) return { complete: true }
    if (times.lastDropped !== undefined && times.lastDropped >= since) return { complete: false }
    const time = times.recent.find(value => value >= since)
    return { ...(time !== undefined ? { time } : {}), complete: true }
  }

  /** Whether a message matching the pattern (and level) has arrived since the run started. */
  matched(pattern: string, level?: ConsoleLevel): boolean { return this.patterns.get(key(pattern, level))?.matched ?? false }

  dispose(): void { this.stop() }
}

const key = (pattern: string, level?: string): string => `${level ?? ''}\0${pattern}`
