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
