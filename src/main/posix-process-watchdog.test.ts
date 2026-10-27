import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import test from 'node:test'
import { POSIX_WATCHDOG_SCRIPT } from './posix-process-watchdog.js'

const posixOnly = { skip: process.platform === 'win32' ? 'macOS and Linux watchdog' : false }

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)) }
  return check()
}

/** A child that starts a long-running "tool" and prints the tool's PID, like Copilot running a command. */
async function childWithTool(detached: boolean): Promise<{ child: ChildProcess; tool: number }> {
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached, stdio: ['ignore', 'pipe', 'ignore'] })
  const tool = await new Promise<number>((resolve) => child.stdout!.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim()))))
  return { child, tool }
}

/** The watchdog as its owner leaves it: track the PIDs, then close its input as a dying owner would. */
async function ownerDies(...pids: number[]): Promise<void> {
  const watchdog = spawn('/bin/sh', ['-c', POSIX_WATCHDOG_SCRIPT], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin' } })
  for (const pid of pids) watchdog.stdin!.write(`track ${pid}\n`)
  watchdog.stdin!.end()
  await new Promise((resolve) => watchdog.once('exit', resolve))
}

test('a tracked child that stays in the caller\'s process group is killed with the tools it started', posixOnly, async () => {
  const { child, tool } = await childWithTool(false)
  try {
    assert.ok(alive(child.pid!) && alive(tool))
    await ownerDies(child.pid!)
    assert.equal(await until(() => !alive(tool)), true, 'the tool did not outlive the dead owner')
    assert.equal(await until(() => child.exitCode !== null || child.signalCode !== null), true)
    assert.equal(alive(process.pid), true, 'the caller\'s own group was not signalled')
  } finally { try { process.kill(tool, 'SIGKILL') } catch { /* gone */ } child.kill('SIGKILL') }
})

test('a tracked group leader is killed with its whole group, and a released child is left alone', posixOnly, async () => {
  const leader = await childWithTool(true)
  const released = await childWithTool(true)
  try {
    const watchdog = spawn('/bin/sh', ['-c', POSIX_WATCHDOG_SCRIPT], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin' } })
    watchdog.stdin!.write(`track ${leader.child.pid}\ntrack ${released.child.pid}\nrelease ${released.child.pid}\n`)
    watchdog.stdin!.end()
    await new Promise((resolve) => watchdog.once('exit', resolve))
    assert.equal(await until(() => !alive(leader.tool)), true)
    assert.equal(alive(released.tool), true, 'a released process is not killed')
  } finally {
    for (const { child, tool } of [leader, released]) { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } try { process.kill(tool, 'SIGKILL') } catch { /* gone */ } }
  }
})
