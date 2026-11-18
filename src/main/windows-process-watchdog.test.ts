import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startWindowsProcessWatchdog } from './windows-process-watchdog.js'

test('invalid process IDs are rejected before opening a process', () => {
  for (const pid of [0, -1, 1.5, 2 ** 32]) assert.throws(() => startWindowsProcessWatchdog(pid), /Invalid watchdog process ID/)
})

test('abrupt owner death kills the tracked Windows tree and preserves a released child',
  { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    const sleeper = 'setTimeout(() => {}, 30000)'
    const tracked = spawn(process.execPath, ['-e', `
      process.once('message', () => {
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { stdio: 'ignore', windowsHide: true })
        process.send(child.pid)
      })
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    const released = spawn(process.execPath, ['-e', sleeper], { windowsHide: true, stdio: 'ignore' })
    t.after(() => { tracked.kill(); released.kill() })
    assert.ok(tracked.pid && released.pid)

    const owner = spawn(process.execPath, ['--input-type=module', '-e', `
      import { startWindowsProcessWatchdog } from ${JSON.stringify(new URL('./windows-process-watchdog.js', import.meta.url).href)}
      startWindowsProcessWatchdog(${tracked.pid})
      const lease = startWindowsProcessWatchdog(${released.pid})
      lease.release()
      lease.release()
      process.send('ready')
      setInterval(() => {}, 30000)
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true })
    t.after(() => { owner.kill() })
    await once(owner, 'message')
    const childStarted = once(tracked, 'message')
    tracked.send('start')
    const [grandchild] = await childStarted
    assert.ok(Number.isInteger(grandchild) && grandchild > 0)
    const alive = (): boolean => { try { process.kill(grandchild, 0); return true } catch { return false } }
    assert.ok(alive())
    const ownerExited = once(owner, 'exit')
    owner.kill()
    await ownerExited
    const deadline = Date.now() + 10000
    while ((tracked.exitCode === null && tracked.signalCode === null || alive()) && Date.now() < deadline) await delay(50)
    assert.ok(tracked.exitCode !== null || tracked.signalCode !== null, 'tracked process survived owner exit')
    assert.equal(alive(), false, 'grandchild survived owner exit')
    assert.equal(released.exitCode, null)
    assert.equal(released.signalCode, null)
  })
