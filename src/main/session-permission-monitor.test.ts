import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionPermissionMonitor } from './session-permission-monitor.js'

test('oversized partial events invalidate activity, report one diagnostic, and recover at later complete turns', async () => {
  for (const replay of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'copilot-activity-gap-'))
    const path = join(directory, 'events.jsonl'), activity: Array<string | null> = [], diagnostics: string[] = []
    const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
    const monitor = new SessionPermissionMonitor(path, () => {}, 60_000, message => diagnostics.push(message), value => activity.push(value))
    try {
      await writeFile(path, line('assistant.turn_start', { turnId: '1' }))
      if (!replay) {
        await monitor.start()
        await appendFile(path, line('assistant.turn_start', { turnId: '2' }))
        await monitor.poll()
        assert.deepEqual(activity, ['working'])
      }
      await appendFile(path, '{"type":"assistant.message","data":{"content":"PRIVATE_EVENT_CONTENT' + 'x'.repeat(8 * 1024 * 1024))
      if (replay) await monitor.start()
      else await monitor.poll()
      assert.deepEqual(activity, replay ? [] : ['working', null])
      assert.equal(diagnostics.length, 1)
      assert.match(diagnostics[0]!, /Skipped session event exceeding 8388608 bytes/)
      assert.ok(!diagnostics[0]!.includes('PRIVATE_EVENT_CONTENT'))
      await appendFile(path, 'more discarded bytes')
      await monitor.poll()
      assert.equal(diagnostics.length, 1)
      await appendFile(path, '"}}\n' + line('assistant.turn_end', { turnId: replay ? '1' : '2' }))
      await monitor.poll()
      assert.deepEqual(activity, replay ? [] : ['working', null], 'the turn after the gap must not revive stale activity')
      await appendFile(path, line('assistant.turn_start', { turnId: '3' }) + line('assistant.message', { content: 'Done' }) + line('assistant.turn_end', { turnId: '3' }))
      await monitor.poll()
      assert.deepEqual(activity.slice(-2), ['working', 'idle'])
    } finally { monitor.stop(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('activity tails complete records, seeds only the final outcome, and reports unknown tool-turn outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-activity-monitor-'))
  const path = join(directory, 'events.jsonl'), activity: string[] = []
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const monitor = new SessionPermissionMonitor(path, () => {}, 60_000, () => {}, (value) => activity.push(value ?? 'unknown'))
  try {
    await writeFile(path, line('assistant.turn_start', { turnId: 'old' }) + line('assistant.message', { content: 'Done' }) + line('assistant.turn_end', { turnId: 'old' }))
    await monitor.start()
    assert.deepEqual(activity, ['idle'])
    await appendFile(path, line('assistant.turn_start', { turnId: '1' }) + line('assistant.message', { content: '', toolRequests: [{}] }) + line('assistant.turn_end', { turnId: '1' }))
    await monitor.poll()
    assert.deepEqual(activity, ['idle', 'working', 'unknown'])
    const ending = line('assistant.turn_start', { turnId: '2' }) + line('assistant.message', { content: 'Done' }) + line('assistant.turn_end', { turnId: '2' })
    await appendFile(path, ending.slice(0, -2))
    await monitor.poll()
    assert.deepEqual(activity, ['idle', 'working', 'unknown', 'working'])
    await appendFile(path, ending.slice(-2))
    await monitor.poll()
    assert.deepEqual(activity, ['idle', 'working', 'unknown', 'working', 'idle'])
    await writeFile(path, line('assistant.turn_end', { turnId: '2' }))
    await monitor.poll()
    assert.equal(activity.at(-1), 'unknown')
  } finally { monitor.stop(); await rm(directory, { recursive: true, force: true }) }
})

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
