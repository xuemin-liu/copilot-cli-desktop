import assert from 'node:assert/strict'
import test from 'node:test'
import { canOpenSessionTab, desktopViewMode } from '../renderer/desktop-view-state.js'

test('an unresolved startup probe remains on the loading view', () => {
  assert.equal(desktopViewMode(false, null), 'loading')
})

test('only a completed failed probe shows Copilot CLI diagnostics', () => {
  assert.equal(desktopViewMode(false, {
    kind: 'direct',
    command: 'copilot',
    prefixArgs: [],
    resolvedPath: null,
    version: null,
    error: 'copilot CLI was not found',
  }), 'diagnostics')
})

test('existing terminal tabs remain visible after a failed probe', () => {
  assert.equal(desktopViewMode(false, {
    kind: 'direct',
    command: 'copilot',
    prefixArgs: [],
    resolvedPath: null,
    version: null,
    error: 'copilot CLI was not found',
  }, true), 'desktop')
})

test('a completed successful probe shows the desktop', () => {
  assert.equal(desktopViewMode(false, {
    kind: 'direct',
    command: 'copilot',
    prefixArgs: [],
    resolvedPath: null,
    version: '1.0.82',
    error: null,
  }), 'desktop')
})

test('new sessions require a resolved CLI and an available tab slot', () => {
  const found = {
    kind: 'direct' as const,
    command: 'copilot',
    prefixArgs: [],
    resolvedPath: null,
    version: '1.0.82',
    error: null,
  }
  assert.equal(canOpenSessionTab(null, 0, 20), false)
  assert.equal(canOpenSessionTab({ ...found, version: null }, 0, 20), false)
  assert.equal(canOpenSessionTab(found, 19, 20), true)
  assert.equal(canOpenSessionTab(found, 20, 20), false)
})
