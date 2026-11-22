import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { authorPostProblem, DEFAULT_PR_MARKER } from './pr-loop-rules.js'
import { GithubWriteRefused, type GithubApi, type GithubWrite } from './workflow-github.js'
import type { FollowupGrant } from './workflow-followups.js'

/**
 * The PR loops' only way to write to GitHub (docs/pr-loops-plan.md, decisions 1 and 6). A session asks through its
 * helper; the desktop checks the grant, the account, the PR and the target, then posts. Every post has a receipt: its
 * intent is saved before the write, and its GitHub id after. A hidden tag in the body lets the desktop find, after a
 * crash, whether a post landed. When it cannot tell, the person decides; nothing is ever posted twice by itself.
 */

export type ReceiptState = 'intent' | 'posted' | 'uncertain' | 'dismissed'
export interface PostReceipt {
  id: string; grantId: string; sessionId: string; repository: string; number: number
  kind: 'reply' | 'comment'; target: number | null; bodyHash: string; state: ReceiptState
  githubId: number | null; url: string | null; createdAt: number
}
export interface PostHost { api: GithubApi; write: GithubWrite; now?: () => number }
export interface ReplyRequest { to: string; body: string }

const MAX_BODY = 60_000
/** How long a write may still be in flight before reconciliation looks it up on GitHub. */
const RECONCILE_AFTER_MS = 90_000
export const receiptTag = (id: string): string => `<!-- copilot-desktop-receipt:${id} -->`
const TAG = /<!-- copilot-desktop-receipt:([a-f0-9-]{36}) -->/g
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export class PrPostRejected extends Error {}

export class PrLoopPosts {
  private readonly db: DatabaseSync
  private readonly now: () => number
  /** One post at a time per grant, so two helper calls cannot race past the checks. */
  private readonly busy = new Set<string>()
  constructor(path: string, private readonly host: PostHost) {
    this.now = host.now ?? Date.now
    this.db = new DatabaseSync(path)
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported PR post schema')
      this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS receipts_grant ON receipts(grant_id);
        PRAGMA user_version=1;`)
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }

  list(grantId?: string): PostReceipt[] {
    const rows = (grantId === undefined ? this.db.prepare('SELECT value FROM receipts ORDER BY rowid').all()
      : this.db.prepare('SELECT value FROM receipts WHERE grant_id=? ORDER BY rowid').all(grantId)) as { value: string }[]
    return rows.map((row) => JSON.parse(row.value) as PostReceipt)
  }
  /** False while a post of this grant is not known to have landed or not. */
  settled(grantId: string): boolean {
    return !this.list(grantId).some((receipt) => receipt.state === 'intent' || receipt.state === 'uncertain')
  }

  /**
   * An author's reply on its own PR. `grant` is the grant as stored now; `sessionId` is the session the helper call
   * came from, which must be the grant's.
   */
  async reply(grant: FollowupGrant | null, sessionId: string, request: ReplyRequest, authorized: () => boolean = () => true): Promise<PostReceipt> {
    if (!grant || !grant.enabled || grant.role !== 'author') throw new PrPostRejected('This session has no active fix loop.')
    if (grant.sessionId !== sessionId) throw new PrPostRejected('This session does not hold the fix loop for that PR.')
    if (this.busy.has(grant.id)) throw new PrPostRejected('Another reply of this loop is being posted; try again in a moment.')
    this.busy.add(grant.id)
    try {
      if (!this.settled(grant.id)) throw new PrPostRejected('An earlier reply may not have reached GitHub. The person has to check it in Needs you first.')
      const body = typeof request.body === 'string' ? request.body.replace(/\r\n/g, '\n').trim() : ''
      if (!body) throw new PrPostRejected('The reply is empty.')
      if (body.length > MAX_BODY) throw new PrPostRejected('The reply is too long.')
      if (new RegExp(TAG.source).test(body)) throw new PrPostRejected('The reply may not carry a receipt tag.')
      const problem = authorPostProblem(body, grant.marker ?? DEFAULT_PR_MARKER)
      if (problem) throw new PrPostRejected(problem)
      const to = request.to
      const target = to === 'conversation' ? null : /^[0-9]{1,19}$/.test(to) && Number.isSafeInteger(Number(to)) && Number(to) > 0 ? Number(to) : undefined
      if (target === undefined) throw new PrPostRejected('Name an inline comment id, or "conversation".')

      const me = await this.host.api('user') as { id?: unknown }
      if (!me || me.id !== grant.accountId) throw new PrPostRejected('GitHub is signed in to a different account than the one this loop was enrolled with.')
      const pull = await this.host.api(`repos/${grant.repository}/pulls/${grant.number}`) as { state?: unknown }
      if (!pull || pull.state !== 'open') throw new PrPostRejected('The pull request is not open.')
      if (target !== null) {
        // The id must be an inline comment on this PR, not on another one the session saw somewhere.
        const comment = await this.host.api(`repos/${grant.repository}/pulls/comments/${target}`) as { pull_request_url?: unknown }
        const expected = `https://api.github.com/repos/${grant.repository}/pulls/${grant.number}`.toLowerCase()
        if (!comment || typeof comment.pull_request_url !== 'string' || comment.pull_request_url.toLowerCase() !== expected) {
          throw new PrPostRejected('That comment is not on this pull request.')
        }
      }

      // The lookups above took time: the loop may have been paused, or the session lost its grant, meanwhile.
      if (!authorized()) throw new PrPostRejected('The fix loop was stopped or changed; nothing was posted.')
      const receipt: PostReceipt = { id: randomUUID(), grantId: grant.id, sessionId, repository: grant.repository, number: grant.number,
        kind: target === null ? 'comment' : 'reply', target, bodyHash: '', state: 'intent', githubId: null, url: null, createdAt: this.now() }
      const posted = `${body}\n\n${receiptTag(receipt.id)}`
      receipt.bodyHash = sha256(posted)
      this.save(receipt)
      if (!authorized()) { this.save({ ...receipt, state: 'dismissed' }); throw new PrPostRejected('The fix loop was stopped or changed; nothing was posted.') }
      let answer: unknown
      try {
        answer = target === null
          ? await this.host.write('POST', `repos/${grant.repository}/issues/${grant.number}/comments`, { body: posted })
          : await this.host.write('POST', `repos/${grant.repository}/pulls/${grant.number}/comments/${target}/replies`, { body: posted })
      } catch (error) {
        if (error instanceof GithubWriteRefused) {
          // GitHub said no, so nothing exists to reconcile: the reply can be corrected and sent once.
          this.save({ ...receipt, state: 'dismissed' })
          throw new PrPostRejected(`GitHub refused the reply (HTTP ${error.status}): ${error.detail || 'no reason given'}. Nothing was posted; correct it and send it once.`)
        }
        // It may still have landed: the receipt stays an intent, and reconciliation looks for its tag.
        throw new PrPostRejected('GitHub did not confirm the reply. The desktop will check whether it landed; do not post it again.')
      }
      const result = answer as { id?: unknown; html_url?: unknown } | null
      if (!result || !Number.isSafeInteger(result.id)) throw new PrPostRejected('GitHub did not confirm the reply. The desktop will check whether it landed; do not post it again.')
      const done = { ...receipt, state: 'posted' as const, githubId: result.id as number, url: typeof result.html_url === 'string' ? result.html_url : null }
      this.save(done)
      return done
    } finally {
      this.busy.delete(grant.id)
    }
  }

  /**
   * Settles intents that are old enough: a single comment on the PR carrying the tag, with the body that was posted,
   * makes it posted. No match, or more than one, makes it uncertain for the person.
   */
  async reconcile(): Promise<void> {
    const due = this.list().filter((receipt) => receipt.state === 'intent' && this.now() - receipt.createdAt >= RECONCILE_AFTER_MS && !this.busy.has(receipt.grantId))
    const byPull = new Map<string, PostReceipt[]>()
    for (const receipt of due) byPull.set(`${receipt.repository}#${receipt.number}`, [...(byPull.get(`${receipt.repository}#${receipt.number}`) ?? []), receipt])
    for (const receipts of byPull.values()) {
      const { repository, number } = receipts[0]!
      let comments: { id: number; body: string; url: string | null }[]
      try {
        const pages = [
          await this.host.api(`repos/${repository}/pulls/${number}/comments?per_page=100`, true),
          await this.host.api(`repos/${repository}/issues/${number}/comments?per_page=100`, true),
        ]
        comments = pages.flatMap((paged) => Array.isArray(paged) ? paged.flat() : [])
          .filter((item): item is { id: number; body: string; html_url?: unknown } => !!item && typeof item === 'object' && Number.isSafeInteger((item as { id?: unknown }).id) && typeof (item as { body?: unknown }).body === 'string')
          .map((item) => ({ id: item.id, body: item.body, url: typeof item.html_url === 'string' ? item.html_url : null }))
      } catch { continue }
      for (const receipt of receipts) {
        const matches = comments.filter((comment) => comment.body.includes(receiptTag(receipt.id)))
        const current = this.list(receipt.grantId).find((item) => item.id === receipt.id)
        if (current?.state !== 'intent') continue
        if (matches.length === 1 && sha256(matches[0]!.body) === receipt.bodyHash) this.save({ ...current, state: 'posted', githubId: matches[0]!.id, url: matches[0]!.url })
        else this.save({ ...current, state: 'uncertain' })
      }
    }
  }

  /** The person looked at an uncertain post: it is settled either way, and nothing is posted again. */
  dismiss(id: string): void {
    const receipt = this.list().find((item) => item.id === id)
    if (!receipt || receipt.state !== 'uncertain') throw new Error('There is no uncertain reply with that id')
    this.save({ ...receipt, state: 'dismissed' })
  }

  private save(receipt: PostReceipt): void {
    this.db.prepare('INSERT INTO receipts(id,grant_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(receipt.id, receipt.grantId, JSON.stringify(receipt))
  }
}
