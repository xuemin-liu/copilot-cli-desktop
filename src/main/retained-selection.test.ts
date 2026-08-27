import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activateSelection,
  beginApplicationScroll,
  captureSelectionText,
  confirmPendingSelection,
  detachSelection,
  emptyRetainedSelection,
  isApplicationScrollShortcut,
  isCopyShortcut,
  mouseModeForwardsWheel,
  retainedSelectionTextForCopy,
  retainSelection,
  shouldClearSelectionForKey,
  wheelIsApplicationInput,
  type RetainedSelectionRange,
} from '../renderer/retained-selection.js'

const range: RetainedSelectionRange = { column: 7, row: 12, length: 6 }

test('application scroll hides a retained selection from copy without discarding it', () => {
  const pending = beginApplicationScroll(retainSelection(range, 'target'))

  assert.deepEqual(pending, {
    phase: 'scroll-pending',
    range,
    text: 'target',
  })
  assert.equal(retainedSelectionTextForCopy(pending), '')
})

test('a quiet application scroll restores the original selection when its cells still match', () => {
  const pending = beginApplicationScroll(retainSelection(range, 'target'))

  assert.deepEqual(confirmPendingSelection(pending, true), retainSelection(range, 'target'))
})

test('a completed redraw detaches a pending selection when its original cells changed', () => {
  const pending = beginApplicationScroll(retainSelection(range, 'target'))

  assert.deepEqual(confirmPendingSelection(pending, false), {
    phase: 'detached',
    range,
    text: 'target',
  })
})

test('a detached selection may legitimately reactivate at its original coordinates', () => {
  const detached = detachSelection(retainSelection(range, 'target'))

  assert.deepEqual(activateSelection(detached, range), retainSelection(range, 'target'))
})

test('only mouse protocols that encode wheel input trigger application-scroll invalidation', () => {
  assert.equal(mouseModeForwardsWheel('none'), false)
  assert.equal(mouseModeForwardsWheel('x10'), false)
  assert.equal(mouseModeForwardsWheel('vt200'), true)
  assert.equal(mouseModeForwardsWheel('drag'), true)
  assert.equal(mouseModeForwardsWheel('any'), true)
})

test('alternate-buffer wheel input reaches the application even without wheel mouse reporting', () => {
  assert.equal(wheelIsApplicationInput('none', 'normal'), false)
  assert.equal(wheelIsApplicationInput('x10', 'normal'), false)
  assert.equal(wheelIsApplicationInput('vt200', 'normal'), true)
  assert.equal(wheelIsApplicationInput('none', 'alternate'), true)
  assert.equal(wheelIsApplicationInput('x10', 'alternate'), true)
})

test('copy and application scrolling are distinguished from other input', () => {
  const key = (keyName: string, ctrlKey = false, shiftKey = false) => ({
    type: 'keydown',
    key: keyName,
    ctrlKey,
    altKey: false,
    shiftKey,
  })

  assert.equal(isCopyShortcut(key('c', true)), true)
  assert.equal(isCopyShortcut(key('PageUp')), false)
  assert.equal(isApplicationScrollShortcut(key('PageUp')), true)
  assert.equal(isApplicationScrollShortcut(key('PageDown')), true)
  assert.equal(isApplicationScrollShortcut(key('u', true)), true)
  assert.equal(isApplicationScrollShortcut(key('d', true)), true)
  assert.equal(isApplicationScrollShortcut(key('PageUp', false, true)), false)
  assert.equal(isApplicationScrollShortcut(key('x')), false)
  assert.equal(shouldClearSelectionForKey(key('x')), true)
  assert.equal(shouldClearSelectionForKey(key('Control', true)), false)
})

test('selection text capture ignores a stale animation-frame callback', () => {
  const oldRange = { ...range }
  const current = retainSelection(range, 'current')

  assert.strictEqual(captureSelectionText(current, oldRange, 'stale'), current)
  assert.deepEqual(captureSelectionText(current, range, 'updated'), retainSelection(range, 'updated'))
  assert.deepEqual(emptyRetainedSelection(), { range: null })
})
