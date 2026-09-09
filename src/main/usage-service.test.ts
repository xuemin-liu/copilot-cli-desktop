import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { UsageService, UsageServiceUnavailableError } from './usage-service.js'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { UsageLedger } from './usage-ledger.js'
import { seedSourceStore } from '../../scripts/usage-source-fixture.js'

class TestWorker extends EventEmitter {
  sent: Array<{ id: number; method: string }> = []
  terminated = false
  postMessage(message: { id: number; method: string }): void {
    this.sent.push(message)
    this.emit('message', { id: message.id, type: 'started' })
  }
  async terminate(): Promise<number> { this.terminated = true; this.emit('exit', 1); return 1 }
  ready(): void { this.emit('message', { type: 'ready' }) }
  finish(result?: unknown): void {
    const active = this.sent.at(-1)!
    this.emit('message', { id: active.id, result: result ?? (active.method === 'report' ? { warnings: [], totals: { input: 50 } } : { backupWarning: null }) })
  }
}

test('queued usage calls receive a full execution budget after the active call completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker, executionTimeoutMs: 100, startupTimeoutMs: 1000 })
  try {
    worker.ready()
    const first = service.report('2026-09', 'all')
    const second = service.report('2026-08', 'all')
    t.mock.timers.tick(90); worker.finish()
    t.mock.timers.tick(90); worker.finish()
    assert.equal((await first).totals.input, 50)
    t.mock.timers.tick(90); worker.finish()
    assert.equal((await second).totals.input, 50)
    assert.equal(worker.terminated, false)
  } finally { await service.abort() }
})

test('a timed-out worker is replaced; only its active call fails and queued work survives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const workers: TestWorker[] = []
  const service = new UsageService('unused', 'unused', () => {}, {
    createWorker: () => { const worker = new TestWorker(); workers.push(worker); return worker }, executionTimeoutMs: 100, startupTimeoutMs: 1000,
  })
  try {
    workers[0]!.ready()
    workers[0]!.finish()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const failed = assert.rejects(service.collect(), /timed out/)
    const queued = service.report('2026-09', 'all')
    t.mock.timers.tick(101)
    await failed
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(workers[0]!.terminated, true)
    assert.equal(workers.length, 2)
    workers[1]!.ready(); workers[1]!.finish()
    assert.equal((await queued).totals.input, 50)
    const later = service.collect()
    workers[1]!.finish()
    await later
  } finally { await service.abort() }
})

test('service shutdown has an overall deadline even while queued behind an unfinished operation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker, executionTimeoutMs: 1000, shutdownTimeoutMs: 100 })
  worker.ready()
  const stopped = assert.rejects(service.stop(), /deadline/)
  t.mock.timers.tick(101)
  await stopped
  assert.equal(worker.terminated, true)
})

test('refresh during collection awaits one coalesced subsequent scan', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    worker.ready()
    const first = service.collect()
    const second = service.collect()
    assert.equal(first, second)
    let completed = false
    void first.then(() => { completed = true })
    worker.finish()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(completed, false)
    assert.deepEqual(worker.sent.map((request) => request.method), ['collect', 'collect'])
    worker.finish(); await first
    assert.equal(completed, true)
  } finally { await service.abort() }
})

test('shutdown remains bounded when native worker termination never completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const worker = new TestWorker()
  worker.terminate = () => new Promise(() => {})
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker, shutdownTimeoutMs: 100 })
  worker.ready(); worker.finish()
  const stopped = assert.rejects(service.stop(), /deadline/)
  worker.finish()
  await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(101)
  await stopped
  const aborted = assert.rejects(service.abort(), /deadline/)
  t.mock.timers.tick(101); await aborted
})

test('repeated bootstrap failures stop automatic worker creation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const workers: TestWorker[] = []
  const service = new UsageService('unused', 'unused', () => {}, {
    createWorker: () => { const worker = new TestWorker(); workers.push(worker); return worker }, startupTimeoutMs: 100,
  })
  try {
    const pending = assert.rejects(service.report('2026-09', 'all'), /startup timed out/)
    for (let attempt = 0; attempt < 3; attempt++) {
      t.mock.timers.tick(101)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await pending
    t.mock.timers.tick(300_000)
    await assert.rejects(service.collect(), /repeatedly failed/)
    assert.equal(workers.length, 3)
  } finally { await service.abort() }
})

test('a failed flush remains visible in subsequent reports', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    worker.ready(); worker.finish()
    const failed = assert.rejects(service.flush(), /disk full/)
    worker.emit('message', { id: worker.sent.at(-1)!.id, error: 'disk full' })
    await failed
    const report = service.report('2026-09', 'all'); worker.finish()
    assert.match((await report).warnings.join(' '), /disk full/)
  } finally { await service.abort() }
})

test('restore admission and selection failures do not create or replace collection warnings', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  const report = async () => {
    const result = service.report('2026-09', 'all'); worker.finish(); return result
  }
  const rejectRestore = async () => {
    const rejected = assert.rejects(service.restoreFrom('invalid.sqlite'), /Invalid selected backup/)
    worker.emit('message', { id: worker.sent.at(-1)!.id, error: 'Invalid selected backup' })
    await rejected
  }
  try {
    worker.ready(); worker.finish()
    await new Promise<void>((resolve) => setImmediate(resolve))
    service.pauseCollection()
    await assert.rejects(service.restoreFrom('unused'), /writes are paused/)
    assert.deepEqual((await report()).warnings, [])
    service.resumeCollection()
    await rejectRestore()
    assert.deepEqual((await report()).warnings, [])
    const failed = assert.rejects(service.flush(), /genuine collection failure/)
    worker.emit('message', { id: worker.sent.at(-1)!.id, error: 'genuine collection failure' })
    await failed; await rejectRestore()
    const warning = (await report()).warnings.join(' ')
    assert.match(warning, /genuine collection failure/)
    assert.doesNotMatch(warning, /Invalid selected backup/)
    const restored = service.restoreFrom('valid.sqlite'); worker.finish(); await restored
    assert.deepEqual((await report()).warnings, [])
  } finally { await service.abort() }
})

test('a paused update flush replaces queued collection and stop reuses the completed backup', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    // The startup collect is still unsent while the worker starts.
    service.pauseCollection()
    const flushed = service.flush()
    worker.ready()
    assert.deepEqual(worker.sent.map((request) => request.method), ['flush'])
    worker.finish(); await flushed
    await service.stop()
    assert.deepEqual(worker.sent.map((request) => request.method), ['flush'])
    assert.equal(worker.terminated, true)
  } finally { await service.abort() }
})

test('a flush started before update preparation cannot skip the final backup', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    worker.ready(); worker.finish()
    const oldFlush = service.flush()
    service.noteSourceChanged()
    service.pauseCollection()
    worker.finish(); await oldFlush
    const stopped = service.stop()
    assert.equal(worker.sent.filter((request) => request.method === 'flush').length, 2)
    worker.finish(); await stopped
  } finally { await service.abort() }
})

test('shutdown retries a paused flush whose backup failed without losing its diagnostic', async () => {
  const worker = new TestWorker()
  const diagnostics: string[] = []
  const service = new UsageService('unused', 'unused', (message) => diagnostics.push(message), { createWorker: () => worker })
  try {
    service.pauseCollection()
    const flushed = service.flush(); worker.ready()
    worker.finish({ backupWarning: 'backup file locked' }); await flushed
    const report = service.report('2026-09', 'all'); worker.finish({ warnings: ['backup file locked'], totals: { input: 50 } })
    assert.deepEqual((await report).warnings, ['backup file locked'])
    assert.deepEqual(diagnostics, ['backup file locked'])
    const stopped = service.stop()
    assert.equal(worker.sent.filter((request) => request.method === 'flush').length, 2)
    worker.finish(); await stopped
  } finally { await service.abort() }
})

test('backup diagnostics gain raw detail once and ignore changing temporary paths until recovery', async () => {
  const worker = new TestWorker()
  const diagnostics: string[] = []
  const service = new UsageService('unused', 'unused', (message) => diagnostics.push(message), { createWorker: () => worker })
  const backupWarning = 'Usage is committed, but the backup refresh failed (UNKNOWN): The backup could not be written.'
  try {
    // A restart can initially know only the persisted warning during the retry interval.
    service.pauseCollection()
    let flushed = service.flush(); worker.ready(); worker.finish({ backupWarning, backupDiagnostic: null }); await flushed
    assert.deepEqual(diagnostics, [backupWarning])
    flushed = service.flush(); worker.finish({ backupWarning, backupDiagnostic: 'TypeError: driver failed at first-uuid.tmp' }); await flushed
    flushed = service.flush(); worker.finish({ backupWarning, backupDiagnostic: 'TypeError: driver failed at second-uuid.tmp' }); await flushed
    assert.equal(diagnostics.length, 2)
    assert.match(diagnostics[1]!, /TypeError: driver failed at first-uuid.tmp/)
    const report = service.report('2026-09', 'all'); worker.finish({ warnings: [backupWarning], totals: { input: 50 } })
    assert.deepEqual((await report).warnings, [backupWarning])
    flushed = service.flush(); worker.finish({ backupWarning: null, backupDiagnostic: null }); await flushed
    flushed = service.flush(); worker.finish({ backupWarning, backupDiagnostic: 'TypeError: driver failed again' }); await flushed
    assert.equal(diagnostics.length, 3)
    assert.match(diagnostics[2]!, /failed again/)
  } finally { await service.abort() }
})

test('pause rejects stopping and closed services instead of silently succeeding', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    worker.ready(); worker.finish()
    const stopped = service.stop()
    assert.throws(() => service.pauseCollection(), UsageServiceUnavailableError)
    worker.finish(); await stopped
    assert.throws(() => service.pauseCollection(), UsageServiceUnavailableError)
  } finally { await service.abort() }
})

test('writes after a prepared flush require a fresh shutdown backup', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    worker.ready(); worker.finish()
    service.pauseCollection()
    const flushed = service.flush(); worker.finish(); await flushed
    service.resumeCollection()
    service.associate('session', false); worker.finish()
    service.pauseCollection()
    const stopped = service.stop()
    assert.equal(worker.sent.at(-1)?.method, 'flush')
    worker.finish(); await stopped
  } finally { await service.abort() }
})

test('read-only reports queued behind a flush do not trigger another shutdown backup', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    worker.ready(); worker.finish(); service.pauseCollection()
    const flushed = service.flush()
    const report = service.report('2026-09', 'all')
    worker.finish(); await flushed
    assert.equal(worker.sent.at(-1)?.method, 'report')
    worker.finish(); await report
    await service.stop()
    assert.equal(worker.sent.filter((request) => request.method === 'flush').length, 1)
  } finally { await service.abort() }
})

test('timezone writes invalidate a completed flush and are rejected while paused', async () => {
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    worker.ready(); worker.finish(); service.pauseCollection()
    const flushed = service.flush(); worker.finish(); await flushed
    await assert.rejects(service.report('2026-09', 'all', 'UTC'), /writes are paused/)
    await assert.rejects(service.exportTo('unused'), /writes are paused/)
    await assert.rejects(service.restoreFrom('unused'), /writes are paused/)
    service.resumeCollection()
    const report = service.report('2026-09', 'all', 'UTC'); worker.finish(); await report
    service.pauseCollection()
    const stopped = service.stop(); worker.finish(); await stopped
    assert.equal(worker.sent.filter((request) => request.method === 'flush').length, 2)
  } finally { await service.abort() }
})

test('retrying update preparation reuses the active flush until source writes change', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const worker = new TestWorker()
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => worker })
  try {
    worker.ready(); worker.finish(); service.pauseCollection()
    const first = service.flush()
    service.resumeCollection()
    t.mock.timers.tick(30_001)
    service.pauseCollection()
    const retry = service.flush()
    assert.equal(first, retry)
    assert.equal(worker.sent.filter((request) => request.method === 'flush').length, 1)
    worker.finish(); await retry
    await service.stop()
  } finally { await service.abort() }
})

test('unavailable-worker errors take precedence over update admission errors', async () => {
  const service = new UsageService('unused', 'unused', () => {}, { createWorker: () => { throw new Error('worker missing; restart the app') } })
  try {
    assert.throws(() => service.pauseCollection(), /worker missing/)
    await assert.rejects(service.collect(), /worker missing/)
    await assert.rejects(service.flush(), /worker missing/)
  } finally { await service.abort() }
})

test('worker collects, exports, merges and shuts down with committed usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-worker-test-'))
  const home = join(root, 'copilot'), path = join(root, 'app', 'usage.sqlite')
  seedSourceStore(home)
  const diagnostics: string[] = []
  const service = new UsageService(path, home, (message) => diagnostics.push(message))
  try {
    await service.collect()
    service.associate('session', false)
    const report = await service.report('2026-09', 'app', 'UTC')
    assert.equal(report.totals.input, 50)
    await service.exportTo(join(root, 'export.sqlite'))
    await service.restoreFrom(join(root, 'export.sqlite'))
    assert.equal((await service.report('2026-09', 'all')).totals.input, 50)
    assert.deepEqual(diagnostics, [])
  } finally {
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('periodic and forced backup failures share one durable report warning and log each failure transition once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-backup-failure-'))
  const path = join(root, 'usage.sqlite')
  seedSourceStore(root)
  await writeFile(join(root, 'usage-backups'), 'backup directory unavailable')
  const diagnostics: string[] = []
  const service = new UsageService(path, root, (message) => diagnostics.push(message))
  try {
    await service.collect()
    const report = await service.report('2026-09', 'all')
    assert.equal(report.totals.input, 50)
    assert.match(report.warnings.join(' '), /Usage is committed, but the backup refresh failed/)
    assert.equal(report.warnings.filter((warning) => warning.includes('backup refresh')).length, 1)
    assert.equal(diagnostics.filter((message) => message.includes('Usage is committed')).length, 1)
    assert.ok(diagnostics.some((message) => message.includes(root)), 'the app log retains the raw filesystem diagnostic')
    assert.ok(!report.warnings.find((warning) => warning.includes('backup refresh'))!.includes(root))
    await service.collect(); await service.flush()
    assert.equal(diagnostics.filter((message) => message.includes('Usage is committed')).length, 1)
    assert.equal((await service.report('2026-09', 'all')).warnings.filter((warning) => warning.includes('backup refresh')).length, 1)
    await rm(join(root, 'usage-backups'))
    await service.flush()
    assert.doesNotMatch((await service.report('2026-09', 'all')).warnings.join(' '), /backup refresh/)
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }) }
})

test('worker restore succeeds and collects new source rows when both backup refreshes fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-restore-backup-failure-'))
  const path = join(root, 'usage.sqlite'), backup = join(root, 'selected.sqlite')
  seedSourceStore(root)
  const diagnostics: string[] = []
  const service = new UsageService(path, root, (message) => diagnostics.push(message))
  try {
    await service.collect(); await service.exportTo(backup)
    await rm(join(root, 'usage-backups'), { recursive: true })
    await writeFile(join(root, 'usage-backups'), 'backup location unavailable')
    const source = new DatabaseSync(join(root, 'session-store.db'))
    try { source.exec('INSERT INTO assistant_usage_events SELECT 2,session_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at FROM assistant_usage_events WHERE id=1') } finally { source.close() }
    await service.restoreFrom(backup)
    const report = await service.report('2026-09', 'all')
    assert.equal(report.totals.input, 100, 'restore must run its follow-up collection')
    assert.equal(report.warnings.filter((warning) => warning.includes('backup refresh failed')).length, 1)
    assert.equal(diagnostics.length, 1)
    assert.ok(diagnostics[0]!.includes(root), 'restore retains its own raw diagnostic through the throttled follow-up scan')
    await service.collect()
    assert.equal(diagnostics.length, 1)
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }) }
})

test('explicit worker restore recovers an unopenable ledger after bounded retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-restore-test-'))
  const path = join(root, 'app', 'usage.sqlite'), backup = join(root, 'export.sqlite')
  const exported = new UsageLedger(backup)
  exported.close()
  await mkdir(path, { recursive: true })
  const service = new UsageService(path, root, () => {})
  try {
    await service.restoreFrom(backup)
    assert.equal((await service.report('2026-09', 'all')).totals.input, 0)
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }) }
})

test('worker flush makes one backup pair and export makes only its requested copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-backup-count-'))
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (sql === 'VACUUM INTO ?') {
        const run = statement.run;
        statement.run = function(...args) { parentPort.postMessage({ type: 'vacuum' }); return run.apply(this, args); };
      }
      return statement;
    };
    import(${JSON.stringify(new URL('./usage-worker.js', import.meta.url).href)});
  `, { eval: true, workerData: { path: join(root, 'usage.sqlite'), home: root } })
  let copies = 0
  worker.on('message', (message) => { if (message.type === 'vacuum') copies++ })
  const operation = (id: number, method: string, args: string[] = []): Promise<void> => new Promise((resolve, reject) => {
    const listener = (message: { id?: number; type?: string; error?: string }): void => {
      if (message.id !== id || message.type === 'started') return
      worker.off('message', listener)
      if (message.error) reject(new Error(message.error)); else resolve()
    }
    worker.on('message', listener)
    worker.postMessage({ id, method, args })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on('error', reject)
      worker.on('message', (message) => { if (message.type === 'ready') resolve() })
    })
    await operation(1, 'flush')
    assert.equal(copies, 2)
    await operation(2, 'export', [join(root, 'export.sqlite')])
    assert.equal(copies, 3)
  } finally { await worker.terminate(); await rm(root, { recursive: true, force: true }) }
})
