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

test('extractSessionId recognizes only bounded resume banners', () => {
  assert.equal(extractSessionId('Session ID: work-session-9\n'), 'work-session-9')
  assert.equal(extractSessionId('Resume this session with copilot --resume=abc123\n'), 'abc123')
  assert.equal(extractSessionId('Session ID: --allow-all-tools\n'), null)
  assert.equal(extractSessionId('Session ID: work-'), null)
  assert.equal(extractSessionId('ordinary output'), null)
})
