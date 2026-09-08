import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { UsageService } from './usage-service.js'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { UsageLedger } from './usage-ledger.js'

class TestWorker extends EventEmitter {
  sent: Array<{ id: number; method: string }> = []
  terminated = false
  postMessage(message: { id: number; method: string }): void {
    this.sent.push(message)
    this.emit('message', { id: message.id, type: 'started' })
  }
  async terminate(): Promise<number> { this.terminated = true; this.emit('exit', 1); return 1 }
  ready(): void { this.emit('message', { type: 'ready' }) }
  finish(): void {
    const active = this.sent.at(-1)!
    this.emit('message', { id: active.id, result: active.method === 'report' ? { warnings: [], totals: { input: 50 } } : undefined })
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

test('worker collects, exports, merges and shuts down with committed usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-worker-test-'))
  const home = join(root, 'copilot'), path = join(root, 'app', 'usage.sqlite')
  await mkdir(home)
  const source = new DatabaseSync(join(home, 'session-store.db'))
  source.exec(`CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY,session_id TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,created_at TEXT);
    INSERT INTO assistant_usage_events VALUES(1,'session','model',100,20,40,10,'2026-09-08T00:00:00Z')`)
  source.close()
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
      if (sql === 'VACUUM INTO ?') parentPort.postMessage({ type: 'vacuum' });
      return prepare.call(this, sql);
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
