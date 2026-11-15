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

test('a surviving split keeps receiving resize updates after its parent shell exits', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  let parentStatus = 'running'
  const resizes: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { copilotDesktop: {
    toolTerminal: async (_profile: string, request: { action: string; id: string }) => {
      if (request.action === 'resize') { resizes.push(request.id); return {} }
      return { id: request.id, generation: request.id, status: request.id === 'child' ? 'running' : parentStatus, output: '', cursor: 0, start: 0, splitId: 'child' }
    },
  } } })
  const host = createMyTerminalHost('project', 'parent', () => {}, message => assert.fail(message))
  try {
    host.onTerminal({} as import('@xterm/xterm').Terminal); host.setActive(true); host.start()
    await host.api.ssh.connect('child')
    await new Promise(resolve => setTimeout(resolve, 250))
    host.api.ssh.resize('child', 80, 24)
    assert.deepEqual(resizes, ['child'])
    parentStatus = 'exited'
    await new Promise(resolve => setTimeout(resolve, 250))
    host.api.ssh.resize('child', 120, 30)
    assert.deepEqual(resizes, ['child', 'child'])
  } finally {
    host.stop()
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})

test('a retained split view keeps its output subscription across an in-flight activation change', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  let finishAttach!: (state: object) => void
  const reads: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { copilotDesktop: {
    toolTerminal: async (_profile: string, request: { id: string; cursor?: number }) => {
      if (request.id === 'child' && request.cursor === undefined) return new Promise(resolve => { finishAttach = resolve })
      reads.push(request.id)
      return { generation: request.id, status: 'running', splitId: 'child', output: '', cursor: 0, start: 0 }
    },
  } } })
  const host = createMyTerminalHost('project', 'parent', () => {}, message => assert.fail(message))
  try {
    host.setActive(true); host.onTerminal({} as import('@xterm/xterm').Terminal); host.start()
    const pending = host.api.ssh.connect('child')
    host.setActive(false); host.setActive(true); finishAttach({ status: 'running' }); await pending
    reads.length = 0; await new Promise(resolve => setTimeout(resolve, 450))
    assert.ok(reads.includes('child'), 'showing the retained pane must resume child output')
    host.api.ssh.disconnect('child'); reads.length = 0
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.ok(reads.every(id => id === 'parent'), 'detached split stops polling')
  } finally {
    host.stop()
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})

test('hidden panes consume pushed output beyond the replay cap and deduplicate racing polls', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  type State = import('./tool-terminal.js').TerminalSnapshot
  let push!: (profile: string, state: State) => void, complete!: (state: State) => void
  const received: string[] = [], errors: string[] = []
  let unsubscribed = false
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { copilotDesktop: {
    onToolTerminalOutput: (listener: typeof push) => { push = listener; return () => { unsubscribed = true } },
    toolTerminal: () => new Promise(resolve => { complete = resolve }),
  } } })
  const host = createMyTerminalHost('p', 't', () => {}, message => errors.push(message))
  const frame = (output: string, cursor: number, generation = 'first'): State => ({ id: 't', generation, status: 'running', output, start: cursor - output.length, cursor })
  try {
    host.api.ssh.onData((_id: string, value: string) => received.push(value))
    host.onTerminal({} as import('@xterm/xterm').Terminal)
    host.start() // Deliberately never activate the pane.
    const text = 'EARLY_MARKER' + 'x'.repeat(600000)
    push('p', frame(text, text.length))
    complete(frame('stale snapshot', 14))
    await new Promise(resolve => setTimeout(resolve, 250))
    complete(frame(text.slice(-524288), text.length))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(received.join(''), text, 'live stream cannot be truncated or duplicated by replay')
    push('p', frame('new process', 11, 'second'))
    assert.equal(received.join(''), text + '\r\n[Reconnected]\r\nnew process', 'reconnect appends without clearing scrollback')
    assert.deepEqual(errors, [])
  } finally {
    host.stop(); assert.equal(unsubscribed, true)
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})

test('a parent read begun before split attachment cannot detach its output or publish stale pane metadata', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  type State = import('./tool-terminal.js').TerminalSnapshot
  try {
    for (const pushParent of [false, true]) {
      let push!: (profile: string, state: State) => void, finishRead!: (state: State) => void, first = true
      const received: string[] = [], changes: State[] = []
      const state = (id: string, output = '', splitId?: string): State => ({ id, generation: 'g', status: 'running', output, cursor: output.length, start: 0, ...(splitId ? { splitId } : {}) })
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { copilotDesktop: {
        onToolTerminalOutput: (fn: typeof push) => { push = fn; return () => {} },
        toolTerminal: async (_profile: string, request: { id: string }) => {
          if (request.id === 'parent' && first) { first = false; return new Promise(resolve => { finishRead = resolve }) }
          return state(request.id, '', 'child')
        },
      } } })
      const host = createMyTerminalHost('p', 'parent', next => changes.push(next as State), message => assert.fail(message))
      try {
        host.onTerminal({} as import('@xterm/xterm').Terminal); host.setActive(true)
        host.api.ssh.onData((id: string, value: string) => { if (id === 'child') received.push(value) })
        host.start()
        await host.api.ssh.connect('child')
        if (pushParent) push('p', state('parent', 'fresh'))
        finishRead(state('parent')) // This old snapshot has no splitId.
        await new Promise(resolve => setTimeout(resolve, 250))
        push('p', state('child', 'SPLIT_OUTPUT'))
        assert.deepEqual(received, ['SPLIT_OUTPUT'])
        assert.ok(changes.length > 0 && changes.every(next => next.splitId === 'child'))
      } finally { host.stop() }
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})

test('hidden transport reconnect can restore its grid but cannot send terminal input', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  const commands: object[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { copilotDesktop: {
    toolTerminal: async (_profile: string, request: { action: string }) => {
      if (request.action !== 'read') commands.push(request)
      return { status: 'running' }
    },
  } } })
  const host = createMyTerminalHost('p', 'parent', () => {}, message => assert.fail(message))
  try {
    await host.api.ssh.connect('child')
    host.api.ssh.resize('child', 59, 15)
    host.api.ssh.write('child', 'must not execute')
    assert.deepEqual(commands, [{ action: 'resize', cols: 59, rows: 15, id: 'child' }])
  } finally {
    host.stop()
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})

test('mount replays buffered history before queued live chunks, including an in-flight first read', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  type State = import('./tool-terminal.js').TerminalSnapshot
  try {
    for (const holdFirst of [false, true]) {
      let push!: (profile: string, state: State) => void, finishFirst!: (state: State) => void, first = true, live = false
      const received: string[] = []
      const frame = (output: string, start = 0): State => ({ id: 't', generation: 'g', status: 'running', output, start, cursor: start + output.length })
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { copilotDesktop: {
        onToolTerminalOutput: (fn: typeof push) => { push = fn; return () => {} },
        toolTerminal: async () => {
          if (first) { first = false; if (holdFirst) return new Promise(resolve => { finishFirst = resolve }) }
          return frame(live ? 'HISTORY\r\nLIVE\r\n' : 'HISTORY\r\n')
        },
      } } })
      const host = createMyTerminalHost('p', 't', () => {}, message => assert.fail(message))
      try {
        host.api.ssh.onData((_id: string, value: string) => received.push(value)); host.start()
        await new Promise(resolve => setTimeout(resolve, 10))
        live = true; push('p', frame('LIVE\r\n', 9))
        host.onTerminal({} as import('@xterm/xterm').Terminal)
        if (holdFirst) finishFirst(frame('HISTORY\r\n'))
        await new Promise(resolve => setTimeout(resolve, 300))
        assert.equal(received.join(''), 'HISTORY\r\nLIVE\r\n')
      } finally { host.stop() }
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})

test('parent and split replay need no quiet interval and reject an obsolete transport baseline', async () => {
  const bundle = await build({ entryPoints: ['src/renderer/myterminal-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { createMyTerminalHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`) as typeof import('../renderer/myterminal-host.js')
  const previous = globalThis.window
  type State = import('./tool-terminal.js').TerminalSnapshot
  const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
  try {
    for (const channel of ['parent', 'child']) for (const obsolete of [false, true]) {
      let push!: (profile: string, state: State) => void, finish!: (state: State) => void
      let baselineRequested!: () => void
      const requested = new Promise<void>(resolve => { baselineRequested = resolve })
      let first = true, live = false
      const received: string[] = []
      const frame = (id: string, output: string, generation = 'g', start = 0): State => ({ id, generation, status: 'running', output, start, cursor: start + output.length, splitId: 'child' })
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { copilotDesktop: {
        onToolTerminalOutput: (fn: typeof push) => { push = fn; return () => {} },
        toolTerminal: async (_profile: string, request: { id: string; cursor?: number }) => {
          if (request.id === channel && request.cursor !== undefined && first) {
            first = false; baselineRequested(); return new Promise(resolve => { finish = resolve })
          }
          return frame(request.id, live ? (obsolete ? 'NEW' : 'HISTORYLIVE') : 'HISTORY', obsolete && live ? 'new' : 'g')
        },
      } } })
      const host = createMyTerminalHost('p', 'parent', () => {}, message => assert.fail(message))
      try {
        host.onTerminal({} as import('@xterm/xterm').Terminal)
        host.api.ssh.onData((id: string, value: string) => { if (id === channel) received.push(value) })
        if (channel === 'child') await host.api.ssh.connect('child')
        host.start(); await requested
        live = true
        push('p', obsolete ? frame(channel, 'NEW', 'new') : frame(channel, 'LIVE', 'g', 7))
        finish(frame(channel, 'HISTORY'))
        await tick(); await tick()
        if (obsolete) {
          assert.equal(received.join(''), '', 'an obsolete baseline cannot switch back from queued new transport output')
          await new Promise(resolve => setTimeout(resolve, 250))
          assert.equal(received.join(''), 'NEW')
        } else {
          assert.equal(received.join(''), 'HISTORYLIVE', 'same-generation output must render immediately despite a concurrent push')
          push('p', frame(channel, 'MORE', 'g', 11))
          assert.equal(received.join(''), 'HISTORYLIVEMORE', 'subsequent chunks stream without a polling pause')
        }
      } finally { host.stop() }
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previous })
  }
})
