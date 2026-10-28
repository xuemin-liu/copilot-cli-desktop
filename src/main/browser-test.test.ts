import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBrowserTestPlan } from './browser-test-plan.js'
import { redactTestEvidence, runBrowserTest } from './browser-test-runner.js'

const assertion = { action: 'assert', label: 'Result visible', selector: '#result', condition: 'visible' }
const plan = (steps: unknown[] = [assertion], extra = {}) => validateBrowserTestPlan({ description: 'Test the app', expected: 'The result is visible', steps, ...extra })

test('drag plans accept bounded CSS-pixel paths and reject malformed input', () => {
  const drag = { action: 'drag', selector: '#canvas', path: [{ x: 1.5, y: 20 }, { x: 240, y: 90 }], durationMs: 500 }
  assert.deepEqual(plan([drag, assertion]).steps[0]?.path, drag.path)
  assert.equal(plan([{ ...drag, inputSelector: '#viewer svg' }, assertion]).steps[0]?.inputSelector, '#viewer svg')
  for (const inputSelector of ['', 1, 'x'.repeat(513)]) assert.throws(() => plan([{ ...drag, inputSelector }, assertion]))
  assert.throws(() => plan([{ action: 'click', selector: '#canvas', inputSelector: '#viewer' }, assertion]))
  for (const path of [undefined, [], [{ x: 1, y: 1 }], Array.from({ length: 101 }, () => ({ x: 1, y: 1 })),
    [{ x: -1, y: 0 }, { x: 1, y: 1 }], [{ x: NaN, y: 0 }, { x: 1, y: 1 }], [{ x: Infinity, y: 0 }, { x: 1, y: 1 }],
    [{ x: '1', y: 0 }, { x: 1, y: 1 }], [{ x: 20000, y: 0 }, { x: 1, y: 1 }],
    [{ x: 1, y: 0, script: 'alert(1)' }, { x: 1, y: 1 }]]) assert.throws(() => plan([{ ...drag, path }, assertion]))
  for (const durationMs of [0, 99, 5001, 100.5, '500', NaN]) assert.throws(() => plan([{ ...drag, durationMs }, assertion]))
  assert.throws(() => plan([{ ...drag, selector: undefined }, assertion]))
  assert.equal(plan([{ ...drag, button: 'right' }, assertion]).steps[0]?.button, 'right')
})

test('references, coordinate pointers, modifiers and combined public-state assertions have closed bounded shapes', () => {
  const ref = `${'a'.repeat(32)}-t1`
  for (const action of ['click', 'doubleClick', 'hover']) {
    assert.ok(plan([{ action, targetRef: ref, inputRef: `${'a'.repeat(32)}-t2`, point: { x: 20.5, y: 10 }, modifiers: ['Shift'] }, assertion]))
    for (const extra of [{ point: { x: -1, y: 0 } }, { modifiers: ['Shift', 'Shift'] }, { modifiers: ['F5'] }, { point: { x: 0, y: 0, script: 'x' } }, { selector: '#also' }]) {
      assert.throws(() => plan([{ action, targetRef: ref, ...extra }, assertion]))
    }
  }
  assert.ok(plan([{ action: 'reload', all: [{ selector: '#ready', condition: 'attribute', attribute: 'data-test-ready', expected: 'true' },
    { selector: '#busy', condition: 'hidden' }, { selector: '#angle', condition: 'numericValue', expected: 12.5, tolerance: 0.01 }] }, assertion]))
  for (const extra of [{ all: [] }, { all: [{ selector: '#a', condition: 'attribute', attribute: 'value', expected: 'secret' }] },
    { all: [{ selector: '#a', condition: 'numericValue', expected: 1, tolerance: -1 }] }, { all: [assertion] }]) assert.throws(() => plan([{ action: 'reload', ...extra }, assertion]))
  assert.throws(() => plan([{ ...assertion, all: [{ selector: '#ready', condition: 'visible' }] }]))
})

test('network failure simulation is explicit, bounded and cannot supply scripts, credentials, headers or response bodies', () => {
  const rule = { urlPattern: 'http://localhost:3000/api/*', method: 'POST', failure: 'http', status: 503, maxRequests: 1, durationMs: 1000 }
  assert.ok(plan([assertion], { allowNetworkFailures: true, networkFailures: [rule] }))
  assert.throws(() => plan([assertion], { networkFailures: [rule] }))
  for (const extra of [{ maxRequests: 0 }, { maxRequests: 21 }, { durationMs: 60001 }, { durationMs: undefined }, { status: 200 }, { method: '*' },
    { urlPattern: 'http://user:secret@localhost/api/*' }, { urlPattern: 'http://*/api' }, { urlPattern: 'http://localhost/api?token=x' },
    { headers: {} }, { body: 'response' }, { script: 'fetch()' }]) assert.throws(() => plan([assertion], { allowNetworkFailures: true, networkFailures: [{ ...rule, ...extra }] }))
})

test('delivery, failed semantic assertions, uncertain actions and live recovery checkpoints stay distinct', async () => {
  const value = plan([{ action: 'drag', selector: '#canvas', path: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }, { ...assertion, timeoutMs: 100 }])
  const checkpoints: unknown[] = []
  const report = await runBrowserTest(value, 1, { active: () => true, progress: () => {}, checkpoint: (report, current) => checkpoints.push(structuredClone({ report, current })),
    execute: async step => ({ passed: step.action === 'drag', delivery: step.action === 'drag' ? 'delivered' : 'not-attempted' }) }, new AbortController().signal)
  assert.equal(report.status, 'failed'); assert.equal(report.steps[0]?.outcome, 'delivered'); assert.equal(report.steps[1]?.outcome, 'assertion-failed')
  assert.ok(report.runId); assert.ok(checkpoints.length >= 4)
  const uncertain = await runBrowserTest(plan([{ action: 'click', selector: '#save' }, assertion]), 1, { active: () => true, progress: () => {}, execute: async () => {
    throw Object.assign(new Error('Disconnected after sending input.'), { delivery: 'uncertain' })
  } }, new AbortController().signal)
  assert.equal(uncertain.steps[0]?.outcome, 'uncertain'); assert.equal(uncertain.steps[1]?.outcome, 'skipped')
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

test('run evidence filters supplied inputs and explicitly reports capture truncation', () => {
  const value = plan([{ action: 'fill', selector: '#private', value: 'private-input-value' }, assertion])
  const evidence = redactTestEvidence(value, { console: [{ message: 'private-input-value' }, { message: 'x'.repeat(100000) }] })
  assert.ok(!JSON.stringify(evidence).includes('private-input-value'))
  assert.equal(evidence.redacted, true)
  assert.equal(evidence.truncated, true)
})

test('cancellation interrupts waits and prevents any subsequent action', async () => {
  const cancelled = new AbortController(); let calls = 0
  const report = await runBrowserTest(plan([{ action: 'waitFor', label: 'Waiting', selector: '#later', condition: 'visible' }, assertion]), 12, {
    active: () => true, progress: () => {}, execute: async () => { calls++; cancelled.abort(); return { passed: false } },
  }, cancelled.signal)
  assert.equal(report.status, 'cancelled'); assert.equal(calls, 1)
})

test('cancellation immediately after confirmed delivery does not erase the completed action', async () => {
  const cancelled = new AbortController()
  const report = await runBrowserTest(plan([{ action: 'click', selector: '#save' }, assertion]), 1, {
    active: () => true, progress: () => {}, execute: async () => { cancelled.abort(); return { passed: true, delivery: 'delivered' } },
  }, cancelled.signal)
  assert.equal(report.status, 'cancelled'); assert.equal(report.steps[0]?.delivery, 'delivered'); assert.equal(report.steps[1]?.outcome, 'skipped')
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

test('dialog expectations are accepted only on actions that can trigger a dialog and only in their closed shape', () => {
  const click = { action: 'click', selector: '#delete', dialog: { accept: true, message: 'Delete item' } }
  assert.deepEqual(plan([click, assertion]).steps[0]?.dialog, { accept: true, message: 'Delete item' })
  for (const action of ['doubleClick', 'press', 'fill', 'select']) {
    const extra = action === 'press' ? { key: 'Enter' } : action === 'fill' || action === 'select' ? { value: 'x' } : {}
    assert.ok(plan([{ action, selector: '#a', ...extra, dialog: { accept: false } }, assertion]))
  }
  assert.ok(plan([{ action: 'navigate', url: 'http://localhost:3000/', dialog: { accept: true } }, assertion]))
  for (const dialog of [{}, { accept: 'yes' }, { accept: true, value: 'typed' }, { accept: true, message: '' }, { accept: true, message: 'x'.repeat(501) }, 'accept', null, []]) {
    assert.throws(() => plan([{ ...click, dialog }, assertion]), /Invalid browser test/, JSON.stringify(dialog))
  }
  for (const action of ['hover', 'scroll', 'screenshot', 'waitFor', 'assert']) {
    assert.throws(() => plan([{ action, selector: '#a', pixels: 1, condition: 'visible', dialog: { accept: true } }, assertion]), /Invalid browser test/, action)
  }
})
