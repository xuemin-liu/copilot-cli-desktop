import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopViewMode } from '../renderer/desktop-view-state.js'

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
