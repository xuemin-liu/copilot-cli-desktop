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
