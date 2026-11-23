import assert from 'node:assert/strict'
import test from 'node:test'
import { compareCopilotVersions, isCliVersionChanged, isCopilotVersionOutdated } from './copilot-version.js'

test('Copilot versions follow stable and prerelease semver ordering', () => {
  assert.equal(compareCopilotVersions('1.0.80', '1.0.82'), -1)
  assert.equal(compareCopilotVersions('1.0.82-2', '1.0.82'), -1)
  assert.equal(compareCopilotVersions('1.0.82-10', '1.0.82-2'), 1)
  assert.equal(compareCopilotVersions('v1.0.82', '1.0.82'), 0)
})

test('outdated detection fails closed for missing and unrecognized versions', () => {
  assert.equal(isCopilotVersionOutdated('1.0.80', '1.0.82'), true)
  assert.equal(isCopilotVersionOutdated('1.0.82', '1.0.80'), false)
  assert.equal(isCopilotVersionOutdated(null, '1.0.82'), false)
  assert.equal(isCopilotVersionOutdated('unknown', '1.0.82'), false)
})

test('a changed CLI is any known, different version, newer or older', () => {
  assert.equal(isCliVersionChanged('2.1.0', '2.1.5'), true)
  assert.equal(isCliVersionChanged('2.1.5', '2.0.9'), true)
  assert.equal(isCliVersionChanged('2.1.5', '2.1.5'), false)
  assert.equal(isCliVersionChanged(null, '2.1.5'), false)
  assert.equal(isCliVersionChanged('2.1.5', null), false)
  assert.equal(isCliVersionChanged('unknown', '2.1.5'), false)
})