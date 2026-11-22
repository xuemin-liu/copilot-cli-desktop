import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'
import type { ReviewCandidate } from './types.js'

/**
 * New PRs, the desktop's Stage C of /review-pr: a project the person asked for ("review new PRs in this repo", or a
 * "review PR N" that started) gets a review loop for each new pull request that qualifies, by the same rules as a
 * review started by hand, one start at a time. The desktop checks every thirty seconds with gh; no model runs until a
 * review starts.
 *
 * - "New" is opened after the queue was turned on, and not among the PRs open then: neither a missed page of the
 *   listing nor an old PR that later qualifies starts a review of the backlog.
 * - The queue belongs to one repository: if the project's origin changes, it starts nothing until the person asks again.
 * - Turning it off wins over a check already under way, also one that fails: every write after an await is fenced by
 *   the project's revision, which every enable and disable moves.
 * - A "review PR N" for a PR that does not exist yet (just being created in another tab) waits here for up to an hour.
 */

export interface QueueState {
  enabled: boolean
  /** The repository the queue was turned on for, `owner/repo` in lower case. */
  repository: string
  activatedAt: number
  /** PRs handled: open when the queue was turned on, started, or refused for good. */
  seen: number[]
  /** New PRs that did not qualify yet (someone else's, a fork, already in review) and may later. */
  waiting: number[]
  /** "review PR N" asked before PR N existed: started when it appears, until `until`. */
  expected: { number: number; until: number }[]
  lastError: string | null
}
export interface QueueListing { repository: string; pulls: ReviewCandidate[] }
export interface QueueHost {
  /** Every open PR of the project's repository (all pages), and that repository as its origin names it now. */
  candidates(profileId: string): Promise<QueueListing>
  start(url: string, profileId: string): Promise<void>
  /** Automatic work paused for this project (or everywhere): the queue starts nothing, and catches up on resume. */
  paused?(profileId: string): boolean
  now?: () => number
  /** Saves the queue file; tests hold it to reach the moment between recording a start and making it. */
  write?: (path: string, text: string) => Promise<void>
}

/** The queue's file in the desktop's data folder. */
export const QUEUE_FILE = 'pr-review-queue.json'
/**
 * What startup reopens from the data folder. The queue reopens from its own file: turning it on (or waiting for a PR
 * number) saves it before any review has run, so before the follow-up database may exist.
 */
export function startupReopens(exists: (name: string) => boolean): { followups: boolean; queue: boolean } {
  return { followups: exists('workflow-followups.sqlite'), queue: exists(QUEUE_FILE) }
}

/** How long a "review PR N" waits for PR N to exist. */
export const EXPECTED_PR_WAIT_MS = 60 * 60_000

export class PrReviewQueue {
  private state: Record<string, QueueState> = {}
  private readonly revisions = new Map<string, number>()
  private busy = false
  private loaded = false
  private readonly now: () => number
  constructor(private readonly path: string, private readonly host: QueueHost) { this.now = host.now ?? Date.now }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) { const state = normalize(value); if (state) this.state[id] = state }
      }
    } catch { /* No queue yet, or an unreadable one: nothing is enabled. */ }
    this.loaded = true
  }
  views(): Record<string, QueueState> { return structuredClone(this.state) }

  private revision(profileId: string): number { return this.revisions.get(profileId) ?? 0 }
  private bump(profileId: string): number { const next = this.revision(profileId) + 1; this.revisions.set(profileId, next); return next }

  /**
   * Turns the queue on for the project's repository, recording every PR open now as seen. Asking again changes
   * nothing while it is on for the same repository. `repository`, when given, must be the project's: a review of
   * another repository's PR never turns on this project's queue.
   */
  async enable(profileId: string, repository?: string): Promise<QueueState> {
    await this.load()
    const revision = this.revision(profileId)
    const listing = await this.host.candidates(profileId)
    if (this.revision(profileId) !== revision) throw new Error('The new-PR queue was changed meanwhile; ask again')
    const current = this.state[profileId]
    if (repository !== undefined && listing.repository !== repository.toLowerCase()) throw new Error(`This project's origin is ${listing.repository}, not ${repository}`)
    // Already on for this repository: nothing changes, so a check under way (a start being recorded) carries on.
    if (current?.enabled && current.repository === listing.repository) return structuredClone(current)
    this.bump(profileId)
    const next: QueueState = { enabled: true, repository: listing.repository, activatedAt: this.now(), seen: listing.pulls.map((candidate) => candidate.number).slice(-5000),
      waiting: [], expected: current?.repository === listing.repository ? current.expected : [], lastError: null }
    this.state[profileId] = next
    await this.save()
    return structuredClone(next)
  }
  async disable(profileId: string): Promise<void> {
    await this.load()
    this.bump(profileId)
    const current = this.state[profileId]
    if (current) { this.state[profileId] = { ...current, enabled: false, waiting: [] }; await this.save() }
  }
  /** A "review PR N" for a PR GitHub does not list yet: it starts when it appears, within the hour. */
  async expect(profileId: string, repository: string, number: number): Promise<void> {
    await this.load()
    const repo = repository.toLowerCase(), current = this.state[profileId]
    const base: QueueState = current?.repository === repo ? current : { enabled: false, repository: repo, activatedAt: this.now(), seen: [], waiting: [], expected: [], lastError: null }
    // A queue on for another repository is not touched: the expected PR waits only with a queue of its own repository.
    if (current && current.repository !== repo && current.enabled) throw new Error(`This project's queue watches ${current.repository}`)
    this.state[profileId] = { ...base, expected: [...base.expected.filter((e) => e.number !== number), { number, until: this.now() + EXPECTED_PR_WAIT_MS }].slice(-20) }
    await this.save()
  }

  /** Applies `change` to the latest state, only if nothing turned the queue on or off since `revision` was read. */
  private apply(profileId: string, revision: number, change: (state: QueueState) => QueueState): boolean {
    const latest = this.state[profileId]
    if (!latest || this.revision(profileId) !== revision) return false
    this.state[profileId] = change(latest)
    return true
  }

  /** One pass over the projects; at most one review starts per project per pass, and one at a time. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.load()
      for (const profileId of Object.keys(this.state)) {
        const current = this.state[profileId]
        if (!current || (!current.enabled && !current.expected.length) || this.host.paused?.(profileId)) continue
        const revision = this.revision(profileId)
        let listing: QueueListing
        try { listing = await this.host.candidates(profileId) } catch (error) {
          if (this.apply(profileId, revision, (state) => ({ ...state, lastError: message(error) }))) await this.save()
          continue
        }
        const latest = this.state[profileId]
        if (!latest || this.revision(profileId) !== revision) continue
        if (listing.repository !== latest.repository) {
          if (this.apply(profileId, revision, (state) => ({ ...state, lastError: `The project's origin is now ${listing.repository}, not ${state.repository}: ask again to review its new PRs.` }))) await this.save()
          continue
        }
        const now = this.now(), done = new Set<number>()
        let pick: ReviewCandidate | null = null, note: string | null = null
        for (const expected of latest.expected) {
          if (expected.until <= now) { done.add(expected.number); note = `PR #${expected.number} did not appear within the hour.`; continue }
          const found = listing.pulls.find((candidate) => candidate.number === expected.number)
          if (!found) continue
          // Only the one started now leaves the list: the others start on later passes, one at a time, and one that
          // does not qualify yet (already in review, say) keeps waiting until its hour is up.
          if (found.reason !== null) note = `#${found.number}: ${found.reason}`
          else if (!pick) { pick = found; done.add(found.number) }
        }
        const fresh = latest.enabled
          ? listing.pulls.filter((candidate) => !latest.seen.includes(candidate.number) && candidate.createdAt >= latest.activatedAt).sort((a, b) => a.number - b.number)
          : []
        if (!pick) pick = fresh.find((candidate) => candidate.reason === null) ?? null
        const started = pick
        // Recorded before it starts, so a crash mid-start cannot start it twice; a failed start is not retried by itself.
        const recorded = this.apply(profileId, revision, (state) => ({ ...state,
          seen: started ? [...state.seen.filter((n) => n !== started.number), started.number].slice(-5000) : state.seen,
          waiting: fresh.filter((candidate) => candidate.reason !== null && candidate.number !== started?.number).map((candidate) => candidate.number).slice(0, 200),
          expected: state.expected.filter((e) => !done.has(e.number)), lastError: note }))
        if (!recorded) continue
        await this.save()
        if (!started) continue
        // The save awaited: a Stop that came meanwhile wins, and a pause holds the start for the next pass.
        if (this.revision(profileId) !== revision) continue
        if (this.host.paused?.(profileId)) {
          const wasExpected = latest.expected.find((e) => e.number === started.number)
          if (this.apply(profileId, revision, (state) => ({ ...state, seen: state.seen.filter((n) => n !== started.number),
            expected: wasExpected ? [...state.expected, wasExpected] : state.expected }))) await this.save()
          continue
        }
        try { await this.host.start(started.url, profileId) } catch (error) {
          if (this.apply(profileId, revision, (state) => ({ ...state, lastError: `#${started.number}: ${message(error)}` }))) await this.save()
        }
      }
    } finally { this.busy = false }
  }

  /**
   * Saves run one after another, and each writes the state as it is when its turn comes, not when it was asked for:
   * a check's save that was slow to finish can never land after a Stop's and turn the queue back on.
   */
  private save(): Promise<void> {
    const next = this.writing.catch(() => {}).then(() => (this.host.write ?? writeFileAtomic)(this.path, JSON.stringify(this.state)))
    this.writing = next
    return next
  }
  private writing: Promise<void> = Promise.resolve()
}

const message = (error: unknown): string => (error instanceof Error ? error.message : 'failed').slice(0, 300)
const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 5000 && value.every((n) => Number.isSafeInteger(n) && n > 0)
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/
/** A stored queue, or null. A queue saved before it knew its repository is dropped: it is turned on again by asking. */
function normalize(value: unknown): QueueState | null {
  const v = value as Partial<QueueState> | null
  if (!v || typeof v !== 'object' || typeof v.enabled !== 'boolean' || typeof v.repository !== 'string' || !REPOSITORY.test(v.repository)
    || !Number.isFinite(v.activatedAt) || !numbers(v.seen) || !numbers(v.waiting) || (v.lastError !== null && typeof v.lastError !== 'string')) return null
  const expected = Array.isArray(v.expected) ? v.expected.filter((e) => e && Number.isSafeInteger(e.number) && e.number > 0 && Number.isFinite(e.until)).slice(-20) : []
  return { enabled: v.enabled, repository: v.repository, activatedAt: v.activatedAt as number, seen: v.seen, waiting: v.waiting, expected, lastError: v.lastError ?? null }
}
