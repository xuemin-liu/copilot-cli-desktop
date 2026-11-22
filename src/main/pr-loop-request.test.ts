import test from 'node:test'
import assert from 'node:assert/strict'
import { prLoopRequest } from './pr-loop-request.js'

test('a review request names a PR by number or URL', () => {
  assert.deepEqual(prLoopRequest('review PR 287'), { kind: 'review', number: 287, repository: null })
  assert.deepEqual(prLoopRequest('Please review pull request #287 when you can'), { kind: 'review', number: 287, repository: null })
  assert.deepEqual(prLoopRequest('review https://github.com/Owner/Repo/pull/12'), { kind: 'review', number: 12, repository: 'Owner/Repo' })
  assert.deepEqual(prLoopRequest('can you review #45?'), { kind: 'review', number: 45, repository: null })
})

test('a fix request wins over the word review in the same sentence', () => {
  assert.deepEqual(prLoopRequest('watch PR 286 and fix the review feedback'), { kind: 'fix', number: 286, repository: null })
  assert.deepEqual(prLoopRequest('fix PR 286'), { kind: 'fix', number: 286, repository: null })
  assert.deepEqual(prLoopRequest('address the comments on pull request 7'), { kind: 'fix', number: 7, repository: null })
})

test('no PR, no intent, a URL to another host or a request deep in pasted text start nothing', () => {
  for (const text of ['review the plan', 'PR 287 looks good', 'review https://evil.test/o/r/pull/3', 'fix it', '', 'review PR 0',
    'Here is a log:\nline\nline\nline\nreview PR 287']) assert.equal(prLoopRequest(text), null, JSON.stringify(text))
})
