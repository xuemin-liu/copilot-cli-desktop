import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { enrollDescendants, startWindowsProcessWatchdog } from './windows-process-watchdog.js'

test('invalid process IDs are rejected before opening a process', () => {
  for (const pid of [0, -1, 1.5, 2 ** 32]) assert.throws(() => startWindowsProcessWatchdog(pid), /Invalid watchdog process ID/)
})

test('a childless root needs no full inventory and a whole existing chain needs only one catch-up scan', () => {
  const root = { pid: 1, created: 1n }
  enrollDescendants(root, () => false, () => assert.fail('unexpected full inventory'), () => assert.fail('unexpected child'))
  const tree = new Map<number, { pid: number; created: bigint }[]>()
  for (let pid = 2; pid <= 11; pid++) tree.set(pid - 1, [{ pid, created: BigInt(pid) }])
  let scans = 0
  const enrolled = new Set<number>()
  const enroll = (child: { pid: number }): boolean => {
    if (enrolled.has(child.pid)) return false
    enrolled.add(child.pid)
    return true
  }
  enrollDescendants(root, () => true, () => { scans++; return tree }, enroll)
  assert.equal(enrolled.size, 10)
  assert.equal(scans, 2)
  // A child born during the first scan must also be discovered and enrolled.
  enrolled.clear()
  scans = 0
  enrollDescendants(root, () => true, () => {
    if (++scans === 2) tree.set(11, [{ pid: 12, created: 12n }])
    return tree
  }, enroll)
  assert.ok(enrolled.has(12))
  assert.equal(scans, 3)
})

for (const release of [false, true]) {
  test(`pre-existing descendants ${release ? 'survive release' : 'die with the watchdog owner'}`,
    { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
      const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
      const pids: number[] = []
      t.after(() => { for (const pid of pids.reverse()) { try { process.kill(pid) } catch { /* already exited */ } } })
      const leaf = 'setInterval(() => {}, 30000)'
      // Detached children avoid libuv's own per-parent job masking a missing
      // watchdog assignment. The IPC barrier establishes both descendants first.
      const branch = `
        const leaf = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { detached: true, windowsHide: true, stdio: 'ignore' })
        process.send(leaf.pid)
        setInterval(() => {}, 30000)
      `
      const root = spawn(process.execPath, ['-e', `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(branch)}], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
        child.once('message', leaf => process.send([child.pid, leaf]))
        setInterval(() => {}, 30000)
      `], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      assert.ok(root.pid)
      pids.push(root.pid)
      const [descendants] = await once(root, 'message') as [number[]]
      pids.push(...descendants)
      assert.equal(descendants.length, 2)
      assert.ok(pids.every(alive))
      const owner = spawn(process.execPath, ['--input-type=module', '-e', `
        import { startWindowsProcessWatchdog } from ${JSON.stringify(new URL('./windows-process-watchdog.js', import.meta.url).href)}
        const lease = startWindowsProcessWatchdog(${root.pid})
        ${release ? 'lease.release(); lease.release()' : ''}
        process.send('ready')
        setInterval(() => {}, 30000)
      `], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
      t.after(() => owner.kill())
      await once(owner, 'message')
      const exited = once(owner, 'exit'); owner.kill(); await exited
      if (release) {
        await delay(300)
        assert.ok(pids.every(alive), 'release killed an existing member of the tree')
      } else {
        const deadline = Date.now() + 3000
        while (pids.some(alive) && Date.now() < deadline) await delay(50)
        assert.deepEqual(pids.filter(alive), [], 'pre-existing descendants survived owner death')
      }
    })
}

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
