import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ReloadBudget, describeError, describeProcessExit, observeProcessFailures } from './process-diagnostics.js'

test('a page may reload a few times in a period, then no more until the period has passed', () => {
  let now = 1000
  const budget = new ReloadBudget(3, 60_000, () => now)
  assert.deepEqual([budget.take(), budget.take(), budget.take(), budget.take()], [true, true, true, false])
  now += 59_999
  assert.equal(budget.take(), false)
  now += 1
  assert.equal(budget.take(), true, 'the first three are a period old')
  assert.equal(budget.take(), true)
  assert.equal(budget.take(), true)
  assert.equal(budget.take(), false)
})

test('why a process ended is logged from its known fields only', () => {
  assert.equal(describeProcessExit({ reason: 'crashed', exitCode: -1073741819, extra: 'ignored' }), 'reason=crashed exitCode=-1073741819')
  assert.equal(describeProcessExit({ type: 'GPU', reason: 'killed', exitCode: 9, name: 'a\nb' }), 'type=GPU name=a?b reason=killed exitCode=9')
  assert.equal(describeProcessExit(undefined), 'no details')
})

test('an error is logged with its stack, and anything else as text, both cut to a bound', () => {
  const error = new Error('broken')
  assert.match(describeError(error), /^Error: broken\n\s+at /)
  assert.equal(describeError('plain'), 'plain')
  assert.equal(describeError({ code: 5 }), '{"code":5}')
  const circular: Record<string, unknown> = {}; circular.self = circular
  assert.equal(describeError(circular), '[object Object]')
  assert.ok(describeError('x'.repeat(10_000)).length < 4100)
})

test('unhandled failures are logged without replacing how the process handles them', () => {
  const target = new EventEmitter()
  const logged: string[] = [], printed: string[] = []
  observeProcessFailures(target as never, line => logged.push(line), line => printed.push(line))
  assert.deepEqual(target.eventNames(), ['unhandledRejection', 'uncaughtExceptionMonitor'], 'no uncaughtException listener, which would keep a broken process alive')
  target.emit('unhandledRejection', 'lost')
  target.emit('uncaughtExceptionMonitor', new RangeError('deep'), 'uncaughtException')
  assert.deepEqual(printed, ['Unhandled promise rejection: lost'])
  assert.equal(logged[0], 'Unhandled promise rejection: lost')
  assert.match(logged[1]!, /^Fatal error \(uncaughtException\): RangeError: deep/)
})
