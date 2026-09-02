import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TRANSIENT_REFRESH_FAILURE_TOLERANCE,
  sameCopilotResolution,
  shouldAdoptRefreshedResolution,
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
