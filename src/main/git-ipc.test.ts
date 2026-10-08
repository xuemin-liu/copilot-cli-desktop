import assert from 'node:assert/strict'
import test from 'node:test'
import { registerGitIpc } from './git-ipc.js'
import type { GitIpcEvent } from './git-ipc.js'
import type { GitService } from './git-service.js'

type Handler = (event: GitIpcEvent, ...args: unknown[]) => unknown

function setup(options: { mainWindowId?: number; service?: boolean; untrusted?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const calls: Array<[string, ...unknown[]]> = []
  const record = (name: string) => (...args: unknown[]): unknown => { calls.push([name, ...args]); return { name } }
  const fake = {
    subscribe: record('subscribe'), unsubscribe: record('unsubscribe'), unsubscribeAll: record('unsubscribeAll'), rescan: record('rescan'),
    trust: record('trust'), getStatus: record('getStatus'), getDiff: record('getDiff'), getLog: record('getLog'),
  }
  let service: GitService | null = options.service === false ? null : fake as unknown as GitService
  registerGitIpc({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener as unknown as Handler) } },
    service: () => service,
    assertTrustedSender: () => { if (options.untrusted) throw new Error('untrusted') },
    isMainWindowSender: event => event.sender.id === (options.mainWindowId ?? 1),
  })
  const listeners = new Map<string, Array<() => void>>()
  const sender = (id = 1): GitIpcEvent => ({ sender: { id, on: (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]) } } })
  const call = (channel: string, event: GitIpcEvent, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel)
    assert.ok(handler, `no handler for ${channel}`)
    return handler(event, ...args)
  }
  return { handlers, calls, call, sender, listeners, endService: () => { service = null } }
}

const PROFILE = '0123456789abcdef'

test('every channel is registered', () => {
  const { handlers } = setup()
  assert.deepEqual([...handlers.keys()].sort(), [
    'desktop:git-close', 'desktop:git-diff', 'desktop:git-log', 'desktop:git-open', 'desktop:git-rescan', 'desktop:git-status', 'desktop:git-trust',
  ])
})

test('valid calls reach the service with the sender id', () => {
  const { call, sender, calls } = setup()
  call('desktop:git-open', sender(), PROFILE)
  call('desktop:git-close', sender(), PROFILE)
  call('desktop:git-rescan', sender(), PROFILE)
  call('desktop:git-status', sender(), PROFILE, 'repo-3')
  call('desktop:git-diff', sender(), PROFILE, 'repo-3', 'e12-4', true)
  call('desktop:git-log', sender(), PROFILE, 'repo-3', 20, 40)
  call('desktop:git-trust', sender(), PROFILE, 'repo-3', 'a'.repeat(64))
  assert.deepEqual(calls.map(entry => entry[0]), ['subscribe', 'unsubscribe', 'rescan', 'getStatus', 'getDiff', 'getLog', 'trust'])
  assert.deepEqual(calls[0], ['subscribe', 1, PROFILE])
  assert.deepEqual(calls[4], ['getDiff', 1, PROFILE, 'repo-3', 'e12-4', true])
})

test('arguments are validated before the service sees them', () => {
  const { call, sender, calls } = setup()
  for (const bad of ['', 'short', 'ZZZZZZZZZZZZZZZZ', '0123456789abcdef0', '../0123456789', 7, null, undefined, {}]) {
    assert.throws(() => call('desktop:git-open', sender(), bad), /Invalid workspace/, JSON.stringify(bad))
  }
  for (const bad of ['', 'repo-0', 'repo-', 'repo-1x', 'tab-1', '..\\repo-1', 'repo-1234567890', 3]) {
    assert.throws(() => call('desktop:git-status', sender(), PROFILE, bad), /Invalid repository/, JSON.stringify(bad))
  }
  for (const bad of ['', 'e1', 'e1-', 'x1-1', 'e1-1; rm', '../e1-1', 5]) {
    assert.throws(() => call('desktop:git-diff', sender(), PROFILE, 'repo-1', bad, false), /Invalid file/, JSON.stringify(bad))
  }
  assert.throws(() => call('desktop:git-diff', sender(), PROFILE, 'repo-1', 'e1-1', 'yes'), /Invalid diff side/)
  for (const bad of [0, 201, 1.5, -1, '10', NaN, Infinity]) {
    assert.throws(() => call('desktop:git-log', sender(), PROFILE, 'repo-1', bad, 0), /Invalid limit/, String(bad))
  }
  for (const bad of [-1, 100_001, 1.5, '0']) {
    assert.throws(() => call('desktop:git-log', sender(), PROFILE, 'repo-1', 10, bad), /Invalid offset/, String(bad))
  }
  for (const bad of ['', 'abc', 'G'.repeat(64), 'a'.repeat(63), 1]) {
    assert.throws(() => call('desktop:git-trust', sender(), PROFILE, 'repo-1', bad), /Invalid repository settings/, JSON.stringify(bad))
  }
  assert.equal(calls.length, 0)
})

test('only the main window may use the Git channels', () => {
  const { call, sender, calls, handlers } = setup({ mainWindowId: 1 })
  for (const channel of handlers.keys()) {
    assert.throws(() => call(channel, sender(2), PROFILE, 'repo-1', 'e1-1', false, 0), /main window/, channel)
  }
  assert.equal(calls.length, 0)
})

test('an untrusted frame, or migration in progress, is rejected first', () => {
  const { call, sender, calls } = setup({ untrusted: true })
  assert.throws(() => call('desktop:git-open', sender(), PROFILE), /untrusted/)
  assert.equal(calls.length, 0)
})

test('nothing runs once the service has been shut down', () => {
  const { call, sender, endService } = setup()
  endService()
  assert.throws(() => call('desktop:git-open', sender(), PROFILE), /closing/)
})

test('a reload, crash or close of the renderer releases its subscriptions, registered once', () => {
  const { call, sender, calls, listeners } = setup()
  const event = sender(1)
  call('desktop:git-open', event, PROFILE)
  call('desktop:git-open', event, PROFILE)
  assert.equal(listeners.get('did-start-loading')?.length, 1, 'listeners are attached once per renderer')
  for (const name of ['did-start-loading', 'render-process-gone', 'destroyed'] as const) {
    calls.length = 0
    listeners.get(name)?.[0]?.()
    assert.deepEqual(calls, [['unsubscribeAll', 1]], name)
  }
})
