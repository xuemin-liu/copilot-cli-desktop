import test from 'node:test'
import assert from 'node:assert/strict'
import { prLoopRequest } from './pr-loop-request.js'

test('a review command names a PR by number or URL', () => {
  assert.deepEqual(prLoopRequest('review PR 287'), { kind: 'review', number: 287, repository: null })
  assert.deepEqual(prLoopRequest('Please review pull request #287 when you can'), { kind: 'review', number: 287, repository: null })
  assert.deepEqual(prLoopRequest('review https://github.com/Owner/Repo/pull/12'), { kind: 'review', number: 12, repository: 'Owner/Repo' })
  assert.deepEqual(prLoopRequest('can you review #45?'), { kind: 'review', number: 45, repository: null })
  assert.deepEqual(prLoopRequest('ok, could you please review PR 3'), { kind: 'review', number: 3, repository: null })
})

test('a fix command, including watch-and-fix', () => {
  assert.deepEqual(prLoopRequest('watch PR 286 and fix the review feedback'), { kind: 'fix', number: 286, repository: null })
  assert.deepEqual(prLoopRequest('fix PR 286'), { kind: 'fix', number: 286, repository: null })
  assert.deepEqual(prLoopRequest('address the comments on pull request 7'), { kind: 'fix', number: 7, repository: null })
  assert.deepEqual(prLoopRequest('please fix the review feedback on PR 286'), { kind: 'fix', number: 286, repository: null })
})

test('watching alone, negations, questions and ambiguous commands start nothing', () => {
  for (const text of ['watch PR 286', 'Please do not review PR 287', 'review PR 287 — never mind', 'fix PR 286 but do not push anything', "don't fix PR 286 yet", 'is the review of PR 287 finished?',
    'has PR 287 been reviewed?', 'review and fix PR 286', 'stop reviewing PR 287', 'review the plan', 'PR 287 looks good',
    'review https://evil.test/o/r/pull/3', 'fix it', '', 'review PR 0', 'tell me what review PR 287 found',
    'Here is a log:\nreview PR 287']) assert.equal(prLoopRequest(text), null, JSON.stringify(text))
})
