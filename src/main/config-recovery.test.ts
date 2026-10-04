import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pruneBrowserProfiles } from './browser-cleanup.js'
import { activeConfigRecovery, preserveUnreadableFile, resolveConfigRecovery } from './config-recovery.js'
import { readDesktopConfig, writeDesktopConfig } from './desktop-config.js'

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-recovery-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const failing = async (): Promise<never> => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }) }
const lockedRename = failing as unknown as typeof rename
const lockedCopy = failing as unknown as typeof copyFile

test('preserveUnreadableFile moves the file aside when rename works', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    await writeFile(file, '{ bad')
    const preserved = await preserveUnreadableFile(file)
    assert.ok(preserved)
    assert.equal(await readFile(preserved, 'utf8'), '{ bad')
    await assert.rejects(() => stat(file))
  })
})

test('preserveUnreadableFile falls back to a verified copy when rename is locked', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    await writeFile(file, '{ bad')
    const preserved = await preserveUnreadableFile(file, { rename: lockedRename, copyFile })
    assert.ok(preserved)
    assert.equal(await readFile(preserved, 'utf8'), '{ bad')
    assert.equal(await readFile(file, 'utf8'), '{ bad')
  })
})

test('preserveUnreadableFile returns null and leaves no partial backup when nothing can be preserved', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    await writeFile(file, '{ bad')
    assert.equal(await preserveUnreadableFile(file, { rename: lockedRename, copyFile: lockedCopy }), null)
    assert.deepEqual(await readdir(dir), ['desktop.json'])
  })
})

test('an unpreservable unreadable config blocks writes instead of being replaced', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    await writeFile(file, '{ bad')
    const outcome = await resolveConfigRecovery(file, join(dir, 'config-recovery.json'), true, {
      rename: lockedRename,
      copyFile: lockedCopy,
    })
    assert.deepEqual(outcome, { hold: null, writesBlocked: true, newlyPreserved: false })
    assert.equal(await readFile(file, 'utf8'), '{ bad')
  })
})

test('browser profiles survive a second startup until the preserved config is restored or deleted', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    const marker = join(dir, 'config-recovery.json')
    const profile = join(dir, 'browser-profiles', '3f6d2c1e-8a4b-4c5d-9e7f-1a2b3c4d5e6f')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'Cookies'), 'cookie-data')
    await writeFile(file, '{ "profiles": [')

    // Startup 1: the unreadable config is preserved, defaults are persisted, pruning is held.
    let unparseable = false
    let config = await readDesktopConfig(file, undefined, () => { unparseable = true })
    const first = await resolveConfigRecovery(file, marker, unparseable)
    assert.equal(first.newlyPreserved, true)
    assert.ok(first.hold)
    await writeDesktopConfig(file, config)

    // Startup 2: the replacement config is valid and empty, but the hold still protects browser data.
    unparseable = false
    config = await readDesktopConfig(file, undefined, () => { unparseable = true })
    assert.equal(unparseable, false)
    const second = await resolveConfigRecovery(file, marker, unparseable)
    assert.equal(second.hold, first.hold)
    if (!second.hold) await pruneBrowserProfiles(dir, [])
    assert.equal(await readFile(join(profile, 'Cookies'), 'utf8'), 'cookie-data')

    // Deleting the preserved file is the explicit discard: the hold is released and pruning resumes.
    await rm(first.hold!)
    const third = await resolveConfigRecovery(file, marker, false)
    assert.equal(third.hold, null)
    await assert.rejects(() => stat(marker))
    await pruneBrowserProfiles(dir, [])
    await assert.rejects(() => stat(profile))
  })
})

test('an unreadable recovery marker is treated as an active hold', async () => {
  await withDir(async (dir) => {
    const marker = join(dir, 'config-recovery.json')
    await writeFile(marker, 'not json')
    assert.equal(await activeConfigRecovery(marker), marker)
  })
})

test('a failed marker write leaves the unreadable config untouched and blocks writes', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    const marker = join(dir, 'config-recovery.json')
    await writeFile(file, '{ bad')
    // A directory at the marker path makes the atomic marker write fail.
    await mkdir(marker)
    const outcome = await resolveConfigRecovery(file, marker, true)
    assert.deepEqual(outcome, { hold: null, writesBlocked: true, newlyPreserved: false })
    assert.equal(await readFile(file, 'utf8'), '{ bad')
    assert.deepEqual((await readdir(dir)).sort(), ['config-recovery.json', 'desktop.json'])
  })
})

test('the hold is published before the original moves, so a later launch still finds the backup', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    const marker = join(dir, 'config-recovery.json')
    await writeFile(file, '{ bad')
    const first = await resolveConfigRecovery(file, marker, true)
    assert.ok(first.hold)
    // Simulate the next launch: desktop.json is gone, so defaults read as valid; the marker must still hold.
    await assert.rejects(() => stat(file))
    assert.equal((await resolveConfigRecovery(file, marker, false)).hold, first.hold)
  })
})

test('a preserve failure after the marker write removes the marker and leaves the original', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    const marker = join(dir, 'config-recovery.json')
    await writeFile(file, '{ bad')
    const outcome = await resolveConfigRecovery(file, marker, true, { rename: lockedRename, copyFile: lockedCopy })
    assert.equal(outcome.writesBlocked, true)
    assert.equal(await readFile(file, 'utf8'), '{ bad')
    await assert.rejects(() => stat(marker))
  })
})

test('a non-ENOENT stat error keeps the hold and the marker', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'desktop.json')
    const marker = join(dir, 'config-recovery.json')
    await writeFile(file, '{ bad')
    const first = await resolveConfigRecovery(file, marker, true)
    const denied = (async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }) as unknown as typeof stat
    const held = await resolveConfigRecovery(file, marker, false, { stat: denied })
    assert.equal(held.hold, first.hold)
    assert.ok(await readFile(marker, 'utf8'))
    // A confirmed missing backup still releases it.
    await rm(first.hold!)
    assert.equal((await resolveConfigRecovery(file, marker, false)).hold, null)
    await assert.rejects(() => stat(marker))
  })
})
