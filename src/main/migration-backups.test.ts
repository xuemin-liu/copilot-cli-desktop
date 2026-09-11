import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteMigrationBackup, listMigrationBackups } from './migration-backups.js'

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'migration-backups-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const uuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

test('owned atomic and SQLite snapshot debris is listed and removable with completed backups', async (t) => {
  const root = await fixture(t), path = join(root, 'migration-backups', id)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'journal.json'), '{"version":1,"status":"complete"}')
  for (const name of ['0.bak', `0.bak.1234.${uuid}.tmp`, `journal.json.1234.${uuid}.tmp`, `usage-before.sqlite.${uuid}.tmp`, `usage-before.sqlite.${uuid}.tmp-journal`, 'usage-before.sqlite-journal']) await writeFile(join(path, name), 'private backup bytes')
  const listed = await listMigrationBackups(root)
  assert.deepEqual(listed.warnings, [])
  assert.equal(listed.backups[0]!.status, 'complete')
  await deleteMigrationBackup(root, id, listed.backups[0]!.token)
  await assert.rejects(readdir(path), /ENOENT/)
})

test('usage snapshots, unfinished preparation, and empty folders have distinct visible labels', async (t) => {
  const root = await fixture(t)
  for (const [directory, name] of [[id, 'usage-before.sqlite'], [uuid, '0.bak'], ['cccccccc-cccc-cccc-cccc-cccccccccccc', null]] as const) {
    const path = join(root, 'migration-backups', directory); await mkdir(path, { recursive: true })
    if (name) await writeFile(join(path, name), 'data')
  }
  const listed = await listMigrationBackups(root)
  assert.deepEqual(listed.backups.map((backup) => backup.status).sort(), ['empty', 'incomplete', 'usage-snapshot'])
})

test('a failed final directory removal leaves an empty row that can be retried', async (t) => {
  const root = await fixture(t), path = join(root, 'migration-backups', id)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'journal.json'), '{"version":1,"status":"rolled-back"}')
  await writeFile(join(path, '0.bak'), 'before')
  const initial = (await listMigrationBackups(root)).backups[0]!
  await assert.rejects(deleteMigrationBackup(root, id, initial.token, async () => { throw Object.assign(new Error('directory still busy'), { code: 'EBUSY' }) }), /still busy/)
  const remaining = (await listMigrationBackups(root)).backups[0]!
  assert.equal(remaining.status, 'empty')
  await deleteMigrationBackup(root, id, remaining.token)
  await assert.rejects(readdir(path), /ENOENT/)
})

test('cleanup still refuses unrelated files and links disguised as temporary artifacts', async (t) => {
  const root = await fixture(t), path = join(root, 'migration-backups', id)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'unrelated.tmp'), 'preserve')
  assert.equal((await listMigrationBackups(root)).backups.length, 0)
  assert.equal(await readFile(join(path, 'unrelated.tmp'), 'utf8'), 'preserve')
  await rm(join(path, 'unrelated.tmp'))
  const outside = join(root, 'outside'); await mkdir(outside)
  await symlink(outside, join(path, `0.bak.1234.${uuid}.tmp`), 'junction')
  const listed = await listMigrationBackups(root)
  assert.equal(listed.backups.length, 0)
  assert.match(listed.warnings.join(), /Unsupported backup entry/)
})
