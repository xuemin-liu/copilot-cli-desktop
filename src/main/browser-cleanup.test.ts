import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { browserProfileHasPartition, clearBrowserStorage, pruneBrowserLaunches, pruneBrowserProfiles, removeBrowserLaunch, removeBrowserProfileSettings } from './browser-cleanup.js'

const KEEP = '11111111-1111-4111-8111-111111111111'
const ORPHAN = '22222222-2222-4222-8222-222222222222'
const CURRENT = '33333333-3333-4333-8333-333333333333'
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'browser-cleanup-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('startup cleanup removes orphan browser profiles and partitions while retaining restored and unrelated data', async () => fixture(async root => {
  for (const id of [KEEP, ORPHAN]) {
    await mkdir(join(root, 'browser-profiles', id), { recursive: true })
    await writeFile(join(root, 'browser-profiles', id, 'settings.json'), 'saved-page')
    await mkdir(join(root, 'Partitions', `browser-debug%3A${id}`), { recursive: true })
    await writeFile(join(root, 'Partitions', `browser-debug%3A${id}`, 'Cookies'), 'cookie-fixture')
  }
  await mkdir(join(root, 'Partitions', 'unrelated'), { recursive: true })
  assert.equal(await browserProfileHasPartition(root, KEEP), true)
  assert.equal(await browserProfileHasPartition(root, CURRENT), false)
  await pruneBrowserProfiles(root, [KEEP, undefined, '../outside'])
  assert.equal(await readFile(join(root, 'browser-profiles', KEEP, 'settings.json'), 'utf8'), 'saved-page')
  assert.equal(await readFile(join(root, 'Partitions', `browser-debug%3A${KEEP}`, 'Cookies'), 'utf8'), 'cookie-fixture')
  await assert.rejects(access(join(root, 'browser-profiles', ORPHAN)))
  await assert.rejects(access(join(root, 'Partitions', `browser-debug%3A${ORPHAN}`)))
  assert.equal(await browserProfileHasPartition(root, ORPHAN), false)
  await access(join(root, 'Partitions', 'unrelated'))
  await removeBrowserProfileSettings(root, KEEP)
  await assert.rejects(access(join(root, 'browser-profiles', KEEP)))
}))

test('helper cleanup removes old launches, one closed tab, and the current launch on quit', async () => fixture(async root => {
  for (const id of [ORPHAN, CURRENT]) {
    for (const tab of ['tab-1', 'tab-2']) {
      await mkdir(join(root, 'browser-sessions', id, tab), { recursive: true })
      await writeFile(join(root, 'browser-sessions', id, tab, 'control.json'), '{}')
    }
  }
  await pruneBrowserLaunches(root, CURRENT)
  await assert.rejects(access(join(root, 'browser-sessions', ORPHAN)))
  await removeBrowserLaunch(root, CURRENT, 'tab-1')
  await assert.rejects(access(join(root, 'browser-sessions', CURRENT, 'tab-1')))
  await access(join(root, 'browser-sessions', CURRENT, 'tab-2', 'control.json'))
  await removeBrowserLaunch(root, CURRENT)
  await assert.rejects(access(join(root, 'browser-sessions', CURRENT)))
  await assert.rejects(removeBrowserLaunch(root, '../outside'))
  await assert.rejects(removeBrowserLaunch(root, CURRENT, '../tab-2'))
}))

test('cleanup refuses linked roots and does not touch a linked profile target', async () => fixture(async root => {
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'sentinel'), 'keep')
  await mkdir(join(root, 'browser-profiles'))
  await symlink(outside, join(root, 'browser-profiles', ORPHAN), process.platform === 'win32' ? 'junction' : 'dir')
  await pruneBrowserProfiles(root, [])
  await assert.rejects(removeBrowserProfileSettings(root, ORPHAN), /refuses linked/)
  await symlink(outside, join(root, 'browser-sessions'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(pruneBrowserLaunches(root, CURRENT), /refuses linked/)
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep')
}))

test('clearing stored authentication continues after one cleanup operation fails', async () => {
  const operations: string[] = []
  const errors: string[] = []
  await clearBrowserStorage({
    async closeAllConnections() { operations.push('connections') },
    async clearData() { operations.push('data'); throw new Error('storage unavailable') },
    async clearCache() { operations.push('cache') },
    async clearAuthCache() { operations.push('auth') },
  }, message => errors.push(message))
  assert.deepEqual(operations, ['connections', 'data', 'cache', 'auth'])
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /storage unavailable/)
})
