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

test('a spawn failure is reported as an exit instead of crashing or hanging', async () => {
  const pty = spawnChildProcessPty('definitely-not-a-real-binary-xyz', [], {
    cwd: process.cwd(), env: process.env, cols: 80, rows: 24,
  })
  const exit = await new Promise<{ exitCode: number }>((resolve) => pty.onExit(resolve))
  assert.equal(exit.exitCode, 1)
})

test('multibyte output split across chunks is decoded intact and delivered before exit', async () => {
  const script = "const b=Buffer.from('héllo→世界');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)"
  const pty = spawnChildProcessPty(process.execPath, ['-e', script], { cwd: process.cwd(), env: process.env, cols: 80, rows: 24 })
  let output = ''
  pty.onData((data) => { output += data })
  await new Promise<void>((resolve) => pty.onExit(() => resolve()))
  assert.equal(output, 'héllo→世界')
})
