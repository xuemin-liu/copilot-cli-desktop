import assert from 'node:assert/strict'
import test from 'node:test'
import { reservedTestImages, validateBaselinePath, validateBrowserTestPlan } from './browser-test-plan.js'
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

test('a screenshot crops to a viewport region or to one top-frame target, never both', () => {
  assert.ok(plan([{ action: 'screenshot', region: { x: 0, y: 40, width: 320.5, height: 240 } }, assertion]))
  assert.ok(plan([{ action: 'screenshot', selector: '.cell', text: 'Axial' }, assertion]))
  assert.ok(plan([{ action: 'screenshot', targetRef: `${'a'.repeat(32)}-t1` }, assertion]))
  for (const step of [{ region: { x: 0, y: 0, width: 0, height: 10 } }, { region: { x: -1, y: 0, width: 10, height: 10 } }, { region: { x: 0, y: 0, width: 10 } },
    { region: { x: 0, y: 0, width: 10, height: 10, scale: 2 } }, { region: { x: 0, y: 0, width: 20001, height: 10 } }, { region: { x: '0', y: 0, width: 10, height: 10 } },
    { region: { x: 0, y: 0, width: 10, height: 10 }, selector: '.cell' }, { text: 'Axial' }, { selector: '.cell', frame: 'f1' }, { selector: '.cell', targetRef: `${'a'.repeat(32)}-t1` }]) {
    assert.throws(() => plan([{ action: 'screenshot', ...step }, assertion]), /Invalid browser test/, JSON.stringify(step))
  }
})

test('dragTo takes a source, exactly one drop target, optional points inside each and a bounded duration', () => {
  const dragTo = { action: 'dragTo', label: 'Open series in cell', selector: 'li[data-container]', text: 'Ball Phantom', dropSelector: '#D_3' }
  assert.ok(plan([dragTo, assertion]))
  assert.ok(plan([{ ...dragTo, point: { x: 10, y: 10 }, dropPoint: { x: 200, y: 150 }, durationMs: 800, modifiers: ['Control'], dropText: 'Empty' }, assertion]))
  assert.ok(plan([{ action: 'dragTo', targetRef: `${'a'.repeat(32)}-t1`, dropRef: `${'a'.repeat(32)}-t2` }, assertion]))
  for (const extra of [{ dropSelector: undefined }, { dropRef: `${'a'.repeat(32)}-t2` }, { dropSelector: '' }, { dropSelector: 'x'.repeat(513) },
    { dropSelector: undefined, dropRef: 'not-a-ref' }, { dropPoint: { x: -1, y: 0 } }, { dropPoint: { x: 1, y: 1, z: 1 } }, { durationMs: 99 }, { durationMs: 5001 },
    { selector: undefined }, { path: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }, { inputSelector: '#overlay' }, { button: 'right' },
    { dataTransfer: { 'text/plain': 'injected' } }, { files: ['C:/secret.txt'] }, { dropText: '' }]) {
    assert.throws(() => plan([{ ...dragTo, ...extra }, assertion]), /Invalid browser test/, JSON.stringify(extra))
  }
})

test('compareScreenshot needs a local baseline path and the image the helper attached, and counts as an assertion', () => {
  const baseline = process.platform === 'win32' ? 'C:\\tests\\viewer\\cell.png' : '/tmp/viewer/cell.png'
  const compare = { action: 'compareScreenshot', selector: '#viewport-1', baseline, baselineImage: Buffer.from('png').toString('base64') }
  assert.ok(plan([compare]), 'a comparison is the assertion a plan needs')
  assert.ok(plan([{ ...compare, selector: undefined, region: { x: 0, y: 0, width: 200, height: 100 } }]))
  assert.ok(plan([{ ...compare, selector: undefined }]), 'the whole viewport')
  assert.ok(plan([{ ...compare, text: 'Axial', ignore: [{ x: 0, y: 0, width: 220, height: 60 }], imageTolerance: { channel: 8, maxDiffRatio: 0.002 } }]))
  const tooLarge = 'A'.repeat(Math.ceil(2 * 1024 * 1024 / 3) * 4 + 4)
  for (const extra of [{ baseline: undefined }, { baseline: 'cell.png' }, { baseline: baseline.replace(/\.png$/, '.jpg') }, { baseline: '//host/share/cell.png' },
    { baselineImage: undefined }, { baselineImage: '' }, { baselineImage: 'not base64!' }, { baselineImage: tooLarge },
    { ignore: [] }, { ignore: [{ x: 0, y: 0, width: 0, height: 5 }] }, { ignore: [{ x: -1, y: 0, width: 5, height: 5 }] }, { ignore: Array(21).fill({ x: 0, y: 0, width: 1, height: 1 }) },
    { imageTolerance: { channel: 256 } }, { imageTolerance: { channel: 1.5 } }, { imageTolerance: { maxDiffRatio: 1.5 } }, { imageTolerance: { pixels: 3 } },
    { tolerance: 3 }, { selector: undefined, text: 'Axial' }, { region: { x: 0, y: 0, width: 10, height: 10 } }, { condition: 'visible' }]) {
    assert.throws(() => plan([{ ...compare, ...extra }]), /Invalid browser test/, JSON.stringify(extra).slice(0, 120))
  }
  const shot = { action: 'screenshot' }
  assert.ok(plan([shot, shot, shot, shot, compare]))
  assert.throws(() => plan([shot, shot, shot, shot, shot, compare]), /five screenshots and comparisons/)
  assert.ok(plan([{ ...compare, label: 'x'.repeat(200), baselineImage: 'A'.repeat(1024 * 1024) }]), 'the reference image does not count toward the 128 KiB plan limit')
})

test('baseline paths are local absolute .png paths, and off Windows hold no quote or backslash', () => {
  for (const path of ['C:\\tests\\cell.png', 'D:/tests/cell.PNG']) assert.doesNotThrow(() => validateBaselinePath(path, 'win32'), path)
  for (const path of ['\\\\host\\share\\cell.png', 'C:cell.png', 'C:\\tests\\cell.exe', 'C:\\tests\\CON.png', 'C:\\te|sts\\cell.png', '/tmp/cell.png']) {
    assert.throws(() => validateBaselinePath(path, 'win32'), /local absolute .png/, path)
  }
  for (const path of ['/tmp/cell one.png', '/Users/me/tests/cell.png']) assert.doesNotThrow(() => validateBaselinePath(path, 'linux'), path)
  for (const path of ['tmp/cell.png', '//host/cell.png', '/tmp/ce"ll.png', '/tmp/ce\\ll.png', '/tmp/cell\n.png', 'C:\\tests\\cell.png']) {
    assert.throws(() => validateBaselinePath(path, 'darwin'), /local absolute .png/, path)
  }
  assert.equal(reservedTestImages([{ action: 'screenshot' }, { action: 'compareScreenshot' }, { action: 'click' }]), 3)
})

test('visualStable waits on one top-frame element or a region, with an image tolerance and a window shorter than the timeout', () => {
  const settle = { action: 'waitFor', selector: '#viewport-1', condition: 'visualStable' }
  assert.ok(plan([settle, assertion]))
  assert.ok(plan([{ ...settle, stableMs: 10000, timeoutMs: 20000, imageTolerance: { channel: 4, maxDiffRatio: 0.001 }, ignore: [{ x: 0, y: 0, width: 40, height: 20 }] }, assertion]))
  assert.ok(plan([{ action: 'waitFor', condition: 'visualStable', region: { x: 0, y: 0, width: 300, height: 200 } }, assertion]))
  assert.ok(plan([{ action: 'assert', selector: '#viewport-1', text: 'Axial', condition: 'visualStable', timeoutMs: 3000 }]))
  assert.ok(plan([{ action: 'waitFor', all: [{ selector: '#loading', condition: 'hidden' }, { selector: '#viewport-1', condition: 'visualStable', stableMs: 300 }] }, assertion]))
  for (const extra of [{ stableMs: 99 }, { stableMs: 10001 }, { stableMs: 5000, timeoutMs: 5000 }, { frame: 'f1' }, { selector: undefined },
    { region: { x: 0, y: 0, width: 10, height: 10 } }, { expected: 'x' }, { tolerance: 1 }, { imageTolerance: { channel: 300 } }, { ignore: [] }, { baseline: 'C:/a.png' }]) {
    assert.throws(() => plan([{ ...settle, ...extra }, assertion]), /Invalid browser test/, JSON.stringify(extra))
  }
  assert.throws(() => plan([{ action: 'waitFor', all: [{ selector: '#a', condition: 'visualStable', stableMs: 2000 }], timeoutMs: 2000 }, assertion]), /shorter than the step timeout/)
  for (const condition of ['visible', 'stable', 'text']) {
    assert.throws(() => plan([{ action: 'waitFor', selector: '#a', condition, expected: condition === 'text' ? 'x' : undefined, region: { x: 0, y: 0, width: 5, height: 5 } }, assertion]), /visualStable/)
    assert.throws(() => plan([{ action: 'waitFor', selector: '#a', condition, expected: condition === 'text' ? 'x' : undefined, imageTolerance: { channel: 1 } }, assertion]), /visualStable/)
  }
  assert.throws(() => plan([{ action: 'waitFor', selector: '#a', condition: 'stable', stableMs: 6000, timeoutMs: 10000 }, assertion]), /5000/, 'stable keeps its own window limit')
})
