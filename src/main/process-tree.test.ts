import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { groupKillLog, killProcessTree, processDescendants, processGroupMembers, processRows, type ProcessGroupSystem } from './process-tree.js'

test('the members of a process group are read from a pid and group listing', () => {
  const listing = '  100   100\n  101   100\n  102   200\n    1     1\n  103   100 \nnot a line\n 104 1000\n'
  assert.deepEqual(processGroupMembers(listing, 100), [100, 101, 103])
  assert.deepEqual(processGroupMembers(listing, 200), [102])
  assert.deepEqual(processGroupMembers(listing, 10), [], 'a group number is matched whole, not as a prefix')
  assert.deepEqual(processGroupMembers(listing, 1), [], 'process 1 is never a target')
  assert.deepEqual([...processDescendants('10 1\n11 10\n12 11\n13 1\n', 10)].sort(), [10, 11, 12])
})

test('processes are reported by number only, never by what their command line says', () => {
  const listing = [' 4001  4000  4000 S    sh .git/hooks/pre-commit', ' 4002  4001  4000 S    sleep 15', ' 5001     1  5001 S    git diff -- pre-commit-notes.txt',
    ' 5002     1  5002 S    sleep 150', '40010     1 40010 R    sleep 15', 'not a row'].join('\n')
  assert.deepEqual(processRows(listing, [4001, 4002]), ['4001 4000 4000 S', '4002 4001 4000 S'], 'the two wanted processes, without their commands')
  assert.deepEqual(processRows(listing, [4001, 9999]), ['4001 4000 4000 S'], 'a process that has ended is simply absent')
  assert.deepEqual(processRows(listing, []), [])
  assert.deepEqual(processRows(listing, [1, 0, Number.NaN]), [])
})

function fakeSystem(groupSignal: 'accepted' | 'EPERM' | 'ESRCH', listing: string | Error): { system: ProcessGroupSystem; killed: number[]; listed: number; killedBeforeListing: number[] } {
  const state = { killed: [] as number[], listed: 0, killedBeforeListing: [] as number[] }
  const system: ProcessGroupSystem = {
    kill: (pid, signal) => {
      assert.equal(signal, 'SIGKILL')
      if (pid < 0 && groupSignal !== 'accepted') throw Object.assign(new Error(`kill ${groupSignal}`), { code: groupSignal })
      state.killed.push(pid)
    },
    listGroups: async () => { state.listed++; state.killedBeforeListing = [...state.killed]; if (listing instanceof Error) throw listing; return listing },
  }
  return { system, get killed() { return state.killed }, get listed() { return state.listed }, get killedBeforeListing() { return state.killedBeforeListing } }
}

test('one signal to the group kills a tree when the system accepts it', async () => {
  const fake = fakeSystem('accepted', '')
  await killProcessTree(500, 'linux', fake.system)
  assert.deepEqual(fake.killed, [-500])
  assert.equal(fake.listed, 0, 'nothing is listed when the group signal went through')
})

test('when the group signal is refused, every process of the group is killed one by one', async () => {
  const fake = fakeSystem('EPERM', '500 500\n501 500\n502 500\n900 900\n503 500\n')
  await killProcessTree(500, 'darwin', fake.system)
  assert.deepEqual(fake.killed, [500, 501, 502, 503], 'the leader at once, then the others; no process of another group')
  assert.deepEqual(fake.killedBeforeListing, [500], 'the leader is killed in the same turn, before the listing')
  assert.deepEqual(groupKillLog.at(-1), { pid: 500, outcome: 'group signal refused (EPERM)', members: [500, 501, 502, 503] })
  // A listing that fails still kills the leader, as before.
  const blind = fakeSystem('EPERM', new Error('ps failed'))
  await killProcessTree(500, 'darwin', blind.system)
  assert.deepEqual(blind.killed, [500])
  // By the time the listing is back, the group may be gone and its number given to another process. Only what the
  // listing shows in this group is killed: the number itself, now in another group, is not signalled again.
  const reused = fakeSystem('EPERM', '500 900\n501 500\n777 900\n')
  await killProcessTree(500, 'darwin', reused.system)
  assert.deepEqual(reused.killed, [500, 501])
  assert.deepEqual(reused.killed.slice(reused.killedBeforeListing.length), [501], 'after the listing, only members of the group')
  // A group that no longer exists is left alone: nothing is listed and nothing is signalled, not even the old number.
  const gone = fakeSystem('ESRCH', '500 900\n')
  await killProcessTree(500, 'darwin', gone.system)
  assert.deepEqual([gone.killed, gone.listed], [[], 0])
  assert.deepEqual(groupKillLog.at(-1), { pid: 500, outcome: 'no such group' })
  // Never a group of every process or of this process's own group.
  for (const pid of [0, 1, -5, 1.5, Number.NaN]) {
    const none = fakeSystem('accepted', '')
    await killProcessTree(pid, 'linux', none.system)
    assert.deepEqual(none.killed, [], String(pid))
  }
})

// This does not show that such a group makes the system refuse the group signal: on the systems it has run on, the
// signal is accepted (see the log entry asserted at the end). It shows that the tree is gone either way.
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
    assert.deepEqual(running, [], `nothing of the group is left running (${JSON.stringify(groupKillLog.at(-1))})`)
    assert.equal(groupKillLog.at(-1)?.pid, pid)
  } finally { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
})
