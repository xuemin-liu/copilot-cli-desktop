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
    stage: record('stage'), unstage: record('unstage'), commit: record('commit'), cancel: record('cancel'),
    fetch: record('fetch'), pull: record('pull'), push: record('push'),
    getBranches: record('getBranches'), createBranch: record('createBranch'), switchBranch: record('switchBranch'),
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
    'desktop:git-branch', 'desktop:git-branches', 'desktop:git-cancel', 'desktop:git-close', 'desktop:git-commit', 'desktop:git-diff', 'desktop:git-log', 'desktop:git-open', 'desktop:git-rescan',
    'desktop:git-stage', 'desktop:git-status', 'desktop:git-sync', 'desktop:git-trust', 'desktop:git-unstage',
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

test('stage and unstage take a bounded list of valid file ids and the file list version they were made from', () => {
  const { call, sender, calls } = setup()
  call('desktop:git-stage', sender(), PROFILE, 'repo-3', ['e4-0', 'e4-12'], 4)
  call('desktop:git-unstage', sender(), PROFILE, 'repo-3', ['e4-1'], 4)
  assert.deepEqual(calls, [['stage', 1, PROFILE, 'repo-3', ['e4-0', 'e4-12'], 4], ['unstage', 1, PROFILE, 'repo-3', ['e4-1'], 4]])
  calls.length = 0
  for (const channel of ['desktop:git-stage', 'desktop:git-unstage']) {
    for (const bad of [[], 'e1-0', null, ['e1-0', 5], ['..\\x'], ['e1-0; calc'], ['e1'], Array.from({ length: 5_001 }, (_item, index) => `e1-${index}`)]) {
      assert.throws(() => call(channel, sender(), PROFILE, 'repo-1', bad, 1), /Invalid file/, `${channel} ${JSON.stringify(bad)?.slice(0, 40)}`)
    }
    for (const bad of [-1, 1.5, '1', null, 1_000_000_001, NaN]) {
      assert.throws(() => call(channel, sender(), PROFILE, 'repo-1', ['e1-0'], bad), /Invalid file list version/, String(bad))
    }
    assert.throws(() => call(channel, sender(), 'nope', 'repo-1', ['e1-0'], 1), /Invalid workspace/)
    assert.throws(() => call(channel, sender(), PROFILE, 'repo-0', ['e1-0'], 1), /Invalid repository/)
  }
  assert.equal(calls.length, 0, 'nothing reached the service')
})

test('commit validates the message, the version and the hooks approval before the service sees them', () => {
  const { call, sender, calls } = setup()
  call('desktop:git-commit', sender(), PROFILE, 'repo-1', 'feat: a thing', 3, null)
  call('desktop:git-commit', sender(), PROFILE, 'repo-1', 'feat: a thing', 3, 'a'.repeat(64))
  assert.deepEqual(calls.map(entry => entry.slice(4)), [['feat: a thing', 3, null], ['feat: a thing', 3, 'a'.repeat(64)]])
  calls.length = 0
  for (const bad of ['', '   \n', 'a\0b', 'x'.repeat(100_001), 5, null, undefined]) {
    assert.throws(() => call('desktop:git-commit', sender(), PROFILE, 'repo-1', bad, 3, null), /Invalid commit message/, JSON.stringify(bad)?.slice(0, 30))
  }
  for (const bad of ['', 'abc', 'G'.repeat(64), 5, undefined]) {
    assert.throws(() => call('desktop:git-commit', sender(), PROFILE, 'repo-1', 'ok', 3, bad), /Invalid hooks approval/, JSON.stringify(bad))
  }
  assert.throws(() => call('desktop:git-commit', sender(), PROFILE, 'repo-1', 'ok', -2, null), /Invalid file list version/)
  assert.equal(calls.length, 0)
})

test('cancel takes only a workspace and a repository, and the write channels are main-window only', () => {
  const { call, sender, calls, handlers } = setup({ mainWindowId: 1 })
  call('desktop:git-cancel', sender(), PROFILE, 'repo-2')
  assert.deepEqual(calls, [['cancel', 1, PROFILE, 'repo-2']])
  assert.throws(() => call('desktop:git-cancel', sender(), PROFILE, 'repo-0'), /Invalid repository/)
  for (const channel of ['desktop:git-stage', 'desktop:git-unstage', 'desktop:git-commit', 'desktop:git-cancel', 'desktop:git-sync', 'desktop:git-branch']) {
    assert.ok(handlers.has(channel), channel)
    assert.throws(() => call(channel, sender(2), PROFILE, 'repo-1', ['e1-0'], 1, null), /main window/, channel)
  }
})

const OID = 'a'.repeat(40)
const SEEN = { branch: 'main', headOid: OID }

test('sync accepts only the three operations, a remote only for a push, and the branch a pull or push was asked for', () => {
  const { call, sender, calls } = setup()
  call('desktop:git-sync', sender(), PROFILE, 'repo-1', 'fetch', null, null)
  call('desktop:git-sync', sender(), PROFILE, 'repo-1', 'pull', null, SEEN)
  call('desktop:git-sync', sender(), PROFILE, 'repo-1', 'push', null, SEEN)
  call('desktop:git-sync', sender(), PROFILE, 'repo-1', 'push', 'origin', { branch: 'feature/x', headOid: 'b'.repeat(64) })
  assert.deepEqual(calls, [['fetch', 1, PROFILE, 'repo-1'], ['pull', 1, PROFILE, 'repo-1', SEEN], ['push', 1, PROFILE, 'repo-1', null, SEEN], ['push', 1, PROFILE, 'repo-1', 'origin', { branch: 'feature/x', headOid: 'b'.repeat(64) }]])
  calls.length = 0
  for (const bad of ['force-push', 'clone', '', 5, null, undefined]) {
    assert.throws(() => call('desktop:git-sync', sender(), PROFILE, 'repo-1', bad, null, SEEN), /Invalid operation/, String(bad))
  }
  for (const bad of ['', '-oProxyCommand=x', 'a\0b', 'a\nb', 'x'.repeat(201), 5, undefined]) {
    assert.throws(() => call('desktop:git-sync', sender(), PROFILE, 'repo-1', 'push', bad, SEEN), /Invalid remote/, String(bad))
  }
  assert.throws(() => call('desktop:git-sync', sender(), PROFILE, 'repo-1', 'fetch', 'origin', null), /Only a push takes a remote/)
  assert.throws(() => call('desktop:git-sync', sender(), PROFILE, 'repo-0', 'fetch', null, null), /Invalid repository/)
  // A pull or push must say which branch and commit it was asked for; a fetch must not.
  for (const operation of ['pull', 'push']) {
    for (const bad of [undefined, null, 'main', [], {}, { branch: 'main' }, { headOid: OID }, { branch: '', headOid: OID }, { branch: 'a\nb', headOid: OID }, { branch: 'x'.repeat(256), headOid: OID },
      { branch: 'main', headOid: 'zz' }, { branch: 'main', headOid: 'A'.repeat(40) }, { branch: 'main', headOid: 'a'.repeat(39) }, { branch: 5, headOid: OID }]) {
      assert.throws(() => call('desktop:git-sync', sender(), PROFILE, 'repo-1', operation, null, bad), /Invalid (branch|commit)/, `${operation} ${JSON.stringify(bad)}`)
    }
  }
  assert.throws(() => call('desktop:git-sync', sender(), PROFILE, 'repo-1', 'fetch', null, SEEN), /not tied to a branch/)
  assert.equal(calls.length, 0, 'nothing reached the service')
})

test('branch changes carry the branch name and the head the person saw, and nothing else gets through', () => {
  const { call, sender, calls } = setup()
  const seen = { branch: 'main', headOid: OID }
  call('desktop:git-branches', sender(), PROFILE, 'repo-1')
  call('desktop:git-branch', sender(), PROFILE, 'repo-1', 'create', 'feature/x', seen)
  call('desktop:git-branch', sender(), PROFILE, 'repo-1', 'switch', 'other', { branch: null, headOid: 'b'.repeat(64) })
  assert.deepEqual(calls, [['getBranches', 1, PROFILE, 'repo-1'], ['createBranch', 1, PROFILE, 'repo-1', 'feature/x', seen], ['switchBranch', 1, PROFILE, 'repo-1', 'other', { branch: null, headOid: 'b'.repeat(64) }]])
  calls.length = 0
  for (const bad of ['delete', 'force', '', 5, null, undefined]) assert.throws(() => call('desktop:git-branch', sender(), PROFILE, 'repo-1', bad, 'x', seen), /Invalid operation/, String(bad))
  for (const bad of ['', '-f', '--force', 'a\0b', 'a\nb', 'x'.repeat(256), 5, null, undefined]) {
    assert.throws(() => call('desktop:git-branch', sender(), PROFILE, 'repo-1', 'switch', bad, seen), /Invalid branch name/, String(bad))
  }
  for (const bad of [undefined, null, 'main', [], {}, { branch: 'main' }, { headOid: OID }, { branch: '', headOid: OID }, { branch: 5, headOid: OID }, { branch: 'main', headOid: 'zz' }, { branch: 'main', headOid: 'A'.repeat(40) }]) {
    assert.throws(() => call('desktop:git-branch', sender(), PROFILE, 'repo-1', 'switch', 'x', bad), /Invalid (branch|commit)/, JSON.stringify(bad))
  }
  assert.throws(() => call('desktop:git-branches', sender(), PROFILE, 'repo-0'), /Invalid repository/)
  assert.equal(calls.length, 0, 'nothing reached the service')
})
