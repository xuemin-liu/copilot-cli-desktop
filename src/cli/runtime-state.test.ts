import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireControllerLock, constantTimeTokenEqual, getCliPaths, readDaemonState } from './runtime-state.js'

async function withTempCliHome(run: (paths: ReturnType<typeof getCliPaths>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-desktop-cli-state-'))
  try {
    await run(getCliPaths({ COPILOT_DESKTOP_CLI_HOME: dir } as NodeJS.ProcessEnv))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('readDaemonState returns null (not a throw) with no state file', async () => {
  await withTempCliHome(async (paths) => {
    assert.equal(await readDaemonState(paths), null)
  })
})

test('readDaemonState quarantines and returns null for syntactically invalid JSON', async () => {
  await withTempCliHome(async (paths) => {
    await writeFile(paths.statePath, '{ not valid json', 'utf8')
    const state = await readDaemonState(paths)
    assert.equal(state, null)
    await assert.rejects(() => readFile(paths.statePath, 'utf8'), /ENOENT/)
    const entries = await readdir(paths.root)
    assert.ok(entries.some((name) => name.startsWith('state.json.corrupt-')))
  })
})

test('readDaemonState quarantines and returns null for a structurally invalid document', async () => {
  await withTempCliHome(async (paths) => {
    await writeFile(paths.statePath, JSON.stringify({ version: 1, pid: 'not-a-number' }), 'utf8')
    const state = await readDaemonState(paths)
    assert.equal(state, null)
    await assert.rejects(() => readFile(paths.statePath, 'utf8'), /ENOENT/)
  })
})

test('readDaemonState upgrades legacy state files without a warning field', async () => {
  await withTempCliHome(async (paths) => {
    await writeFile(paths.statePath, JSON.stringify({
      version: 1,
      pid: 123,
      controlPort: 3210,
      token: 'test-token',
      workspace: 'D:\\work\\project',
      processId: null,
      status: 'running',
      startedAt: '2026-08-25T00:00:00.000Z',
      error: null,
    }), 'utf8')
    const state = await readDaemonState(paths)
    assert.equal(state?.warning, null)
  })
})

test('constantTimeTokenEqual compares fixed-length controller capabilities', () => {
  assert.equal(constantTimeTokenEqual('a'.repeat(48), 'a'.repeat(48)), true)
  assert.equal(constantTimeTokenEqual('a'.repeat(48), 'b'.repeat(48)), false)
  assert.equal(constantTimeTokenEqual('short', 'different-length'), false)
})

test('acquireControllerLock never removes a newly-created partial lock', async () => {
  await withTempCliHome(async (paths) => {
    await writeFile(paths.lockPath, '')
    await assert.rejects(() => acquireControllerLock(paths), /still being created/)
    assert.equal(await readFile(paths.lockPath, 'utf8'), '')
  })
})

test('acquireControllerLock recovers an old invalid lock', async () => {
  await withTempCliHome(async (paths) => {
    await writeFile(paths.lockPath, 'invalid')
    const old = new Date(Date.now() - 60_000)
    await utimes(paths.lockPath, old, old)
    const token = await acquireControllerLock(paths)
    assert.equal(token.length, 48)
  })
})

test('concurrent stale-lock recovery admits exactly one controller owner', async () => {
  await withTempCliHome(async (paths) => {
    await writeFile(paths.lockPath, JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token: 'stale-token-that-is-at-least-thirty-two-characters',
      createdAt: '2020-01-01T00:00:00.000Z',
    }))
    const results = await Promise.allSettled([
      acquireControllerLock(paths),
      acquireControllerLock(paths),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    assert.match(String(rejected?.reason), /controller operation is active/)
  })
})

test('a stale recovery mutex left by an abrupt exit is reclaimed', async () => {
  await withTempCliHome(async (paths) => {
    await writeFile(paths.lockPath, 'invalid')
    const old = new Date(Date.now() - 60_000)
    await utimes(paths.lockPath, old, old)
    const recoveryPath = `${paths.lockPath}.recovery`
    await mkdir(recoveryPath)
    await utimes(recoveryPath, old, old)
    const token = await acquireControllerLock(paths)
    assert.equal(token.length, 48)
  })
})
