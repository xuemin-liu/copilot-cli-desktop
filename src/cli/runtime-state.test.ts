import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getCliPaths, readDaemonState } from './runtime-state.js'

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
