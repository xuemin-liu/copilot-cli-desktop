import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnChildProcessPty } from './child-process-pty-backend.js'

test('a clean exit reports exitCode 0 and no signal', async () => {
  const pty = spawnChildProcessPty(process.execPath, ['-e', 'process.exit(0)'], {
    cwd: process.cwd(),
    env: process.env,
    cols: 80,
    rows: 24,
  })
  const exit = await new Promise<{ exitCode: number; signal?: number | undefined }>((resolve) => {
    pty.onExit((event) => resolve(event))
  })
  assert.equal(exit.exitCode, 0)
  assert.equal(exit.signal, undefined)
  assert.doesNotThrow(() => pty.write('late input'))
})

test('termination by signal is preserved as a failure with the real signal number, not exitCode 0', async () => {
  const pty = spawnChildProcessPty(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    cwd: process.cwd(),
    env: process.env,
    cols: 80,
    rows: 24,
  })
  const exit = await new Promise<{ exitCode: number; signal?: number | undefined }>((resolve) => {
    pty.onExit((event) => resolve(event))
    pty.kill('SIGTERM')
  })
  assert.notEqual(exit.exitCode, 0)
  assert.equal(typeof exit.signal, 'number')
})
