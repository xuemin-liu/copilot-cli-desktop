import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_REVIEWER_CLIS, normalizeReviewerClis, otherCliLaunchKey } from './session-cli.js'

test('the launch key changes when a tab restarts as another version, so the sidebar reads the fresh lookup', () => {
  const before = otherCliLaunchKey([{ cli: 'claude', cliVersion: '2.1.0' }, { cli: 'claude', cliVersion: '2.1.0' }])
  const restarted = otherCliLaunchKey([{ cli: 'claude', cliVersion: '2.1.5' }, { cli: 'claude', cliVersion: '2.1.0' }])
  assert.notEqual(restarted, before)
  assert.notEqual(otherCliLaunchKey([{ cli: 'claude', cliVersion: '2.1.0' }, { cli: 'codex', cliVersion: '0.50.0' }]), otherCliLaunchKey([{ cli: 'claude', cliVersion: '2.1.0' }]))
})

test('the launch key ignores Copilot tabs and tab order, and is empty without another CLI', () => {
  assert.equal(otherCliLaunchKey([{ cliVersion: '1.0.82' }]), '')
  assert.equal(
    otherCliLaunchKey([{ cli: 'codex', cliVersion: '0.50.0' }, { cliVersion: '1.0.82' }, { cli: 'claude', cliVersion: '2.1.0' }]),
    otherCliLaunchKey([{ cli: 'claude', cliVersion: '2.1.0' }, { cli: 'codex', cliVersion: '0.50.0' }]),
  )
})

test('legacy reviewer CLI normalization preserves canonical order and deduplicates', () => {
  assert.deepEqual(normalizeReviewerClis(undefined), DEFAULT_REVIEWER_CLIS)
  assert.deepEqual(normalizeReviewerClis([]), DEFAULT_REVIEWER_CLIS)
  assert.deepEqual(normalizeReviewerClis(['unknown-cli', 42]), DEFAULT_REVIEWER_CLIS)
  assert.deepEqual(
    normalizeReviewerClis(['antigravity', 'codex', 'claude', 'codex', 'copilot']),
    ['copilot', 'claude', 'codex', 'antigravity'],
  )
})
