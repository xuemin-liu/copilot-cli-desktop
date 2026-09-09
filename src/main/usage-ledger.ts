import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, lstatSync, statSync, unlinkSync, writeFileSync, readFileSync, openSync, fsyncSync, closeSync, type Dirent } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { emptyUsage, type UsageCounts, type UsageGroup, type UsageReport, type UsageScope, type UsageFlushResult } from './usage-types.js'
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
type PendingSample = Sample | (Omit<Sample, 'key' | 'kind'> & { kind: 'shutdown' })
interface HistoryProgress {
  signature: string
  identity: string
  offset: number
  start: string | null
  warnings: string[]
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
function backupFailureWarning(error: unknown): string {
  const value = error as { code?: unknown; errcode?: unknown }
  const sqliteCode = typeof value?.errcode === 'number' ? value.errcode & 255 : null
  const code = sqliteCode !== null ? `SQLITE_${sqliteCode}`
    : typeof value?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(value.code) ? value.code : 'UNKNOWN'
  const reason: Record<string, string> = {
    EPERM: 'Access to the backup file was denied.', EACCES: 'Access to the backup file was denied.',
    EBUSY: 'The backup file is in use.', SQLITE_5: 'The backup file is in use.', SQLITE_6: 'The backup file is in use.',
    ENOSPC: 'There is not enough disk space.', SQLITE_13: 'There is not enough disk space.',
    ENOENT: 'The backup location is unavailable.', ENOTDIR: 'The backup location is unavailable.',
    SQLITE_14: 'The backup location is unavailable.', SQLITE_8: 'The backup location is read-only.',
    EIO: 'The backup storage reported an I/O error.', SQLITE_10: 'The backup storage reported an I/O error.',
  }
  // Do not persist raw exception text: it can contain private paths, changing
  // temporary UUIDs, and arbitrarily long messages. Fixed reasons stay stable.
  return `Usage is committed, but the backup refresh failed (${code}): ${reason[code] ?? 'The backup could not be written.'}`
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

function recoveryPlan(path: string, suffix: string, temporary: string) {
  return { path, temporary, originals: ['-wal', '-shm', ''].map((extension): [string, string] => [path + extension, path + suffix + extension]) }
}
function installRecovery(plan: ReturnType<typeof recoveryPlan>): void {
  // Both callers validate the copy before entering this mutation-only step.
  // Move sidecars first so an access failure cannot strand them beside a new ledger.
  for (const [original, parked] of plan.originals) {
    if (!existsSync(original)) continue
    if (existsSync(parked)) throw new Error('Ambiguous usage recovery files; originals were preserved')
    renameWithRetry(original, parked)
  }
  renameWithRetry(plan.temporary, plan.path)
  removeRecoveryArtifact(`${plan.path}.recovery-pending`)
}

/** Finish an interrupted restore using only validated, owned journal paths. */
export function replayUsageRecovery(path: string): void {
  const journal = `${path}.recovery-pending`
  if (!existsSync(journal)) return
  const record = JSON.parse(readFileSync(journal, 'utf8')) as { path?: unknown; temporary?: unknown; originals?: unknown }
  if (record.path !== path || typeof record.temporary !== 'string' || !record.temporary.startsWith(path + '.')
    || !new RegExp(`^${UUID}\\.recovered$`, 'i').test(record.temporary.slice(path.length + 1))
    || !Array.isArray(record.originals) || record.originals.length !== 3) throw new Error('Invalid usage recovery journal; files were preserved')
  const mainPair: unknown = record.originals[2]
  if (!Array.isArray(mainPair) || typeof mainPair[1] !== 'string' || !mainPair[1].startsWith(path)) throw new Error('Invalid usage recovery journal paths')
  const suffix = mainPair[1].slice(path.length)
  const plan = recoveryPlan(path, suffix, record.temporary)
  if (!new RegExp(`^\\.corrupt-\\d+-${UUID}$`, 'i').test(suffix)
    || JSON.stringify(record.originals) !== JSON.stringify(plan.originals)) throw new Error('Invalid usage recovery journal paths')
  // A valid durable copy records the user's restore choice, even before the
  // first move. A damaged copy can only be abandoned after originals are intact.
  if (existsSync(plan.temporary)) {
    let damaged = false
    try { validateUsageDatabase(plan.temporary) }
    catch (error) { if (!confirmedCorruption(error)) throw error; damaged = true }
    if (damaged) {
      for (const [original, parked] of [...plan.originals].reverse()) {
        if (!existsSync(parked)) continue
        if (existsSync(original)) throw new Error('Ambiguous usage recovery files; originals were preserved')
        renameWithRetry(parked, original)
      }
    } else installRecovery(plan)
  }
  // Missing copy means installation already finished; never roll parked corrupt
  // originals over a current ledger or a later deletion.
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
  let journalCreated = false
  try {
    const source = new DatabaseSync(backup, { readOnly: true })
    try { source.prepare('VACUUM INTO ?').run(temporary) } finally { source.close() }
    validateUsageDatabase(temporary)
    const copy = openSync(temporary, 'r+')
    try { fsyncSync(copy) } finally { closeSync(copy) }
    const suffix = `.corrupt-${Date.now()}-${randomUUID()}`
    const plan = recoveryPlan(path, suffix, temporary)
    // Replay above has settled any previous plan, including a journal whose
    // cleanup was locked. Replacing that stale journal is safe.
    writeFileSync(journal, JSON.stringify(plan), { flag: 'w', flush: true })
    journalCreated = true
    installRecovery(plan)
  } finally {
    // Once journaled, leave failures for the same replay path used after a crash.
    if (!journalCreated) removeRecoveryArtifact(temporary)
  }
}

/** Owned only by the usage worker. No writes are made to Copilot's source store. */
export class UsageLedger {
  private db: DatabaseSync
  private statements = new Map<string, StatementSync>()
  private warnings: string[] = []
  private recoveryWarning: string | null = null
  private backupDiagnostic: string | null = null
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
        if (!validateUsageDatabase(path, true) && this.hasAnyBackup()) throw new UsageDatabaseCorruptionError('Empty ledger has existing backups')
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
      if (missing && this.hasAnyBackup()) this.setMeta('missingLedgerWarning', '1')
      if (!this.meta('backupGeneration')) this.setMeta('backupGeneration', `generation-${randomUUID()}`)
      this.db.exec('COMMIT')
    } catch (error) { this.db.close(); throw error }
    try {
      if (!this.meta('timezone')) this.setMeta('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone)
      if (this.recoveryWarning) this.setMeta('recoveryWarning', this.recoveryWarning)
      const generation = this.meta('backupGeneration')!
      if (!new RegExp(`^generation-${UUID}$`, 'i').test(generation)) throw new Error('Invalid usage backup generation')
      this.backupDirectory = join(this.backupRoot, generation)
      this.cleanInterruptedCopies()
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
    for (const directory of [dirname(this.path), this.backupDirectory]) {
      if (!existsSync(directory)) continue
      const pattern = directory === this.backupDirectory
        ? new RegExp(`^(?:daily-\\d{4}-\\d{2}-\\d{2}|monthly-\\d{4}-\\d{2})\\.sqlite\\.${UUID}\\.tmp(?:-journal)?$`, 'i')
        : new RegExp(`^${basename(this.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${UUID}\\.(?:restore|recovered)$`, 'i')
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && pattern.test(entry.name)) {
          removeRecoveryArtifact(join(directory, entry.name))
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
  private save(sample: PendingSample): void {
    const saved = sample.kind === 'shutdown' ? { ...sample, key: `shutdown:${sample.session}:${this.shutdownIdentity(sample)}` } : sample
    if (this.stmt('INSERT OR IGNORE INTO samples VALUES (?,?)').run(saved.key, JSON.stringify(saved)).changes) this.cachedSamples = null
  }
  private shutdownIdentity(sample: Omit<Sample, 'key'>): string {
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
          this.setMeta(progressKey, JSON.stringify({ fingerprint, cursor, first, last }))
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
    const previous = JSON.parse(this.meta(progressKey) ?? 'null') as HistoryProgress | null
    if (previous?.signature === signature && previous.identity === identity) { this.warnings.push(...previous.warnings); return }
    const previousSize = previous?.signature ? Number(previous.signature.split(':')[0]) : previous?.offset
    const appended = previous && previous.identity === identity && (info.size > previousSize! || (info.size === previousSize && previous.signature === ''))
    const samples: PendingSample[] = []
    const warnings: string[] = appended ? [...previous.warnings] : []
    let start: string | null = appended ? previous.start : null
    let lastCheckpoint = appended ? previous.offset : 0
    const checkpoint = (offset: number, complete = false): void => {
      if (!complete && samples.length < 500 && offset - lastCheckpoint < 4 * 1024 * 1024) return
      const progress: HistoryProgress = { signature: complete ? signature : '', identity, offset, start, warnings }
      this.transaction(() => {
        for (const sample of samples) this.save(sample)
        this.setMeta(progressKey, JSON.stringify(progress))
      })
      samples.length = 0
      lastCheckpoint = offset
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
          samples.push({ session, model, at, start, kind: 'shutdown', ...value })
        }
      } catch (error) { if (warnings.length < 10) warnings.push(`Skipped invalid shutdown record: ${String(error)}`) }
    }, { allowPartial: true, allowEmpty: true, offset: appended ? previous.offset : 0, checkpoint })
    checkpoint(result.completeBytes, true)
    this.warnings.push(...warnings)
  }
  private *backupFiles(allGenerations = false): Generator<string> {
    const directories = new Set([this.backupDirectory])
    const entries = (directory: string): Dirent[] => {
      try { return readdirSync(directory, { withFileTypes: true }) } catch { return [] }
    }
    if (allGenerations) {
      directories.add(this.backupRoot)
      for (const entry of entries(this.backupRoot)) if (entry.isDirectory() && new RegExp(`^generation-${UUID}$`, 'i').test(entry.name)) directories.add(join(this.backupRoot, entry.name))
    }
    for (const directory of directories) for (const entry of entries(directory)) {
      if (!entry.isFile() || !/^(daily|monthly)-.*\.sqlite$/.test(entry.name)) continue
      yield join(directory, entry.name)
    }
  }
  private hasAnyBackup(): boolean {
    for (const _path of this.backupFiles(true)) return true
    return false
  }
  private backups(allGenerations = false): string[] {
    const files: Array<{ path: string; modified: number }> = []
    for (const path of this.backupFiles(allGenerations)) {
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
      // Retry state belongs to this live ledger, not to a portable snapshot.
      const copy = new DatabaseSync(temporary)
      // This unpublished copy is disposable on interruption. Avoid rollback
      // sidecars in arbitrary export folders; validate before publishing it.
      try { copy.exec("PRAGMA busy_timeout=1500; PRAGMA journal_mode=OFF; DELETE FROM metadata WHERE key IN ('backupStale','backupLastAttempt')") } finally { copy.close() }
      validateUsageDatabase(temporary)
      renameWithRetry(temporary, destination)
    } finally { removeRecoveryArtifact(temporary); removeRecoveryArtifact(`${temporary}-journal`) }
  }
  backup(force = false, now = new Date()): void {
    const day = now.toISOString().slice(0, 10)
    const daily = join(this.backupDirectory, `daily-${day}.sqlite`)
    const stale = this.backupWarning()
    const elapsed = now.getTime() - Date.parse(this.meta('backupLastAttempt') ?? '')
    if (!force && stale && Math.abs(elapsed) < 10 * 60_000) return
    if (force || stale || !existsSync(daily)) {
      // Persist before touching backup files so interruptions and worker restarts
      // retain the warning and force a retry even when today's backup exists.
      this.setMeta('backupStale', 'Usage is committed, but the backup refresh is pending. Collection will retry the backup.')
      this.setMeta('backupLastAttempt', now.toISOString())
      this.backupDiagnostic = null
      try {
        mkdirSync(this.backupDirectory, { recursive: true })
        this.exportTo(daily)
        const monthly = join(this.backupDirectory, `monthly-${day.slice(0, 7)}.sqlite`)
        this.exportTo(monthly)
        this.setMeta('lastBackup', now.toISOString())
        this.stmt("DELETE FROM metadata WHERE key='backupStale'").run()
      } catch (error) {
        // Keep detailed exceptions only in memory for the app log, never in the
        // portable ledger or user-facing report. Bound unusually large messages.
        this.backupDiagnostic = (error instanceof Error ? error.stack ?? String(error) : String(error)).slice(0, 8000)
        this.setMeta('backupStale', backupFailureWarning(error))
        throw error
      }
      // Only rotate after both replacement backups have passed integrity validation.
      const backups = this.backups()
      for (const [prefix, keep] of [['daily-', 30], ['monthly-', 12]] as const) {
        for (const file of backups.filter((path) => basename(path).startsWith(prefix)).slice(keep)) removeRecoveryArtifact(file)
      }
    }
  }
  backupWarning(): string | null { return this.meta('backupStale') }
  tryBackup(force = false): UsageFlushResult {
    try { this.backup(force) } catch (error) { if (!this.backupWarning()) throw error }
    return { backupWarning: this.backupWarning(), backupDiagnostic: this.backupDiagnostic }
  }
  restoreFrom(path: string): void {
    if (resolve(path).toLowerCase() === resolve(this.path).toLowerCase()) throw new Error('Select a backup rather than the active usage database')
    validateUsageDatabase(path)
    // Freeze the selected backup before rotation: it may itself be today's daily backup.
    const frozen = `${this.path}.${randomUUID()}.restore`
    try {
      const selected = new DatabaseSync(path, { readOnly: true })
      try { selected.prepare('VACUUM INTO ?').run(frozen) } finally { selected.close() }
      this.tryBackup(true)
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
    } finally { removeRecoveryArtifact(frozen) }
    this.tryBackup(true)
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
    const warnings = new Set<string>(JSON.parse(this.meta('warnings') ?? '[]') as string[])
    const backupWarning = this.backupWarning()
    if (backupWarning) warnings.add(backupWarning)
    const activeSource = `${hash(this.meta('sourcePath') ?? '')}:%`
    const rejected = Number(this.stmt('SELECT count(*) AS n FROM rejected_usage WHERE key LIKE ?').get(activeSource)?.n)
    if (rejected) {
      const reasons = this.stmt('SELECT DISTINCT reason FROM rejected_usage WHERE key LIKE ? LIMIT 3').all(activeSource).map((row) => row.reason).join('; ')
      warnings.add(`${rejected} invalid source usage row(s) were skipped; later rows are still collected. ${reasons}`)
    }
    const recoveryWarning = this.meta('recoveryWarning')
    if (recoveryWarning) warnings.add(recoveryWarning)
    if (this.meta('missingLedgerWarning') === '1') warnings.add(`The usage ledger was missing. Earlier usage may be absent from these totals. Use Restore backup to recover records from earlier generations under ${this.backupRoot}. Earlier generations are retained without rotation.`)
    warnings.add('Recorded usage may be incomplete where Copilot history was lost before collection. App scope includes whole sessions observed in the app, including usage outside the app.')
    const include = (sample: Sample, value: UsageCounts, reconciled: boolean): void => {
      const sampleMonth = monthOf(sample.at)
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
    return { month, timezone: zone, totals, unallocated,
      models: sort(models.values()), sessions: sort(sessions.values()), warnings: [...warnings],
      lastCollected: this.meta('lastCollected'), lastBackup: this.meta('lastBackup'), databasePath: this.path }
  }
}
