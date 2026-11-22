import test from 'node:test'
import assert from 'node:assert/strict'
import { inclusiveRange } from './range.mjs'

test('returns both endpoints', () => {
  assert.deepEqual(inclusiveRange(2, 4), [2, 3, 4])
})

test('returns an empty range when start exceeds end', () => {
  assert.deepEqual(inclusiveRange(4, 2), [])
})
