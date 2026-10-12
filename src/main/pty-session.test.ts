import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { PtySession } from './pty-session.js'
import { SessionPermissionMonitor } from './session-permission-monitor.js'
import type { PtyLike, SpawnPtyFn } from './pty-backend.js'

class FakePty extends EventEmitter implements PtyLike {
  pid = 4242
  written: string[] = []
  killed: string[] = []
  resized: Array<[number, number]> = []
  disposed = 0

  onData(listener: (data: string) => void): void {
    this.on('data', listener)
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.on('exit', listener)
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows])
  }

  kill(signal?: string): void {
    this.killed.push(signal ?? 'default')
    // Simulate the OS terminating the process shortly after a kill signal.
    setImmediate(() => this.emit('exit', { exitCode: 0, signal: undefined }))
  }

  dispose(): void {
    this.disposed += 1
  }
}

function fakeSpawnPty(pty: FakePty): SpawnPtyFn {
  return () => pty
}

test('stop waits for permission drain after the PTY has already exited', async (context) => {
  let release!: () => void
  const drained = new Promise<void>((resolve) => { release = resolve })
  context.mock.method(SessionPermissionMonitor.prototype, 'start', async () => {})
  context.mock.method(SessionPermissionMonitor.prototype, 'finish', () => drained)
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work',
    spawnPty: fakeSpawnPty(pty), sessionId: 'drain-test', monitorSessionPermissions: true })
  await session.start()
  pty.emit('exit', { exitCode: 0 })
  let stopped = false
  const stopping = session.stop().then(() => { stopped = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  release()
  await stopping
  assert.equal(stopped, true)
})

test('start() transitions to running and spawns with the given file/args/cwd', async () => {
  const pty = new FakePty()
  const session = new PtySession({
    file: 'copilot',
    args: ['--resume', 'abc'],
    cwd: 'C:\\work',
    spawnPty: fakeSpawnPty(pty),
  })
  assert.equal(session.status, 'starting')
  await session.start()
  assert.equal(session.status, 'running')
  assert.equal(session.processId, 4242)
})

test('approval-heuristic output flips status to approval-needed, and write() clears it', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()

  const events: string[] = []
  session.on('status', (status: string) => events.push(status))
  session.on('desktop-event', (event: { type: string }) => events.push(`event:${event.type}`))

  pty.emit('data', 'Allow copilot to run `git push`?')
  assert.equal(session.status, 'approval-needed')
  assert.ok(events.includes('approval-needed'))
  assert.ok(events.includes('event:approval-needed'))

  session.write('y\n')
  assert.equal(session.status, 'running')
  assert.deepEqual(pty.written, ['y\n'])
})

test('empty input and empty bracketed paste preserve the approval badge', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  pty.emit('data', 'Allow copilot to run `git push`?')
  session.write('')
  session.write('\u001b[200~\u001b[201~')
  assert.equal(session.status, 'approval-needed')
  assert.deepEqual(pty.written, [])
  session.write('\u001bv')
  session.write('\u0016')
  assert.equal(session.status, 'approval-needed', 'image shortcuts are not approval responses')
  assert.deepEqual(pty.written, ['\u001bv', '\u0016'])
  session.write('y\n')
  assert.equal(session.status, 'running')
  assert.deepEqual(pty.written, ['\u001bv', '\u0016', 'y\n'])
})

test('heuristics reassemble text split across pty chunks without trusting session IDs by default', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()

  pty.emit('data', 'Do you want to pro')
  assert.equal(session.status, 'running')
  pty.emit('data', 'ceed with this edit?\nSession ID: work-')
  assert.equal(session.status, 'approval-needed')
  pty.emit('data', 'session-9\n')
  assert.equal(session.lastSessionId, null)
})

test('legacy sessions can opt into bounded session-id banner discovery', async () => {
  const pty = new FakePty()
  const session = new PtySession({
    file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty), discoverSessionIdFromOutput: true,
  })
  await session.start()
  const discovered: string[] = []
  session.on('session-id', (id: string) => discovered.push(id))
  pty.emit('data', 'Resume this session with copilot --res')
  assert.equal(session.lastSessionId, null)
  pty.emit('data', 'ume=work-session-9\n')
  assert.equal(session.lastSessionId, 'work-session-9')
  assert.deepEqual(discovered, ['work-session-9'])
})

test('approval-needed stays up across ordinary output until an explicit transition', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()

  pty.emit('data', 'Allow copilot to run `git push`?')
  assert.equal(session.status, 'approval-needed')

  // A cursor-blink escape code or a split prompt fragment — anything that
  // does not itself match the approval heuristic — must not silently clear
  // the badge while Copilot is still actually waiting on the user.
  pty.emit('data', '\u001b[?25h')
  assert.equal(session.status, 'approval-needed')
  pty.emit('data', 'some unrelated streamed output\n')
  assert.equal(session.status, 'approval-needed')

  session.write('y\n')
  assert.equal(session.status, 'running')
})

test('output history is bounded by bytes, not just line count', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()

  // A single very long line gets truncated rather than retained whole.
  pty.emit('data', `${'a'.repeat(20_000)}\n`)
  const firstLine = session.recentOutput[0]
  assert.ok(firstLine !== undefined)
  assert.ok(firstLine.length < 20_000)
  assert.match(firstLine, /truncated/)

  // Newline-free output that never terminates still gets chunked into the
  // bounded line buffer (capped at MAX_OUTPUT_LINES) instead of growing a
  // single pendingLine string without limit.
  for (let i = 0; i < 600; i += 1) pty.emit('data', 'b'.repeat(8_000))
  assert.ok(session.recentOutput.length <= 500)
})

test('recentOutputText reconstructs retained lines plus any unterminated fragment', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  pty.emit('data', 'line one\nline two\npartial')
  assert.equal(session.recentOutputText, 'line one\nline two\npartial')
})

test('unexpected exit with a nonzero code marks the session crashed and emits a desktop-event', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()

  let crashMessage: string | null = null
  session.on('desktop-event', (event: { type: string; message?: string }) => {
    if (event.type === 'session-crashed') crashMessage = event.message ?? null
  })
  const exited = once(session, 'exit')
  pty.emit('exit', { exitCode: 1, signal: undefined })
  await exited
  assert.equal(session.status, 'crashed')
  assert.match(crashMessage ?? '', /unexpectedly/)
})

test('a clean exit with code 0 marks the session completed', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  const exited = once(session, 'exit')
  pty.emit('exit', { exitCode: 0, signal: undefined })
  await exited
  assert.equal(session.status, 'completed')
  assert.equal(pty.disposed, 1)
})

test('stop() kills the process and does not report a crash for the expected exit', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()

  const statuses: string[] = []
  session.on('status', (status: string) => statuses.push(status))
  await session.stop()
  assert.ok(statuses.includes('stopping'))
  assert.ok(!statuses.includes('crashed'))
})

test('a trusted constructor session id is never replaced by banner discovery', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty), sessionId: 'trusted-session-1', discoverSessionIdFromOutput: true })
  await session.start()
  pty.emit('data', 'Session ID: work-session-9\n')
  assert.equal(session.lastSessionId, 'trusted-session-1')
})

test('resize() forwards to the underlying pty', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  session.resize(120, 40)
  assert.deepEqual(pty.resized, [[120, 40]])
})

test('repeated sizes from hiding and revealing a tab do not trigger a native redraw', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  session.resize(80, 24)
  session.resize(120, 40)
  session.resize(120, 40)
  session.resize(120, 40)
  session.resize(121, 40)
  assert.deepEqual(pty.resized, [[120, 40], [121, 40]])
})

test('dimensions defaults to 80x24 and reflects the most recent resize()', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  assert.deepEqual(session.dimensions, { cols: 80, rows: 24 })
  await session.start()
  // A caller that replaces this session (e.g. to restart it under a fresh
  // PtySession instance) reads this to spawn at the terminal's real current
  // size — if resize() didn't persist it, a restart would silently revert
  // to the 80x24 construction default while the renderer's xterm instance
  // (unaware anything changed, since restart keeps the same tab) keeps
  // rendering at its actual, larger size.
  session.resize(120, 40)
  assert.deepEqual(session.dimensions, { cols: 120, rows: 40 })
})

test('a resize() that arrives while spawnPty() is still resolving is still applied to the new pty', async () => {
  const pty = new FakePty()
  let resolveSpawn: ((pty: PtyLike) => void) | undefined
  const spawnPty: SpawnPtyFn = () => new Promise<PtyLike>((resolve) => {
    resolveSpawn = resolve
  })
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', cols: 80, rows: 24, spawnPty })

  const startPromise = session.start()
  // The resize lands after spawnPty() was called but before it resolves —
  // this.pty is still null, so resize() can only update this.options, not
  // forward to a live pty (there isn't one yet).
  session.resize(167, 57)
  assert.deepEqual(pty.resized, [])

  resolveSpawn?.(pty)
  await startPromise

  // start() must reconcile the pty to the latest stored size once it
  // actually exists, rather than leaving it stuck at the 80x24 it was
  // spawned with.
  assert.deepEqual(pty.resized, [[167, 57]])
  assert.deepEqual(session.dimensions, { cols: 167, rows: 57 })
})

test('write() and resize() safely ignore a session that has already exited', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  pty.emit('exit', { exitCode: 1, signal: undefined })
  assert.doesNotThrow(() => session.write('late input'))
  assert.doesNotThrow(() => session.resize(80, 24))
  assert.deepEqual(pty.written, [])
})

test('a session without an id adopts the new store directory, announces it, and starts monitoring it', async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'pty-store-discovery-'))
  const root = join(home, 'session-state')
  await mkdir(root, { recursive: true })
  const launchCwd = join(root, 'project')
  try {
    const pty = new FakePty()
    const session = new PtySession({
      file: 'copilot', args: ['--worktree', '--name=t'], cwd: launchCwd, spawnPty: fakeSpawnPty(pty), env: { COPILOT_HOME: home },
      discoverSessionIdFromStore: { root, since: Date.now(), launchCwd, worktreeName: 'desktop-t-aaaaaa', pollMs: 20, timeoutMs: 5_000 },
      monitorSessionPermissions: true,
    })
    const announced = once(session, 'session-id')
    await session.start()
    assert.equal(session.lastSessionId, null)
    const id = '55555555-5555-4555-8555-555555555555'
    await mkdir(join(root, id), { recursive: true })
    await writeFile(join(root, id, 'events.jsonl'),
      JSON.stringify({ type: 'session.start', data: { startTime: new Date().toISOString(), context: { cwd: join(root, 'project.worktrees', 'desktop-t-aaaaaa') } } }) + '\n'
      + JSON.stringify({ type: 'session.permissions_changed', data: { allowAllPermissionMode: 'auto', allowAllPermissions: false } }) + '\n')
    assert.deepEqual(await announced, [id])
    assert.equal(session.lastSessionId, id)
    const mode = await once(session, 'permission-mode')
    assert.equal(mode[0], 'assisted', 'the monitor was attached to the discovered session')
    await session.stop()
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('store discovery is cancelled by stop and never overrides an id learned another way', async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'pty-store-discovery-'))
  const root = join(home, 'session-state')
  await mkdir(root, { recursive: true })
  try {
    const pty = new FakePty()
    const session = new PtySession({
      file: 'copilot', args: [], cwd: root, spawnPty: fakeSpawnPty(pty), discoverSessionIdFromOutput: true,
      discoverSessionIdFromStore: { root, since: Date.now(), launchCwd: root, worktreeName: 'desktop-t-bbbbbb', pollMs: 20, timeoutMs: 5_000 },
    })
    await session.start()
    pty.emit('data', 'session id: 66666666-6666-4666-8666-666666666666\n')
    assert.equal(session.lastSessionId, '66666666-6666-4666-8666-666666666666')
    const late = '77777777-7777-4777-8777-777777777777'
    await mkdir(join(root, late), { recursive: true })
    await writeFile(join(root, late, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { startTime: new Date().toISOString(), context: { cwd: join(root, 'elsewhere', 'desktop-t-bbbbbb') } } }) + '\n')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(session.lastSessionId, '66666666-6666-4666-8666-666666666666', 'the output-discovered id wins')
    await session.stop()
    const stopped = new PtySession({
      file: 'copilot', args: [], cwd: root, spawnPty: fakeSpawnPty(new FakePty()),
      discoverSessionIdFromStore: { root, since: Date.now(), launchCwd: root, worktreeName: 'desktop-t-cccccc', pollMs: 20, timeoutMs: 5_000 },
    })
    await stopped.start()
    await stopped.stop()
    await mkdir(join(root, '88888888-8888-4888-8888-888888888888'), { recursive: true })
    await writeFile(join(root, '88888888-8888-4888-8888-888888888888', 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { startTime: new Date().toISOString(), context: { cwd: join(root, 'elsewhere', 'desktop-t-cccccc') } } }) + '\n')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(stopped.lastSessionId, null, 'a stopped session does not adopt a directory that appears later')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('the store snapshot is complete before the spawn, even when the listing is slow and the CLI writes its log at once', async () => {
  const { mkdir, mkdtemp, readdir, rm, writeFile } = await import('node:fs/promises')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'pty-store-order-'))
  const root = join(home, 'session-state')
  await mkdir(root, { recursive: true })
  try {
    const id = '13131313-1313-4131-8131-131313131313'
    const pty = new FakePty()
    // The spawn creates the session's log synchronously, as a fast CLI can; the listing takes longer than that.
    const spawnPty: SpawnPtyFn = () => {
      mkdirSync(join(root, id), { recursive: true })
      writeFileSync(join(root, id, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { startTime: new Date().toISOString(), context: { cwd: join(home, 'p.worktrees', 'desktop-o-dddddd') } } }) + '\n')
      return pty
    }
    const slowList = async (directory: string): Promise<Set<string>> => { await new Promise((resolve) => setTimeout(resolve, 80)); return new Set((await readdir(directory)).filter((name) => /^[0-9a-f-]{36}$/.test(name))) }
    const session = new PtySession({
      file: 'copilot', args: [], cwd: join(home, 'p'), spawnPty, env: { COPILOT_HOME: home },
      discoverSessionIdFromStore: { root, since: Date.now(), launchCwd: join(home, 'p'), worktreeName: 'desktop-o-dddddd', pollMs: 20, timeoutMs: 3_000, listSessions: slowList },
    })
    const announced = once(session, 'session-id')
    await session.start()
    assert.deepEqual(await announced, [id])
    await session.stop()
    void writeFile
  } finally { await rm(home, { recursive: true, force: true }) }
})
