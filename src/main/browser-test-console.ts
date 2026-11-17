import type { ConsoleSlice } from './browser-console-buffer.js'
import { globMatches, type BrowserTestPlan, type BrowserTestStep, type ConsoleLevel, type TestStepConsole } from './browser-test-plan.js'

export interface ConsoleMessage { level: string; message: string; source: string; line: number }
export interface ConsoleSource {
  mark(): number
  slice(pageId: number, after: number, through: number, max: number): ConsoleSlice
  /** Called for every message of the page, recorded or not. */
  watch(pageId: number, listener: (message: ConsoleMessage) => void): () => void
}
export interface ConsoleErrorRecord { message: string; source: string; line: number; count: number }

const STEP_ENTRIES = 10
const MESSAGE_CHARS = 500
const PENDING_ERRORS = 20

/** One run's view of the test page's console. It listens to every message as it arrives, so the
 * error latch and consoleMessage matches do not depend on what the bounded buffer still holds. */
export class TestConsoleWatch {
  private readonly patterns = new Map<string, { pattern: string; level?: ConsoleLevel; matched: boolean }>()
  private readonly ignore: string[]
  private pending: ConsoleErrorRecord[] = []
  private overflow = 0
  private readonly stop: () => void

  constructor(plan: BrowserTestPlan, private readonly pageId: number, private readonly source: ConsoleSource) {
    for (const step of plan.steps) for (const condition of [step, ...step.all ?? []] as BrowserTestStep[]) {
      if (condition.condition === 'consoleMessage') this.patterns.set(key(String(condition.expected), condition.level), { pattern: String(condition.expected), ...(condition.level ? { level: condition.level } : {}), matched: false })
    }
    this.ignore = plan.failOnConsoleError ? plan.consoleErrorIgnore ?? [] : []
    const latch = plan.failOnConsoleError === true
    this.stop = source.watch(pageId, message => {
      for (const entry of this.patterns.values()) if (!entry.matched && (!entry.level || entry.level === message.level) && globMatches(entry.pattern, message.message)) entry.matched = true
      if (!latch || message.level !== 'error' || this.ignore.some(pattern => globMatches(pattern, message.message))) return
      const last = this.pending.at(-1)
      if (last && last.message === message.message.slice(0, MESSAGE_CHARS) && last.source === message.source && last.line === message.line) last.count++
      else if (this.pending.length < PENDING_ERRORS) this.pending.push({ message: message.message.slice(0, MESSAGE_CHARS), source: message.source.slice(0, 500), line: message.line, count: 1 })
      else this.overflow++
    })
  }

  mark(): number { return this.source.mark() }

  /** The page's messages after `after` up to now, capped, with errors kept first. */
  slice(after: number): TestStepConsole {
    const slice = this.source.slice(this.pageId, after, this.source.mark(), STEP_ENTRIES)
    return { entries: slice.entries.map(entry => ({ level: entry.level, message: entry.message.slice(0, MESSAGE_CHARS), source: entry.source.slice(0, 500), line: entry.line,
      ...(entry.count && entry.count > 1 ? { count: entry.count } : {}) })), total: slice.total, truncated: slice.truncated, complete: slice.complete }
  }

  /** Errors latched since the last call, and how many more did not fit. */
  takeErrors(): { errors: ConsoleErrorRecord[]; more: number } {
    const result = { errors: this.pending, more: this.overflow }
    this.pending = []; this.overflow = 0
    return result
  }

  /** Whether a message matching the pattern (and level) has arrived since the run started. */
  matched(pattern: string, level?: ConsoleLevel): boolean { return this.patterns.get(key(pattern, level))?.matched ?? false }

  dispose(): void { this.stop() }
}

const key = (pattern: string, level?: string): string => `${level ?? ''}\0${pattern}`
