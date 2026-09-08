import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { UsageLedger, recoverUsageDatabase } from './usage-ledger.js'

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
  const preserved = fresh['meta']('preservedBackups')!
  fresh.close()
  const reopened = new UsageLedger(path)
  try {
    reopened.backup(true, new Date('2026-10-01T00:00:00Z'))
    for (const [name, bytes] of originals) assert.deepEqual(readFileSync(join(preserved, name)), bytes)
    reopened.restoreFrom(join(preserved, originals[0]![0]))
    assert.equal(reopened.report('2026-09').totals.input, 50)
  } finally { reopened.close() }
}))

test('failed restore renames roll back every completed move', async (t) => fixture(async ({ ledger, path, root, home, request }) => {
  request(); await ledger.collect(home)
  const backup = join(root, 'export.sqlite')
  ledger.exportTo(backup); ledger.close()
  const bytes = readFileSync(path)
  const rename = fs.renameSync
  for (const failure of ['-wal', '-shm', '', 'install']) {
    writeFileSync(path + '-wal', 'original wal'); writeFileSync(path + '-shm', 'original shm')
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (failure === 'install' ? String(from).endsWith('.recovered') : String(from) === path + failure) throw Object.assign(new Error('access denied'), { code: 'EPERM' })
      rename(from, to)
    })
    syncBuiltinESMExports()
    try { assert.throws(() => recoverUsageDatabase(path, backup), /access denied/) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    assert.deepEqual(readFileSync(path), bytes)
    assert.equal(readFileSync(path + '-wal', 'utf8'), 'original wal')
    assert.equal(readFileSync(path + '-shm', 'utf8'), 'original shm')
    assert.ok(!readdirSync(join(path, '..')).some((name) => /recovered|recovery-pending|corrupt-/.test(name)))
  }
}))

test('an interrupted restore blocks initialization and retains its recovery copy', () => fixture(async ({ ledger, path }) => {
  ledger.close(); rmSync(path)
  const copy = `${path}.11111111-1111-4111-8111-111111111111.recovered`
  writeFileSync(copy, 'recovery evidence')
  writeFileSync(`${path}.recovery-pending`, '{}')
  assert.throws(() => new UsageLedger(path), /interrupted usage recovery/)
  assert.equal(readFileSync(copy, 'utf8'), 'recovery evidence')
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

test('only owned incomplete backup copies are removed when a worker restarts', () => fixture(async ({ ledger, path }) => {
  ledger.backup(true); ledger.close()
  const uuid = '11111111-1111-4111-8111-111111111111'
  const abandoned = join(ledger.backupDirectory, `daily-2026-09-08.sqlite.${uuid}.tmp`)
  writeFileSync(abandoned, 'incomplete')
  writeFileSync(`${path}.${uuid}.restore`, 'incomplete')
  writeFileSync(join(ledger.backupDirectory, 'unrelated.tmp'), 'keep')
  const reopened = new UsageLedger(path)
  try {
    assert.ok(!readdirSync(ledger.backupDirectory).includes(`daily-2026-09-08.sqlite.${uuid}.tmp`))
    assert.ok(!readdirSync(join(path, '..')).some((file) => file.endsWith('.restore')))
    assert.equal(readFileSync(join(ledger.backupDirectory, 'unrelated.tmp'), 'utf8'), 'keep')
  } finally { reopened.close() }
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
