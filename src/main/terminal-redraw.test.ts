import assert from 'node:assert/strict'
import test from 'node:test'
import { clipboardCopyNeedsRedraw } from '../renderer/terminal-redraw.js'

test('requests recovery when a populated viewport collapses to a copy status line', () => {
  assert.equal(clipboardCopyNeedsRedraw(240, 19), true)
})

test('leaves a normally updated viewport alone', () => {
  assert.equal(clipboardCopyNeedsRedraw(240, 235), false)
  assert.equal(clipboardCopyNeedsRedraw(60, 25), false)
})

test('does not treat a naturally sparse viewport as a failed redraw', () => {
  assert.equal(clipboardCopyNeedsRedraw(30, 5), false)
})
