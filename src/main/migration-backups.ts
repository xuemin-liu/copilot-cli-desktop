import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoLinks, digest, jsonBytes, optionalRead } from './migration-inventory.js'
import type { MigrationBackup } from './migration-types.js'

async function inspectBackup(root: string, id: string): Promise<MigrationBackup | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid backup selection')
  const path = join(root, 'migration-backups', id)
  await assertNoLinks(path)
  const names = (await readdir(path)).sort()
  const journal = await optionalRead(join(path, 'journal.json'))
  let status: MigrationBackup['status']
  if (journal) {
    const parsed = JSON.parse(journal.toString('utf8')) as { version?: number; status?: string }
    if (parsed.version !== 1 || !['complete', 'rolled-back'].includes(parsed.status ?? '')) return null
    status = parsed.status as MigrationBackup['status']
  } else if (names.some((name) => /^journal\.dismissed-[0-9a-f-]{36}\.json$/.test(name))) status = 'dismissed'
  else if (names.length) status = 'prepared' // Uncommitted preparation or a separate usage snapshot.
  else return null
  const metadata: unknown[] = []
  let bytes = 0
  for (const name of names) {
    if (!/^(?:\d+\.bak|journal\.json|journal\.dismissed-[0-9a-f-]{36}\.json|usage-before\.sqlite)$/.test(name)) throw new Error(`Unexpected backup entry; inspect manually: ${join(path, name)}`)
    const info = await lstat(join(path, name))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsupported backup entry: ${join(path, name)}`)
    bytes += info.size
    metadata.push([name, info.size, info.mtimeMs, info.ino])
  }
  return { id, path, status, bytes, token: digest(jsonBytes(metadata)) }
}
export async function listMigrationBackups(root: string): Promise<{ backups: MigrationBackup[]; warnings: string[] }> {
  const backups: MigrationBackup[] = [], warnings: string[] = []
  let names: string[]
  try { names = await readdir(join(root, 'migration-backups')); await assertNoLinks(join(root, 'migration-backups')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not list retained backups: ${String(error)}`); return { backups, warnings } }
  for (const id of names.filter((name) => /^[0-9a-f-]{36}$/.test(name))) {
    try { const backup = await inspectBackup(root, id); if (backup) backups.push(backup) }
    catch (error) { warnings.push(`Could not inspect backup ${id}: ${String(error)}`) }
  }
  return { backups, warnings }
}
export async function deleteMigrationBackup(root: string, id: string, token: string): Promise<void> {
  const backup = await inspectBackup(root, id)
  if (!backup || backup.token !== token) throw new Error('Backup changed or still needs recovery; refresh the backup list before deleting it')
  // Flat, validated files only. Delete the journal last so partial cleanup stays visible.
  const names = (await readdir(backup.path)).sort((a, b) => Number(a.startsWith('journal')) - Number(b.startsWith('journal')))
  if ((await inspectBackup(root, id))?.token !== token) throw new Error('Backup changed; refresh the backup list')
  for (const name of names) { await assertNoLinks(join(backup.path, name)); await rm(join(backup.path, name)) }
  await rmdir(backup.path)
}
