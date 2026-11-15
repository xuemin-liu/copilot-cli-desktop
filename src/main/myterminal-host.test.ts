import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

test('a reconnect read crossing tab/project activation cannot restart a terminal or publish stale errors', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  const errors: string[] = [], actions: string[] = []
  let resolveRead!: (value: unknown) => void, rejectRead!: (error: Error) => void
  const fixture = { copilotDesktop: { toolTerminal: async (_profile: string, request: { action: string }) => {
    actions.push(request.action)
    return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject })
  } } }
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fixture })
  const host = createMyTerminalHost('project', 'terminal', () => {}, message => errors.push(message))
  try {
    host.setActive(true)
    const first = host.connect()
    host.setActive(false); host.setActive(true)
    resolveRead({ status: 'exited' })
    await first
    assert.deepEqual(actions, ['read'], 'an old read must never become a restart after returning to the tab')
    const second = host.connect()
    host.setActive(false)
    rejectRead(new Error('Terminal controls belong to the current project'))
    await second
    assert.deepEqual(errors, [], 'stale permission failures must not follow the user to another project')
    host.setActive(true)
    const attached = host.api.local.spawn()
    resolveRead({ status: 'exited' })
    assert.deepEqual(await attached, { error: 'Terminal exited' }, 'an already-exited process cannot appear connected')
  } finally {
    host.stop()
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})

test('a fast SSH startup banner stays queued until the terminal view has subscribed', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  const cursors: number[] = [], received: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { copilotDesktop: {
    toolTerminal: async (_profile: string, request: { cursor?: number }) => {
      cursors.push(request.cursor ?? 0)
      return { id: 'terminal', generation: 'first', status: 'running', output: request.cursor ? '' : 'SSH_READY', cursor: 9, start: request.cursor ?? 0 }
    },
  } } })
  const host = createMyTerminalHost('project', 'terminal', () => {}, message => assert.fail(message))
  try {
    host.setActive(true); host.start()
    await new Promise(resolve => setTimeout(resolve, 450))
    assert.ok(cursors.length >= 2); assert.ok(cursors.every(cursor => cursor === 0))
    host.api.ssh.onData((_id: string, text: string) => received.push(text))
    host.onTerminal({} as import('@xterm/xterm').Terminal)
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.deepEqual(received, ['SSH_READY'])
  } finally {
    host.stop()
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})
