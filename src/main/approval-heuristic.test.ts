import assert from 'node:assert/strict'
import test from 'node:test'
import { detectApprovalPrompt, extractSessionId } from './approval-heuristic.js'

test('detectApprovalPrompt matches common approval-prompt phrasings', () => {
  assert.equal(detectApprovalPrompt('Allow copilot to run `rm -rf build`?'), true)
  assert.equal(detectApprovalPrompt('Do you want to proceed with this edit?'), true)
  assert.equal(detectApprovalPrompt('Apply this change? [y/n]'), true)
  assert.equal(detectApprovalPrompt('Continue? (y/n)'), true)
  assert.equal(detectApprovalPrompt('This tool call is requesting permission to fetch a URL.'), true)
  assert.equal(detectApprovalPrompt('Press Enter to approve, or Esc to cancel.'), true)
})

test('detectApprovalPrompt ignores ordinary streamed output', () => {
  assert.equal(detectApprovalPrompt('Reading package.json...'), false)
  assert.equal(detectApprovalPrompt('Applied 3 edits to src/index.ts'), false)
  assert.equal(detectApprovalPrompt(''), false)
})

test('extractSessionId reads a labeled session id', () => {
  assert.equal(extractSessionId('Session ID: 8f3c2a91-aa'), '8f3c2a91-aa')
  assert.equal(extractSessionId('session_id=work-2026-08-24'), 'work-2026-08-24')
})

test('extractSessionId reads an id referenced inside a --resume hint', () => {
  assert.equal(
    extractSessionId('Resume this session with `copilot --resume=abcDEF123`'),
    'abcDEF123',
  )
})

test('extractSessionId returns null when no id-shaped text is present', () => {
  assert.equal(extractSessionId('Copilot is ready. Type a message to begin.'), null)
})
