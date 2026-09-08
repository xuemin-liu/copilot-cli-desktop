import test from 'node:test'
import assert from 'node:assert/strict'
import { withShutdownDeadline } from './shutdown-deadline.js'

test('overall deadline releases cleanup even when an earlier session or config write never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const never = new Promise<void>(() => {})
  const result = assert.rejects(withShutdownDeadline(never.then(() => Promise.resolve()), 100), /deadline/)
  t.mock.timers.tick(101)
  await result
})
