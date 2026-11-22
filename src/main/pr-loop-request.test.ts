import test from 'node:test'
import assert from 'node:assert/strict'
import { prLoopRequest, prQueueRequest } from './pr-loop-request.js'

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
    'Here is a log:\nreview PR 287', 'Review PR 287\nPlease do not post anything yet', 'Watch PR 286 and fix PR 287',
    'review PR 287 and https://github.com/o/r/pull/12', 'fix PR 286, like #12',
    'fix https://github.com/a/repo/pull/5 using https://github.com/b/repo/pull/5', `review PR 287\n${'x'.repeat(2100)}`])
    assert.equal(prLoopRequest(text), null, JSON.stringify(text.slice(0, 80)))
  assert.deepEqual(prLoopRequest('review https://github.com/o/r/pull/12 (that is PR 12)'), { kind: 'review', number: 12, repository: 'o/r' }, 'a URL and its own number agree')
  assert.deepEqual(prLoopRequest('review https://github.com/o/r/pull/12\nThe one about logins.'), { kind: 'review', number: 12, repository: 'o/r' }, 'one PR, named once by URL')
  assert.deepEqual(prLoopRequest('fix PR 286\nIt is PR 286 on the main repo.'), { kind: 'fix', number: 286, repository: null }, 'the same PR named twice')
})

test('reviewing new PRs is turned on and off by one short command', () => {
  for (const text of ['review new PRs in this repo', 'Please review new pull requests', 'review all new PRs for this project.', 'watch for new PRs', 'watch and review new PRs in the repo'])
    assert.deepEqual(prQueueRequest(text), { kind: 'queue-on' }, text)
  for (const text of ['stop reviewing new PRs', 'stop reviewing new pull requests in this repo', 'no longer watching new PRs'])
    assert.deepEqual(prQueueRequest(text), { kind: 'queue-off' }, text)
  for (const text of ['review PR 287', 'do not review new PRs', 'are new PRs reviewed?', 'review new PRs\nbut not mine', 'tell me about new PRs', `review new PRs ${'x'.repeat(300)}`])
    assert.equal(prQueueRequest(text), null, text.slice(0, 60))
  assert.equal(prLoopRequest('review new PRs in this repo'), null, 'not a single-PR review')
})
