import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { shareDevtoolsSettings } from './browser-devtools-settings.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const prefsFile = (root: string, id: string): string => join(root, 'Partitions', `browser-debug%3A${id}`, 'Preferences')

async function writePrefs(root: string, id: string, prefs: unknown, seconds: number): Promise<void> {
  const file = prefsFile(root, id)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(prefs))
  await utimes(file, seconds, seconds)
}
const readPrefs = async (root: string, id: string): Promise<any> => JSON.parse(await readFile(prefsFile(root, id), 'utf8'))

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'devtools-settings-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('a new session browser starts with Local Overrides enabled and the DevTools settings another session saved', () => fixture(async root => {
  await writePrefs(root, A, {
    spellcheck: { dictionaries: ['en-US'] },
    electron: { devtools: { preferences: { 'persistence-network-overrides-enabled': 'true', 'console-history': '["token"]' } } },
  }, 1000)
  shareDevtoolsSettings(root, B)
  const seeded = await readPrefs(root, B)
  // Console history is shared too, as in one Chrome profile; preferences outside DevTools are not.
  assert.deepEqual(seeded.electron.devtools.preferences, { 'persistence-network-overrides-enabled': 'true', 'console-history': '["token"]' })
  assert.equal(seeded.spellcheck, undefined)
}))

test('a restored session keeps its unrelated preferences and its own DevTools changes while taking shared ones', () => fixture(async root => {
  await writePrefs(root, A, { electron: { devtools: { preferences: { theme: '"dark"' } } } }, 1000)
  await writePrefs(root, B, { spellcheck: { dictionaries: ['fr'] }, electron: { devtools: { preferences: { 'console-history': '["x"]' } } } }, 500)
  shareDevtoolsSettings(root, B)
  const prefs = await readPrefs(root, B)
  assert.deepEqual(prefs.spellcheck, { dictionaries: ['fr'] })
  assert.deepEqual(prefs.electron.devtools.preferences, { 'console-history': '["x"]', theme: '"dark"' })
}))

test('a stale session cannot undo a newer change, and a setting removed in one session is removed everywhere', () => fixture(async root => {
  const overrides = { electron: { devtools: { preferences: { theme: '"light"', 'persistence-network-overrides-enabled': 'true' } } } }
  await writePrefs(root, A, overrides, 1000)
  shareDevtoolsSettings(root, B)
  shareDevtoolsSettings(root, C)
  // B changes the theme; A is saved again later for an unrelated reason with its old theme.
  const changed = await readPrefs(root, B)
  changed.electron.devtools.preferences.theme = '"dark"'
  await writePrefs(root, B, changed, 2000)
  await writePrefs(root, A, { ...overrides, spellcheck: {} }, 3000)
  shareDevtoolsSettings(root)
  // C turns Local Overrides off, and its saved settings no longer list it.
  const removed = await readPrefs(root, C)
  delete removed.electron.devtools.preferences['persistence-network-overrides-enabled']
  await writePrefs(root, C, removed, 4000)
  await rm(join(root, 'Partitions', `browser-debug%3A${A}`), { recursive: true })
  const D = '44444444-4444-4444-8444-444444444444'
  shareDevtoolsSettings(root, D)
  const seeded = await readPrefs(root, D)
  assert.deepEqual(seeded.electron.devtools.preferences, { theme: '"dark"' })
  const store = JSON.parse(await readFile(join(root, 'browser-devtools.json'), 'utf8'))
  assert.deepEqual(Object.keys(store.seen).sort(), [B, C, D])
}))

test('an unreadable Chromium preferences file is left untouched', () => fixture(async root => {
  await mkdir(join(prefsFile(root, A), '..'), { recursive: true })
  await writeFile(prefsFile(root, A), '{not json')
  assert.throws(() => shareDevtoolsSettings(root, A))
  assert.equal(await readFile(prefsFile(root, A), 'utf8'), '{not json')
  assert.throws(() => shareDevtoolsSettings(root, '../x'), /Invalid browser profile/)
}))

test('a session with its own DevTools settings starts with defaults and its changes never reach the shared ones', () => fixture(async root => {
  const overridesOn = { electron: { devtools: { preferences: { 'persistence-network-overrides-enabled': 'true' } } } }
  await writePrefs(root, A, overridesOn, 1000)
  shareDevtoolsSettings(root, B, { private: true })
  await assert.rejects(readPrefs(root, B), 'nothing is seeded into a private partition')
  // It turns Local Overrides off and changes the theme; a session opened later still gets the shared settings.
  await writePrefs(root, B, { electron: { devtools: { preferences: { theme: '"light"' } } } }, 2000)
  shareDevtoolsSettings(root, C)
  assert.deepEqual((await readPrefs(root, C)).electron.devtools.preferences, overridesOn.electron.devtools.preferences)
  // Also after it closes: startup still finds its partition, and it stays out until the partition is gone.
  shareDevtoolsSettings(root)
  const store = JSON.parse(await readFile(join(root, 'browser-devtools.json'), 'utf8'))
  assert.deepEqual(store.private, [B])
  assert.deepEqual(store.values, overridesOn.electron.devtools.preferences)
  assert.throws(() => shareDevtoolsSettings(root, B), /keeps its DevTools settings to itself/)
  await rm(join(root, 'Partitions', `browser-debug%3A${B}`), { recursive: true })
  shareDevtoolsSettings(root)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'browser-devtools.json'), 'utf8')).private, [], 'forgotten once its partition is gone')
}))

test('a profile marked private before its partition exists stays private while sessions open', () => fixture(async root => {
  shareDevtoolsSettings(root, B, { private: true })
  // Another session opens before B's browser has created its partition.
  shareDevtoolsSettings(root, C)
  await writePrefs(root, B, { electron: { devtools: { preferences: { theme: '"light"' } } } }, 2000)
  shareDevtoolsSettings(root, A)
  assert.deepEqual((await readPrefs(root, A)).electron.devtools.preferences, {}, 'B\'s theme did not leak')
}))
