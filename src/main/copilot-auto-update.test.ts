import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  effectiveCopilotAutoUpdate,
  isCopilotUpdateChannel,
  readCopilotAutoUpdate,
  writeCopilotAutoUpdate,
} from './copilot-auto-update.js'

async function withTempSettings(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-auto-update-'))
  try {
    await run(join(directory, 'nested', 'settings.json'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('Copilot auto-update defaults to enabled on the stable channel', () => {
  assert.deepEqual(effectiveCopilotAutoUpdate({}), { enabled: true, channel: 'stable', error: null })
  assert.equal(isCopilotUpdateChannel('stable'), true)
  assert.equal(isCopilotUpdateChannel('prerelease'), true)
  assert.equal(isCopilotUpdateChannel('nightly'), false)
})

test('writeCopilotAutoUpdate preserves unknown and nested settings', async () => {
  await withTempSettings(async (path) => {
    await writeCopilotAutoUpdate(path, true, 'stable')
    const initial = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    initial.futureSetting = { keep: true }
    await writeFile(path, JSON.stringify(initial), 'utf8')

    await writeCopilotAutoUpdate(path, false, 'prerelease')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      autoUpdate: false,
      autoUpdatesChannel: 'prerelease',
      futureSetting: { keep: true },
    })
    assert.deepEqual(await readCopilotAutoUpdate(path), {
      enabled: false,
      channel: 'prerelease',
      error: null,
    })
  })
})

test('a malformed settings document is reported and never overwritten', async () => {
  await withTempSettings(async (path) => {
    await writeCopilotAutoUpdate(path, true, 'stable')
    await writeFile(path, '{broken', 'utf8')
    assert.match((await readCopilotAutoUpdate(path)).error ?? '', /JSON/)
    await assert.rejects(() => writeCopilotAutoUpdate(path, false, 'stable'), /JSON/)
    assert.equal(await readFile(path, 'utf8'), '{broken')
  })
})
