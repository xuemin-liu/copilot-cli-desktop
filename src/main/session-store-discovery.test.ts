import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionStoreDiscovery, readSessionStart } from './session-store-discovery.js'

const start = (startTime: number, cwd: string | null, type = 'session.start'): string =>
  JSON.stringify({ type, data: { sessionId: 'x', startTime: new Date(startTime).toISOString(), context: cwd === null ? {} : { cwd } } }) + '\n{"type":"next"}\n'

async function session(root: string, id: string, content: string): Promise<void> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'events.jsonl'), content)
}

test('readSessionStart reads only a leading session.start record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-discovery-'))
  try {
    await session(root, 'a', start(1_000, 'D:\\wt'))
    assert.deepEqual(await readSessionStart(join(root, 'a', 'events.jsonl')), { startTime: 1_000, cwd: 'D:\\wt' })
    await session(root, 'b', start(1_000, 'D:\\wt', 'session.resume'))
    assert.equal(await readSessionStart(join(root, 'b', 'events.jsonl')), null)
    await session(root, 'c', '{"type":"session.start","data":{"startTime":"soon"}}\n')
    assert.equal(await readSessionStart(join(root, 'c', 'events.jsonl')), null, 'an unparsable start time is not a start')
    await session(root, 'd', '{"type":"session.start","data":{"startTime":"2026-10-12T00:00:00.000Z"}')
    assert.equal(await readSessionStart(join(root, 'd', 'events.jsonl')), null, 'a record without its newline is not complete yet')
    await session(root, 'e', `{"type":"session.start","data":{"startTime":"2026-10-12T00:00:00.000Z","context":{"cwd":"${'x'.repeat(5_000)}"}}}\n`)
    assert.equal(await readSessionStart(join(root, 'e', 'events.jsonl')), null, 'only the first kilobytes are read')
    assert.equal(await readSessionStart(join(root, 'missing', 'events.jsonl')), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a new session directory started after the spawn, outside the launch folder, is the one; others are ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-discovery-'))
  const launchCwd = join(root, 'project')
  try {
    const since = Date.now()
    await session(root, '11111111-1111-4111-8111-111111111111', start(since + 100, join(root, 'project.worktrees', 'old')))
    const discovery = new SessionStoreDiscovery({ root, since, launchCwd, pollMs: 20, timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Written after the snapshot: one from before the spawn, one in the launch folder, a junk directory, then the real one.
    await session(root, '22222222-2222-4222-8222-222222222222', start(since - 60_000, join(root, 'project.worktrees', 'stale')))
    await session(root, '33333333-3333-4333-8333-333333333333', start(since + 50, launchCwd + '\\'))
    await mkdir(join(root, 'not-a-session'), { recursive: true })
    await mkdir(join(root, '44444444-4444-4444-8444-444444444444'), { recursive: true })
    const pending = discovery.find()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await session(root, '44444444-4444-4444-8444-444444444444', start(since + 200, join(root, 'project.worktrees', 'fresh')))
    assert.equal(await pending, '44444444-4444-4444-8444-444444444444')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('discovery gives up at the timeout and stops when cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-discovery-'))
  try {
    const timed = new SessionStoreDiscovery({ root, since: Date.now(), launchCwd: root, pollMs: 10, timeoutMs: 80 })
    assert.equal(await timed.find(), null)
    const cancelled = new SessionStoreDiscovery({ root, since: Date.now(), launchCwd: root, pollMs: 10, timeoutMs: 10_000 })
    const pending = cancelled.find()
    setTimeout(() => cancelled.cancel(), 30)
    const before = Date.now()
    assert.equal(await pending, null)
    assert.ok(Date.now() - before < 2_000, 'cancel ends the wait')
    const missing = new SessionStoreDiscovery({ root: join(root, 'absent'), since: Date.now(), launchCwd: root, pollMs: 10, timeoutMs: 50 })
    assert.equal(await missing.find(), null, 'a missing store is not an error')
  } finally { await rm(root, { recursive: true, force: true }) }
})
