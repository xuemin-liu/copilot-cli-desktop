import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionStoreDiscovery, readSessionStart, worktreeNameFor } from './session-store-discovery.js'

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

test('the new session directory running in the worktree this launch named is the one; every other directory is ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-discovery-'))
  const launchCwd = join(root, 'project')
  try {
    const since = Date.now()
    await session(root, '11111111-1111-4111-8111-111111111111', start(since + 100, join(root, 'project.worktrees', 'desktop-mine-abc123')))
    const discovery = new SessionStoreDiscovery({ root, since, launchCwd, worktreeName: 'desktop-mine-abc123', pollMs: 20, timeoutMs: 5_000 })
    await discovery.ready()
    // Written after the snapshot: before the spawn, in the launch folder, without a cwd, in another launch's worktree,
    // a junk directory, an empty directory, then the real one.
    await session(root, '22222222-2222-4222-8222-222222222222', start(since - 60_000, join(root, 'project.worktrees', 'desktop-mine-abc123')))
    await session(root, '33333333-3333-4333-8333-333333333333', start(since + 50, launchCwd + '\\'))
    await session(root, '55555555-5555-4555-8555-555555555555', start(since + 50, null))
    await session(root, '66666666-6666-4666-8666-666666666666', start(since + 50, join(root, 'project.worktrees', 'desktop-other-ffffff')))
    await mkdir(join(root, 'not-a-session'), { recursive: true })
    await mkdir(join(root, '44444444-4444-4444-8444-444444444444'), { recursive: true })
    const pending = discovery.find()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await session(root, '44444444-4444-4444-8444-444444444444', start(since + 200, join(root, 'project.worktrees', 'DESKTOP-MINE-ABC123') + '\\'))
    assert.equal(await pending, '44444444-4444-4444-8444-444444444444', 'matched by folder name, case-insensitively, trailing separator ignored')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('two launches at once each adopt their own session, whichever log appears first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-discovery-'))
  const launchCwd = join(root, 'project')
  try {
    const since = Date.now()
    const a = new SessionStoreDiscovery({ root, since, launchCwd, worktreeName: 'desktop-a-000001', pollMs: 20, timeoutMs: 5_000 })
    const b = new SessionStoreDiscovery({ root, since, launchCwd, worktreeName: 'desktop-b-000002', pollMs: 20, timeoutMs: 5_000 })
    await Promise.all([a.ready(), b.ready()])
    const found = Promise.all([a.find(), b.find()])
    await session(root, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', start(since + 10, join(root, 'project.worktrees', 'desktop-a-000001')))
    await new Promise((resolve) => setTimeout(resolve, 80))
    await session(root, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', start(since + 20, join(root, 'project.worktrees', 'desktop-b-000002')))
    assert.deepEqual(await found, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('ready() completes the pre-spawn snapshot, so a directory created right after it is new', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-discovery-'))
  try {
    const { readdir } = await import('node:fs/promises')
    // A slow listing, as on a busy disk: the snapshot must still be taken before anything the spawn creates.
    const slowList = async (directory: string): Promise<Set<string>> => { await new Promise((resolve) => setTimeout(resolve, 80)); return new Set((await readdir(directory)).filter((name) => /^[0-9a-f-]{36}$/.test(name))) }
    const discovery = new SessionStoreDiscovery({ root, since: Date.now(), launchCwd: join(root, 'p'), worktreeName: 'desktop-x-abcdef', pollMs: 20, timeoutMs: 3_000, listSessions: slowList })
    await discovery.ready()
    await session(root, '12121212-1212-4121-8121-121212121212', start(Date.now(), join(root, 'p.worktrees', 'desktop-x-abcdef')))
    assert.equal(await discovery.find(), '12121212-1212-4121-8121-121212121212')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('worktree names are git-safe, bounded, derived from the title and unique per launch', () => {
  assert.equal(worktreeNameFor('Fix login race', () => 'abc123'), 'desktop-fix-login-race-abc123')
  assert.equal(worktreeNameFor('  --Weird__Title!! (v2) ', () => '000000'), 'desktop-weird-title-v2-000000')
  assert.equal(worktreeNameFor('', () => 'ffffff'), 'desktop-session-ffffff')
  assert.equal(worktreeNameFor('ü', () => 'ffffff'), 'desktop-session-ffffff')
  const long = worktreeNameFor('a'.repeat(100) + ' ' + 'b'.repeat(100), () => '123456')
  assert.equal(long, `desktop-${'a'.repeat(24)}-123456`)
  assert.match(worktreeNameFor('x'), /^desktop-x-[0-9a-f]{6}$/)
  assert.notEqual(worktreeNameFor('x'), worktreeNameFor('x'))
})

test('discovery gives up at the timeout and stops when cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-discovery-'))
  try {
    const timed = new SessionStoreDiscovery({ root, since: Date.now(), launchCwd: root, worktreeName: 'desktop-t-000000', pollMs: 10, timeoutMs: 80 })
    assert.equal(await timed.find(), null)
    const cancelled = new SessionStoreDiscovery({ root, since: Date.now(), launchCwd: root, worktreeName: 'desktop-t-000000', pollMs: 10, timeoutMs: 10_000 })
    const pending = cancelled.find()
    setTimeout(() => cancelled.cancel(), 30)
    const before = Date.now()
    assert.equal(await pending, null)
    assert.ok(Date.now() - before < 2_000, 'cancel ends the wait')
    const missing = new SessionStoreDiscovery({ root: join(root, 'absent'), since: Date.now(), launchCwd: root, worktreeName: 'desktop-t-000000', pollMs: 10, timeoutMs: 50 })
    assert.equal(await missing.find(), null, 'a missing store is not an error')
  } finally { await rm(root, { recursive: true, force: true }) }
})
