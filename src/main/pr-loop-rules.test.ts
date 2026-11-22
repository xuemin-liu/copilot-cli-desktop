import test from 'node:test'
import assert from 'node:assert/strict'
import { approvalOfHead, authorPostProblem, decisiveStates, DEFAULT_PR_MARKER, isMarked, validMarker } from './pr-loop-rules.js'
import type { GithubFeedback, GithubReview, GithubSnapshot } from './workflow-github.js'

const head = 'a'.repeat(40), base = 'b'.repeat(40), old = 'c'.repeat(40)
const AUTHOR = 1, REVIEWER = 7, OTHER = 9
const review = (id: number, actorId: number, state: GithubReview['state'], commitId = head, submittedAt = id, body = ''): GithubReview => ({ id, actorId, state, commitId, submittedAt, body })
const comment = (id: number, actorId: number, body: string, at = id): GithubFeedback => ({ source: `github/o/r/pull/1/conversation/${id}`, version: String(id).padStart(64, '0'), actorId, kind: 'review', body, head: null, at })
const snapshot = (reviews: GithubReview[] = [], feedback: GithubFeedback[] = [], author: number | null = AUTHOR): GithubSnapshot =>
  ({ repository: 'o/r', headRepository: 'o/r', branch: 'feature', head, base, open: true, checks: 'absent', feedback, author, reviews })
const allowed = [{ id: REVIEWER }]

test('the marker is read as a person reads it, and must be a short visible prefix', () => {
  assert.equal(isMarked('🤖 Fixed in abc', DEFAULT_PR_MARKER), true)
  assert.equal(isMarked('  \n🤖Fixed', DEFAULT_PR_MARKER), true)
  assert.equal(isMarked('Fixed 🤖', DEFAULT_PR_MARKER), false)
  assert.equal(validMarker('🤖 '), true)
  for (const bad of ['', '   ', 'x'.repeat(17), 'a\u0000b', 7]) assert.equal(validMarker(bad), false, String(bad))
})

test('a decisive state is the latest approval or change request; comments and dismissals do not count', () => {
  const states = decisiveStates([review(1, REVIEWER, 'APPROVED'), review(2, REVIEWER, 'COMMENTED')])
  assert.equal(states.get(REVIEWER)?.state, 'APPROVED')
  assert.equal(decisiveStates([review(1, REVIEWER, 'DISMISSED')]).size, 0)
  assert.equal(decisiveStates([review(1, REVIEWER, 'APPROVED'), review(2, REVIEWER, 'CHANGES_REQUESTED')]).get(REVIEWER)?.state, 'CHANGES_REQUESTED')
  assert.equal(decisiveStates([review(2, REVIEWER, 'CHANGES_REQUESTED', head, 1), review(1, REVIEWER, 'APPROVED', head, 2)]).get(REVIEWER)?.state, 'APPROVED', 'ordered by submit time')
})

test('a formal approval of the head counts, bodyless or not, but only from an allowed reviewer who is not the author', () => {
  assert.equal(approvalOfHead(snapshot([review(5, REVIEWER, 'APPROVED')]), allowed, DEFAULT_PR_MARKER)?.kind, 'review')
  assert.equal(approvalOfHead(snapshot([review(5, REVIEWER, 'APPROVED', head, 5, 'LGTM')]), allowed, DEFAULT_PR_MARKER)?.ref, '5')
  assert.equal(approvalOfHead(snapshot([review(5, OTHER, 'APPROVED')]), allowed, DEFAULT_PR_MARKER), null, 'not an allowed reviewer')
  assert.equal(approvalOfHead(snapshot([review(5, REVIEWER, 'APPROVED')], [], REVIEWER), allowed, DEFAULT_PR_MARKER), null, 'the author approving their own PR')
  assert.equal(approvalOfHead(snapshot([review(5, REVIEWER, 'APPROVED', old)]), allowed, DEFAULT_PR_MARKER), null, 'an older head')
  assert.equal(approvalOfHead(snapshot([review(5, REVIEWER, 'APPROVED'), review(6, REVIEWER, 'COMMENTED')]), allowed, DEFAULT_PR_MARKER)?.kind, 'review', 'a later comment changes nothing')
  assert.equal(approvalOfHead(snapshot([review(5, REVIEWER, 'DISMISSED')]), allowed, DEFAULT_PR_MARKER), null, 'dismissed')
  assert.equal(approvalOfHead(snapshot([review(5, REVIEWER, 'APPROVED'), review(6, REVIEWER, 'CHANGES_REQUESTED')]), allowed, DEFAULT_PR_MARKER), null, 'changes requested later')
})

test('a text approval names the full head sha, comes from an allowed account, and is never a marked reply', () => {
  const same = [{ id: AUTHOR }]
  assert.equal(approvalOfHead(snapshot([], [comment(3, AUTHOR, `Approved at ${head}\nRan the suite.`)]), same, DEFAULT_PR_MARKER)?.kind, 'text', 'one account for both sides')
  assert.equal(approvalOfHead(snapshot([], [comment(3, AUTHOR, `🤖 Approved at ${head}`)]), same, DEFAULT_PR_MARKER), null, 'the author side cannot approve')
  assert.equal(approvalOfHead(snapshot([], [comment(3, AUTHOR, `Approved at ${head.slice(0, 12)}`)]), same, DEFAULT_PR_MARKER), null, 'a prefix is not enough')
  assert.equal(approvalOfHead(snapshot([], [comment(3, AUTHOR, `Approved at ${old}`)]), same, DEFAULT_PR_MARKER), null, 'an older head')
  assert.equal(approvalOfHead(snapshot([], [comment(3, AUTHOR, `Not approved at ${head}`)]), same, DEFAULT_PR_MARKER), null)
  assert.equal(approvalOfHead(snapshot([], [comment(3, OTHER, `Approved at ${head}`)]), same, DEFAULT_PR_MARKER), null, 'not allowed')
  assert.equal(approvalOfHead(snapshot([review(1, AUTHOR, 'CHANGES_REQUESTED')], [comment(3, AUTHOR, `Approved at ${head}`)]), same, DEFAULT_PR_MARKER), null, 'changes still requested')
})

test('an author reply starts with the marker and never reads as an approval', () => {
  assert.equal(authorPostProblem('🤖 Fixed in 1234567.', DEFAULT_PR_MARKER), null)
  assert.match(authorPostProblem('Fixed in 1234567.', DEFAULT_PR_MARKER) ?? '', /Start the reply/)
  assert.match(authorPostProblem('🤖 Approved, looks good', DEFAULT_PR_MARKER) ?? '', /approval/)
  assert.match(authorPostProblem(`🤖 Approved at ${head}`, DEFAULT_PR_MARKER) ?? '', /approval/)
  assert.equal(authorPostProblem('🤖 The approved list is unchanged.', DEFAULT_PR_MARKER), null)
})
