import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'

export interface PersistedCodexAuthSync {
  seatAuthPath: string
  realAuthPath: string
  initialSha256: string
}

/**
 * Which review owns which reviewer folder and worktree (docs/pr-loops-plan.md, decision 6). A start records its
 * (repository, PR, reviewer) and the folder it is about to make before anything is made, so:
 * - a second start of the same review is refused, also while the first is still cloning;
 * - after a crash, what the desktop finds in the person's project is known to be its own, and nothing else is touched.
 * A failed start releases its record once its folder is gone. A record whose worktree has changes is kept for the
 * person (`kept`), with its folder.
 */
export interface ReviewReservation {
  /** The launch id: the reviewer folder's own name. */
  launchId: string
  repository: string; number: number; reviewer: string
  project: string; root: string; checkout: string; ref: string
  /** The review task, once the session took its first prompt. */
  taskId: string | null
  createdAt: number
  kept: boolean
  /**
   * When a removal found that Git had taken the worktree out of the project while it had no changes, and only deleting
   * its folder failed (a file still held open, on Windows). What was in the folder then is the desktop's to clear, not
   * the person's; anything saved there later is not. Set only from such a removal: a kept record without it is the
   * person's for as long as its folder exists.
   */
  detachedAt?: number
  /** Trusted restart-recovery record for syncing a rotated Codex OAuth refresh token before deleting the seat home. */
  codexAuthSync?: PersistedCodexAuthSync | null
}

const key = (r: Pick<ReviewReservation, 'repository' | 'number' | 'reviewer'>): string => `${r.repository.toLowerCase()}#${r.number}#${r.reviewer}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

export class ReviewReservations {
  private records = new Map<string, ReviewReservation>()
  private writing: Promise<void> = Promise.resolve()
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (Array.isArray(parsed)) for (const value of parsed) if (valid(value)) this.records.set(value.launchId, value)
    } catch { /* None yet. An unreadable file reserves nothing; the startup sweep keeps folders it cannot account for. */ }
  }
  list(): ReviewReservation[] { return [...this.records.values()].map((r) => ({ ...r })) }
  /** The holder of this review, if any. */
  holder(repository: string, number: number, reviewer: string): ReviewReservation | null {
    const wanted = key({ repository, number, reviewer })
    return [...this.records.values()].find((r) => key(r) === wanted) ?? null
  }
  /** Records the review before anything is made. Throws if this review is already held. Atomic within the process. */
  async reserve(record: Omit<ReviewReservation, 'taskId' | 'createdAt' | 'kept' | 'codexAuthSync'>): Promise<void> {
    if (!UUID.test(record.launchId) || basename(record.root) !== record.launchId) throw new Error('Invalid reviewer folder')
    const held = this.holder(record.repository, record.number, record.reviewer)
    if (held) throw new Error(held.kept
      ? held.detachedAt !== undefined
        ? `The folder of an earlier review of PR #${record.number} is still in use and could not be deleted (${held.root}); close what has it open, then try again.`
        : `An earlier review of PR #${record.number} left changes in its worktree (${held.checkout}); look at it and remove it first.`
      : `PR #${record.number} already has a review starting or running.`)
    this.records.set(record.launchId, { ...record, taskId: null, createdAt: this.now(), kept: false })
    try { await this.save() } catch (error) { this.records.delete(record.launchId); throw error }
  }
  async bind(launchId: string, taskId: string): Promise<void> {
    const r = this.records.get(launchId); if (!r) return
    this.records.set(launchId, { ...r, taskId }); await this.save()
  }
  async setCodexAuthSync(launchId: string, codexAuthSync: PersistedCodexAuthSync | null): Promise<void> {
    const r = this.records.get(launchId); if (!r) return
    if (codexAuthSync) {
      this.records.set(launchId, { ...r, codexAuthSync })
    } else {
      const { codexAuthSync: _removed, ...rest } = r
      this.records.set(launchId, rest)
    }
    await this.save()
  }
  /** Keeps the record with its folder. `detached` says a clean removal took the worktree out and only the folder stayed. */
  async keep(launchId: string, detached = false): Promise<void> {
    const r = this.records.get(launchId); if (!r || (r.kept && (r.detachedAt !== undefined || !detached))) return
    this.records.set(launchId, { ...r, kept: true, ...(detached ? { detachedAt: this.now() } : {}) }); await this.save()
  }
  /** The leftover folder turned out to hold something saved after the removal: the record is the person's again. */
  async undetach(launchId: string): Promise<void> {
    const r = this.records.get(launchId); if (!r || r.detachedAt === undefined) return
    const { detachedAt: _removed, ...rest } = r
    this.records.set(launchId, rest); await this.save()
  }
  async release(launchId: string): Promise<void> {
    if (!this.records.delete(launchId)) return
    await this.save()
  }
  private save(): Promise<void> {
    const text = JSON.stringify([...this.records.values()])
    this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(this.path, text))
    return this.writing
  }
}

function validCodexAuthSync(value: unknown, root: string): value is PersistedCodexAuthSync {
  const c = value as PersistedCodexAuthSync
  if (!c || typeof c !== 'object') return false
  if (typeof c.seatAuthPath !== 'string' || !c.seatAuthPath.trim()) return false
  if (typeof c.realAuthPath !== 'string' || !c.realAuthPath.trim()) return false
  if (typeof c.initialSha256 !== 'string' || !SHA256_HEX.test(c.initialSha256)) return false
  const expectedSeatAuth = join(resolve(root), 'home', 'codex-home', 'auth.json')
  const sameSeat = process.platform === 'win32'
    ? resolve(c.seatAuthPath).toLowerCase() === expectedSeatAuth.toLowerCase()
    : resolve(c.seatAuthPath) === expectedSeatAuth
  return sameSeat
}

function valid(value: unknown): value is ReviewReservation {
  const v = value as ReviewReservation
  return !!v && typeof v === 'object' && typeof v.launchId === 'string' && UUID.test(v.launchId) && typeof v.repository === 'string' && Number.isSafeInteger(v.number)
    && typeof v.reviewer === 'string' && typeof v.project === 'string' && typeof v.root === 'string' && basename(v.root) === v.launchId
    && typeof v.checkout === 'string' && typeof v.ref === 'string' && v.ref === `refs/desktop-review/${v.launchId}`
    && (v.taskId === null || typeof v.taskId === 'string') && Number.isFinite(v.createdAt) && typeof v.kept === 'boolean'
    && (v.detachedAt === undefined || (typeof v.detachedAt === 'number' && Number.isFinite(v.detachedAt)))
    && (v.codexAuthSync === undefined || v.codexAuthSync === null || validCodexAuthSync(v.codexAuthSync, v.root))
}
