import assert from 'node:assert/strict'
import test from 'node:test'
import { bucketKey, orderedComments, removeCommentBucket, updateCommentBucket } from '../renderer/diff-comments.js'
import type { DiffCommentBuckets } from '../renderer/diff-comments.js'

const anchor = (line: number, order = line) => ({ side: 'new' as const, line, quote: `+line ${line}`, order })

test('each file and side keeps its own comments: updating or clearing one bucket leaves the others alone', () => {
  const a = bucketKey('r1', 'a.txt', false)
  const b = bucketKey('r1', 'b.txt', false)
  const aStaged = bucketKey('r1', 'a.txt', true)
  assert.notEqual(a, aStaged)
  let buckets: DiffCommentBuckets = new Map()
  buckets = updateCommentBucket(buckets, a, 'diff a', 'new:2', anchor(2), 'first')
  buckets = updateCommentBucket(buckets, b, 'diff b', 'new:7', anchor(7), 'second')
  buckets = updateCommentBucket(buckets, a, 'diff a changed', 'new:1', anchor(1), 'another on a')
  assert.deepEqual([...buckets.keys()], [a, b])
  assert.equal(buckets.get(a)?.diffText, 'diff a', 'the baseline is the diff the first comment was written against')
  assert.deepEqual(orderedComments(buckets.get(a)!).map(comment => comment.text), ['another on a', 'first'])
  assert.deepEqual(orderedComments(buckets.get(b)!).map(comment => [comment.text, comment.index]), [['second', 7]])
  const cleared = removeCommentBucket(buckets, a)
  assert.deepEqual([...cleared.keys()], [b])
  assert.equal(cleared.get(b), buckets.get(b), 'the other bucket is the same object')
  assert.equal(removeCommentBucket(cleared, a), cleared, 'removing a missing bucket changes nothing')
  const emptied = updateCommentBucket(updateCommentBucket(buckets, a, 'x', 'new:2', anchor(2), null), a, 'x', 'new:1', anchor(1), null)
  assert.deepEqual([...emptied.keys()], [b], 'a bucket with no comments left is dropped')
  assert.equal(buckets.size, 2, 'inputs are never mutated')
})
