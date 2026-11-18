import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorMovedComments, bucketKey, orderedComments, pruneCommentBuckets, removeCommentBucket, updateCommentBucket } from '../renderer/diff-comments.js'
import type { DiffCommentBuckets } from '../renderer/diff-comments.js'

const anchor = (line: number, order = line, quote = `+line ${line}`) => ({ side: 'new' as const, line, quote, order, position: line })
const A = { repoId: 'r1', path: 'a.txt', staged: false }
const B = { repoId: 'r1', path: 'b.txt', staged: false }
const A_STAGED = { repoId: 'r1', path: 'a.txt', staged: true }

test('each file and side keeps its own comments: updating or clearing one bucket leaves the others alone', () => {
  assert.notEqual(bucketKey(A), bucketKey(A_STAGED))
  let buckets: DiffCommentBuckets = new Map()
  buckets = updateCommentBucket(buckets, A, 'diff a', 'new:2', anchor(2), 'first')
  buckets = updateCommentBucket(buckets, B, 'diff b', 'new:7', anchor(7), 'second')
  buckets = updateCommentBucket(buckets, A, 'diff a changed', 'new:1', anchor(1), 'another on a')
  assert.deepEqual([...buckets.keys()], [bucketKey(A), bucketKey(B)])
  assert.equal(buckets.get(bucketKey(A))?.diffText, 'diff a', 'the baseline is the diff the first comment was written against')
  assert.deepEqual(orderedComments(buckets.get(bucketKey(A))!).map(comment => comment.text), ['another on a', 'first'])
  assert.deepEqual(orderedComments(buckets.get(bucketKey(B))!).map(comment => [comment.text, comment.index, comment.redacted]), [['second', 7, false]])
  const cleared = removeCommentBucket(buckets, bucketKey(A))
  assert.deepEqual([...cleared.keys()], [bucketKey(B)])
  assert.equal(cleared.get(bucketKey(B)), buckets.get(bucketKey(B)), 'the other bucket is the same object')
  assert.equal(removeCommentBucket(cleared, bucketKey(A)), cleared, 'removing a missing bucket changes nothing')
  const emptied = updateCommentBucket(updateCommentBucket(buckets, A, 'x', 'new:2', anchor(2), null), A, 'x', 'new:1', anchor(1), null)
  assert.deepEqual([...emptied.keys()], [bucketKey(B)], 'a bucket with no comments left is dropped')
  assert.equal(buckets.size, 2, 'inputs are never mutated')
})

test('a quote taken from inside a private-key block of the diff it was captured from is redacted at capture', () => {
  const first = '@@ -1 +1,2 @@\n harmless\n+also harmless'
  const later = '@@ -1 +1,5 @@\n harmless\n+-----BEGIN RSA PRIVATE KEY-----\n+MIIEowIBAAKCAQEAu7secretsecretsecret\n+-----END RSA PRIVATE KEY-----\n+after'
  let buckets: DiffCommentBuckets = new Map()
  buckets = updateCommentBucket(buckets, A, first, 'new:2', anchor(2, 2, '+also harmless'), 'fine')
  // The file changed under the bucket; the new comment's anchor comes from the diff that is current now.
  buckets = updateCommentBucket(buckets, A, later, 'new:3', anchor(3, 3, '+MIIEowIBAAKCAQEAu7secretsecretsecret'), 'rotate')
  buckets = updateCommentBucket(buckets, A, later, 'new:5', anchor(5, 5, '+after'), 'ok')
  const bucket = buckets.get(bucketKey(A))!
  assert.equal(bucket.diffText, first, 'the stale-warning baseline stays the first diff')
  assert.deepEqual(orderedComments(bucket).map(comment => [comment.text, comment.redacted, comment.quote]), [['fine', false, '+also harmless'], ['rotate', true, ''], ['ok', false, '+after']])
  assert.ok(!JSON.stringify([...buckets.values()]).includes('MIIEow'), 'key material is never stored')
})

test('clean files lose their comments, and files that moved sides keep their drafts without touching other repositories', () => {
  let buckets: DiffCommentBuckets = new Map()
  buckets = updateCommentBucket(buckets, A, 'a', 'new:1', anchor(1), 'on a')
  buckets = updateCommentBucket(buckets, B, 'b', 'new:1', anchor(1), 'on b')
  buckets = updateCommentBucket(buckets, A_STAGED, 'a staged', 'new:1', anchor(1), 'on staged a')
  buckets = updateCommentBucket(buckets, { repoId: 'r2', path: 'a.txt', staged: false }, 'other repo', 'new:1', anchor(1), 'elsewhere')
  const changed = new Set(['a.txt:working', 'a.txt:staged'])
  const pruned = pruneCommentBuckets(buckets, 'r1', (path, staged) => changed.has(`${path}:${staged ? 'staged' : 'working'}`))
  assert.deepEqual([...pruned.keys()], [bucketKey(A), bucketKey(A_STAGED), bucketKey({ repoId: 'r2', path: 'a.txt', staged: false })], 'b.txt went clean; the other repository is not reconciled')
  assert.equal(pruneCommentBuckets(pruned, 'r1', () => true), pruned, 'nothing to prune returns the same map')
  const staged = pruneCommentBuckets(pruned, 'r1', (_path, staged) => !staged)
  assert.deepEqual([...staged.keys()], [bucketKey(A), bucketKey({ repoId: 'r2', path: 'a.txt', staged: false })])
  assert.deepEqual(staged.get(bucketKey(A))?.pending.map(comment => comment.text), ['on staged a'])
  assert.equal(buckets.size, 4, 'inputs are never mutated')
})

test('moving comments reanchors unique quotes and keeps collisions, redacted and ambiguous quotes unanchored', () => {
  const diffText = '@@ -1 +1,5 @@\n base\n+unique\n+repeated\n+repeated\n+occupied'
  const privateDiff = '@@ -0,0 +1,3 @@\n+-----BEGIN RSA PRIVATE KEY-----\n+fakepayload\n+-----END RSA PRIVATE KEY-----'
  let buckets: DiffCommentBuckets = new Map()
  buckets = updateCommentBucket(buckets, A_STAGED, diffText, 'new:5', anchor(5, 5, '+occupied'), 'destination')
  buckets = updateCommentBucket(buckets, A, '', 'new:8', anchor(8, 8, '+unique'), 'moves')
  buckets = updateCommentBucket(buckets, A, '', 'new:9', anchor(9, 9, '+repeated'), 'ambiguous')
  buckets = updateCommentBucket(buckets, A, '', 'new:10', anchor(10, 10, '+occupied'), 'collision')
  buckets = updateCommentBucket(buckets, A, privateDiff, 'new:2', anchor(2, 2, '+fakepayload'), 'redacted')
  const moved = pruneCommentBuckets(buckets, A.repoId, (_path, staged) => staged)
  const key = bucketKey(A_STAGED)
  const anchored = anchorMovedComments(moved, key, { entryId: 'e1-0', path: A.path, kind: 'text', text: diffText, truncated: false, added: 4, deleted: 0 })
  assert.deepEqual(orderedComments(anchored.get(key)!).map(comment => [comment.text, comment.line, comment.redacted]), [
    ['moves', 2, false], ['destination', 5, false], ['ambiguous', null, false], ['collision', null, false], ['redacted', null, true],
  ])
  assert.ok(anchored.get(key)?.unanchored.every(comment => comment.quote === ''))
})
