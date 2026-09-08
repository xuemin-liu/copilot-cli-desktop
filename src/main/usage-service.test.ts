import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { UsageService } from './usage-service.js'
import { EventEmitter } from 'node:events'

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
