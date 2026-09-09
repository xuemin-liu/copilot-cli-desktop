import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, lstatSync, statSync, unlinkSync, writeFileSync, readFileSync, type Dirent } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { emptyUsage, type UsageCounts, type UsageGroup, type UsageReport, type UsageScope } from './usage-types.js'
import { visitSessionHistoryLines } from './session-history.js'
import { renameWithRetry, retryFileOperationSync } from './atomic-file.js'

type Row = Record<string, unknown>
interface Sample extends UsageCounts {
  key: string
  session: string
  model: string
  at: string
  start: string | null
  kind: 'request' | 'shutdown'
}
const COUNT_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const
const REQUIRED = ['id', 'session_id', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'created_at']
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Missing or invalid token counter')
  return value
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing usage timestamp')
  // SQLite datetime() strings have no suffix but are UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(normalized) || !Number.isFinite(Date.parse(normalized))) throw new Error('Invalid usage timestamp')
  return new Date(normalized).toISOString()
}
function counts(row: Row): UsageCounts {
  const gross = number(row.input_tokens)
  const cacheRead = number(row.cache_read_tokens)
  const cacheWrite = number(row.cache_write_tokens)
  if (cacheRead + cacheWrite > gross) throw new Error('Cache counters exceed gross input; unsupported counter semantics')
  return { input: gross - cacheRead - cacheWrite, output: number(row.output_tokens), cacheRead, cacheWrite,
    reasoning: row.reasoning_tokens == null ? 0 : number(row.reasoning_tokens) }
}
function add(target: UsageCounts, source: UsageCounts): void {
  for (const key of COUNT_KEYS) {
    target[key] += source[key]
    if (!Number.isSafeInteger(target[key])) throw new Error('Usage total exceeds supported integer precision')
  }
}
export class UsageDatabaseCorruptionError extends Error {}
export class UsageDatabaseVersionError extends Error {}
export function isTransientUsageError(error: unknown): boolean {
  const value = error as { errcode?: number; code?: string }
  return [5, 6, 8, 10, 14].includes((value?.errcode ?? -1) & 255) || ['EBUSY', 'EACCES', 'EPERM'].includes(value?.code ?? '')
}
function confirmedCorruption(error: unknown): boolean {
  return error instanceof UsageDatabaseCorruptionError || [11, 26].includes(((error as { errcode?: number })?.errcode ?? -1) & 255)
}
/** Returns false only for an interrupted, empty initialization. Backups must be initialized. */
export function validateUsageDatabase(path: string, allowEmpty = false): boolean {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=1500')
    if (db.prepare('PRAGMA integrity_check').all().some((row) => row.integrity_check !== 'ok')) throw new UsageDatabaseCorruptionError('Usage database integrity check failed')
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    if (version > 1) throw new UsageDatabaseVersionError('Unsupported usage database version')
    const empty = version === 0 && db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n === 0
    if (empty && allowEmpty) return false
    if (version !== 1) throw new UsageDatabaseCorruptionError('Usage database initialization is incomplete')
    try {
      db.prepare('SELECT key, payload FROM samples LIMIT 0').all()
      db.prepare('SELECT session, fork FROM app_sessions LIMIT 0').all()
      db.prepare('SELECT key, value FROM metadata LIMIT 0').all()
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 1) throw error
      throw new UsageDatabaseCorruptionError('Usage database schema is incomplete')
    }
    return true
  } finally { db.close() }
}

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
function removeRecoveryArtifact(path: string): void {
  try { retryFileOperationSync(() => { if (existsSync(path)) unlinkSync(path) }) } catch { /* Replay/cleanup retries next startup without masking a completed recovery. */ }
}

/** Finish an interrupted restore using only validated, owned journal paths. */
export function replayUsageRecovery(path: string): void {
  const journal = `${path}.recovery-pending`
  if (!existsSync(journal)) return
  const record = JSON.parse(readFileSync(journal, 'utf8')) as { path?: unknown; temporary?: unknown; originals?: unknown }
  const normalized = resolve(path)
  if (record.path !== path || typeof record.temporary !== 'string' || !record.temporary.startsWith(path + '.')
    || !new RegExp(`^${UUID}\\.recovered$`, 'i').test(record.temporary.slice(path.length + 1))
    || !Array.isArray(record.originals) || record.originals.length !== 3) throw new Error('Invalid usage recovery journal; files were preserved')
  const pairs = record.originals as Array<[string, string]>
  let suffix: string | undefined
  for (const [index, extension] of ['-wal', '-shm', ''].entries()) {
    const pair = pairs[index]
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== path + extension || typeof pair[1] !== 'string') throw new Error('Invalid usage recovery journal paths')
    const tail = pair[1].slice(path.length)
    const currentSuffix = extension ? tail.slice(0, -extension.length) : tail
    if (resolve(pair[0]) !== normalized + extension || !pair[1].startsWith(path) || !tail.endsWith(extension)
      || !new RegExp(`^\\.corrupt-\\d+-${UUID}$`, 'i').test(currentSuffix) || (suffix && suffix !== currentSuffix)) throw new Error('Invalid usage recovery journal paths')
    suffix = currentSuffix
  }
  // Missing temporary + present main file means installation or rollback already
  // completed. Leave the current ledger in place, even if cleanup was AV-locked.
  if (existsSync(record.temporary)) {
    validateUsageDatabase(record.temporary)
    for (const [original, parked] of pairs) {
      if (!existsSync(original)) continue
      if (existsSync(parked)) throw new Error('Ambiguous usage recovery files; originals were preserved')
      renameWithRetry(original, parked)
    }
    renameWithRetry(record.temporary, path)
  } else if (!existsSync(path)) {
    for (const [original, parked] of [...pairs].reverse()) {
      if (!existsSync(parked)) continue
      if (existsSync(original)) throw new Error('Ambiguous usage recovery files; originals were preserved')
      renameWithRetry(parked, original)
    }
    if (!existsSync(path)) throw new Error('Usage recovery files are unavailable; original journal was preserved')
  }
  removeRecoveryArtifact(record.temporary)
  removeRecoveryArtifact(journal)
}

/** Recovery is explicit or uses a verified local backup; originals are always retained. */
export function recoverUsageDatabase(path: string, backup: string): void {
  const journal = `${path}.recovery-pending`
  replayUsageRecovery(path)
  if (resolve(path).toLowerCase() === resolve(backup).toLowerCase()) throw new Error('Select a separate usage backup')
  validateUsageDatabase(backup)
  const temporary = `${path}.${randomUUID()}.recovered`
  const moved: Array<[string, string]> = []
  let retainRecovery = false
  let journalCreated = false
  try {
    const source = new DatabaseSync(backup, { readOnly: true })
    try { source.prepare('VACUUM INTO ?').run(temporary) } finally { source.close() }
    validateUsageDatabase(temporary)
    const suffix = `.corrupt-${Date.now()}-${randomUUID()}`
    writeFileSync(journal, JSON.stringify({ path, temporary, originals: ['-wal', '-shm', ''].map((extension) => [path + extension, path + suffix + extension]) }), { flag: 'wx', flush: true })
    journalCreated = true
    // Move sidecars first so an access failure cannot strand them beside a new ledger.
    for (const extension of ['-wal', '-shm', '']) {
      if (existsSync(path + extension)) {
        renameWithRetry(path + extension, path + suffix + extension)
        moved.push([path + extension, path + suffix + extension])
      }
    }
    renameWithRetry(temporary, path)
  } catch (error) {
    for (const [original, parked] of moved.reverse()) {
      try { renameWithRetry(parked, original) } catch { retainRecovery = true }
    }
    if (retainRecovery) throw new Error(`Usage recovery could not roll back all original files. Preserved originals and recovery copy at ${temporary}; resolve file access before retrying.`, { cause: error })
    throw error
  } finally {
    if (!retainRecovery) {
      removeRecoveryArtifact(temporary)
      if (journalCreated) removeRecoveryArtifact(journal)
    }
  }
}

/** Owned only by the usage worker. No writes are made to Copilot's source store. */
export class UsageLedger {
  private db: DatabaseSync
  private statements = new Map<string, StatementSync>()
  private warnings: string[] = []
  private recoveryWarning: string | null = null
  private historySignatures = new Map<string, { signature: string; identity: string; size: number; offset: number; start: string | null; warnings: string[] }>()
  private cachedSamples: Sample[] | null = null
  private monthCache = { zone: '', values: new Map<string, string>() }
  readonly backupDirectory: string
  private readonly backupRoot: string

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    replayUsageRecovery(path)
    this.backupRoot = join(dirname(path), 'usage-backups')
    this.backupDirectory = this.backupRoot
    const missing = !existsSync(path)
    if (existsSync(path)) {
      try {
        if (!validateUsageDatabase(path, true) && this.backups(true).length) throw new UsageDatabaseCorruptionError('Empty ledger has existing backups')
      } catch (error) {
        // Lock, permission and I/O errors do not prove data corruption. Leave the ledger in place.
        if (!confirmedCorruption(error)) throw error
        const candidate = this.backups(true).find((file) => { try { validateUsageDatabase(file); return true } catch { return false } })
        if (!candidate) throw new Error('Usage database is damaged. Original files preserved; restore a valid usage backup.')
        recoverUsageDatabase(path, candidate)
        this.recoveryWarning = 'Recovered usage from a verified backup. Original damaged files were preserved; usage since that backup may be missing.'
      }
    }
    this.db = new DatabaseSync(path)
    try { this.db.exec(`PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS samples (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_sessions (session TEXT PRIMARY KEY, fork INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rejected_usage (key TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_occurrences (source TEXT, digest TEXT, count INTEGER NOT NULL, PRIMARY KEY(source,digest));
      PRAGMA user_version=1;`)
      if (missing && this.backups(true).length) this.setMeta('missingLedgerWarning', '1')
      if (this.meta('preservedBackups')) this.setMeta('missingLedgerWarning', '1')
      if (!this.meta('backupGeneration')) this.setMeta('backupGeneration', `generation-${randomUUID()}`)
      this.stmt("DELETE FROM metadata WHERE key IN ('preservedBackups','preserveBackupsPending')").run()
      this.db.exec('COMMIT')
    } catch (error) { this.db.close(); throw error }
    try {
      if (!this.meta('timezone')) this.setMeta('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone)
      if (this.recoveryWarning) this.setMeta('recoveryWarning', this.recoveryWarning)
      const generation = this.meta('backupGeneration')!
      if (!new RegExp(`^generation-${UUID}$`, 'i').test(generation)) throw new Error('Invalid usage backup generation')
      this.backupDirectory = join(this.backupRoot, generation)
      this.cleanInterruptedCopies()
      // Old rejection keys encoded row content and cannot be retried. The new durable
      // checkpoints start with a full scan and replace those obsolete diagnostics.
      if (!this.meta('retryableRejections')) this.transaction(() => {
        this.db.exec('DELETE FROM rejected_usage')
        this.setMeta('retryableRejections', '1')
      })
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.statements.clear(); this.db.close() }
  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement) }
    return statement
  }
  private cleanInterruptedCopies(): void {
    if (existsSync(`${this.path}.recovery-pending`)) return
    // A new worker starts only after the previous one exits. Restrict cleanup to our exact temporary names.
    const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
    for (const directory of [dirname(this.path), this.backupDirectory]) {
      if (!existsSync(directory)) continue
      const pattern = directory === this.backupDirectory
        ? new RegExp(`^(?:daily-\\d{4}-\\d{2}-\\d{2}|monthly-\\d{4}-\\d{2})\\.sqlite\\.${uuid}\\.tmp$`, 'i')
        : new RegExp(`^${basename(this.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${uuid}\\.(?:restore|recovered)$`, 'i')
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && pattern.test(entry.name)) {
          try { unlinkSync(join(directory, entry.name)) } catch { /* An AV lock can be retried on the next worker start. */ }
        }
      }
    }
  }
  private meta(key: string): string | null { return (this.stmt('SELECT value FROM metadata WHERE key=?').get(key)?.value as string | undefined) ?? null }
  private setMeta(key: string, value: string): void { this.stmt('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, value) }
  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { action(); this.db.exec('COMMIT') } catch (error) {
      // SQLITE_FULL can already have rolled back the transaction; preserve the original failure.
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
  private save(sample: Sample): void {
    if (sample.kind === 'shutdown') sample = { ...sample, key: `shutdown:${sample.session}:${this.shutdownIdentity(sample)}` }
    if (this.stmt('INSERT OR IGNORE INTO samples VALUES (?,?)').run(sample.key, JSON.stringify(sample)).changes) this.cachedSamples = null
  }
  private shutdownIdentity(sample: Sample): string {
    const value = Object.fromEntries(COUNT_KEYS.map((key) => [key, sample[key]]))
    return hash({ at: sample.at, model: sample.model, start: sample.start, value })
  }
  associate(session: string, fork = false): void {
    this.stmt('INSERT INTO app_sessions VALUES (?,?) ON CONFLICT(session) DO UPDATE SET fork=max(fork,excluded.fork)').run(session, fork ? 1 : 0)
  }
  async collect(home: string): Promise<void> {
    this.warnings = []
    this.setMeta('sourcePath', join(home, 'session-store.db'))
    let successful = false
    try { this.importRequests(join(home, 'session-store.db')); successful = true }
    catch (error) { this.warnings.push(`Request collection: ${String(error)}`) }
    const root = join(home, 'session-state')
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[\da-f-]{36}$/i.test(entry.name)) continue
        const path = join(root, entry.name, 'events.jsonl')
        if (!existsSync(path)) continue
        try { await this.importHistory(path, entry.name) }
        catch (error) { this.warnings.push(`Some shutdown history could not be imported: ${String(error)}`) }
      }
    }
    if (successful) this.setMeta('lastCollected', new Date().toISOString())
    this.setMeta('warnings', JSON.stringify([...new Set(this.warnings)]))
  }
  private importRequests(path: string): void {
    if (!existsSync(path)) throw new Error('Copilot usage store is unavailable. Previously saved usage is retained.')
    const source = new DatabaseSync(path, { readOnly: true })
    try {
      source.exec('PRAGMA busy_timeout=1500; BEGIN')
      const columns = new Set(source.prepare('PRAGMA table_info(assistant_usage_events)').all().map((row) => row.name))
      if (REQUIRED.some((name) => !columns.has(name))) throw new Error('Unsupported Copilot usage schema; required columns are missing')
      const optional = ['turn_index', 'agent_id', 'parent_tool_call_id', 'reasoning_tokens'].filter((name) => columns.has(name))
      const fields = [...REQUIRED, ...optional].join(',')
      const rowById = source.prepare(`SELECT ${fields} FROM assistant_usage_events WHERE id=?`)
      const nextRows = source.prepare(`SELECT ${fields} FROM assistant_usage_events WHERE id>? ORDER BY id LIMIT 500`)
      const sourceVersion = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get()
        ? source.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get()?.version
        : source.prepare('PRAGMA user_version').get()?.user_version
      // Checkpoints and occurrence counts commit with each batch. Validate the file
      // and boundary rows on every resume so recreated stores cannot hide behind reused IDs.
      const info = statSync(path)
      const fingerprint = `${info.dev}:${info.ino}:${info.birthtimeMs}:${fields}`
      const first = hash(source.prepare(`SELECT ${fields} FROM assistant_usage_events ORDER BY id LIMIT 1`).get() ?? null)
      const sourceKey = hash(path)
      const progressKey = `sourceProgress:${sourceKey}`
      const progress = JSON.parse(this.meta(progressKey) ?? 'null') as { fingerprint: string; cursor: number; first: string; last: string } | null
      const unchanged = progress && progress.fingerprint === fingerprint && progress.first === first
        && hash(rowById.get(progress.cursor) ?? null) === progress.last
      let cursor = unchanged ? progress.cursor : 0
      let last = unchanged ? progress.last : hash(null)
      if (!unchanged) this.transaction(() => {
        this.stmt('DELETE FROM source_occurrences WHERE source=?').run(sourceKey)
        this.stmt('DELETE FROM rejected_usage WHERE key LIKE ?').run(`${sourceKey}:%`)
        this.setMeta(progressKey, JSON.stringify({ fingerprint, cursor, first, last }))
      })
      const importRow = (row: Row): void => {
        const rejectionKey = `${sourceKey}:${number(row.id)}`
        let value: UsageCounts
        let at: string
        try { value = counts(row); at = timestamp(row.created_at) }
        catch (error) {
          this.stmt(`INSERT INTO rejected_usage VALUES (?,?) ON CONFLICT(key)
            DO UPDATE SET reason=excluded.reason WHERE reason!=excluded.reason`).run(rejectionKey, String(error).slice(0, 300))
          return
        }
        const identity = Object.fromEntries([...REQUIRED, 'turn_index', 'agent_id', 'parent_tool_call_id'].filter((key) => key !== 'id').map((key) => [key, row[key] ?? null]))
        const digest = hash(identity)
        const occurrence = Number(this.stmt(`INSERT INTO source_occurrences VALUES (?,?,1)
          ON CONFLICT(source,digest) DO UPDATE SET count=count+1 RETURNING count`).get(sourceKey, digest)!.count)
        this.save({ key: `request:${digest}:${occurrence}`, session: String(row.session_id), model: String(row.model), at, start: null, kind: 'request', ...value })
        this.stmt('DELETE FROM rejected_usage WHERE key=?').run(rejectionKey)
      }
      // Retry a rotating bounded batch so a large invalid backlog cannot starve new records.
      const retryKey = `rejectedCursor:${sourceKey}`
      const pending = this.stmt('SELECT key FROM rejected_usage WHERE key LIKE ? AND key>? ORDER BY key LIMIT 500')
      let rejectedRows = pending.all(`${sourceKey}:%`, unchanged ? this.meta(retryKey) ?? '' : '')
      if (!rejectedRows.length) rejectedRows = pending.all(`${sourceKey}:%`, '')
      if (rejectedRows.length) this.transaction(() => {
        for (const rejected of rejectedRows) {
          const row = rowById.get(Number(String(rejected.key).slice(sourceKey.length + 1)))
          if (row) importRow(row)
          else this.stmt('DELETE FROM rejected_usage WHERE key=?').run(String(rejected.key))
        }
        this.setMeta(retryKey, String(rejectedRows.at(-1)!.key))
      })
      while (true) {
        const rows = nextRows.all(cursor)
        if (!rows.length) break
        this.transaction(() => {
          for (const row of rows) {
            cursor = number(row.id)
            last = hash(row)
            importRow(row)
          }
          this.setMeta(progressKey, JSON.stringify({ fingerprint, cursor, first, last, schema: sourceVersion }))
        })
      }
    } finally { source.close() }
  }
  private async importHistory(path: string, session: string): Promise<void> {
    const info = lstatSync(path)
    if (!info.isFile()) throw new Error('History must be a regular file')
    const signature = `${info.size}:${info.mtimeMs}`
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
    const progressKey = `historyProgress:${hash(path)}`
    const previous = this.historySignatures.get(path) ?? JSON.parse(this.meta(progressKey) ?? 'null') as { signature: string; identity: string; size: number; offset: number; start: string | null; warnings: string[] } | null
    if (previous?.signature === signature && previous.identity === identity) { this.warnings.push(...previous.warnings); return }
    const appended = previous && previous.identity === identity && (info.size > previous.size || (info.size === previous.size && previous.signature === ''))
    const samples: Sample[] = []
    const warnings: string[] = appended ? [...previous.warnings] : []
    let start: string | null = appended ? previous.start : null
    let lastCheckpoint = appended ? previous.offset : 0
    const checkpoint = (offset: number, complete = false): void => {
      if (!complete && samples.length < 500 && offset - lastCheckpoint < 4 * 1024 * 1024) return
      const progress = { signature: complete ? signature : '', identity, size: complete ? info.size : offset, offset, start, warnings }
      this.transaction(() => {
        for (const sample of samples) this.save(sample)
        this.setMeta(progressKey, JSON.stringify(progress))
      })
      samples.length = 0
      lastCheckpoint = offset
      this.historySignatures.set(path, progress)
    }
    const result = await visitSessionHistoryLines(path, (line) => {
      if (!/"type"\s*:\s*"session\.(?:start|shutdown)"/.test(line)) return
      try {
        const event = JSON.parse(line) as { type: string; timestamp: unknown; data: Record<string, any> }
        if (event.type === 'session.start') start = timestamp(event.data.startTime ?? event.timestamp)
        if (event.type !== 'session.shutdown') return
        const at = timestamp(event.timestamp)
        for (const [model, metrics] of Object.entries(event.data.modelMetrics ?? {}) as Array<[string, Record<string, any>]>) {
          if (!metrics.usage) continue
          const usage = metrics.usage
          const value = counts({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
            cache_read_tokens: usage.cacheReadTokens, cache_write_tokens: usage.cacheWriteTokens, reasoning_tokens: usage.reasoningTokens })
          const key = `shutdown:${session}:${hash({ at, model, start, value })}`
          samples.push({ key, session, model, at, start, kind: 'shutdown', ...value })
        }
      } catch (error) { if (warnings.length < 10) warnings.push(`Skipped invalid shutdown record: ${String(error)}`) }
    }, { allowPartial: true, allowEmpty: true, offset: appended ? previous.offset : 0, checkpoint })
    checkpoint(result.completeBytes, true)
    this.warnings.push(...warnings)
    this.historySignatures.set(path, { signature, identity, size: result.size, offset: result.completeBytes, start, warnings })
  }
  private backups(allGenerations = false): string[] {
    const directories = new Set([this.backupDirectory])
    const entries = (directory: string): Dirent[] => {
      try { return readdirSync(directory, { withFileTypes: true }) } catch { return [] }
    }
    if (allGenerations) {
      directories.add(this.backupRoot)
      for (const entry of entries(this.backupRoot)) if (entry.isDirectory() && new RegExp(`^generation-${UUID}$`, 'i').test(entry.name)) directories.add(join(this.backupRoot, entry.name))
      for (const entry of entries(dirname(this.path))) if (entry.isDirectory() && new RegExp(`^usage-backups-preserved-${UUID}$`, 'i').test(entry.name)) directories.add(join(dirname(this.path), entry.name))
    }
    const files: Array<{ path: string; modified: number }> = []
    for (const directory of directories) for (const entry of entries(directory)) {
      if (!entry.isFile() || !/^(daily|monthly|manual)-.*\.sqlite$/.test(entry.name)) continue
      const path = join(directory, entry.name)
      try { files.push({ path, modified: statSync(path).mtimeMs }) } catch { /* Unavailable candidates can be retried on the next recovery. */ }
    }
    return files.sort((a, b) => b.modified - a.modified).map((file) => file.path)
  }
  exportTo(destination: string): void {
    const normalized = resolve(destination).toLowerCase()
    const activePaths = [this.path, this.meta('sourcePath')].filter((path): path is string => path !== null)
    if (activePaths.some((path) => ['', '-wal', '-shm'].some((suffix) => normalized === resolve(path + suffix).toLowerCase()))) throw new Error('Choose an export location outside the active usage database and Copilot source store')
    // Never copy a live WAL database with filesystem copyFile.
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      this.stmt('VACUUM INTO ?').run(temporary)
      validateUsageDatabase(temporary)
      renameWithRetry(temporary, destination)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
  backup(force = false, now = new Date()): void {
    mkdirSync(this.backupDirectory, { recursive: true })
    const day = now.toISOString().slice(0, 10)
    const daily = join(this.backupDirectory, `daily-${day}.sqlite`)
    if (force || !existsSync(daily)) {
      this.exportTo(daily)
      const monthly = join(this.backupDirectory, `monthly-${day.slice(0, 7)}.sqlite`)
      this.exportTo(monthly)
      this.setMeta('lastBackup', now.toISOString())
      // Only rotate after both replacement backups have passed integrity validation.
      for (const [prefix, keep] of [['daily-', 30], ['monthly-', 12]] as const) {
        for (const file of this.backups().filter((path) => path.includes(prefix)).slice(keep)) unlinkSync(file)
      }
    }
  }
  restoreFrom(path: string): void {
    if (resolve(path).toLowerCase() === resolve(this.path).toLowerCase()) throw new Error('Select a backup rather than the active usage database')
    validateUsageDatabase(path)
    // Freeze the selected backup before rotation: it may itself be today's daily backup.
    const frozen = `${this.path}.${randomUUID()}.restore`
    try {
      const selected = new DatabaseSync(path, { readOnly: true })
      try { selected.prepare('VACUUM INTO ?').run(frozen) } finally { selected.close() }
      this.backup(true)
      const source = new DatabaseSync(frozen, { readOnly: true })
      try {
        this.transaction(() => {
          for (const row of source.prepare('SELECT payload FROM samples').iterate()) {
            const sample = JSON.parse(String(row.payload)) as Sample
            if (!['request', 'shutdown'].includes(sample.kind) || typeof sample.key !== 'string' || typeof sample.session !== 'string' || typeof sample.model !== 'string') throw new Error('Invalid backup usage record')
            timestamp(sample.at)
            if (sample.start !== null) timestamp(sample.start)
            for (const key of COUNT_KEYS) number(sample[key])
            this.save(sample)
          }
          for (const row of source.prepare('SELECT session, fork FROM app_sessions').iterate()) this.associate(String(row.session), row.fork === 1)
          this.stmt("DELETE FROM metadata WHERE key IN ('missingLedgerWarning','recoveryWarning')").run()
        })
      } finally { source.close() }
    } finally { if (existsSync(frozen)) unlinkSync(frozen) }
    this.backup(true)
  }
  report(month: string, scope: UsageScope = 'all', timezone?: string): UsageReport {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid usage month')
    const zone = timezone ?? this.meta('timezone') ?? 'UTC'
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit' })
    if (timezone) this.setMeta('timezone', zone)
    if (this.monthCache.zone !== zone) this.monthCache = { zone, values: new Map() }
    const monthOf = (at: string): string => {
      const cached = this.monthCache.values.get(at)
      if (cached) return cached
      const parts = formatter.formatToParts(new Date(at))
      const value = `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`
      this.monthCache.values.set(at, value)
      return value
    }
    const appSessions = new Map(this.stmt('SELECT session,fork FROM app_sessions').all().map((row) => [String(row.session), row.fork === 1]))
    const samples = this.cachedSamples ??= this.stmt('SELECT payload FROM samples').all().map((row) => JSON.parse(String(row.payload)) as Sample)
    const selected = samples.filter((sample) => scope === 'all' || appSessions.has(sample.session))
    const requests = selected.filter((sample) => sample.kind === 'request')
    const requestGroups = new Map<string, Sample[]>()
    const groupKey = (sample: Sample): string => JSON.stringify([sample.session, sample.model])
    for (const sample of requests) {
      const key = groupKey(sample)
      const group = requestGroups.get(key) ?? []
      group.push(sample)
      requestGroups.set(key, group)
    }
    for (const group of requestGroups.values()) group.sort((a, b) => a.at.localeCompare(b.at))
    const snapshots = new Map<string, Sample[]>()
    const seenSnapshots = new Set<string>()
    for (const sample of selected.filter((sample) => sample.kind === 'shutdown')) {
      // Also deduplicate legacy keys against newly imported per-session keys. Known forks are
      // excluded below, never allowed to claim the original's record based on directory order.
      const identity = `${sample.session}:${this.shutdownIdentity(sample)}`
      if (seenSnapshots.has(identity)) continue
      seenSnapshots.add(identity)
      const key = groupKey(sample)
      const group = snapshots.get(key) ?? []
      group.push(sample)
      snapshots.set(key, group)
    }
    const totals = emptyUsage(), unallocated = emptyUsage()
    const models = new Map<string, UsageGroup>(), sessions = new Map<string, UsageGroup>()
    const months = new Set<string>([month])
    const warnings = new Set<string>(JSON.parse(this.meta('warnings') ?? '[]') as string[])
    const activeSource = `${hash(this.meta('sourcePath') ?? '')}:%`
    const rejected = Number(this.stmt('SELECT count(*) AS n FROM rejected_usage WHERE key LIKE ?').get(activeSource)?.n)
    if (rejected) {
      const reasons = this.stmt('SELECT DISTINCT reason FROM rejected_usage WHERE key LIKE ? LIMIT 3').all(activeSource).map((row) => row.reason).join('; ')
      warnings.add(`${rejected} invalid source usage row(s) were skipped; later rows are still collected. ${reasons}`)
    }
    const recoveryWarning = this.meta('recoveryWarning')
    if (recoveryWarning) warnings.add(recoveryWarning)
    if (this.meta('missingLedgerWarning') === '1') warnings.add(`The usage ledger was missing. Earlier usage may be absent from these totals. Use Restore backup to recover records from earlier generations under ${this.backupRoot} or sibling usage-backups-preserved folders. Earlier generations are retained without rotation.`)
    warnings.add('Recorded usage may be incomplete where Copilot history was lost before collection. App scope includes whole sessions observed in the app, including usage outside the app.')
    const include = (sample: Sample, value: UsageCounts, reconciled: boolean): void => {
      const sampleMonth = monthOf(sample.at)
      months.add(sampleMonth)
      if (sampleMonth !== month) return
      add(totals, value)
      for (const [map, name] of [[models, sample.model], [sessions, sample.session]] as const) {
        const group = map.get(name) ?? { name, ...emptyUsage(), requests: 0, source: 'requests' as const }
        add(group, value)
        if (reconciled) group.source = 'reconciled'
        else group.requests++
        map.set(name, group)
      }
    }
    for (const request of requests) include(request, request, false)
    for (const [key, group] of snapshots) {
      group.sort((a,b) => a.at.localeCompare(b.at))
      const groupRequests = requestGroups.get(key) ?? []
      let requestIndex = 0
      let previous: Sample | undefined
      for (const snapshot of group) {
        if (appSessions.get(snapshot.session)) { warnings.add('Shutdown fallback is excluded for known forks because inherited counters cannot be safely attributed. Request records are retained.'); continue }
        const known = emptyUsage()
        while (requestIndex < groupRequests.length && groupRequests[requestIndex]!.at <= snapshot.at) add(known, groupRequests[requestIndex++]!)
        const interval = emptyUsage()
        for (const key of COUNT_KEYS) interval[key] = snapshot[key] - (previous?.[key] ?? 0)
        const start = previous?.at ?? snapshot.start
        previous = snapshot
        if (COUNT_KEYS.some((key) => interval[key] < 0)) { warnings.add('Cumulative counters reset or disagree; the affected shutdown interval is excluded. Request records are retained.'); continue }
        // A residual fills partial request coverage, but never subtracts previously saved requests.
        const residual = emptyUsage()
        for (const key of COUNT_KEYS) residual[key] = Math.max(0, interval[key] - known[key])
        if (!COUNT_KEYS.some((key) => residual[key])) continue
        if (COUNT_KEYS.some((key) => known[key] > interval[key])) warnings.add('Some cumulative counters disagree with request records; shutdown residuals are provisional.')
        warnings.add('Reconciled totals include provisional shutdown residuals; unknown fork ancestry or counter resets may affect them.')
        if (start && monthOf(start) === monthOf(snapshot.at)) include(snapshot, residual, true)
        else { add(unallocated, residual); warnings.add('Some shutdown usage spans months or has no start time. It is shown as unallocated across all months, excluded from monthly totals.') }
      }
    }
    const sort = (values: Iterable<UsageGroup>): UsageGroup[] => [...values].sort((a,b) => (b.input + b.output + b.cacheRead + b.cacheWrite) - (a.input + a.output + a.cacheRead + a.cacheWrite))
    return { month, timezone: zone, months: [...months].sort().reverse(), totals, unallocated,
      models: sort(models.values()), sessions: sort(sessions.values()), warnings: [...warnings],
      lastCollected: this.meta('lastCollected'), lastBackup: this.meta('lastBackup'), databasePath: this.path }
  }
}
