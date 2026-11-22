import type { GithubFeedback, GithubReview, GithubSnapshot } from './workflow-github.js'

/**
 * Fixed rules for the PR loops (docs/pr-loops-plan.md), with no model involved. The `🤖 ` marker only routes comments
 * between an author and a reviewer that may share one GitHub account; it never proves who wrote something.
 */

export type PrLoopRole = 'follow-up' | 'author' | 'reviewer'
export const DEFAULT_PR_MARKER = '\u{1F916} '
export const PR_LOOP_LIMIT = 30
export const PR_LOOP_EXTENSION = 10
export const PR_LOOP_MAX_LIMIT = 100

export function validMarker(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 16 && !/[\p{Cc}]/u.test(value) && value.trim().length > 0
}

/** Leading whitespace is ignored, as it is when a person reads the comment. */
export function isMarked(body: string, marker: string): boolean {
  return body.replace(/^\s+/, '').startsWith(marker.trimEnd())
}

export interface ApprovalEvidence {
  /** `review`: a formal APPROVED review. `text`: a comment that starts "Approved at <head sha>". */
  kind: 'review' | 'text'
  head: string; base: string
  /** The review id, or the comment's source key. */
  ref: string
  at: number
}

/**
 * A reviewer's decisive state is their latest APPROVED or CHANGES_REQUESTED review. GitHub turns a dismissed review's
 * own state into DISMISSED, so a dismissed approval simply stops counting; a later COMMENTED review changes nothing.
 */
export function decisiveStates(reviews: readonly GithubReview[]): Map<number, GithubReview> {
  const latest = new Map<number, GithubReview>()
  const ordered = [...reviews].sort((a, b) => a.submittedAt - b.submittedAt || a.id - b.id)
  for (const review of ordered) {
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED') continue
    latest.set(review.actorId, review)
  }
  return latest
}

const APPROVED_AT = /^\s*Approved at ([a-f0-9]{40,64})\b/

/**
 * What an author's loop may show as an approval of the PR's current head. Nothing here ends a loop by itself: GitHub
 * does not say which base an outside review saw, so the person confirms (Confirm approval). Returns null when an
 * allowed reviewer still requests changes, or when nothing names the current head.
 * - A formal approval counts only from an allowed reviewer whose account is not the PR author's.
 * - A text approval may come from the author's own account (one account for both sides), but never from a comment
 *   that starts with the marker, which is the author's side.
 */
export function approvalOfHead(snapshot: GithubSnapshot, reviewers: readonly { id: number }[], marker: string): ApprovalEvidence | null {
  const allowed = new Set(reviewers.map((reviewer) => reviewer.id))
  const states = decisiveStates(snapshot.reviews ?? [])
  for (const [actor, review] of states) if (allowed.has(actor) && review.state === 'CHANGES_REQUESTED') return null
  let best: ApprovalEvidence | null = null
  for (const [actor, review] of states) {
    if (!allowed.has(actor) || review.state !== 'APPROVED' || review.commitId !== snapshot.head) continue
    if (snapshot.author !== null && snapshot.author !== undefined && actor === snapshot.author) continue
    if (!best || review.submittedAt > best.at) best = { kind: 'review', head: snapshot.head, base: snapshot.base, ref: String(review.id), at: review.submittedAt }
  }
  if (best) return best
  for (const event of snapshot.feedback) if (textApproves(event, allowed, marker, snapshot.head)) {
    if (!best || event.at > best.at) best = { kind: 'text', head: snapshot.head, base: snapshot.base, ref: event.source, at: event.at }
  }
  return best
}

function textApproves(event: GithubFeedback, allowed: ReadonlySet<number>, marker: string, head: string): boolean {
  if (event.kind !== 'review' || event.actorId === null || !allowed.has(event.actorId) || isMarked(event.body, marker)) return false
  return APPROVED_AT.exec(event.body)?.[1] === head
}

/** A comment whose text approves exactly this head ("Approved at <head>"), whoever wrote it. */
export function approvesHeadText(event: GithubFeedback, head: string): boolean {
  return event.kind === 'review' && APPROVED_AT.exec(event.body)?.[1] === head
}

/** An author's post must start with the marker and must not read as an approval of anything. */
export function authorPostProblem(body: string, marker: string): string | null {
  if (!isMarked(body, marker)) return `Start the reply with "${marker.trimEnd()}" so the reviewer's loop can tell it is yours.`
  const rest = body.replace(/^\s+/, '').slice(marker.trimEnd().length)
  if (/^\s*approved\b/i.test(rest) || APPROVED_AT.test(rest)) return 'An author reply may not read as an approval.'
  return null
}
