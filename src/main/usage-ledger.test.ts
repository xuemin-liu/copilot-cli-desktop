import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { UsageLedger, recoverUsageDatabase, replayUsageRecovery } from './usage-ledger.js'

const SESSION = '12345678-1234-1234-1234-123456789012'
async function fixture(action: (f: { root: string; home: string; path: string; source: DatabaseSync; ledger: UsageLedger; request: (at?: string, input?: number) => void; shutdown: (at: string, input: number) => void }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'usage-test-')), home = join(root, 'copilot'), path = join(root, 'app', 'usage.sqlite')
  mkdirSync(home)
  const source = new DatabaseSync(join(home, 'session-store.db'))
  source.exec(`PRAGMA journal_mode=WAL; CREATE TABLE assistant_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, created_at TEXT)`)
  const request = (at = '2026-09-08T01:00:00Z', input = 100): void => {
    source.prepare('INSERT INTO assistant_usage_events(session_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,created_at) VALUES (?,?,?,?,?,?,?,?)').run(SESSION, 'model', input, 20, 40, 10, 5, at)
  }
  const directory = join(home, 'session-state', SESSION)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'events.jsonl'), JSON.stringify({ type: 'session.start', timestamp: '2026-08-25T00:00:00Z', data: { startTime: '2026-08-25T00:00:00Z' } }) + '\n')
  const shutdown = (at: string, input: number): void => {
    appendFileSync(join(directory, 'events.jsonl'), JSON.stringify({ type: 'session.shutdown', timestamp: at, data: { modelMetrics: { model: { usage: { inputTokens: input, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 5 } } } } }) + '\n')
  }
  const ledger = new UsageLedger(path)
  try { await action({ root, home, path, source, ledger, request, shutdown }) }
  finally { try { ledger.close() } catch {} try { source.close() } catch {} rmSync(root, { recursive: true, force: true }) }
}

test('imports a live WAL store, separates gross input, and rescans without duplicates', () => fixture(async ({ ledger, home, request }) => {
  request(); await ledger.collect(home); await ledger.collect(home)
  const report = ledger.report('2026-09', 'all', 'UTC')
  assert.deepEqual(report.totals, { input: 50, output: 20, cacheRead: 40, cacheWrite: 10, reasoning: 5 })
  assert.equal(report.models[0]?.requests, 1)
  assert.equal(ledger.report('2026-09', 'app').models.length, 0)
  ledger.associate(SESSION)
  assert.equal(ledger.report('2026-09', 'app').totals.input, 50)
}))

test('identical requests are retained; reused source IDs do not duplicate restored rows', () => fixture(async ({ ledger, home, request, source }) => {
  request(); request(); await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 2)
  source.exec('DELETE FROM assistant_usage_events; DELETE FROM sqlite_sequence')
  request(); request(); request('2026-09-09T01:00:00Z'); await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 3)
}))

test('saved usage survives deleting source history and reopening after an update', () => fixture(async ({ ledger, source, path, home, request }) => {
  request(); await ledger.collect(home); ledger.backup(true)
  const before = ledger.report('2026-09')
  ledger.close(); source.close(); rmSync(home, { recursive: true })
  const upgraded = new UsageLedger(path)
  try { await upgraded.collect(home); assert.deepEqual(upgraded.report('2026-09').totals, before.totals) }
  finally { upgraded.close() }
}))

test('snapshot deltas preserve earlier months and never double-count request coverage', () => fixture(async ({ ledger, home, request, shutdown }) => {
  request('2026-08-26T00:00:00Z')
  shutdown('2026-08-27T00:00:00Z', 150)
  await ledger.collect(home)
  assert.equal(ledger.report('2026-08', 'all', 'UTC').totals.input, 100)
  shutdown('2026-09-08T00:00:00Z', 250)
  await ledger.collect(home)
  const august = ledger.report('2026-08')
  assert.equal(august.totals.input, 100)
  assert.equal(august.unallocated.input, 100)
  assert.equal(ledger.report('2026-09').totals.input, 0)
}))

test('month boundaries use a persisted timezone and reject invalid timezones', () => fixture(async ({ ledger, home, request }) => {
  request('2026-09-01T01:00:00Z'); await ledger.collect(home)
  assert.equal(ledger.report('2026-08', 'all', 'America/Chicago').totals.input, 50)
  assert.equal(ledger.report('2026-09').totals.input, 0)
  assert.throws(() => ledger.report('2026-09', 'all', 'invalid/timezone'))
  assert.throws(() => ledger.report('2026-13'))
}))

test('backup restore merges older records without losing newer usage or duplicating it', () => fixture(async ({ ledger, home, request, root, path }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'export.sqlite'); ledger.exportTo(backup)
  request('2026-09-09T00:00:00Z'); await ledger.collect(home)
  ledger.restoreFrom(backup); ledger.restoreFrom(backup)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 2)
  assert.throws(() => ledger.exportTo(path), /active usage database/)
  assert.throws(() => ledger.restoreFrom(path), /active usage database/)
}))

test('backup-only failures before or after restore do not misreport a committed merge', async (t) => {
  for (const phase of ['before', 'after', 'both']) await fixture(async ({ ledger, home, request, root }) => {
    request(); await ledger.collect(home)
    const backup = join(root, 'selected.sqlite'); ledger.exportTo(backup)
    ledger['db'].exec('DELETE FROM samples')
    let calls = 0
    const publish = ledger.exportTo.bind(ledger)
    t.mock.method(ledger, 'exportTo', (destination: string) => {
      calls++
      if (phase === 'both' || calls === (phase === 'before' ? 1 : 3)) throw Object.assign(new Error('backup volume full'), { code: 'ENOSPC' })
      publish(destination)
    })
    try {
      ledger.restoreFrom(backup)
      assert.equal(ledger.report('2026-09').totals.input, 50)
      if (phase === 'before') assert.equal(ledger.backupWarning(), null, 'the successful post-merge backup clears the earlier failure')
      else assert.match(ledger.backupWarning()!, /not enough disk space/)
    } finally { t.mock.restoreAll() }
  })
})

test('corruption restores a verified backup and preserves original damaged files', () => fixture(async ({ ledger, home, request, path }) => {
  request(); await ledger.collect(home); ledger.backup(true); ledger.close()
  writeFileSync(path, 'damaged')
  const recovered = new UsageLedger(path)
  try {
    assert.equal(recovered.report('2026-09').totals.input, 50)
    assert.match(recovered.report('2026-09').warnings.join(' '), /Recovered usage/)
    assert.ok(readdirSync(join(path, '..')).some((file) => file.includes('.corrupt-')))
  } finally { recovered.close() }
}))

test('corruption without a backup fails closed; explicit exported-backup recovery works', () => fixture(async ({ ledger, home, request, root, path }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'export.sqlite'); ledger.exportTo(backup); ledger.close()
  writeFileSync(path, 'damaged')
  assert.throws(() => new UsageLedger(path), /Original files preserved/)
  assert.equal(readFileSync(path, 'utf8'), 'damaged')
  recoverUsageDatabase(path, backup)
  const recovered = new UsageLedger(path)
  try { assert.equal(recovered.report('2026-09').totals.input, 50) } finally { recovered.close() }
}))

test('future ledger versions are never reset or replaced by an older backup', () => fixture(async ({ ledger, path }) => {
  ledger.backup(true); ledger.close()
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=2'); db.close()
  assert.throws(() => new UsageLedger(path), /Unsupported usage database version/)
  const verify = new DatabaseSync(path, { readOnly: true })
  try { assert.equal(verify.prepare('PRAGMA user_version').get()?.user_version, 2) } finally { verify.close() }
}))

test('schema drift or invalid counters warn without removing previously saved usage', () => fixture(async ({ ledger, home, request, source }) => {
  request(); await ledger.collect(home)
  source.exec('ALTER TABLE assistant_usage_events ADD COLUMN future_column TEXT')
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
  request('2026-09-09T00:00:00Z', 5); await ledger.collect(home)
  assert.match(ledger.report('2026-09').warnings.join(' '), /Cache counters exceed/)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
  source.exec('ALTER TABLE assistant_usage_events RENAME COLUMN input_tokens TO renamed_input')
  await ledger.collect(home)
  assert.match(ledger.report('2026-09').warnings.join(' '), /required columns/)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
}))

test('failed backup validation rolls back the entire merge', () => fixture(async ({ ledger, root, home, request }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'bad-record.sqlite'); ledger.exportTo(backup)
  const db = new DatabaseSync(backup)
  db.prepare('INSERT INTO samples VALUES (?,?)').run('bad', '{"kind":"request","key":"bad"}')
  db.close()
  assert.throws(() => ledger.restoreFrom(backup))
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
}))

test('a full destination disk leaves previously committed usage intact', () => fixture(async ({ ledger, home, request, source }) => {
  request(); await ledger.collect(home)
  // SQLite's real page limit simulates SQLITE_FULL without filling the host drive.
  const db = ledger['db']
  const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count)
  db.exec(`PRAGMA max_page_count=${pages}`)
  request('2026-09-10T00:00:00Z')
  source.prepare('UPDATE assistant_usage_events SET model=? WHERE id=2').run('large-model-'.repeat(10000))
  await ledger.collect(home)
  const report = ledger.report('2026-09')
  assert.equal(report.models[0]?.requests, 1)
  assert.match(report.warnings.join(' '), /full/i)
}))

test('known fork shutdowns do not add inherited usage and partial tail lines are retried', () => fixture(async ({ ledger, home, shutdown, request }) => {
  request('2026-08-26T00:00:00Z'); shutdown('2026-08-27T00:00:00Z', 200)
  ledger.associate(SESSION, true); await ledger.collect(home)
  assert.equal(ledger.report('2026-08', 'app', 'UTC').totals.input, 50)
  const path = join(home, 'session-state', SESSION, 'events.jsonl')
  appendFileSync(path, '{"type":"session.shutdown"')
  await ledger.collect(home)
  assert.equal(ledger.report('2026-08').totals.input, 50)
  assert.ok(!ledger.report('2026-08').warnings.some((warning) => warning.includes('could not be imported')))
}))

test('backup rotation keeps the promised daily and monthly retention', () => fixture(async ({ ledger }) => {
  for (let index = 0; index < 40; index++) ledger.backup(true, new Date(Date.UTC(2026, 0, index + 1)))
  assert.equal(readdirSync(ledger.backupDirectory).filter((file) => file.startsWith('daily-')).length, 30)
  for (let index = 0; index < 15; index++) ledger.backup(true, new Date(Date.UTC(2026, index, 1)))
  assert.equal(readdirSync(ledger.backupDirectory).filter((file) => file.startsWith('monthly-')).length, 12)
}))

test('retention ignores daily and monthly prefixes in ancestor directory names', () => fixture(async ({ root }) => {
  const nested = new UsageLedger(join(root, 'daily-build', 'monthly-data', 'usage.sqlite'))
  try {
    for (let index = 0; index < 40; index++) nested.backup(true, new Date(Date.UTC(2026, 0, index + 1)))
    for (let index = 0; index < 15; index++) nested.backup(true, new Date(Date.UTC(2026, index, 1)))
    const files = readdirSync(nested.backupDirectory)
    assert.equal(files.filter((file) => file.startsWith('daily-')).length, 30)
    assert.equal(files.filter((file) => file.startsWith('monthly-')).length, 12)
  } finally { nested.close() }
}))

test('failed forced backups persist across restart and retry despite an existing daily copy', async (t) => fixture(async ({ ledger, home, request, path }) => {
  const now = new Date('2026-09-08T12:00:00Z')
  request(); await ledger.collect(home); ledger.backup(true, now)
  request(); await ledger.collect(home)
  t.mock.method(ledger, 'exportTo', () => { throw new Error('backup locked') })
  assert.throws(() => ledger.backup(true, now), /backup locked/)
  assert.match(ledger.report('2026-09').warnings.join(' '), /backup refresh failed/)
  ledger.close()
  const reopened = new UsageLedger(path)
  try {
    assert.match(reopened.report('2026-09').warnings.join(' '), /backup refresh failed/)
    const exported = t.mock.method(reopened, 'exportTo', () => { throw new Error('still locked') })
    await reopened.collect(home)
    reopened.backup(false, new Date(now.getTime() - 60_000))
    assert.equal(exported.mock.callCount(), 0, 'a clock rollback must not bypass the retry bound')
    for (let seconds = 30; seconds < 600; seconds += 30) reopened.backup(false, new Date(now.getTime() + seconds * 1000))
    assert.equal(exported.mock.callCount(), 0, 'routine retries must remain throttled after restart')
    assert.throws(() => reopened.backup(false, new Date(now.getTime() + 600_000)), /still locked/)
    assert.equal(exported.mock.callCount(), 1)
    t.mock.restoreAll()
    reopened.backup(true, new Date(now.getTime() + 600_001))
    assert.doesNotMatch(reopened.report('2026-09').warnings.join(' '), /backup refresh/)
    for (const file of readdirSync(reopened.backupDirectory)) {
      const backup = new DatabaseSync(join(reopened.backupDirectory, file), { readOnly: true })
      try {
        assert.equal(backup.prepare('SELECT count(*) AS n FROM samples').get()?.n, 2)
        assert.equal(backup.prepare("SELECT count(*) AS n FROM metadata WHERE key IN ('backupStale','backupLastAttempt')").get()?.n, 0)
      } finally { backup.close() }
    }
  } finally { reopened.close() }
}))

test('backup warnings are bounded and stable across publish errors with different temporary paths', async (t) => fixture(async ({ ledger, root }) => {
  const attempted: string[] = []
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    attempted.push(String(from))
    throw Object.assign(new Error(`publish blocked: rename '${from}' -> '${to}' ${'private detail '.repeat(1000)}`), { code: 'EPERM' })
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => ledger.backup(true), /publish blocked/)
    const first = ledger.backupWarning()!
    assert.throws(() => ledger.backup(true), /publish blocked/)
    assert.equal(ledger.backupWarning(), first)
    assert.equal(new Set(attempted).size, 2)
    assert.ok(first.length < 200)
    assert.match(first, /EPERM.*denied/)
    assert.ok(!first.includes(root) && !first.includes('.tmp') && !first.includes('private detail'))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('unmapped backup errors retain diagnostic detail in memory but never in the ledger report or metadata', async (t) => fixture(async ({ ledger, path }) => {
  const marker = 'unmapped-filter-driver-diagnostic'
  t.mock.method(ledger, 'exportTo', () => { throw new TypeError(marker) })
  const result = ledger.tryBackup(true)
  assert.match(result.backupWarning!, /UNKNOWN/)
  assert.match(result.backupDiagnostic!, /TypeError: unmapped-filter-driver-diagnostic/)
  assert.ok(!ledger.report('2026-09').warnings.join(' ').includes(marker))
  assert.ok(!JSON.stringify(ledger['db'].prepare('SELECT * FROM metadata').all()).includes(marker))
  assert.equal(ledger.tryBackup().backupDiagnostic, null, 'a throttled call must not resend the previous stack')
  ledger.close()
  const reopened = new UsageLedger(path)
  try {
    const deferred = reopened.tryBackup()
    assert.equal(deferred.backupWarning, result.backupWarning)
    assert.equal(deferred.backupDiagnostic, null)
  } finally { reopened.close() }
}))

test('backup diagnostics describe early metadata failures and clear on success or a skipped backup', async (t) => fixture(async ({ ledger }) => {
  t.mock.method(ledger, 'exportTo', () => { throw new Error('old publication failure') })
  assert.match(ledger.tryBackup(true).backupDiagnostic!, /old publication failure/)
  const setMeta = ledger['setMeta'].bind(ledger)
  t.mock.method(ledger as unknown as { setMeta: typeof setMeta }, 'setMeta', (key: string, value: string) => {
    if (key === 'backupLastAttempt') throw Object.assign(new Error('current metadata busy'), { errcode: 5 })
    setMeta(key, value)
  })
  const failed = ledger.tryBackup(true)
  assert.match(failed.backupDiagnostic!, /current metadata busy/)
  assert.doesNotMatch(failed.backupDiagnostic!, /old publication failure/)
  t.mock.restoreAll()
  assert.deepEqual(ledger.tryBackup(true), { backupWarning: null, backupDiagnostic: null })
  assert.deepEqual(ledger.tryBackup(), { backupWarning: null, backupDiagnostic: null })
}))

test('a failed warning write preserves the original backup exception and diagnostic', async (t) => fixture(async ({ ledger }) => {
  const original = Object.assign(new Error('original export destination is full'), { code: 'ENOSPC' })
  const secondary = Object.assign(new Error('secondary warning metadata is full'), { errcode: 13 })
  t.mock.method(ledger, 'exportTo', () => { throw original })
  const setMeta = ledger['setMeta'].bind(ledger)
  t.mock.method(ledger as unknown as { setMeta: typeof setMeta }, 'setMeta', (key: string, value: string) => {
    if (key === 'backupStale' && value.includes('refresh failed')) throw secondary
    setMeta(key, value)
  })
  assert.throws(() => ledger.backup(true), (error) => error === original)
  const result = ledger.tryBackup(true)
  assert.match(result.backupWarning!, /refresh is pending/)
  assert.match(result.backupDiagnostic!, /original export destination is full/)
  assert.doesNotMatch(result.backupDiagnostic!, /secondary warning metadata/)
}))

test('a far-future backup timestamp permits one fresh retry and then resumes the normal interval', async (t) => fixture(async ({ ledger, path }) => {
  const now = new Date('2026-09-08T12:00:00Z')
  const future = new Date('2027-09-08T12:00:00Z')
  t.mock.method(ledger, 'exportTo', () => { throw new Error('backup unavailable') })
  assert.throws(() => ledger.backup(true, future), /backup unavailable/)
  ledger.close()
  const reopened = new UsageLedger(path)
  try {
    const attempted = t.mock.method(reopened, 'exportTo', () => { throw new Error('backup still unavailable') })
    assert.throws(() => reopened.backup(false, now), /backup still unavailable/)
    for (let seconds = 30; seconds < 600; seconds += 30) reopened.backup(false, new Date(now.getTime() + seconds * 1000))
    assert.equal(attempted.mock.callCount(), 1)
    assert.throws(() => reopened.backup(false, new Date(now.getTime() + 600_000)), /backup still unavailable/)
    assert.equal(attempted.mock.callCount(), 2)
  } finally { reopened.close() }
}))

test('a missing ledger records its recovery hint from listed backups without probing their accessibility', async (t) => fixture(async ({ ledger, path }) => {
  ledger.backup(true); ledger.close(); rmSync(path)
  const stat = fs.statSync
  let backupStats = 0
  t.mock.method(fs, 'statSync', (file: fs.PathLike, options?: any) => {
    if (String(file).includes('usage-backups')) backupStats++
    return stat(file, options)
  })
  syncBuiltinESMExports()
  let reopened: UsageLedger | undefined
  try {
    reopened = new UsageLedger(path)
    assert.match(reopened.report('2026-09').warnings.join(' '), /ledger was missing/)
    assert.equal(backupStats, 0)
  } finally { reopened?.close(); t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('a missing-ledger hint survives inaccessible backups and later restarts until restore', async (t) => fixture(async ({ ledger, path, home, request }) => {
  request(); await ledger.collect(home); ledger.backup(true); ledger.close(); rmSync(path)
  const selected = join(ledger.backupDirectory, readdirSync(ledger.backupDirectory).find((file) => file.startsWith('daily-'))!)
  const stat = fs.statSync
  t.mock.method(fs, 'statSync', (file: fs.PathLike, options?: any) => {
    if (String(file).startsWith(ledger.backupDirectory)) throw Object.assign(new Error('backup held by scanner'), { code: 'EBUSY' })
    return stat(file, options)
  })
  syncBuiltinESMExports()
  let fresh: UsageLedger | undefined
  try {
    fresh = new UsageLedger(path)
    assert.equal(fresh.report('2026-09').totals.input, 0)
    assert.match(fresh.report('2026-09').warnings.join(' '), /ledger was missing/)
  } finally { fresh?.close(); t.mock.restoreAll(); syncBuiltinESMExports() }
  const reopened = new UsageLedger(path)
  try {
    assert.match(reopened.report('2026-09').warnings.join(' '), /ledger was missing/)
    reopened.restoreFrom(selected)
    assert.equal(reopened.report('2026-09').totals.input, 50)
    assert.doesNotMatch(reopened.report('2026-09').warnings.join(' '), /ledger was missing/)
  } finally { reopened.close() }
}))

test('an empty ledger initializes when all listed backup candidates are inaccessible', async (t) => fixture(async ({ ledger, path }) => {
  ledger.backup(true); ledger.close(); writeFileSync(path, '')
  const stat = fs.statSync
  const originalBackups = readdirSync(ledger.backupDirectory)
  t.mock.method(fs, 'statSync', (file: fs.PathLike, options?: any) => {
    if (String(file).startsWith(ledger.backupDirectory)) throw Object.assign(new Error('backup temporarily unavailable'), { code: 'EACCES' })
    return stat(file, options)
  })
  syncBuiltinESMExports()
  let reopened: UsageLedger | undefined
  try {
    reopened = new UsageLedger(path)
    assert.equal(reopened.report('2026-09').totals.input, 0)
    assert.deepEqual(readdirSync(ledger.backupDirectory), originalBackups)
  } finally { reopened?.close(); t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('locked retention files do not mark fresh backups stale or cause repeated copies', async (t) => fixture(async ({ ledger }) => {
  const now = new Date('2026-09-08T12:00:00Z')
  ledger.backup(true, now)
  const daily = join(ledger.backupDirectory, 'daily-2026-09-08.sqlite')
  const oldest = join(ledger.backupDirectory, 'daily-2020-01-01.sqlite')
  for (let day = 1; day <= 30; day++) {
    const file = join(ledger.backupDirectory, `daily-2020-01-${String(day).padStart(2, '0')}.sqlite`)
    copyFileSync(daily, file)
    fs.utimesSync(file, day, day)
  }
  const unlink = fs.unlinkSync
  const exported = t.mock.method(ledger, 'exportTo', ledger.exportTo.bind(ledger))
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file) === oldest) throw Object.assign(new Error('retention locked'), { code: 'EPERM' })
    unlink(file)
  })
  syncBuiltinESMExports()
  try {
    ledger.backup(true, now)
    assert.equal(ledger.backupWarning(), null)
    for (let seconds = 30; seconds < 600; seconds += 30) ledger.backup(false, new Date(now.getTime() + seconds * 1000))
    assert.equal(exported.mock.callCount(), 2)
    assert.equal(readdirSync(ledger.backupDirectory).filter((file) => file.startsWith('daily-')).length, 31)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  ledger.backup(true, now)
  assert.equal(readdirSync(ledger.backupDirectory).filter((file) => file.startsWith('daily-')).length, 30)
}))

test('recovering a backup does not inherit the original ledger backup attempt state', () => fixture(async ({ ledger, path, home, request }) => {
  request(); await ledger.collect(home); ledger.backup(true); ledger.close()
  writeFileSync(path, 'corrupt original')
  const recovered = new UsageLedger(path)
  try {
    assert.equal(recovered.report('2026-09').totals.input, 50)
    assert.match(recovered.report('2026-09').warnings.join(' '), /Recovered usage/)
    assert.doesNotMatch(recovered.report('2026-09').warnings.join(' '), /backup refresh/)
  } finally { recovered.close() }
}))

test('locked restore-copy cleanup does not mask the merge or skip its backup', async (t) => fixture(async ({ ledger, home, request, root }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'export.sqlite'); ledger.exportTo(backup)
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file).endsWith('.restore')) throw Object.assign(new Error('cleanup locked'), { code: 'EPERM' })
    unlink(file)
  })
  syncBuiltinESMExports()
  const backups = t.mock.method(ledger, 'backup', ledger.backup.bind(ledger))
  try {
    ledger.restoreFrom(backup)
    assert.equal(ledger.report('2026-09').totals.input, 50)
    assert.equal(backups.mock.callCount(), 2)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('export cleanup preserves the original export error when its temporary is locked', async (t) => fixture(async ({ ledger, root }) => {
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'renameSync', () => { throw new Error('export destination unavailable') })
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file).endsWith('.tmp')) throw Object.assign(new Error('cleanup locked'), { code: 'EPERM' })
    unlink(file)
  })
  syncBuiltinESMExports()
  try { assert.throws(() => ledger.exportTo(join(root, 'export.sqlite')), /export destination unavailable/) }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('invalid rows do not prevent later usage from being collected and warnings persist', () => fixture(async ({ ledger, home, request, source }) => {
  request(); request('2026-09-09T00:00:00Z'); request('2026-09-10T00:00:00Z')
  source.exec('UPDATE assistant_usage_events SET input_tokens=NULL WHERE id=2')
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 2)
  request('2026-09-11T00:00:00Z')
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 3)
  assert.match(ledger.report('2026-09').warnings.join(' '), /1 invalid source usage row/)
}))

test('incomplete rows are retried by ID and their warning clears after repair or deletion', () => fixture(async ({ ledger, home, request, source }) => {
  request(); request(); request()
  source.exec('UPDATE assistant_usage_events SET input_tokens=NULL WHERE id=2')
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 2)
  source.exec('UPDATE assistant_usage_events SET output_tokens=NULL WHERE id=2')
  await ledger.collect(home)
  assert.match(ledger.report('2026-09').warnings.join(' '), /1 invalid source usage row/)
  source.exec('UPDATE assistant_usage_events SET input_tokens=100,output_tokens=20 WHERE id=2')
  await ledger.collect(home); await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 3)
  assert.doesNotMatch(ledger.report('2026-09').warnings.join(' '), /invalid source usage row/)
  request(); request()
  source.exec('UPDATE assistant_usage_events SET input_tokens=NULL WHERE id=4')
  await ledger.collect(home)
  source.exec('DELETE FROM assistant_usage_events WHERE id=4')
  await ledger.collect(home)
  assert.doesNotMatch(ledger.report('2026-09').warnings.join(' '), /invalid source usage row/)
}))

test('a large rejected backlog is retried in bounded batches without starving new requests', () => fixture(async ({ ledger, home, request, source }) => {
  for (let index = 0; index < 602; index++) request()
  source.exec('UPDATE assistant_usage_events SET input_tokens=NULL WHERE id BETWEEN 2 AND 601')
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 2)
  source.exec('UPDATE assistant_usage_events SET input_tokens=100 WHERE id BETWEEN 2 AND 601')
  request('2026-09-09T00:00:00Z')
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 503)
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 603)
  assert.doesNotMatch(ledger.report('2026-09').warnings.join(' '), /invalid source usage row/)
}))

test('interrupted request batches resume from a durable cursor without recounting duplicates', () => fixture(async ({ ledger, home, request, path }) => {
  for (let index = 0; index < 601; index++) request()
  const originalSave = ledger['save'].bind(ledger)
  let saved = 0
  ledger['save'] = (sample) => { if (++saved > 500) throw new Error('simulated interruption'); originalSave(sample) }
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 500)
  ledger.close()
  const reopened = new UsageLedger(path)
  try {
    let resumed = 0
    const save = reopened['save'].bind(reopened)
    reopened['save'] = (sample) => { resumed++; save(sample) }
    await reopened.collect(home)
    assert.equal(resumed, 101)
    assert.equal(reopened.report('2026-09').models[0]?.requests, 601)
    await reopened.collect(home)
    assert.equal(resumed, 101)
  } finally { reopened.close() }
}))

test('history progress commits at chunk boundaries and survives an interrupted scan', () => fixture(async ({ ledger, home, path, shutdown }) => {
  const history = join(home, 'session-state', SESSION, 'events.jsonl')
  appendFileSync(history, (JSON.stringify({ type: 'assistant.message', data: { content: 'x'.repeat(1000) } }) + '\n').repeat(9000))
  shutdown('2026-08-27T00:00:00Z', 200)
  const setMeta = ledger['setMeta'].bind(ledger)
  ledger['setMeta'] = (key, value) => {
    if (key.startsWith('historyProgress:') && JSON.parse(value).offset > 5 * 1024 * 1024) throw new Error('simulated interruption')
    setMeta(key, value)
  }
  await ledger.collect(home)
  const progress = ledger['db'].prepare("SELECT value FROM metadata WHERE key LIKE 'historyProgress:%'").get()
  assert.ok(JSON.parse(String(progress?.value)).offset > 0)
  ledger.close()
  const reopened = new UsageLedger(path)
  try {
    await reopened.collect(home)
    assert.equal(reopened.report('2026-08', 'all', 'UTC').totals.input, 150)
    assert.doesNotMatch(reopened.report('2026-08').warnings.join(' '), /simulated interruption/)
  } finally { reopened.close() }
}))

test('a missing ledger preserves old restore points across forced backups and restart', () => fixture(async ({ ledger, path, home, request }) => {
  request(); await ledger.collect(home); ledger.backup(true); ledger.close(); rmSync(path)
  const originals = readdirSync(ledger.backupDirectory).map((name) => [name, readFileSync(join(ledger.backupDirectory, name))] as const)
  const fresh = new UsageLedger(path)
  assert.match(fresh.report('2026-09').warnings.join(' '), /ledger was missing/)
  fresh.backup(true)
  const preserved = ledger.backupDirectory
  assert.notEqual(fresh.backupDirectory, preserved)
  fresh.close()
  const reopened = new UsageLedger(path)
  try {
    reopened.backup(true, new Date('2026-10-01T00:00:00Z'))
    for (const [name, bytes] of originals) assert.deepEqual(readFileSync(join(preserved, name)), bytes)
    reopened.restoreFrom(join(preserved, originals[0]![0]))
    assert.equal(reopened.report('2026-09').totals.input, 50)
    assert.doesNotMatch(reopened.report('2026-09').warnings.join(' '), /ledger was missing/)
  } finally { reopened.close() }
}))

test('failed restore renames retain originals and use startup replay for every boundary', async (t) => {
  for (const failure of ['-wal', '-shm', '', 'install']) await fixture(async ({ ledger, path, root, home, request }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'export.sqlite')
  ledger.exportTo(backup); ledger.close()
  const bytes = readFileSync(path)
  const rename = fs.renameSync
    writeFileSync(path + '-wal', 'original wal'); writeFileSync(path + '-shm', 'original shm')
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (failure === 'install' ? String(from).endsWith('.recovered') : String(from) === path + failure) throw Object.assign(new Error('access denied'), { code: 'EPERM' })
      rename(from, to)
    })
    syncBuiltinESMExports()
    try { assert.throws(() => recoverUsageDatabase(path, backup), /access denied/) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    const journal = JSON.parse(readFileSync(`${path}.recovery-pending`, 'utf8')) as { originals: [string, string][] }
    for (const [original, parked] of journal.originals) {
      const expected = original.endsWith('-wal') ? Buffer.from('original wal') : original.endsWith('-shm') ? Buffer.from('original shm') : bytes
      assert.deepEqual(readFileSync(fs.existsSync(original) ? original : parked), expected)
    }
    replayUsageRecovery(path)
    assert.ok(!fs.existsSync(`${path}.recovery-pending`))
    const reopened = new UsageLedger(path)
    try { assert.equal(reopened.report('2026-09').totals.input, 50) } finally { reopened.close() }
  })
})

test('an invalid recovery journal preserves all evidence and never moves arbitrary files', () => fixture(async ({ ledger, path }) => {
  ledger.close(); rmSync(path)
  const copy = `${path}.11111111-1111-4111-8111-111111111111.recovered`
  writeFileSync(copy, 'recovery evidence')
  writeFileSync(`${path}.recovery-pending`, '{}')
  assert.throws(() => new UsageLedger(path), /Invalid usage recovery journal/)
  assert.equal(readFileSync(copy, 'utf8'), 'recovery evidence')
}))

test('startup completes recovery at every interrupted rename boundary', async () => {
  for (let completed = 0; completed <= 4; completed++) await fixture(async ({ ledger, path, home, request }) => {
    request(); await ledger.collect(home)
    const temporary = `${path}.11111111-1111-4111-8111-111111111111.recovered`
    ledger.exportTo(temporary)
    request(); await ledger.collect(home); ledger.close()
    writeFileSync(path + '-wal', 'old wal'); writeFileSync(path + '-shm', 'old shm')
    const suffix = '.corrupt-1-22222222-2222-4222-8222-222222222222'
    const originals = ['-wal', '-shm', ''].map((extension) => [path + extension, path + suffix + extension])
    writeFileSync(`${path}.recovery-pending`, JSON.stringify({ path, temporary, originals }))
    for (const [from, to] of originals.slice(0, Math.min(completed, 3))) fs.renameSync(from!, to!)
    if (completed === 4) fs.renameSync(temporary, path)
    const reopened = new UsageLedger(path)
    try {
      assert.equal(reopened.report('2026-09').models[0]?.requests, 1)
      assert.ok(!fs.existsSync(`${path}.recovery-pending`))
      assert.equal(readFileSync(path + suffix + '-wal', 'utf8'), 'old wal')
    } finally { reopened.close() }
  })
})

test('a locked recovery journal does not turn a completed restore into a failure', async (t) => fixture(async ({ ledger, path, root, home, request }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'export.sqlite'); ledger.exportTo(backup); ledger.close()
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file).endsWith('.recovery-pending')) throw Object.assign(new Error('journal locked'), { code: 'EPERM' })
    unlink(file)
  })
  syncBuiltinESMExports()
  try {
    recoverUsageDatabase(path, backup)
    // A stale journal that cannot be unlinked must not block a new explicit restore.
    recoverUsageDatabase(path, backup)
    const reopened = new UsageLedger(path)
    try { assert.equal(reopened.report('2026-09').totals.input, 50) } finally { reopened.close() }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  const retried = new UsageLedger(path)
  retried.close()
  assert.ok(!fs.existsSync(`${path}.recovery-pending`))
}))

test('a truncated unstarted recovery copy cannot block the intact ledger or explicit restore', () => fixture(async ({ ledger, path, root, home, request }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'export.sqlite'); ledger.exportTo(backup)
  request(); await ledger.collect(home); ledger.close()
  const temporary = `${path}.11111111-1111-4111-8111-111111111111.recovered`
  const suffix = '.corrupt-1-22222222-2222-4222-8222-222222222222'
  const journal = { path, temporary, originals: ['-wal', '-shm', ''].map((extension) => [path + extension, path + suffix + extension]) }
  writeFileSync(temporary, 'truncated copy')
  writeFileSync(`${path}.recovery-pending`, JSON.stringify(journal))
  const reopened = new UsageLedger(path)
  try { assert.equal(reopened.report('2026-09').models[0]?.requests, 2) } finally { reopened.close() }
  writeFileSync(temporary, 'truncated copy')
  writeFileSync(`${path}.recovery-pending`, JSON.stringify(journal))
  recoverUsageDatabase(path, backup)
  const restored = new UsageLedger(path)
  try { assert.equal(restored.report('2026-09').models[0]?.requests, 1) } finally { restored.close() }
}))

test('a damaged recovery copy restores parked originals at every move boundary and permits retry', async () => {
  for (let completed = 1; completed <= 3; completed++) await fixture(async ({ ledger, path, root, home, request }) => {
    request(); await ledger.collect(home)
    const backup = join(root, 'chosen.sqlite'); ledger.exportTo(backup)
    request(); await ledger.collect(home); ledger.close()
    writeFileSync(path + '-wal', 'old wal'); writeFileSync(path + '-shm', 'old shm')
    const originalBytes = ['', '-wal', '-shm'].map((suffix) => [path + suffix, readFileSync(path + suffix)] as const)
    const temporary = `${path}.11111111-1111-4111-8111-111111111111.recovered`
    const suffix = '.corrupt-1-22222222-2222-4222-8222-222222222222'
    const originals = ['-wal', '-shm', ''].map((extension) => [path + extension, path + suffix + extension])
    writeFileSync(`${path}.recovery-pending`, JSON.stringify({ path, temporary, originals }))
    writeFileSync(temporary, 'damaged after journaling')
    for (const [from, to] of originals.slice(0, completed)) fs.renameSync(from!, to!)
    replayUsageRecovery(path)
    for (const [file, bytes] of originalBytes) assert.deepEqual(readFileSync(file), bytes)
    const reopened = new UsageLedger(path)
    try { assert.equal(reopened.report('2026-09').models[0]?.requests, 2) } finally { reopened.close() }
    recoverUsageDatabase(path, backup)
    const restored = new UsageLedger(path)
    try { assert.equal(restored.report('2026-09').models[0]?.requests, 1) } finally { restored.close() }
  })
})

test('damaged-copy rollback preserves evidence when an original path is ambiguous', () => fixture(async ({ ledger, path }) => {
  ledger.close()
  const bytes = readFileSync(path)
  const temporary = `${path}.11111111-1111-4111-8111-111111111111.recovered`
  const suffix = '.corrupt-1-22222222-2222-4222-8222-222222222222'
  const originals = ['-wal', '-shm', ''].map((extension) => [path + extension, path + suffix + extension])
  writeFileSync(temporary, 'damaged copy'); writeFileSync(path + suffix, 'parked original')
  writeFileSync(`${path}.recovery-pending`, JSON.stringify({ path, temporary, originals }))
  assert.throws(() => replayUsageRecovery(path), /Ambiguous usage recovery/)
  assert.deepEqual(readFileSync(path), bytes)
  assert.equal(readFileSync(path + suffix, 'utf8'), 'parked original')
  assert.ok(fs.existsSync(temporary) && fs.existsSync(`${path}.recovery-pending`))
}))

test('a stale completed journal never rolls corrupt originals back after ledger deletion', async (t) => fixture(async ({ ledger, path, root, home, request }) => {
  request(); await ledger.collect(home); ledger.backup(true)
  const backup = join(root, 'export.sqlite'); ledger.exportTo(backup); ledger.close()
  writeFileSync(path, 'corrupt original')
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file).endsWith('.recovery-pending')) throw new Error('permanent journal cleanup failure')
    unlink(file)
  })
  syncBuiltinESMExports()
  try {
    recoverUsageDatabase(path, backup)
    rmSync(path)
    const reopened = new UsageLedger(path)
    try {
      assert.equal(reopened.report('2026-09').totals.input, 0)
      assert.match(reopened.report('2026-09').warnings.join(' '), /ledger was missing/)
    } finally { reopened.close() }
    const parked = readdirSync(join(path, '..')).find((name) => /^usage\.sqlite\.corrupt-/.test(name))!
    assert.equal(readFileSync(join(path, '..', parked), 'utf8'), 'corrupt original')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('locked old backup files require no directory moves and remain recovery candidates', async (t) => fixture(async ({ ledger, path, home, request }) => {
  request(); await ledger.collect(home); ledger.backup(true); ledger.close(); rmSync(path)
  const previous = ledger.backupDirectory
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === previous || String(from) === join(path, '..', 'usage-backups') || String(from).startsWith(previous + '\\')) throw Object.assign(new Error('old backups locked'), { code: 'EPERM' })
    rename(from, to)
  })
  syncBuiltinESMExports()
  const fresh = new UsageLedger(path)
  try { fresh.backup(true); assert.notEqual(fresh.backupDirectory, previous) }
  finally { fresh.close(); t.mock.restoreAll(); syncBuiltinESMExports() }
  // A corrupt current generation can still recover from an older generation.
  for (const name of readdirSync(fresh.backupDirectory)) writeFileSync(join(fresh.backupDirectory, name), 'bad backup')
  writeFileSync(path, 'bad ledger')
  const recovered = new UsageLedger(path)
  try { assert.equal(recovered.report('2026-09').totals.input, 50) } finally { recovered.close() }
}))

test('an empty backup root does not claim that usage was lost', () => fixture(async ({ ledger, path }) => {
  ledger.close(); rmSync(path)
  mkdirSync(join(path, '..', 'usage-backups'), { recursive: true })
  const fresh = new UsageLedger(path)
  try { assert.doesNotMatch(fresh.report('2026-09').warnings.join(' '), /ledger was missing/) } finally { fresh.close() }
}))

test('backup publication retries transient Windows rename locks', async (t) => fixture(async ({ ledger, root }) => {
  const rename = fs.renameSync
  let attempts = 0
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (++attempts < 3) throw Object.assign(new Error('AV lock'), { code: 'EPERM' })
    rename(from, to)
  })
  syncBuiltinESMExports()
  try { ledger.exportTo(join(root, 'export.sqlite')); assert.equal(attempts, 3) }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('rejection warnings follow the current source path', () => fixture(async ({ ledger, home, root, source, request }) => {
  request(); source.exec('UPDATE assistant_usage_events SET input_tokens=NULL')
  await ledger.collect(home)
  assert.match(ledger.report('2026-09').warnings.join(' '), /invalid source usage row/)
  const alternate = join(root, 'other-home'); mkdirSync(alternate)
  await ledger.collect(alternate)
  assert.doesNotMatch(ledger.report('2026-09').warnings.join(' '), /invalid source usage row/)
  await ledger.collect(home)
  assert.match(ledger.report('2026-09').warnings.join(' '), /invalid source usage row/)
}))

test('timing-only source updates do not invalidate durable import progress', () => fixture(async ({ ledger, home, source, request }) => {
  source.exec('ALTER TABLE assistant_usage_events ADD COLUMN duration_ms INTEGER; ALTER TABLE assistant_usage_events ADD COLUMN time_to_first_token_ms INTEGER; ALTER TABLE assistant_usage_events ADD COLUMN output_ttft_ms INTEGER')
  request(); await ledger.collect(home)
  ledger['save'] = () => assert.fail('timing fields must not cause a reimport')
  source.exec('UPDATE assistant_usage_events SET duration_ms=200,time_to_first_token_ms=10,output_ttft_ms=20')
  await ledger.collect(home)
  assert.doesNotMatch(ledger.report('2026-09').warnings.join(' '), /reimport/)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
}))

test('backfill compiles statements by query rather than by source row', async (t) => fixture(async ({ ledger, home, request }) => {
  for (let index = 0; index < 1000; index++) request()
  let compiled = 0
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) { compiled++; return prepare.call(this, sql) })
  await ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1000)
  assert.ok(compiled < 50, `Compiled ${compiled} statements for 1000 rows`)
}))

test('large history scans checkpoint by progress rather than every input chunk', () => fixture(async ({ ledger, home }) => {
  appendFileSync(join(home, 'session-state', SESSION, 'events.jsonl'), (JSON.stringify({ type: 'assistant.message', data: { content: 'x'.repeat(1000) } }) + '\n').repeat(10_000))
  let checkpoints = 0
  const setMeta = ledger['setMeta'].bind(ledger)
  ledger['setMeta'] = (key, value) => { if (key.startsWith('historyProgress:')) checkpoints++; setMeta(key, value) }
  await ledger.collect(home)
  assert.ok(checkpoints >= 2 && checkpoints <= 4, `Unexpected checkpoint count: ${checkpoints}`)
  await ledger.collect(home)
  assert.ok(checkpoints <= 4, 'unchanged history should not be read again')
}))

test('history growth between lstat and open resumes from the same durable checkpoint before and after restart', async (t) => fixture(async ({ ledger, home, path, shutdown }) => {
  const history = join(home, 'session-state', SESSION, 'events.jsonl')
  shutdown('2026-09-08T00:00:00Z', 100)
  const lstat = fs.lstatSync
  let grew = false
  t.mock.method(fs, 'lstatSync', (file: fs.PathLike, options?: any) => {
    const info = lstat(file, options)
    if (String(file) === history && !grew) { grew = true; shutdown('2026-09-09T00:00:00Z', 200) }
    return info
  })
  syncBuiltinESMExports()
  try { await ledger.collect(home) } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(grew, true)
  let reimported = 0
  const save = ledger['save'].bind(ledger)
  ledger['save'] = (sample) => { reimported++; save(sample) }
  await ledger.collect(home)
  assert.equal(reimported, 0, 'growth already read by the first scan must not trigger a full rescan')
  ledger.close()
  const reopened = new UsageLedger(path)
  try {
    reopened['save'] = () => { reimported++ }
    await reopened.collect(home)
    assert.equal(reimported, 0)
  } finally { reopened.close() }
}))

test('missing ledgers start fresh even when old backups use a future schema', () => fixture(async ({ ledger, path }) => {
  ledger.backup(true); ledger.close(); rmSync(path)
  for (const name of readdirSync(ledger.backupDirectory)) {
    const backup = new DatabaseSync(join(ledger.backupDirectory, name))
    backup.exec('PRAGMA user_version=999'); backup.close()
  }
  const fresh = new UsageLedger(path)
  try { assert.equal(fresh.report('2026-09').totals.input, 0) } finally { fresh.close() }
}))

test('explicit recovery preserves an unavailable directory and restores a verified ledger', () => fixture(async ({ ledger, path, root, home, request }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'export.sqlite')
  ledger.exportTo(backup); ledger.close(); rmSync(path); mkdirSync(path)
  writeFileSync(join(path, 'keep.txt'), 'original')
  recoverUsageDatabase(path, backup)
  const recovered = new UsageLedger(path)
  try {
    assert.equal(recovered.report('2026-09').totals.input, 50)
    const original = readdirSync(join(path, '..')).find((name) => name.startsWith('usage.sqlite.corrupt-'))!
    assert.equal(readFileSync(join(path, '..', original, 'keep.txt'), 'utf8'), 'original')
  } finally { recovered.close() }
}))

test('source and copied fork shutdowns retain original attribution regardless of directory order', () => fixture(async ({ ledger, home, shutdown }) => {
  shutdown('2026-08-27T00:00:00Z', 200)
  for (const fork of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
    const directory = join(home, 'session-state', fork)
    mkdirSync(directory)
    copyFileSync(join(home, 'session-state', SESSION, 'events.jsonl'), join(directory, 'events.jsonl'))
    ledger.associate(fork, true)
  }
  ledger.associate(SESSION)
  await ledger.collect(home)
  for (const scope of ['all', 'app'] as const) {
    const report = ledger.report('2026-08', scope, 'UTC')
    assert.equal(report.totals.input, 150)
    assert.deepEqual(report.sessions.map((row) => row.name), [SESSION])
  }
}))

test('empty initialization is recoverable, including an empty file with a valid older backup', () => fixture(async ({ ledger, home, request, path, root }) => {
  const emptyPath = join(root, 'empty.sqlite')
  writeFileSync(emptyPath, '')
  new UsageLedger(emptyPath).close()
  const headerPath = join(root, 'header.sqlite')
  const header = new DatabaseSync(headerPath); header.exec('PRAGMA user_version=0'); header.close()
  new UsageLedger(headerPath).close()
  request(); await ledger.collect(home); ledger.backup(true); ledger.close()
  writeFileSync(path, '')
  const recovered = new UsageLedger(path)
  try { assert.equal(recovered.report('2026-09').totals.input, 50) } finally { recovered.close() }
  rmSync(path)
  const missing = new UsageLedger(path)
  try { assert.equal(missing.report('2026-09').totals.input, 0) } finally { missing.close() }
}))

test('transient validation errors preserve the healthy ledger instead of installing an older backup', async (t) => fixture(async ({ ledger, path, home, request }) => {
  request(); await ledger.collect(home); ledger.backup(true)
  request('2026-09-09T00:00:00Z'); await ledger.collect(home); ledger.close()
  const original = readFileSync(path)
  const prepare = DatabaseSync.prototype.prepare
  for (const errcode of [5, 14, 10]) {
    const failure = Object.assign(new Error('temporary SQLite access failure'), { errcode })
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql === 'PRAGMA integrity_check') throw failure
      return prepare.call(this, sql)
    })
    try { assert.throws(() => new UsageLedger(path), (error) => error === failure) }
    finally { t.mock.restoreAll() }
    assert.deepEqual(readFileSync(path), original)
    assert.ok(!readdirSync(join(path, '..')).some((file) => file.includes('.corrupt-')))
  }
  const reopened = new UsageLedger(path)
  try { assert.equal(reopened.report('2026-09').models[0]?.requests, 2) } finally { reopened.close() }
}))

test('owned incomplete backup copies and journals retry cleanup while unrelated files survive', async (t) => fixture(async ({ ledger, path }) => {
  ledger.backup(true); ledger.close()
  const uuid = '11111111-1111-4111-8111-111111111111'
  const abandoned = join(ledger.backupDirectory, `daily-2026-09-08.sqlite.${uuid}.tmp`)
  writeFileSync(abandoned, 'incomplete')
  writeFileSync(abandoned + '-journal', 'interrupted journal')
  writeFileSync(`${path}.${uuid}.restore`, 'incomplete')
  writeFileSync(join(ledger.backupDirectory, 'unrelated.tmp'), 'keep')
  writeFileSync(join(ledger.backupDirectory, 'unrelated.tmp-journal'), 'keep journal')
  const attempts = new Map<string, number>()
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    const name = String(file)
    attempts.set(name, (attempts.get(name) ?? 0) + 1)
    if (name.startsWith(abandoned) && attempts.get(name)! <= 2) throw Object.assign(new Error('transient lock'), { code: 'EPERM' })
    unlink(file)
  })
  syncBuiltinESMExports()
  const reopened = new UsageLedger(path)
  try {
    assert.ok(!readdirSync(ledger.backupDirectory).includes(`daily-2026-09-08.sqlite.${uuid}.tmp`))
    assert.ok(!readdirSync(join(path, '..')).some((file) => file.endsWith('.restore')))
    assert.equal(readFileSync(join(ledger.backupDirectory, 'unrelated.tmp'), 'utf8'), 'keep')
    assert.equal(readFileSync(join(ledger.backupDirectory, 'unrelated.tmp-journal'), 'utf8'), 'keep journal')
    assert.ok(!fs.existsSync(abandoned + '-journal'))
    assert.equal(attempts.get(abandoned), 3)
    assert.equal(attempts.get(abandoned + '-journal'), 3)
  } finally { reopened.close(); t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('a failed manual export removes its own temporary journal from the selected folder', async (t) => fixture(async ({ ledger, root }) => {
  const folder = join(root, 'external-export'); mkdirSync(folder)
  const destination = join(folder, 'selected.sqlite')
  writeFileSync(join(folder, 'unrelated.tmp-journal'), 'keep')
  t.mock.method(fs, 'renameSync', (from: fs.PathLike) => {
    writeFileSync(String(from) + '-journal', 'interrupted write')
    throw new Error('publish failed')
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => ledger.exportTo(destination), /publish failed/)
    assert.deepEqual(readdirSync(folder), ['unrelated.tmp-journal'])
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('history import rejects non-files and continues after malformed usage records', () => fixture(async ({ ledger, home, shutdown }) => {
  const path = join(home, 'session-state', SESSION, 'events.jsonl')
  appendFileSync(path, '{"type":"session.shutdown",broken}\n')
  shutdown('2026-08-27T00:00:00Z', 200)
  await ledger.collect(home)
  assert.equal(ledger.report('2026-08', 'all', 'UTC').totals.input, 150)
  assert.match(ledger.report('2026-08').warnings.join(' '), /Skipped invalid shutdown/)
  rmSync(path); mkdirSync(path)
  await ledger.collect(home)
  assert.match(ledger.report('2026-08').warnings.join(' '), /regular file/)
}))
