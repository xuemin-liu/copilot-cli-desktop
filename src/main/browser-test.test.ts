import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBrowserTestPlan } from './browser-test-plan.js'
import { runBrowserTest } from './browser-test-runner.js'

const assertion = { action: 'assert', label: 'Result visible', selector: '#result', condition: 'visible' }
const plan = (steps: unknown[] = [assertion], extra = {}) => validateBrowserTestPlan({ description: 'Test the app', expected: 'The result is visible', steps, ...extra })

test('drag plans accept bounded CSS-pixel paths and reject malformed input', () => {
  const drag = { action: 'drag', selector: '#canvas', path: [{ x: 1.5, y: 20 }, { x: 240, y: 90 }], durationMs: 500 }
  assert.deepEqual(plan([drag, assertion]).steps[0]?.path, drag.path)
  for (const path of [undefined, [], [{ x: 1, y: 1 }], Array.from({ length: 101 }, () => ({ x: 1, y: 1 })),
    [{ x: -1, y: 0 }, { x: 1, y: 1 }], [{ x: NaN, y: 0 }, { x: 1, y: 1 }], [{ x: Infinity, y: 0 }, { x: 1, y: 1 }],
    [{ x: '1', y: 0 }, { x: 1, y: 1 }], [{ x: 20000, y: 0 }, { x: 1, y: 1 }],
    [{ x: 1, y: 0, script: 'alert(1)' }, { x: 1, y: 1 }]]) assert.throws(() => plan([{ ...drag, path }, assertion]))
  for (const durationMs of [0, 99, 5001, 100.5, '500', NaN]) assert.throws(() => plan([{ ...drag, durationMs }, assertion]))
  assert.throws(() => plan([{ ...drag, selector: undefined }, assertion]))
  assert.throws(() => plan([{ ...drag, button: 'right' }, assertion]))
})

test('test plans require real assertions and bounded fixed operations', () => {
  assert.equal(plan().steps.length, 1)
  for (const steps of [[], [{ action: 'click', label: 'click', selector: '#button' }], [{ ...assertion, action: 'evaluate', script: 'process.exit()' }],
    [{ ...assertion, frame: 12 }], [{ ...assertion, condition: 'script' }], [{ ...assertion, timeoutMs: 61000 }],
    [{ action: 'navigate', label: 'open', url: 'file:///C:/private' }, assertion],
    [{ action: 'navigate', label: 'open', url: 'https://user:secret@example.com/' }, assertion],
    [{ action: 'fill', label: 'input', selector: '#field', value: 'x', script: 'alert(1)' }, assertion],
    [{ action: 'press', label: 'key', selector: '#field', key: 'F12' }, assertion], Array.from({ length: 51 }, () => assertion)]) assert.throws(() => plan(steps))
  assert.throws(() => plan([assertion], { timeoutMs: 300001 }))
  assert.throws(() => plan([assertion], { code: 'fetch()' }))
  assert.equal(plan([{ ...assertion, condition: 'value', expected: '' }]).steps[0]?.expected, '')
})

test('test plans derive display labels when generated plans omit them', () => {
  const value = plan([
    { action: 'fill', selector: '#search', value: 'fire tv bulb' },
    { action: 'assert', selector: 'body', condition: 'text', expected: 'fire tv bulb' },
  ])
  assert.deepEqual(value.steps.map(step => step.label), ['fill step 1', 'assert step 2'])
})

test('failed assertions stop writes; report redacts inputs and marks remaining steps skipped', async () => {
  const executed: string[] = []
  const value = plan([{ action: 'fill', label: 'Type private-value', selector: '#field', value: 'private-value' },
    { ...assertion, timeoutMs: 100 }, { action: 'click', label: 'Do not execute', selector: '#write' }])
  const report = await runBrowserTest(value, 12, { active: () => true, progress: () => {}, execute: async step => {
    executed.push(step.action); return { passed: step.action !== 'assert', reason: 'private-value failed' }
  } }, new AbortController().signal)
  assert.equal(report.status, 'failed')
  assert.ok(!executed.includes('click'))
  assert.deepEqual(report.steps.map(step => step.status), ['passed', 'failed', 'skipped'])
  assert.ok(!JSON.stringify(report).includes('private-value'))
})

test('cancellation interrupts waits and prevents any subsequent action', async () => {
  const cancelled = new AbortController(); let calls = 0
  const report = await runBrowserTest(plan([{ action: 'waitFor', label: 'Waiting', selector: '#later', condition: 'visible' }, assertion]), 12, {
    active: () => true, progress: () => {}, execute: async () => { calls++; cancelled.abort(); return { passed: false } },
  }, cancelled.signal)
  assert.equal(report.status, 'cancelled'); assert.equal(calls, 1)
})

test('page changes and overall deadline fail closed', async () => {
  let active = true; let calls = 0
  const switched = await runBrowserTest(plan([assertion, assertion]), 12, { active: () => active, progress: () => {},
    execute: async () => { calls++; active = false; return { passed: true } } }, new AbortController().signal)
  assert.equal(switched.status, 'cancelled'); assert.equal(calls, 1)
  const expired = await runBrowserTest(plan([assertion, assertion], { timeoutMs: 100 }), 12, { active: () => true,
    progress: () => {}, execute: async () => ({ passed: false }) }, new AbortController().signal)
  assert.equal(expired.status, 'failed'); assert.match(expired.steps[0]!.reason!, /timed out/)
})
