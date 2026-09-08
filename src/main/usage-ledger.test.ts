import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UsageLedger, recoverUsageDatabase } from './usage-ledger.js'

const SESSION = '12345678-1234-1234-1234-123456789012'
function fixture(action: (f: { root: string; home: string; path: string; source: DatabaseSync; ledger: UsageLedger; request: (at?: string, input?: number) => void; shutdown: (at: string, input: number) => void }) => void): void {
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
  try { action({ root, home, path, source, ledger, request, shutdown }) }
  finally { try { ledger.close() } catch {} try { source.close() } catch {} rmSync(root, { recursive: true, force: true }) }
}

test('imports a live WAL store, separates gross input, and rescans without duplicates', () => fixture(({ ledger, home, request }) => {
  request(); ledger.collect(home); ledger.collect(home)
  const report = ledger.report('2026-09', 'all', 'UTC')
  assert.deepEqual(report.totals, { input: 50, output: 20, cacheRead: 40, cacheWrite: 10, reasoning: 5 })
  assert.equal(report.models[0]?.requests, 1)
  assert.equal(ledger.report('2026-09', 'app').models.length, 0)
  ledger.associate(SESSION)
  assert.equal(ledger.report('2026-09', 'app').totals.input, 50)
}))

test('identical requests are retained; reused source IDs do not duplicate restored rows', () => fixture(({ ledger, home, request, source }) => {
  request(); request(); ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 2)
  source.exec('DELETE FROM assistant_usage_events; DELETE FROM sqlite_sequence')
  request(); request(); request('2026-09-09T01:00:00Z'); ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 3)
}))

test('saved usage survives deleting source history and reopening after an update', () => fixture(({ ledger, source, path, home, request }) => {
  request(); ledger.collect(home); ledger.backup(true)
  const before = ledger.report('2026-09')
  ledger.close(); source.close(); rmSync(home, { recursive: true })
  const upgraded = new UsageLedger(path)
  try { upgraded.collect(home); assert.deepEqual(upgraded.report('2026-09').totals, before.totals) }
  finally { upgraded.close() }
}))

test('snapshot deltas preserve earlier months and never double-count request coverage', () => fixture(({ ledger, home, request, shutdown }) => {
  request('2026-08-26T00:00:00Z')
  shutdown('2026-08-27T00:00:00Z', 150)
  ledger.collect(home)
  assert.equal(ledger.report('2026-08', 'all', 'UTC').totals.input, 100)
  shutdown('2026-09-08T00:00:00Z', 250)
  ledger.collect(home)
  const august = ledger.report('2026-08')
  assert.equal(august.totals.input, 100)
  assert.equal(august.unallocated.input, 100)
  assert.equal(ledger.report('2026-09').totals.input, 0)
}))

test('month boundaries use a persisted timezone and reject invalid timezones', () => fixture(({ ledger, home, request }) => {
  request('2026-09-01T01:00:00Z'); ledger.collect(home)
  assert.equal(ledger.report('2026-08', 'all', 'America/Chicago').totals.input, 50)
  assert.equal(ledger.report('2026-09').totals.input, 0)
  assert.throws(() => ledger.report('2026-09', 'all', 'invalid/timezone'))
  assert.throws(() => ledger.report('2026-13'))
}))

test('backup restore merges older records without losing newer usage or duplicating it', () => fixture(({ ledger, home, request, root, path }) => {
  request(); ledger.collect(home)
  const backup = join(root, 'export.sqlite'); ledger.exportTo(backup)
  request('2026-09-09T00:00:00Z'); ledger.collect(home)
  ledger.restoreFrom(backup); ledger.restoreFrom(backup)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 2)
  assert.throws(() => ledger.exportTo(path), /active usage database/)
  assert.throws(() => ledger.restoreFrom(path), /active usage database/)
}))

test('corruption restores a verified backup and preserves original damaged files', () => fixture(({ ledger, home, request, path }) => {
  request(); ledger.collect(home); ledger.backup(true); ledger.close()
  writeFileSync(path, 'damaged')
  const recovered = new UsageLedger(path)
  try {
    assert.equal(recovered.report('2026-09').totals.input, 50)
    assert.match(recovered.report('2026-09').warnings.join(' '), /Recovered usage/)
    assert.ok(readdirSync(join(path, '..')).some((file) => file.includes('.corrupt-')))
  } finally { recovered.close() }
}))

test('corruption without a backup fails closed; explicit exported-backup recovery works', () => fixture(({ ledger, home, request, root, path }) => {
  request(); ledger.collect(home)
  const backup = join(root, 'export.sqlite'); ledger.exportTo(backup); ledger.close()
  writeFileSync(path, 'damaged')
  assert.throws(() => new UsageLedger(path), /Original files preserved/)
  assert.equal(readFileSync(path, 'utf8'), 'damaged')
  recoverUsageDatabase(path, backup)
  const recovered = new UsageLedger(path)
  try { assert.equal(recovered.report('2026-09').totals.input, 50) } finally { recovered.close() }
}))

test('future ledger versions are never reset or replaced by an older backup', () => fixture(({ ledger, path }) => {
  ledger.backup(true); ledger.close()
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=2'); db.close()
  assert.throws(() => new UsageLedger(path), /Unsupported usage database version/)
  const verify = new DatabaseSync(path, { readOnly: true })
  try { assert.equal(verify.prepare('PRAGMA user_version').get()?.user_version, 2) } finally { verify.close() }
}))

test('schema drift or invalid counters warn without removing previously saved usage', () => fixture(({ ledger, home, request, source }) => {
  request(); ledger.collect(home)
  source.exec('ALTER TABLE assistant_usage_events ADD COLUMN future_column TEXT')
  ledger.collect(home)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
  request('2026-09-09T00:00:00Z', 5); ledger.collect(home)
  assert.match(ledger.report('2026-09').warnings.join(' '), /Cache counters exceed/)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
  source.exec('ALTER TABLE assistant_usage_events RENAME COLUMN input_tokens TO renamed_input')
  ledger.collect(home)
  assert.match(ledger.report('2026-09').warnings.join(' '), /required columns/)
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
}))

test('failed backup validation rolls back the entire merge', () => fixture(({ ledger, root, home, request }) => {
  request(); ledger.collect(home)
  const backup = join(root, 'bad-record.sqlite'); ledger.exportTo(backup)
  const db = new DatabaseSync(backup)
  db.prepare('INSERT INTO samples VALUES (?,?)').run('bad', '{"kind":"request","key":"bad"}')
  db.close()
  assert.throws(() => ledger.restoreFrom(backup))
  assert.equal(ledger.report('2026-09').models[0]?.requests, 1)
}))

test('a full destination disk leaves previously committed usage intact', () => fixture(({ ledger, home, request, source }) => {
  request(); ledger.collect(home)
  // SQLite's real page limit simulates SQLITE_FULL without filling the host drive.
  const db = ledger['db']
  const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count)
  db.exec(`PRAGMA max_page_count=${pages}`)
  request('2026-09-10T00:00:00Z')
  source.prepare('UPDATE assistant_usage_events SET model=? WHERE id=2').run('large-model-'.repeat(10000))
  ledger.collect(home)
  const report = ledger.report('2026-09')
  assert.equal(report.models[0]?.requests, 1)
  assert.match(report.warnings.join(' '), /full/i)
}))

test('known fork shutdowns do not add inherited usage and partial tail lines are retried', () => fixture(({ ledger, home, shutdown, request }) => {
  request('2026-08-26T00:00:00Z'); shutdown('2026-08-27T00:00:00Z', 200)
  ledger.associate(SESSION, true); ledger.collect(home)
  assert.equal(ledger.report('2026-08', 'app', 'UTC').totals.input, 50)
  const path = join(home, 'session-state', SESSION, 'events.jsonl')
  appendFileSync(path, '{"type":"session.shutdown"')
  ledger.collect(home)
  assert.equal(ledger.report('2026-08').totals.input, 50)
  assert.ok(!ledger.report('2026-08').warnings.some((warning) => warning.includes('could not be imported')))
}))

test('backup rotation keeps the promised daily and monthly retention', () => fixture(({ ledger }) => {
  for (let index = 0; index < 40; index++) ledger.backup(true, new Date(Date.UTC(2026, 0, index + 1)))
  assert.equal(readdirSync(ledger.backupDirectory).filter((file) => file.startsWith('daily-')).length, 30)
  for (let index = 0; index < 15; index++) ledger.backup(true, new Date(Date.UTC(2026, index, 1)))
  assert.equal(readdirSync(ledger.backupDirectory).filter((file) => file.startsWith('monthly-')).length, 12)
}))
