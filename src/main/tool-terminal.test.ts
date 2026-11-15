import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolTerminals, terminalLaunch } from './tool-terminal.js'
import type { PtyLike } from './pty-backend.js'
import { spawnMyTerminal } from './myterminal-backend.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('SSH uses argument boundaries, native config, and validates host/options', () => {
  assert.deepEqual(terminalLaunch('ssh', { host: 'my-server', username: 'alice', port: 2222, identityFile: '/keys/my key' }, '/work', 'linux').args,
    ['-l', 'alice', '-p', '2222', '-i', '/keys/my key', '--', 'my-server'])
  for (const host of ['-oProxyCommand=bad', 'host;echo bad', 'user@host', 'host\nother']) assert.throws(() => terminalLaunch('ssh', { host }), /SSH host/)
  assert.throws(() => terminalLaunch('ssh', { host: 'ok', port: 70000 }), /port/)
  assert.throws(() => terminalLaunch('wsl', {}, '/work', 'linux'), /Windows/)
  assert.deepEqual(terminalLaunch('wsl', { distro: 'Ubuntu-24.04' }, 'D:\\work', 'win32').args, ['--distribution', 'Ubuntu-24.04', '--cd', 'D:\\work'])
})

function mockPty(): PtyLike & { data(text: string): void; exit(): void; writes: string[]; kills: number; disposed: number } {
  let onData = (_data: string): void => {}, onExit = (_event: { exitCode: number }): void => {}
  return { pid: 123, writes: [], kills: 0, disposed: 0,
    onData(listener) { onData = listener }, onExit(listener) { onExit = listener }, data(text) { onData(text) }, exit() { onExit({ exitCode: 7 }) },
    write(text) { this.writes.push(text) }, resize() {}, kill() { this.kills++ }, dispose() { this.disposed++ } }
}

test('background lifecycle distinguishes transport failure from explicit close and cancelled startup', async () => {
  const ended: boolean[] = [], pty = mockPty()
  let spawn: () => Promise<PtyLike> = async () => { throw new Error('SSH unavailable') }
  const manager = new ToolTerminals(undefined, { managed: () => spawn(), started() {}, output() {}, closed: (_profile, _id, unexpected) => ended.push(unexpected) })
  const config = { transport: 'managed' as const, connectionId: 'saved' }
  assert.equal((await manager.start('p', 't', 'ssh', config, '/work', {})).status, 'error')
  assert.deepEqual(ended, [true], 'failed SSH startup schedules retry')
  manager.close('p', 't'); assert.deepEqual(ended, [true, false])
  spawn = async () => pty
  await manager.start('p', 't', 'ssh', config, '/work', {})
  pty.exit(); assert.equal(ended.at(-1), true)
  manager.close('p', 't'); pty.exit(); assert.equal(ended.at(-1), false, 'late exit cannot schedule retry')
  let release!: (pty: PtyLike) => void
  spawn = () => new Promise(resolve => { release = resolve })
  const pending = manager.start('p', 't', 'ssh', config, '/work', {})
  manager.close('p', 't'); const count = ended.length; release(mockPty())
  await assert.rejects(pending, /closed during startup/)
  assert.equal(ended.length, count, 'cancelled startup never schedules another retry')
})
test('terminal output cursors, project ownership, exit, and close are independent of selected UI', async () => {
  const pty = mockPty(), manager = new ToolTerminals(() => pty)
  await manager.start('p1', 't1', 'local', {}, '/work', {})
  pty.data('hello'); assert.equal(manager.read('p1', 't1', 2).output, 'llo')
  assert.throws(() => manager.write('p2', 't1', 'wrong'), /project/)
  assert.throws(() => manager.read('p1', 't1', -1), /cursor/)
  assert.throws(() => manager.read('p1', 't1', 6), /cursor/)
  manager.write('p1', 't1', 'echo hi\r'); assert.deepEqual(pty.writes, ['echo hi\r'])
  pty.data('x'.repeat(600000))
  const state = manager.read('p1', 't1'); assert.equal(state.output.length, 524288); assert.equal(state.start, state.cursor - state.output.length)
  pty.exit(); assert.equal(manager.read('p1', 't1').exitCode, 7); assert.throws(() => manager.write('p1', 't1', 'bad'), /not running/)
  manager.close('p1', 't1'); assert.throws(() => manager.read('p1', 't1'), /not connected/)
})
test('closing a tab during asynchronous spawn cannot leak the eventual process', async () => {
  let resolve!: (pty: PtyLike) => void
  const pty = mockPty(), manager = new ToolTerminals(() => new Promise<PtyLike>(done => { resolve = done }))
  const pending = manager.start('p1', 't1', 'local', {}, '/work', {})
  manager.close('p1', 't1'); resolve(pty)
  await assert.rejects(pending, /closed during startup/)
  assert.equal(pty.kills, 1); assert.equal(pty.disposed, 1)
})

test('closing a terminal forces termination even if its shell ignores graceful signals', async () => {
  const pty = mockPty(), signals: (string | undefined)[] = []
  pty.kill = signal => { signals.push(signal) }
  const manager = new ToolTerminals(() => pty)
  await manager.start('p1', 't1', 'local', {}, '/work', {})
  manager.close('p1', 't1')
  assert.deepEqual(signals, ['SIGKILL'])
  assert.equal(pty.disposed, 1)
})

test('desktop PowerShell launch bypasses PATH shadowing and works without System32 in PATH', { skip: process.platform !== 'win32' }, async () => {
  const before = process.env.Path, upper = process.env.PATH
  const directory = await mkdtemp(join(tmpdir(), 'myterminal-path-'))
  try {
    await writeFile(join(directory, 'powershell.exe'), 'must never be executed')
    const trusted = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const path of [directory, '']) {
      process.env.Path = path; process.env.PATH = path
      const launch = terminalLaunch('local', {}, '/project')
      let executable = ''
      await spawnMyTerminal((file, _args, options) => {
        executable = file
        assert.equal(options.cwd, '/project')
        assert.equal(options.env.COPILOT_DESKTOP_TERMINAL_HELPER, 'helper')
        return mockPty()
      }, launch.file, launch.args, { cwd: '/project', env: { COPILOT_DESKTOP_TERMINAL_HELPER: 'helper' }, cols: 80, rows: 24 })
      assert.equal(executable, trusted)
    }
  } finally {
    if (before === undefined) delete process.env.Path; else process.env.Path = before
    if (upper === undefined) delete process.env.PATH; else process.env.PATH = upper
    assert.ok(resolve(directory).startsWith(join(tmpdir(), 'myterminal-path-')))
    await rm(directory, { recursive: true, force: true })
  }
})

test('managed descriptors retain only public connection metadata across persistence', () => {
  const input = { transport: 'managed' as const, connectionId: 'saved', name: 'Named server', host: 'localhost', port: 2222, username: 'tester', password: 'must-not-persist', identityFile: 'private-key' }
  const expected = { transport: 'managed', connectionId: 'saved', name: 'Named server', host: 'localhost', port: 2222, username: 'tester' }
  assert.deepEqual(terminalLaunch('ssh', input).config, expected)
  assert.deepEqual(terminalLaunch('ssh', JSON.parse(JSON.stringify(expected))).config, expected)
})
