import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, lstatSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { emptyUsage, type UsageCounts, type UsageGroup, type UsageReport, type UsageScope } from './usage-types.js'
import { visitSessionHistoryLines } from './session-history.js'

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
  return [5, 6, 10, 14].includes((value?.errcode ?? -1) & 255) || ['EBUSY', 'EACCES', 'EPERM'].includes(value?.code ?? '')
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

/** Recovery is explicit or uses a verified local backup; originals are always retained. */
export function recoverUsageDatabase(path: string, backup: string): void {
  if (resolve(path).toLowerCase() === resolve(backup).toLowerCase()) throw new Error('Select a separate usage backup')
  validateUsageDatabase(backup)
  const temporary = `${path}.${randomUUID()}.recovered`
  try {
    const source = new DatabaseSync(backup, { readOnly: true })
    try { source.prepare('VACUUM INTO ?').run(temporary) } finally { source.close() }
    validateUsageDatabase(temporary)
    const suffix = `.corrupt-${Date.now()}`
    for (const extension of ['', '-wal', '-shm']) {
      if (existsSync(path + extension)) renameSync(path + extension, path + suffix + extension)
    }
    renameSync(temporary, path)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

/** Owned only by the usage worker. No writes are made to Copilot's source store. */
export class UsageLedger {
  private db: DatabaseSync
  private warnings: string[] = []
  private recoveryWarning: string | null = null
  private historySignatures = new Map<string, { signature: string; identity: string; size: number; offset: number; start: string | null; warnings: string[] }>()
  private cachedSamples: Sample[] | null = null
  private monthCache = { zone: '', values: new Map<string, string>() }
  private sourceProgress = new Map<string, { fingerprint: string; cursor: number; first: string; last: string; occurrences: Map<string, number> }>()
  readonly backupDirectory: string

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.backupDirectory = join(dirname(path), 'usage-backups')
    this.cleanInterruptedCopies()
    if (!existsSync(path) && this.backups().length) {
      const candidate = this.backups().find((file) => { try { validateUsageDatabase(file); return true } catch { return false } })
      if (!candidate) throw new UsageDatabaseCorruptionError('Usage ledger is missing and no valid backup is available; existing files were preserved')
      recoverUsageDatabase(path, candidate)
      this.recoveryWarning = 'Recovered a missing usage ledger from a verified backup. Usage since that backup may be missing.'
    }
    if (existsSync(path)) {
      try {
        if (!validateUsageDatabase(path, true) && this.backups().length) throw new UsageDatabaseCorruptionError('Empty ledger has existing backups')
      } catch (error) {
        // Lock, permission and I/O errors do not prove data corruption. Leave the ledger in place.
        if (!confirmedCorruption(error)) throw error
        const candidate = this.backups().find((file) => { try { validateUsageDatabase(file); return true } catch { return false } })
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
      PRAGMA user_version=1; COMMIT;`) } catch (error) { this.db.close(); throw error }
    if (!this.meta('timezone')) this.setMeta('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone)
    if (this.recoveryWarning) this.setMeta('recoveryWarning', this.recoveryWarning)
  }
  close(): void { this.db.close() }
  private cleanInterruptedCopies(): void {
    // A new worker starts only after the previous one exits. Restrict cleanup to our exact temporary names.
    const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
    for (const directory of [dirname(this.path), this.backupDirectory]) {
      if (!existsSync(directory)) continue
      const pattern = directory === this.backupDirectory
        ? new RegExp(`^(?:daily-\\d{4}-\\d{2}-\\d{2}|monthly-\\d{4}-\\d{2})\\.sqlite\\.${uuid}\\.tmp$`, 'i')
        : new RegExp(`^${basename(this.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${uuid}\\.restore$`, 'i')
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && pattern.test(entry.name)) {
          try { unlinkSync(join(directory, entry.name)) } catch { /* An AV lock can be retried on the next worker start. */ }
        }
      }
    }
  }
  private meta(key: string): string | null { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value as string | undefined) ?? null }
  private setMeta(key: string, value: string): void { this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, value) }
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
    if (this.db.prepare('INSERT OR IGNORE INTO samples VALUES (?,?)').run(sample.key, JSON.stringify(sample)).changes) this.cachedSamples = null
  }
  private shutdownIdentity(sample: Sample): string {
    const value = Object.fromEntries(COUNT_KEYS.map((key) => [key, sample[key]]))
    return hash({ at: sample.at, model: sample.model, start: sample.start, value })
  }
  associate(session: string, fork = false): void {
    this.db.prepare('INSERT INTO app_sessions VALUES (?,?) ON CONFLICT(session) DO UPDATE SET fork=max(fork,excluded.fork)').run(session, fork ? 1 : 0)
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
      const sourceVersion = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get()
        ? source.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get()?.version
        : source.prepare('PRAGMA user_version').get()?.user_version
      // Startup always reconciles the full source. During this process, validate the file identity and
      // first/cursor rows before resuming a bounded scan; recreated stores cannot hide behind reused IDs.
      const info = statSync(path)
      const fingerprint = `${info.dev}:${info.ino}:${info.birthtimeMs}:${fields}`
      const first = hash(source.prepare(`SELECT ${fields} FROM assistant_usage_events ORDER BY id LIMIT 1`).get() ?? null)
      const progress = this.sourceProgress.get(path)
      const unchanged = progress && progress.fingerprint === fingerprint && progress.first === first
        && hash(source.prepare(`SELECT ${fields} FROM assistant_usage_events WHERE id=?`).get(progress.cursor) ?? null) === progress.last
      const occurrences = new Map(unchanged ? progress.occurrences : [])
      let cursor = unchanged ? progress.cursor : 0
      let last = unchanged ? progress.last : hash(null)
      while (true) {
        const rows = source.prepare(`SELECT ${fields} FROM assistant_usage_events WHERE id>? ORDER BY id LIMIT 500`).all(cursor)
        if (!rows.length) break
        this.transaction(() => {
          for (const row of rows) {
            cursor = number(row.id)
            last = hash(row)
            let value: UsageCounts
            let at: string
            try { value = counts(row); at = timestamp(row.created_at) }
            catch (error) {
              this.db.prepare('INSERT OR REPLACE INTO rejected_usage VALUES (?,?)').run(hash({ path, id: row.id, row }), String(error).slice(0, 300))
              continue
            }
            const identity = Object.fromEntries([...REQUIRED, 'turn_index', 'agent_id', 'parent_tool_call_id'].filter((key) => key !== 'id').map((key) => [key, row[key] ?? null]))
            const digest = hash(identity)
            const occurrence = (occurrences.get(digest) ?? 0) + 1
            occurrences.set(digest, occurrence)
            const sample: Sample = { key: `request:${digest}:${occurrence}`, session: String(row.session_id), model: String(row.model),
              at, start: null, kind: 'request', ...value }
            this.save(sample)
          }
          this.setMeta('sourceProgress', JSON.stringify({ path, cursor, schema: sourceVersion }))
        })
      }
      this.sourceProgress.set(path, { fingerprint, cursor, first, last, occurrences })
    } finally { source.close() }
  }
  private async importHistory(path: string, session: string): Promise<void> {
    const info = lstatSync(path)
    if (!info.isFile()) throw new Error('History must be a regular file')
    const signature = `${info.size}:${info.mtimeMs}`
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
    const previous = this.historySignatures.get(path)
    if (previous?.signature === signature && previous.identity === identity) { this.warnings.push(...previous.warnings); return }
    const appended = previous && previous.identity === identity && info.size > previous.size
    const samples: Sample[] = []
    const warnings: string[] = appended ? [...previous.warnings] : []
    let start: string | null = appended ? previous.start : null
    const flush = (): void => { this.transaction(() => { for (const sample of samples) this.save(sample) }); samples.length = 0 }
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
      if (samples.length >= 500) flush()
    }, { allowPartial: true, allowEmpty: true, offset: appended ? previous.offset : 0 })
    flush()
    this.warnings.push(...warnings)
    this.historySignatures.set(path, { signature, identity, size: result.size, offset: result.completeBytes, start, warnings })
  }
  private backups(): string[] {
    if (!existsSync(this.backupDirectory)) return []
    return readdirSync(this.backupDirectory).filter((name) => /^(daily|monthly|manual)-.*\.sqlite$/.test(name))
      .map((name) => join(this.backupDirectory, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  }
  exportTo(destination: string): void {
    const normalized = resolve(destination).toLowerCase()
    const activePaths = [this.path, this.meta('sourcePath')].filter((path): path is string => path !== null)
    if (activePaths.some((path) => ['', '-wal', '-shm'].some((suffix) => normalized === resolve(path + suffix).toLowerCase()))) throw new Error('Choose an export location outside the active usage database and Copilot source store')
    // Never copy a live WAL database with filesystem copyFile.
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      this.db.prepare('VACUUM INTO ?').run(temporary)
      validateUsageDatabase(temporary)
      renameSync(temporary, destination)
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
        })
      } finally { source.close() }
    } finally { if (existsSync(frozen)) unlinkSync(frozen) }
    this.historySignatures.clear()
    this.sourceProgress.clear()
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
    const appSessions = new Map(this.db.prepare('SELECT session,fork FROM app_sessions').all().map((row) => [String(row.session), row.fork === 1]))
    const samples = this.cachedSamples ??= this.db.prepare('SELECT payload FROM samples').all().map((row) => JSON.parse(String(row.payload)) as Sample)
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
    const rejected = Number(this.db.prepare('SELECT count(*) AS n FROM rejected_usage').get()?.n)
    if (rejected) {
      const reasons = this.db.prepare('SELECT DISTINCT reason FROM rejected_usage LIMIT 3').all().map((row) => row.reason).join('; ')
      warnings.add(`${rejected} invalid source usage row(s) were skipped; later rows are still collected. ${reasons}`)
    }
    const recoveryWarning = this.meta('recoveryWarning')
    if (recoveryWarning) warnings.add(recoveryWarning)
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
