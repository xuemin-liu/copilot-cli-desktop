import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidSessionId } from './session-id.js'

test('isValidSessionId accepts plain alphanumeric identifiers with . _ -', () => {
  assert.equal(isValidSessionId('abc123'), true)
  assert.equal(isValidSessionId('work-session-9'), true)
  assert.equal(isValidSessionId('8f3c2a91-aa'), true)
  assert.equal(isValidSessionId('work_2026.08.24'), true)
})

test('isValidSessionId rejects anything that could be parsed as a CLI option', () => {
  assert.equal(isValidSessionId('-x'), false)
  assert.equal(isValidSessionId('--allow-all-tools'), false)
  assert.equal(isValidSessionId('--resume'), false)
})

test('isValidSessionId rejects empty, whitespace, and overlong values', () => {
  assert.equal(isValidSessionId(''), false)
  assert.equal(isValidSessionId('has a space'), false)
  assert.equal(isValidSessionId('a'.repeat(65)), false)
  assert.equal(isValidSessionId('a'.repeat(64)), true)
})
