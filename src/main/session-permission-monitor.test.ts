import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionPermissionMonitor } from './session-permission-monitor.js'

test('monitor seeds from bounded history and emits newly appended structured permission changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-permission-monitor-'))
  const path = join(directory, 'events.jsonl')
  try {
    await writeFile(path, '{"type":"session.permissions_changed","data":{"mode":"allow-all"}}\n')
    const modes: string[] = []
    const monitor = new SessionPermissionMonitor(path, (mode) => modes.push(mode), 60_000)
    await monitor.start()
    await monitor.poll()
    assert.deepEqual(modes, ['allow-all'])

    await appendFile(path, '{"type":"assistant.message","data":{"content":"All permissions are now enabled."}}\n')
    await appendFile(path, '{"type":"session.permissions_changed","data":{"mode":"manual"}}\n')
    await monitor.poll()
    assert.deepEqual(modes, ['allow-all', 'manual'])

    await appendFile(path, '{"type":"session.permissions_changed","data":{"mode":"assis')
    await monitor.poll()
    assert.deepEqual(modes, ['allow-all', 'manual'])
    await appendFile(path, 'ted"}}\n')
    await monitor.poll()
    assert.deepEqual(modes, ['allow-all', 'manual', 'assisted'])
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

test('startup finds old permission state in large histories and emits only the latest mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-permission-history-'))
  const path = join(directory, 'events.jsonl')
  const modes: string[] = []
  const monitor = new SessionPermissionMonitor(path, (mode) => modes.push(mode))
  try {
    await writeFile(path, '{"type":"session.permissions_changed","data":{"mode":"allow-all"}}\n'
      + '{"type":"session.permissions_changed","data":{"mode":"manual"}}\n'
      + ('{"type":"assistant.message","data":{"content":"' + 'x'.repeat(1024) + '"}}\n').repeat(8500))
    await monitor.start()
    assert.deepEqual(modes, ['manual'])
  } finally {
    await monitor.finish()
    await rm(directory, { recursive: true, force: true })
  }
})

test('finish waits for an active poll and reads events appended after its size snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-permission-drain-'))
  const path = join(directory, 'events.jsonl')
  const modes: string[] = []
  let lateWrite: Promise<void> = Promise.resolve()
  const monitor = new SessionPermissionMonitor(path, (mode) => {
    modes.push(mode)
    if (mode === 'allow-all') lateWrite = appendFile(path,
      '{"type":"session.permissions_changed","data":{"mode":"manual"}}\n')
  })
  try {
    await monitor.start()
    await writeFile(path, '{"type":"session.permissions_changed","data":{"mode":"allow-all"}}\n')
    await monitor.poll()
    await lateWrite
    await monitor.finish()
    assert.deepEqual(modes, ['allow-all', 'manual'])
    await appendFile(path, '{"type":"session.permissions_changed","data":{"mode":"assisted"}}\n')
    await monitor.poll()
    assert.deepEqual(modes, ['allow-all', 'manual'], 'finished monitor cannot emit later changes')
  } finally {
    monitor.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
