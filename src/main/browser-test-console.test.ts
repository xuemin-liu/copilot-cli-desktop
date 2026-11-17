import assert from 'node:assert/strict'
import test from 'node:test'
import { ConsoleBuffer } from './browser-console-buffer.js'
import { TestConsoleWatch, type ConsoleMessage, type ConsoleSource } from './browser-test-console.js'
import { globMatches, validateBrowserTestPlan, type BrowserTestStep } from './browser-test-plan.js'
import { redactInputs, redactTestEvidence, runBrowserTest } from './browser-test-runner.js'
import { sanitizedText } from './browser-privacy.js'

const assertion = { action: 'assert', label: 'Result visible', selector: '#result', condition: 'visible' }
const plan = (steps: unknown[], extra: Record<string, unknown> = {}) => validateBrowserTestPlan({ description: 'Console run', expected: 'It passes', steps, ...extra })

/** The page the runner drives: what BrowserDebug does with one console-message event. */
function page(recording = () => true) {
  const buffer = new ConsoleBuffer()
  const listeners = new Set<(message: ConsoleMessage) => void>()
  const source: ConsoleSource = {
    mark: () => buffer.mark(), slice: (pageId, after, through, max) => buffer.slice(pageId, after, through, max),
    watch: (_pageId, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const log = (message: string, level = 'info'): void => {
    // As BrowserDebug does: capture-time sanitizing bounds the text before anything else sees it.
    const entry = { level, message: sanitizedText(message), source: 'http://127.0.0.1/app.js', line: 7 }
    for (const listener of listeners) listener(entry)
    if (recording()) buffer.add({ pageId: 1, timestamp: new Date().toISOString(), ...entry }); else buffer.drop(1)
  }
  return { source, log, listeners }
}

test('glob patterns are anchored and literal apart from *', () => {
  assert.ok(globMatches('viewer ready', 'viewer ready')); assert.ok(!globMatches('viewer ready', 'viewer ready!'))
  assert.ok(globMatches('*ready*', 'the viewer is ready now')); assert.ok(globMatches('state: * frames', 'state: 3 frames'))
  assert.ok(!globMatches('a.b', 'axb'), 'a dot is literal'); assert.ok(!globMatches('*[x]*', 'x'), 'brackets are literal')
})

test('the plan validates consoleMessage, level and the console error options', () => {
  const ready = { action: 'waitFor', label: 'Viewer ready', condition: 'consoleMessage', expected: '*viewer ready*' }
  assert.ok(plan([ready, assertion]))
  assert.ok(plan([{ ...ready, level: 'debug' }, assertion]))
  assert.ok(plan([{ action: 'assert', label: 'Ready and shown', all: [{ condition: 'consoleMessage', expected: 'ready', level: 'info' }, { selector: '#a', condition: 'visible' }] }]))
  for (const extra of [{ selector: '#a' }, { frame: 'f1' }, { expected: '' }, { expected: undefined }, { level: 'verbose' }, { level: 'log' }]) {
    assert.throws(() => plan([{ ...ready, ...extra }, assertion]), /Invalid browser test/, JSON.stringify(extra))
  }
  assert.throws(() => plan([{ ...assertion, level: 'error' }]), /level requires/)
  assert.ok(plan([assertion], { failOnConsoleError: true, consoleErrorIgnore: ['*CanvasTextAlign*'] }))
  for (const extra of [{ failOnConsoleError: 'yes' }, { consoleErrorIgnore: ['*x*'] }, { failOnConsoleError: true, consoleErrorIgnore: [] },
    { failOnConsoleError: true, consoleErrorIgnore: Array(21).fill('x') }, { failOnConsoleError: true, consoleErrorIgnore: ['x'.repeat(501)] }, { failOnConsoleError: true, consoleErrorIgnore: [''] }]) {
    assert.throws(() => plan([assertion], extra), /Invalid browser test/, JSON.stringify(extra))
  }
})

test('consoleMessage matches messages since the run started, by level, even when recording is off', async () => {
  let recording = false
  const { source, log, listeners } = page(() => recording)
  log('viewer ready (before the run)')
  const value = plan([{ action: 'waitFor', label: 'Ready', condition: 'consoleMessage', expected: 'viewer ready*' },
    { action: 'assert', label: 'Debug dump', condition: 'consoleMessage', expected: 'state *', level: 'debug', timeoutMs: 300 }])
  const watch = new TestConsoleWatch(value, 1, source)
  let polls = 0
  const report = await runBrowserTest(value, 1, { active: () => true, progress: () => {}, console: watch,
    execute: async (step: BrowserTestStep) => {
      if (++polls === 3) log('viewer ready')
      if (step.label === 'Debug dump') log('state frames=2', 'info')
      return { passed: watch.matched(String(step.expected), step.level) }
    } }, new AbortController().signal)
  assert.equal(report.steps[0]!.status, 'passed', 'the wait passes once the message arrives, not on the one before the run')
  assert.equal(report.steps[1]!.status, 'failed', 'an info message does not satisfy level debug')
  assert.equal(report.steps[0]!.console?.complete, false, 'a step whose messages were not recorded says so')
  watch.dispose(); assert.equal(listeners.size, 0)
  recording = true
})

test('failOnConsoleError fails the step the error arrived in, stops a wait early, and skips the rest', async () => {
  const { source, log } = page()
  const value = plan([{ action: 'click', label: 'Open viewer', selector: '#open' },
    { action: 'waitFor', label: 'Never', selector: '#never', condition: 'visible', timeoutMs: 20000 },
    { action: 'click', label: 'Do not run', selector: '#write' }, assertion], { failOnConsoleError: true, consoleErrorIgnore: ['*CanvasTextAlign*'] })
  const watch = new TestConsoleWatch(value, 1, source)
  const executed: string[] = []
  const started = Date.now()
  const report = await runBrowserTest(value, 1, { active: () => true, progress: () => {}, console: watch,
    execute: async step => {
      executed.push(step.label)
      if (step.label === 'Open viewer') { log('CanvasTextAlign is deprecated', 'error'); log('warning only', 'warning'); return { passed: true, delivery: 'delivered' } }
      if (executed.length === 3) { log('TypeError: frame is undefined', 'error'); log('TypeError: frame is undefined', 'error') }
      return { passed: false }
    } }, new AbortController().signal)
  watch.dispose()
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.steps.map(step => step.status), ['passed', 'failed', 'skipped', 'skipped'], 'ignored errors and warnings pass')
  assert.ok(Date.now() - started < 5000, 'the wait stopped at its next poll, not at its timeout')
  assert.match(report.steps[1]!.reason!, /^Console error during this step: TypeError: frame is undefined$/)
  assert.deepEqual((report.steps[1]!.data!.consoleErrors as { errors: { count: number }[] }).errors.map(error => error.count), [2])
  assert.ok(!executed.includes('Do not run'))
  assert.deepEqual(report.steps[0]!.console?.entries.map(entry => entry.level), ['error', 'warning'])
  assert.equal(report.steps[1]!.console?.entries[0]!.count, 2)
})

test('an action finishes delivering before its console error fails it, and the delivery is kept', async () => {
  const { source, log } = page()
  const value = plan([{ action: 'click', label: 'Save', selector: '#save' }, assertion], { failOnConsoleError: true })
  const watch = new TestConsoleWatch(value, 1, source)
  const report = await runBrowserTest(value, 1, { active: () => true, progress: () => {}, console: watch,
    execute: async () => { log('Uncaught ReferenceError: x is not defined', 'error'); return { passed: true, delivery: 'delivered' } } }, new AbortController().signal)
  watch.dispose()
  assert.deepEqual([report.steps[0]!.status, report.steps[0]!.delivery, report.steps[0]!.outcome], ['failed', 'delivered', 'failed'])
})

test('without failOnConsoleError errors are only reported, and step slices redact inputs and stay bounded', async () => {
  const { source, log } = page()
  const value = plan([{ action: 'fill', label: 'Type', selector: '#field', value: 'private-input-value' }, assertion])
  const watch = new TestConsoleWatch(value, 1, source)
  const report = await runBrowserTest(value, 1, { active: () => true, progress: () => {}, console: watch,
    execute: async step => {
      if (step.action === 'fill') { log('typed private-input-value', 'error'); for (let i = 0; i < 30; i++) log(`noise ${i}`); log('x'.repeat(5000)) }
      return { passed: true }
    } }, new AbortController().signal)
  watch.dispose()
  assert.equal(report.status, 'passed')
  const slice = report.steps[0]!.console!
  assert.ok(!JSON.stringify(report).includes('private-input-value'))
  assert.deepEqual([slice.total, slice.truncated, slice.entries.length, slice.entries[0]!.level], [32, true, 10, 'error'])
  assert.ok(slice.entries.every(entry => entry.message.length <= 500))
  assert.equal(report.steps[1]!.console, undefined, 'a quiet step carries no console field')
})

test('supplied inputs are redacted before console text is cut, at every boundary', async () => {
  const value = 'SYNTHETIC-PRIVATE-INPUT-12345'
  const long = `LONG-${'p'.repeat(600)}-END`
  const leaks = (text: string): string[] => [value.slice(0, 10), long.slice(0, 20), 'pppppppppppppppppppppppppppppp', 'wSYN'].filter(part => text.includes(part))
  for (const failOnConsoleError of [false, true]) {
    const { source, log } = page()
    const steps = [{ action: 'fill', label: 'Type', selector: '#field', value }, { action: 'fill', label: 'Type long', selector: '#other', value: long }, assertion]
    const plan_ = plan(steps, failOnConsoleError ? { failOnConsoleError } : {})
    const watch = new TestConsoleWatch(plan_, 1, source)
    const report = await runBrowserTest(plan_, 1, { active: () => true, progress: () => {}, console: watch,
      execute: async step => {
        if (step.label === 'Type') {
          log('x'.repeat(490) + value, 'error')        // crosses the 500-character cut
          log('w'.repeat(497) + value)                  // would leave only 3 characters, below the tail check
          log(`start ${long}`)                          // longer than the cut
          log('y'.repeat(8180) + value)                 // crosses the capture limit
        }
        return { passed: true }
      } }, new AbortController().signal)
    watch.dispose()
    const evidence = redactTestEvidence(plan_, { console: source.slice(1, 0, Number.MAX_SAFE_INTEGER, 100).entries })
    assert.deepEqual(leaks(JSON.stringify(report)), [], `report (failOnConsoleError: ${failOnConsoleError})`)
    assert.deepEqual(leaks(JSON.stringify(evidence)), [], `evidence (failOnConsoleError: ${failOnConsoleError})`)
    if (failOnConsoleError) {
      assert.equal(report.steps[0]!.status, 'failed')
      assert.match(report.steps[0]!.reason!, /^Console error during this step: x+\[redacted\]$/)
    } else assert.equal(report.status, 'passed')
  }
})

test('run evidence redacts inputs before its size budget can cut one', () => {
  const value = 'SYNTHETIC-PRIVATE-INPUT-12345'
  const plan_ = plan([{ action: 'fill', label: 'Type', selector: '#field', value }, assertion])
  // 65536 characters in all: the key, eight fillers, then a message the budget cuts two characters into the value.
  const evidence = redactTestEvidence(plan_, { console: [...Array(8).fill('f'.repeat(8000)), 'x'.repeat(1527) + value] })
  assert.ok(!JSON.stringify(evidence).includes('xSY'), 'a value cut by the budget must already be redacted')
  assert.equal(evidence.truncated, true)
})

test('redactInputs removes whole values and the start of one left at the end of cut text', () => {
  assert.equal(redactInputs('a SECRET-1 b SECRET-1', ['SECRET-1']), 'a [redacted] b [redacted]')
  assert.equal(redactInputs('cut at SECR', ['SECRET-1']), 'cut at [redacted]')
  assert.equal(redactInputs('ends with SEC', ['SECRET-1']), 'ends with SEC', 'fewer than four characters are kept')
  assert.equal(redactInputs('ab', ['ab']), '[redacted]')
  assert.equal(redactInputs('nothing here', ['SECRET-1']), 'nothing here')
})

test('the trailing-prefix check is linear: a page cannot stall the main process with crafted text', () => {
  // A long shared run that differs only at the end: the worst case for a prefix-by-prefix search.
  const inputs = Array.from({ length: 10 }, (_, i) => 'A'.repeat(4096) + String.fromCharCode(67 + i).repeat(4096))
  const messages = Array(100).fill('A'.repeat(8192))
  const started = performance.now()
  for (const message of messages) redactInputs(message, inputs)
  const elapsed = performance.now() - started
  assert.ok(elapsed < 1500, `10 crafted inputs over 100 messages took ${Math.round(elapsed)} ms`)
  const evidence = redactTestEvidence(plan([{ action: 'fill', label: 'Type', selector: '#f', value: inputs[0]! }, assertion]), { console: messages.slice(0, 7) })
  assert.equal(evidence.console[0], `${'A'.repeat(4096)}[redacted]`, 'the longest prefix of the value at the end is still redacted')
})

test('the linear check finds the same prefix as a direct search', () => {
  const direct = (text: string, input: string): string => {
    for (let length = Math.min(input.length - 1, text.length); length >= Math.min(4, input.length); length--) {
      if (text.endsWith(input.slice(0, length))) return `${text.slice(0, text.length - length)}[redacted]`
    }
    return text
  }
  let seed = 7
  const random = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  for (let i = 0; i < 3000; i++) {
    const alphabet = 'ab'.slice(0, 1 + random(2)) + (random(3) ? '' : 'c')
    const word = (length: number): string => Array.from({ length }, () => alphabet[random(alphabet.length)]).join('')
    const input = word(1 + random(12)); const text = word(random(20))
    // Inputs never contain the separator, and whole occurrences are replaced first.
    const expected = direct(text.split(input).join('[redacted]'), input)
    assert.equal(redactInputs(text, [input]), expected, JSON.stringify({ input, text }))
  }
})
