import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBrowserTestPlan } from './browser-test-plan.js'
import { parseBrowserTest, testBaselinePaths } from '../cli/browser-test-client.js'

const capture = { action: 'capture', name: 'initial', selector: '#viewer', attribute: 'data-revision' }
const check = { action: 'assert', selector: '#viewer', condition: 'attribute', attribute: 'data-revision', expected: { captured: 'initial' } }
const plan = (steps: unknown[]) => validateBrowserTestPlan({ description: 'Scalar state', expected: 'Matches', steps })

test('scalar references are explicit, bounded, backward-only and use public attributes', () => {
  assert.ok(plan([capture, check]))
  for (const expected of [3, { captured: 'initial', op: 'greater' }, { selector: '#linked', attribute: 'data-revision', numeric: true },
    { targetRef: `${'a'.repeat(32)}-t1`, attribute: 'data-revision', op: 'within' }]) assert.ok(plan([capture, { ...check, expected }]))
  for (const expected of [{ captured: 'future' }, { captured: 'initial', selector: '#other' }, { selector: '#other', attribute: 'value' },
    { selector: '#other', attribute: 'data-revision', frame: 'foreign' }, { captured: 'initial', op: 'eval' },
    { captured: 'initial', op: 'greater', numeric: false }, {}, null, []]) assert.throws(() => plan([capture, { ...check, expected }]), /Invalid browser test/)
  assert.throws(() => plan([check, capture]), /earlier capture/)
  assert.throws(() => plan([capture, capture, check]), /unique/)
  assert.throws(() => plan([capture, { ...check, expected: '3', tolerance: 1 }]), /tolerance/)
  assert.throws(() => plan([capture, { ...check, expected: { captured: 'initial', op: 'greater' }, tolerance: 1 }]), /tolerance/)
  assert.throws(() => plan([capture, { ...check, expected: Infinity }]), /expected number/)
  assert.throws(() => plan([...Array.from({ length: 21 }, (_, index) => ({ ...capture, name: `c${index}` })), check]), /20 captures/)
  assert.ok(plan([capture, { ...check, expected: 3, tolerance: 0.1 }]))
  assert.ok(plan([capture, { ...check, condition: 'numericValue', attribute: undefined, expected: { captured: 'initial' }, tolerance: 0.1 }]))
})

test('wheel timing is optional and bounded without changing legacy event limits', () => {
  for (const intervalMs of [0, 10, 1000]) assert.ok(plan([{ action: 'wheel', selector: '#viewer', deltaY: 1, repeat: 20, intervalMs }, { ...check, expected: 1 }]))
  for (const intervalMs of [-1, 1001, 0.1, '10', null]) assert.throws(() => plan([{ action: 'wheel', selector: '#viewer', deltaY: 1, intervalMs }, { ...check, expected: 1 }]))
})

test('checkpoint baselines need earlier captures and no file transport', () => {
  const screenshot = { action: 'screenshot', selector: '#viewer' }
  const compare = { action: 'compareScreenshot', selector: '#viewer', baselineStep: 1 }
  assert.ok(plan([screenshot, compare, { ...compare, baselineStep: 2 }]))
  for (const baselineStep of [0, -1, 2, 1.5, '1']) assert.throws(() => plan([screenshot, { ...compare, baselineStep }]), /earlier screenshot/)
  assert.throws(() => plan([capture, compare]), /earlier screenshot/)
  assert.throws(() => plan([screenshot, { ...compare, baseline: '/tmp/a.png' }]), /not both/)
  assert.throws(() => plan([screenshot, { ...compare, baselineImage: 'AAAA' }]), /not both/)
  const text = JSON.stringify({ description: 'Checkpoint', expected: 'Restores', steps: [screenshot, compare] })
  assert.deepEqual(testBaselinePaths(text), [])
  assert.equal(parseBrowserTest(text, {}).steps[1]?.baselineStep, 1)
  assert.throws(() => plan([screenshot, ...Array.from({ length: 5 }, () => compare)]), /five screenshots/)
})
