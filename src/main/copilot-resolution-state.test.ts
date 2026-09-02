import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_RESOLUTION_REFRESH_FAILURE_STATE,
  TRANSIENT_REFRESH_FAILURE_TOLERANCE,
  sameCopilotResolution,
  shouldAdoptRefreshedResolution,
  trackResolutionRefreshFailure,
} from './copilot-resolution-state.js'
import type { CopilotResolution } from './types.js'

const FOUND: CopilotResolution = {
  kind: 'direct',
  command: 'copilot',
  prefixArgs: [],
  resolvedPath: 'C:\\Tools\\copilot.exe',
  version: '1.0.82',
  error: null,
}

test('a transient failed refresh cannot replace a known-good CLI resolution', () => {
  assert.equal(shouldAdoptRefreshedResolution(FOUND, {
    ...FOUND,
    version: null,
    error: 'copilot CLI was not found',
  }, 1), false)
})

test('refresh adopts recovery from a failed resolution and real version changes', () => {
  assert.equal(shouldAdoptRefreshedResolution({ ...FOUND, version: null }, FOUND, 0), true)
  assert.equal(shouldAdoptRefreshedResolution(FOUND, { ...FOUND, version: '1.0.83' }, 0), true)
})

test('a persistent failed refresh eventually replaces a stale resolution', () => {
  assert.equal(shouldAdoptRefreshedResolution(FOUND, {
    ...FOUND,
    version: null,
    error: 'copilot CLI was not found',
  }, TRANSIENT_REFRESH_FAILURE_TOLERANCE + 1), true)
})

test('an unchanged refresh is ignored', () => {
  assert.equal(sameCopilotResolution(FOUND, { ...FOUND }), true)
  assert.equal(shouldAdoptRefreshedResolution(FOUND, { ...FOUND }, 0), false)
})

test('callers sharing one failed probe only consume one retry', () => {
  const missing = { ...FOUND, version: null, error: 'copilot CLI was not found' }
  const first = trackResolutionRefreshFailure(FOUND, missing, EMPTY_RESOLUTION_REFRESH_FAILURE_STATE, 7)
  const duplicate = trackResolutionRefreshFailure(FOUND, missing, first, 7)
  const secondProbe = trackResolutionRefreshFailure(FOUND, missing, duplicate, 8)

  assert.equal(first.consecutiveFailures, 1)
  assert.strictEqual(duplicate, first)
  assert.equal(secondProbe.consecutiveFailures, 2)
})

test('a successful probe resets the failed-probe tracker', () => {
  const failed = trackResolutionRefreshFailure(
    FOUND,
    { ...FOUND, version: null },
    EMPTY_RESOLUTION_REFRESH_FAILURE_STATE,
    7,
  )
  assert.strictEqual(trackResolutionRefreshFailure(FOUND, FOUND, failed, 8), EMPTY_RESOLUTION_REFRESH_FAILURE_STATE)
})
