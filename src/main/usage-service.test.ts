import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { UsageService } from './usage-service.js'

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
