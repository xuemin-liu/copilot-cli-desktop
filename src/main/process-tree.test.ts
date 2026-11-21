import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { killProcessTree, processDescendants, processGroupMembers, type ProcessGroupSystem } from './process-tree.js'

test('the members of a process group are read from a pid and group listing', () => {
  const listing = '  100   100\n  101   100\n  102   200\n    1     1\n  103   100 \nnot a line\n 104 1000\n'
  assert.deepEqual(processGroupMembers(listing, 100), [100, 101, 103])
  assert.deepEqual(processGroupMembers(listing, 200), [102])
  assert.deepEqual(processGroupMembers(listing, 10), [], 'a group number is matched whole, not as a prefix')
  assert.deepEqual(processGroupMembers(listing, 1), [], 'process 1 is never a target')
  assert.deepEqual([...processDescendants('10 1\n11 10\n12 11\n13 1\n', 10)].sort(), [10, 11, 12])
})

function fakeSystem(groupSignal: 'accepted' | 'refused', listing: string | Error): { system: ProcessGroupSystem; killed: number[]; listed: number } {
  const state = { killed: [] as number[], listed: 0 }
  const system: ProcessGroupSystem = {
    kill: (pid, signal) => {
      assert.equal(signal, 'SIGKILL')
      if (pid < 0 && groupSignal === 'refused') throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      state.killed.push(pid)
    },
    listGroups: async () => { state.listed++; if (listing instanceof Error) throw listing; return listing },
  }
  return { system, get killed() { return state.killed }, get listed() { return state.listed } }
}

test('one signal to the group kills a tree when the system accepts it', async () => {
  const fake = fakeSystem('accepted', '')
  await killProcessTree(500, 'linux', fake.system)
  assert.deepEqual(fake.killed, [-500])
  assert.equal(fake.listed, 0, 'nothing is listed when the group signal went through')
})

test('when the group signal is refused, every process of the group is killed one by one', async () => {
  // What macOS does when the group holds a process that has exited and not been collected: the signal reaches nobody.
  const fake = fakeSystem('refused', '500 500\n501 500\n502 500\n900 900\n503 500\n')
  await killProcessTree(500, 'darwin', fake.system)
  assert.deepEqual(fake.killed, [501, 502, 503, 500], 'the others first, the leader last, and no process of another group')
  // A listing that fails still kills the leader, as before.
  const blind = fakeSystem('refused', new Error('ps failed'))
  await killProcessTree(500, 'darwin', blind.system)
  assert.deepEqual(blind.killed, [500])
  // Never a group of every process or of this process's own group.
  for (const pid of [0, 1, -5, 1.5, Number.NaN]) {
    const none = fakeSystem('accepted', '')
    await killProcessTree(pid, 'linux', none.system)
    assert.deepEqual(none.killed, [], String(pid))
  }
})

test('a real process group that holds an exited, uncollected process is killed whole', { skip: process.platform === 'win32' }, async () => {
  // The shell starts a long sleep and a command that exits at once, then becomes a program that never collects its
  // children. So the group holds its leader, a running child, and an exited child nobody collected.
  const child = spawn('/bin/sh', ['-c', 'sleep 60 & true & exec sleep 60'], { detached: true, stdio: 'ignore' })
  const pid = child.pid!
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const { execFileSync } = await import('node:child_process')
  const members = (): string[] => execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).split('\n')
    .map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === String(pid)).map(parts => `${parts[0]}:${parts[2]}`)
  try {
    // Wait until the shell has become the sleep and its short child has exited.
    for (let waited = 0; waited < 5_000 && members().length < 2; waited += 50) await new Promise(done => setTimeout(done, 50))
    await new Promise(done => setTimeout(done, 300))
    assert.ok(members().length >= 2, `the group has its leader and a child: ${members().join(' ')}`)
    await killProcessTree(pid)
    await exited
    // Processes that were killed may show for a moment as exited ("Z") until they are collected; none may still run.
    let running = members().filter(member => !/:Z/.test(member))
    for (let waited = 0; waited < 5_000 && running.length > 0; waited += 50) { await new Promise(done => setTimeout(done, 50)); running = members().filter(member => !/:Z/.test(member)) }
    assert.deepEqual(running, [], 'nothing of the group is left running')
  } finally { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
})
