import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionPermissionMonitor } from './session-permission-monitor.js'

test('monitor ignores history and emits newly appended structured permission changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-permission-monitor-'))
  const path = join(directory, 'events.jsonl')
  try {
    await writeFile(path, '{"type":"session.permissions_changed","data":{"mode":"allow-all"}}\n')
    const modes: string[] = []
    const monitor = new SessionPermissionMonitor(path, (mode) => modes.push(mode), 60_000)
    await monitor.start()
    await monitor.poll()
    assert.deepEqual(modes, [])

    await appendFile(path, '{"type":"assistant.message","data":{"content":"All permissions are now enabled."}}\n')
    await appendFile(path, '{"type":"session.permissions_changed","data":{"mode":"manual"}}\n')
    await monitor.poll()
    assert.deepEqual(modes, ['manual'])

    await appendFile(path, '{"type":"session.permissions_changed","data":{"mode":"assis')
    await monitor.poll()
    assert.deepEqual(modes, ['manual'])
    await appendFile(path, 'ted"}}\n')
    await monitor.poll()
    assert.deepEqual(modes, ['manual', 'assisted'])
    monitor.stop()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('monitor can start before Copilot creates the event file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-permission-monitor-'))
  const path = join(directory, 'events.jsonl')
  try {
    const modes: string[] = []
    const monitor = new SessionPermissionMonitor(path, (mode) => modes.push(mode), 60_000)
    await monitor.start()
    await writeFile(path, '{"type":"session.permissions_changed","data":{"mode":"allow-all"}}\n')
    await monitor.poll()
    assert.deepEqual(modes, ['allow-all'])
    monitor.stop()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
