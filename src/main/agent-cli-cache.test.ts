import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentCliResolution } from './agent-cli.js'
import { createOtherCliCache, OTHER_CLI_CACHE_MS } from './agent-cli-cache.js'
import type { OtherCli } from './session-cli.js'

function found(version: string | null): AgentCliResolution {
  return { cli: 'claude', command: 'C:\\bin\\claude.exe', prefixArgs: [], resolvedPath: 'C:\\bin\\claude.exe', version, error: version === null ? 'Not found' : null }
}

/** A CLI whose `--version` answers whatever `installed` holds now, counting each look. */
function fixture() {
  const state = { installed: '2.1.0' as string | null, looks: 0, clock: 0 }
  const lookup = createOtherCliCache(async (_cli: OtherCli) => { state.looks += 1; return found(state.installed) }, () => state.clock)
  return { state, lookup }
}

test('a routine look within a minute reuses the kept CLI', async () => {
  const { state, lookup } = fixture()
  assert.equal((await lookup('claude')).version, '2.1.0')
  state.installed = '2.1.5'
  state.clock = OTHER_CLI_CACHE_MS - 1
  assert.equal((await lookup('claude')).version, '2.1.0')
  assert.equal(state.looks, 1)
  state.clock = OTHER_CLI_CACHE_MS
  assert.equal((await lookup('claude')).version, '2.1.5')
})

test('a launch looks again when the CLI was replaced at the same path, and later looks see that version', async () => {
  const { state, lookup } = fixture()
  assert.equal((await lookup('claude')).version, '2.1.0')
  state.installed = '2.1.5' // updated in place: same command, new version
  const launched = await lookup('claude', true)
  assert.equal(launched.version, '2.1.5', 'the launch records the version it starts')
  assert.equal(launched.command, 'C:\\bin\\claude.exe')
  assert.equal((await lookup('claude')).version, '2.1.5', 'the fresh look replaces the kept one')
  assert.equal(state.looks, 2)
})

test('a downgrade is found the same way', async () => {
  const { state, lookup } = fixture()
  await lookup('claude')
  state.installed = '2.0.9' // moved from latest to stable
  assert.equal((await lookup('claude', true)).version, '2.0.9')
})

test('a failed look is never kept', async () => {
  const { state, lookup } = fixture()
  state.installed = null
  assert.equal((await lookup('claude')).version, null)
  await new Promise((settle) => setImmediate(settle))
  state.installed = '2.1.0'
  assert.equal((await lookup('claude')).version, '2.1.0')
  assert.equal(state.looks, 2)
})

test('each CLI is kept on its own', async () => {
  const { state, lookup } = fixture()
  await lookup('claude')
  await lookup('codex')
  assert.equal(state.looks, 2)
})

test('createOtherCliCache forwards fresh to the resolver', async () => {
  const seen: Array<{ cli: OtherCli; fresh: boolean }> = []
  const lookup = createOtherCliCache(async (cli, fresh) => {
    seen.push({ cli, fresh })
    return found(null)
  })
  await lookup('codex')
  await new Promise((settle) => setImmediate(settle))
  await lookup('codex', true)
  assert.deepEqual(seen, [
    { cli: 'codex', fresh: false },
    { cli: 'codex', fresh: true },
  ])
})
