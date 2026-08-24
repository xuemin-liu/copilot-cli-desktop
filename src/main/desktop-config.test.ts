import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_DESKTOP_CONFIG,
  MAX_PROFILES,
  activateWorkspaceProfile,
  activeWorkspaceProfile,
  readDesktopConfig,
  recordDesktopVersion,
  workspaceProfileId,
  writeDesktopConfig,
  type DesktopConfig,
} from './desktop-config.js'

async function withTempFile(run: (filename: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-desktop-config-'))
  try {
    await run(join(dir, 'desktop.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('readDesktopConfig returns defaults when the file does not exist', async () => {
  await withTempFile(async (filename) => {
    const config = await readDesktopConfig(filename);
    assert.deepEqual(config, DEFAULT_DESKTOP_CONFIG)
  })
})

test('activateWorkspaceProfile creates a profile on first use and reuses it afterward', () => {
  const config: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG, profiles: [] }
  const first = activateWorkspaceProfile(config, 'C:\\work\\project-a')
  assert.equal(first.permissionPreset, 'default')
  assert.equal(first.defaultResumeMode, 'auto-resume')
  assert.equal(config.activeProfileId, first.id)

  const second = activateWorkspaceProfile(config, 'C:\\work\\project-b')
  assert.equal(config.profiles.length, 2)
  assert.equal(config.profiles[0]?.id, second.id, 'most recently activated profile moves to the front')

  const reactivatedFirst = activateWorkspaceProfile(config, 'C:\\work\\project-a')
  assert.equal(reactivatedFirst.id, first.id)
  assert.equal(config.profiles.length, 2, 'reactivating an existing profile does not duplicate it')
})

test('activateWorkspaceProfile never evicts a profile with open session tabs', () => {
  const config: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG, profiles: [] }
  for (let index = 0; index < MAX_PROFILES; index += 1) {
    activateWorkspaceProfile(config, `C:\\work\\project-${index}`)
  }
  const protectedId = config.profiles.at(-1)?.id
  assert.ok(protectedId)
  const evictableId = config.profiles.at(-2)?.id
  activateWorkspaceProfile(config, 'C:\\work\\new-project', new Set([protectedId]))
  assert.equal(config.profiles.length, MAX_PROFILES)
  assert.ok(config.profiles.some((profile) => profile.id === protectedId))
  assert.ok(!config.profiles.some((profile) => profile.id === evictableId))
})

test('activateWorkspaceProfile refuses a new profile when every retained profile has open tabs', () => {
  const config: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG, profiles: [] }
  for (let index = 0; index < MAX_PROFILES; index += 1) {
    activateWorkspaceProfile(config, `C:\\work\\project-${index}`)
  }
  const protectedIds = new Set(config.profiles.map((profile) => profile.id))
  assert.throws(
    () => activateWorkspaceProfile(config, 'C:\\work\\overflow', protectedIds),
    /Close a workspace session/,
  )
  assert.equal(config.profiles.length, MAX_PROFILES)
})

test('workspaceProfileId is stable across path casing on the same normalized path', () => {
  assert.equal(
    workspaceProfileId('C:\\Work\\Project'),
    workspaceProfileId('c:\\work\\project'),
  )
})

test('activeWorkspaceProfile resolves the active id, or null when unset', () => {
  const config: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG, profiles: [] }
  assert.equal(activeWorkspaceProfile(config), null)
  const profile = activateWorkspaceProfile(config, 'C:\\work\\project')
  assert.equal(activeWorkspaceProfile(config)?.id, profile.id)
})

test('recordDesktopVersion tracks the previous version as a rollback target', () => {
  const config: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG }
  assert.equal(recordDesktopVersion(config, '0.1.0'), true)
  assert.equal(config.lastRunVersion, '0.1.0')
  assert.equal(config.rollbackVersion, null)
  assert.equal(recordDesktopVersion(config, '0.1.0'), false, 'no change when the version repeats')
  assert.equal(recordDesktopVersion(config, '0.2.0'), true)
  assert.equal(config.rollbackVersion, '0.1.0')
})

test('writeDesktopConfig then readDesktopConfig round-trips profiles and settings', async () => {
  await withTempFile(async (filename) => {
    const config: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG, profiles: [], notifications: false }
    activateWorkspaceProfile(config, 'C:\\work\\project')
    await writeDesktopConfig(filename, config)
    const roundTripped = await readDesktopConfig(filename)
    assert.equal(roundTripped.profiles.length, 1)
    assert.equal(roundTripped.profiles[0]?.path, resolve('C:\\work\\project'))
    assert.equal(roundTripped.notifications, false)
    assert.equal(roundTripped.activeProfileId, config.activeProfileId)
  })
})

test('readDesktopConfig tolerates a corrupt file by falling back to defaults', async () => {
  await withTempFile(async (filename) => {
    await writeDesktopConfig(filename, { ...DEFAULT_DESKTOP_CONFIG })
    const fs = await import('node:fs/promises')
    await fs.writeFile(filename, 'not json', 'utf8')
    const config = await readDesktopConfig(filename)
    assert.deepEqual(config, DEFAULT_DESKTOP_CONFIG)
  })
})
