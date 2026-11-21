import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireControllerLock, claimControllerLock, constantTimeTokenEqual, getCliPaths, readDaemonState } from './runtime-state.js'
import { REUSED_PID_MARGIN_MS, readProcessStartTime, recordHolderAlive } from './process-identity.js'

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

test('a lock or state whose process id now belongs to a newer process is stale; an unknown or older start is not', async () => {
  const written = '2026-01-01T00:00:00.000Z'
  const at = Date.parse(written)
  const started = (time: number | null) => async (): Promise<number | null> => time
  // This test's own process stands in for "some process that has the id now".
  assert.equal(await recordHolderAlive(process.pid, written, started(at - 5_000)), true, 'started before the record: it can be the writer')
  assert.equal(await recordHolderAlive(process.pid, written, started(at + REUSED_PID_MARGIN_MS)), true, 'within the margin')
  assert.equal(await recordHolderAlive(process.pid, written, started(at + REUSED_PID_MARGIN_MS + 1)), false, 'started after the record: another program')
  assert.equal(await recordHolderAlive(process.pid, written, started(null)), true, 'no answer proves nothing')
  assert.equal(await recordHolderAlive(process.pid, written, async () => { throw new Error('no') }), true)
  assert.equal(await recordHolderAlive(process.pid, 'not a date', started(at + 10 * REUSED_PID_MARGIN_MS)), true)
  assert.equal(await recordHolderAlive(2_147_483_647, written, started(at - 5_000)), false, 'no such process')
})

test('this platform can say when a process started', async () => {
  const started = await readProcessStartTime(process.pid)
  assert.ok(started !== null, 'the start time of this process')
  assert.ok(Math.abs(Date.now() - process.uptime() * 1000 - started!) < 5_000, `about when this process started (${started})`)
  assert.equal(await readProcessStartTime(2_147_483_647), null)
})

test('a lock left by a controller that is gone is recovered even when another program has its process id', async () => {
  await withTempCliHome(async (paths) => {
    const stale = { version: 1, pid: process.pid, token: 'stale-token-that-is-at-least-thirty-two-characters', createdAt: '2020-01-01T00:00:00.000Z' }
    await writeFile(paths.lockPath, JSON.stringify(stale))
    // The real reader: this process started long after 2020, so it cannot be the lock's writer.
    const token = await acquireControllerLock(paths)
    assert.equal(token.length, 48)
    // A lock whose holder started before it was written is still held.
    await assert.rejects(() => acquireControllerLock(paths), /controller operation is active/)
    // And one that only looks old is kept while the start time cannot be read.
    await writeFile(paths.lockPath, JSON.stringify(stale))
    await assert.rejects(() => acquireControllerLock(paths, async () => null), /controller operation is active/)
  })
})

test('claiming the startup lock stamps it with the claimant\'s own time', async () => {
  await withTempCliHome(async (paths) => {
    await writeFile(paths.lockPath, JSON.stringify({ version: 1, pid: 1, token: 'claim-token-that-is-at-least-thirty-two-characters', createdAt: '2020-01-01T00:00:00.000Z' }))
    const before = Date.now()
    await claimControllerLock(paths, 'claim-token-that-is-at-least-thirty-two-characters')
    const claimed = JSON.parse(await readFile(paths.lockPath, 'utf8')) as { pid: number; createdAt: string }
    assert.equal(claimed.pid, process.pid)
    assert.ok(Date.parse(claimed.createdAt) >= before - 1_000)
  })
})

test('the start time is asked of the system\'s own program, not one of that name in the current folder', { skip: process.platform === 'win32' ? false : 'the current folder is searched first only on Windows' }, async () => {
  // A program named powershell.exe in the folder the command is run from, as a repository could plant one. It is Node
  // here, which does not understand the arguments and prints no date.
  const planted = await mkdtemp(join(tmpdir(), 'copilot-desktop-planted-'))
  const before = process.cwd()
  try {
    await copyFile(process.execPath, join(planted, 'powershell.exe'))
    process.chdir(planted)
    const started = await readProcessStartTime(process.pid)
    assert.ok(started !== null && Math.abs(Date.now() - process.uptime() * 1000 - started) < 5_000, `the real start time, not the planted program's answer (${started})`)
  } finally {
    process.chdir(before)
    await rm(planted, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
