import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBrowserTestPlan } from './browser-test-plan.js'
import { testKey } from './browser-test-keys.js'

const assertion = { action: 'assert', label: 'Result visible', selector: '#result', condition: 'visible' }
const plan = (steps: unknown[]) => validateBrowserTestPlan({ description: 'Input run', expected: 'It passes', steps })

test('wheel takes a pointer target, bounded integer deltas and at most 20 events', () => {
  const wheel = { action: 'wheel', label: 'Next slice', selector: '#viewport', deltaY: 120 }
  assert.ok(plan([wheel, assertion]))
  assert.ok(plan([{ ...wheel, deltaX: -40, repeat: 20, modifiers: ['Control', 'Shift'] }, assertion]))
  assert.ok(plan([{ ...wheel, inputSelector: '#overlay', point: { x: 10, y: 10 } }, assertion]))
  for (const extra of [{ deltaY: 0 }, { deltaY: undefined }, { deltaY: 1001 }, { deltaY: -1001 }, { deltaY: 1.5 }, { deltaY: '120' },
    { repeat: 0 }, { repeat: 21 }, { repeat: 2.5 }, { selector: undefined }, { inputSelector: '#overlay' }, { modifiers: ['F5'] }, { pixels: 100 }, { button: 'left' }]) {
    assert.throws(() => plan([{ ...wheel, ...extra }, assertion]), /Invalid browser test/, JSON.stringify(extra))
  }
})

test('press takes either a target or scope "page", and letters and digits for shortcuts', () => {
  assert.ok(plan([{ action: 'press', scope: 'page', key: 'k' }, assertion]))
  assert.ok(plan([{ action: 'press', scope: 'page', key: 's', modifiers: ['Control'] }, assertion]))
  assert.ok(plan([{ action: 'press', scope: 'page', key: 'Escape' }, assertion]))
  assert.ok(plan([{ action: 'press', selector: '#search', key: '7' }, assertion]))
  for (const step of [{ action: 'press', key: 'k' }, { action: 'press', scope: 'page', selector: '#a', key: 'k' }, { action: 'press', scope: 'page', frame: 'f1', key: 'k' },
    { action: 'press', scope: 'page', text: 'Save', key: 'k' }, { action: 'press', scope: 'frame', key: 'k' }, { action: 'click', scope: 'page', selector: '#a' },
    { action: 'press', scope: 'page', key: 'K' }, { action: 'press', scope: 'page', key: 'ab' }, { action: 'press', scope: 'page', key: 'F5' }, { action: 'press', scope: 'page', key: '/' }]) {
    assert.throws(() => plan([step, assertion]), /Invalid browser test/, JSON.stringify(step))
  }
})

test('chords the browser handles itself are refused, with Control or Meta', () => {
  for (const key of ['w', 't', 'f', 'g', 'r', 'i', '0']) for (const modifier of ['Control', 'Meta']) {
    assert.throws(() => plan([{ action: 'press', scope: 'page', key, modifiers: [modifier] }, assertion]), /browser shortcut/, `${modifier}+${key}`)
    assert.throws(() => plan([{ action: 'press', selector: '#a', key, modifiers: [modifier, 'Shift'] }, assertion]), /browser shortcut/, `${modifier}+Shift+${key}`)
  }
  for (const key of ['w', 'r', 'f']) assert.ok(plan([{ action: 'press', scope: 'page', key, modifiers: ['Shift'] }, assertion]), `Shift+${key} is ordinary input`)
  assert.ok(plan([{ action: 'press', scope: 'page', key: 's', modifiers: ['Control'] }, assertion]))
})

test('a letter or digit types its character only without Alt, Control or Meta', () => {
  assert.deepEqual(testKey('k', 0), { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, text: 'k' })
  assert.deepEqual(testKey('k', 8), { key: 'K', code: 'KeyK', windowsVirtualKeyCode: 75, text: 'K' }, 'Shift')
  assert.deepEqual(testKey('s', 2), { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, text: '' }, 'Control')
  assert.deepEqual(testKey('s', 4 | 8), { key: 'S', code: 'KeyS', windowsVirtualKeyCode: 83, text: '' }, 'Meta+Shift')
  assert.deepEqual(testKey('b', 1), { key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, text: '' }, 'Alt')
  assert.deepEqual(testKey('7', 8), { key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' }, 'Shift changes letters only')
  assert.deepEqual(testKey('Enter', 2), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, 'named keys keep their text')
  assert.deepEqual(testKey('Space', 0), { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
})
