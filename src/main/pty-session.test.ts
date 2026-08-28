import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { PtySession } from './pty-session.js'
import type { PtyLike, SpawnPtyFn } from './pty-backend.js'

class FakePty extends EventEmitter implements PtyLike {
  pid = 4242
  written: string[] = []
  killed: string[] = []
  resized: Array<[number, number]> = []

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
}

function fakeSpawnPty(pty: FakePty): SpawnPtyFn {
  return () => pty
}

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

test('approval and session-id heuristics reassemble text split across pty chunks', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()

  pty.emit('data', 'Do you want to pro')
  assert.equal(session.status, 'running')
  pty.emit('data', 'ceed with this edit?\nSession ID: work-')
  assert.equal(session.status, 'approval-needed')
  pty.emit('data', 'session-9\n')
  assert.equal(session.lastSessionId, 'work-session-9')
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
  pty.emit('exit', { exitCode: 1, signal: undefined })
  assert.equal(session.status, 'crashed')
  assert.match(crashMessage ?? '', /unexpectedly/)
})

test('a clean exit with code 0 marks the session completed', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  pty.emit('exit', { exitCode: 0, signal: undefined })
  assert.equal(session.status, 'completed')
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

test('a session id observed in output is captured for later auto-resume', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  pty.emit('data', 'Session ID: work-session-9\n')
  assert.equal(session.lastSessionId, 'work-session-9')
})

test('resize() forwards to the underlying pty', async () => {
  const pty = new FakePty()
  const session = new PtySession({ file: 'copilot', args: [], cwd: 'C:\\work', spawnPty: fakeSpawnPty(pty) })
  await session.start()
  session.resize(120, 40)
  assert.deepEqual(pty.resized, [[120, 40]])
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
