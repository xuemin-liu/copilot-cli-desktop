import test from 'node:test'
import assert from 'node:assert/strict'
import { createBellNotifier, createReconnectController } from '../../vendor/myterminal/lifecycle.cjs'

test('MyTerminal bell delivery retains focus gating and per-terminal cooldown', () => {
  let time = 6000, focused = false, label = 'Shell'
  const notifications: string[] = []
  const bell = createBellNotifier({ now: () => time, focused: () => focused, label: () => label,
    notify: (title, body) => notifications.push(`${title}: ${body}`) })
  bell('plain output'); assert.equal(notifications.length, 0)
  bell('\x07'); bell('\x07'); assert.deepEqual(notifications, ['Terminal Bell: Activity in: Shell'])
  time += 6000; focused = true; bell('\x07'); assert.equal(notifications.length, 1)
  focused = false; label = 'Renamed'; bell('\x07'); assert.equal(notifications[1], 'Terminal Bell: Activity in: Renamed')
})

test('MyTerminal retries remain bounded, deduplicated, cancellable and reset only on connection', () => {
  const callbacks = new Map<number, () => void>(); let next = 0, connections = 0, exhausted = 0
  const retry = createReconnectController({ connect: () => { connections++ }, exhausted: () => { exhausted++ },
    timers: { setInterval: callback => { callbacks.set(++next, callback); return next }, clearInterval: id => { callbacks.delete(id as number) } } })
  const tick = () => { for (const callback of [...callbacks.values()]) callback() }
  for (let attempt = 1; attempt <= 5; attempt++) {
    retry.schedule(); assert.equal(retry.remaining, attempt * 5); assert.equal(callbacks.size, 1)
    for (let second = 0; second < attempt * 5; second++) tick()
    assert.equal(connections, attempt); assert.equal(retry.remaining, null)
  }
  retry.schedule(); assert.equal(exhausted, 1); assert.equal(callbacks.size, 0)
  retry.connected(); retry.schedule(); assert.equal(retry.remaining, 5)
  retry.schedule(); assert.equal(callbacks.size, 1, 'multiple events cannot leave parallel timers')
  retry.cancel(); tick(); assert.equal(connections, 5)
  retry.schedule(); retry.dispose(); tick(); retry.schedule(); assert.equal(callbacks.size, 0)
})
