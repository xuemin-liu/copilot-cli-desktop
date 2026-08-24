import assert from 'node:assert/strict'
import test from 'node:test'
import { truncateUtf8 } from './utf8.js'

test('truncateUtf8 never splits a multi-byte character', () => {
  assert.equal(truncateUtf8('abc😀def', 6), 'abc')
  assert.equal(truncateUtf8('abc😀def', 7), 'abc😀')
  assert.ok(!truncateUtf8('你好世界', 5).includes('\uFFFD'))
})
