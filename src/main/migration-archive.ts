import { createWriteStream } from 'node:fs'
import { lstat, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { MIGRATION_CATEGORIES, type MigrationManifest } from './migration-types.js'
import { assertNoLinks, digest, jsonBytes, MAX_MIGRATION_BYTES, MAX_MIGRATION_ENTRIES, MAX_MIGRATION_FILE, safeRelative, type MigrationFile } from './migration-inventory.js'

export interface MigrationArchive { manifest: MigrationManifest; files: MigrationFile[] }
export async function readMigrationArchive(path: string, signal?: AbortSignal): Promise<MigrationArchive> {
  await assertNoLinks(path)
  if ((await lstat(path)).size > MAX_MIGRATION_BYTES + 16 * 1024 * 1024) throw new Error('Compressed archive exceeds migration size limit')
  signal?.throwIfAborted()
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) => yauzl.open(path, { lazyEntries: true, strictFileNames: true }, (error, value) => error || !value ? fail(error) : ok(value)))
  const raw = new Map<string, Buffer>()
  const names = new Set<string>()
  let total = 0
  await new Promise<void>((ok, fail) => {
    const abort = (): void => { zip.close(); fail(signal!.reason) }
    const reject = (error: unknown): void => { signal?.removeEventListener('abort', abort); zip.close(); fail(error) }
    signal?.addEventListener('abort', abort, { once: true })
    zip.on('error', reject)
    zip.on('end', () => { signal?.removeEventListener('abort', abort); ok() })
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        signal?.throwIfAborted()
        safeRelative(entry.fileName)
        const name = entry.fileName.toLowerCase()
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if ((mode !== 0 && mode !== 0o100000) || (entry.generalPurposeBitFlag & 1)
          || names.has(name) || names.size > MAX_MIGRATION_ENTRIES
          || entry.uncompressedSize > MAX_MIGRATION_FILE) throw new Error('Unsupported, duplicate, or oversized ZIP entry')
        for (const prior of names) if (prior.startsWith(`${name}/`) || name.startsWith(`${prior}/`)) throw new Error('Conflicting ZIP entry paths')
        names.add(name)
        const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => zip.openReadStream(entry, (error, value) => error || !value ? rejectStream(error) : resolveStream(value)))
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of stream) {
          signal?.throwIfAborted()
          const bytes = Buffer.from(chunk as Uint8Array)
          size += bytes.length; total += bytes.length
          if (size > MAX_MIGRATION_FILE || total > MAX_MIGRATION_BYTES) throw new Error('Archive exceeds migration size limits')
          chunks.push(bytes)
        }
        if (size !== entry.uncompressedSize) throw new Error('ZIP entry size mismatch')
        raw.set(entry.fileName, Buffer.concat(chunks))
        zip.readEntry()
      })().catch(reject)
    })
    zip.readEntry()
  })
  const manifestBytes = raw.get('manifest.json')
  if (!manifestBytes || manifestBytes.length > 4 * 1024 * 1024) throw new Error('Missing or oversized migration manifest')
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as MigrationManifest
  if (!manifest || manifest.version !== 1 || manifest.platform !== 'win32' || !Array.isArray(manifest.entries)
    || manifest.entries.length > MAX_MIGRATION_ENTRIES || !Array.isArray(manifest.projects) || manifest.projects.length > 20
    || !Array.isArray(manifest.warnings) || manifest.warnings.length > 1000 || manifest.warnings.some((value) => typeof value !== 'string' || value.length > 4096)
    || typeof manifest.appVersion !== 'string' || typeof manifest.createdAt !== 'string'
    || (manifest.cliVersion !== null && typeof manifest.cliVersion !== 'string')) throw new Error('Unsupported migration manifest or source platform')
  const projects = new Set<string>()
  for (const project of manifest.projects) {
    if (!project || !/^[a-f0-9]{16}$/.test(project.id) || projects.has(project.id)
      || typeof project.name !== 'string' || project.name.length > 100 || typeof project.sourcePath !== 'string' || project.sourcePath.length > 4096) throw new Error('Invalid project manifest')
    projects.add(project.id)
  }
  raw.delete('manifest.json')
  const files: MigrationFile[] = []
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== 'string') throw new Error('Invalid archive entry')
    safeRelative(entry.path)
    const data = raw.get(entry.path)
    if (!data || !MIGRATION_CATEGORIES.includes(entry.category) || entry.size !== data.length || entry.sha256 !== digest(data)) throw new Error('Archive checksum or manifest mismatch')
    files.push({ ...entry, data })
    raw.delete(entry.path)
  }
  if (raw.size) throw new Error('Unlisted files in migration archive')
  return { manifest, files }
}

export async function writeMigrationArchive(path: string, manifest: MigrationManifest, files: MigrationFile[], signal?: AbortSignal): Promise<void> {
  await assertNoLinks(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const zip = new yazl.ZipFile()
    const output = pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { ...(signal ? { signal } : {}) })
    manifest.entries = files.map(({ data: _data, ...entry }) => entry)
    zip.addBuffer(jsonBytes(manifest), 'manifest.json', { mode: 0o100600 })
    for (const file of files) { signal?.throwIfAborted(); zip.addBuffer(file.data, file.path, { mode: 0o100600 }) }
    zip.end()
    await output
    await readMigrationArchive(temporary, signal)
    signal?.throwIfAborted()
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
