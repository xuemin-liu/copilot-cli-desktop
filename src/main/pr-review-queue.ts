import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'
import type { ReviewCandidate } from './types.js'

/**
 * New PRs, the desktop's Stage C of /review-pr: a project the person asked for ("review new PRs in this repo", or any
 * "review PR N") gets a review loop for each new pull request that qualifies (the same rules as a review started by hand). Turning it on takes no backlog: the PRs open then are recorded as seen.
 * A stored set of pending numbers, not a highest number, so PRs that open out of order or qualify later are not missed.
 * Starts are limited like automation rules: three a day and ten in all per opt-in, one at a time. The desktop checks
 * every thirty seconds with gh; no model runs until a review starts.
 */

export interface QueueState {
  enabled: boolean; repository: string | null; activatedAt: number
  /** PRs handled: open when the queue was turned on, started, or refused for good. */
  seen: number[]
  /** PRs that did not qualify yet (someone else's, a fork, already in review) and may later. */
  waiting: number[]
  day: number; dayStarts: number; total: number
  lastError: string | null
}
export interface QueueHost {
  candidates(profileId: string): Promise<ReviewCandidate[]>
  start(url: string, profileId: string): Promise<void>
  /** Automatic work paused for this project (or everywhere): the queue starts nothing, and catches up on resume. */
  paused?(profileId: string): boolean
  now?: () => number
}

export const QUEUE_DAILY_STARTS = 3
export const QUEUE_TOTAL_STARTS = 10
const day = (time: number): number => Math.floor(time / 86_400_000)

export class PrReviewQueue {
  private state: Record<string, QueueState> = {}
  private busy = false
  private loaded = false
  private readonly now: () => number
  constructor(private readonly path: string, private readonly host: QueueHost) { this.now = host.now ?? Date.now }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed as Record<string, QueueState>)) if (valid(value)) this.state[id] = value
      }
    } catch { /* No queue yet, or an unreadable one: nothing is enabled. */ }
    this.loaded = true
  }
  views(): Record<string, QueueState> { return structuredClone(this.state) }

  /** Turning it on records every PR open now as seen, so only PRs opened later start reviews. */
  async enable(profileId: string): Promise<QueueState> {
    await this.load()
    const open = await this.host.candidates(profileId)
    const now = this.now()
    const next: QueueState = { enabled: true, repository: open[0] ? repositoryOf(open[0].url) : this.state[profileId]?.repository ?? null, activatedAt: now,
      seen: open.map((candidate) => candidate.number), waiting: [], day: day(now), dayStarts: 0, total: 0, lastError: null }
    this.state[profileId] = next
    await this.save()
    return structuredClone(next)
  }
  async disable(profileId: string): Promise<void> {
    await this.load()
    const current = this.state[profileId]
    if (current) { this.state[profileId] = { ...current, enabled: false }; await this.save() }
  }

  /** One pass over the enabled projects; at most one review starts per project per pass. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.load()
      for (const [profileId, current] of Object.entries(this.state)) {
        if (!current.enabled || this.host.paused?.(profileId)) continue
        const today = day(this.now())
        const queue: QueueState = current.day === today ? { ...current, seen: [...current.seen], waiting: [...current.waiting] } : { ...current, seen: [...current.seen], waiting: [...current.waiting], day: today, dayStarts: 0 }
        let candidates: ReviewCandidate[]
        try { candidates = await this.host.candidates(profileId) } catch (error) { queue.lastError = message(error); this.state[profileId] = queue; continue }
        queue.lastError = null
        const fresh = candidates.filter((candidate) => !queue.seen.includes(candidate.number)).sort((a, b) => a.number - b.number)
        queue.waiting = fresh.filter((candidate) => candidate.reason !== null).map((candidate) => candidate.number)
        const next = fresh.find((candidate) => candidate.reason === null)
        if (next && queue.total < QUEUE_TOTAL_STARTS && queue.dayStarts < QUEUE_DAILY_STARTS && this.state[profileId]?.enabled) {
          // Counted before it starts, so a crash mid-start cannot start it twice; a failed start is not retried by itself.
          queue.seen.push(next.number); queue.total++; queue.dayStarts++
          this.state[profileId] = queue
          await this.save()
          try { await this.host.start(next.url, profileId) } catch (error) { queue.lastError = `#${next.number}: ${message(error)}` }
        }
        this.state[profileId] = { ...queue, seen: queue.seen.slice(-1000), waiting: queue.waiting.slice(0, 200) }
      }
      await this.save()
    } finally { this.busy = false }
  }

  private async save(): Promise<void> { await writeFileAtomic(this.path, JSON.stringify(this.state)) }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : 'failed').slice(0, 300)
const repositoryOf = (url: string): string | null => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(url)?.[1] ?? null
const numbers = (value: unknown): boolean => Array.isArray(value) && value.length <= 1000 && value.every((n) => Number.isSafeInteger(n) && n > 0)
function valid(value: unknown): value is QueueState {
  const v = value as QueueState
  return !!v && typeof v === 'object' && typeof v.enabled === 'boolean' && (v.repository === null || typeof v.repository === 'string') && Number.isFinite(v.activatedAt)
    && numbers(v.seen) && numbers(v.waiting) && Number.isInteger(v.day) && Number.isInteger(v.dayStarts) && v.dayStarts >= 0 && v.dayStarts <= QUEUE_DAILY_STARTS
    && Number.isInteger(v.total) && v.total >= 0 && v.total <= QUEUE_TOTAL_STARTS && (v.lastError === null || typeof v.lastError === 'string')
}
