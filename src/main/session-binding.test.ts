import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBindingReader, sessionResumeOffset } from './session-binding.js'
import { processDescendants } from './process-tree.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const line = (type: string, data: object, extra = {}) => JSON.stringify({ type, data, ...extra }) + '\n'

test('OS ancestry excludes sibling sessions, malformed rows, missing parents and cycles', () => {
  assert.deepEqual([...processDescendants('10 1\n11 10\n12 11\n20 1\n21 20\n30 31\n31 30\nprivate invalid row', 10)], [10, 11, 12])
  assert.equal(processDescendants('11 10', 10).size, 0)
})

test('routing hints select only root sessions locked by the pinned CLI process, including retained sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-'))
  const processes = new Set([10, 11, 12])
  let processQueries = 0
  const reader = new SessionBindingReader(root, 10, async () => { processQueries++; return processes }, pid => processes.has(pid))
  const create = async (id: string, owner: number) => {
    await mkdir(join(root, id))
    await writeFile(join(root, id, 'events.jsonl'), line('session.start', { sessionId: id, startTime: new Date().toISOString() }))
    await writeFile(join(root, id, `inuse.${owner}.lock`), '')
  }
  try {
    await create(A, 11)
    assert.deepEqual(await reader.read(A), { kind: 'bound', sessionId: A, ownerPid: 11, deliveryReady: true })
    await create(B, 11)
    assert.deepEqual(await reader.read(A, B), { kind: 'bound', sessionId: B, ownerPid: 11, deliveryReady: false })
    assert.deepEqual(await reader.read(B, A), { kind: 'bound', sessionId: A, ownerPid: 11, deliveryReady: false })
    await create(C, 12)
    assert.deepEqual(await reader.read(B, C), { kind: 'unknown' }, 'a nested CLI cannot impersonate the pinned CLI')
    const unanchored = new SessionBindingReader(root, 10, async () => processes, pid => processes.has(pid))
    assert.deepEqual(await unanchored.read('missing-session', C), { kind: 'unknown' }, 'an unanchored hint cannot choose a nested owner over the other CLI')
    assert.deepEqual(await reader.read(B, '../outside'), { kind: 'unknown' })
    await writeFile(join(root, B, 'events.jsonl'), line('session.start', { sessionId: B, startTime: new Date().toISOString(), detachedFromSpawningParentSessionId: A }))
    assert.deepEqual(await reader.read(A, B), { kind: 'unknown' }, 'detached/subagent sessions are excluded')
    assert.equal(processQueries, 1, 'a pinned owner does not need repeated process-tree subprocesses')
    processes.delete(11)
    assert.deepEqual(await reader.read(A, C), { kind: 'unknown' }, 'ownership cannot migrate to a surviving nested CLI')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a session switched before its first prompt can be verified from the caller; foreign locks cannot bind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-first-'))
  try {
    await mkdir(join(root, B))
    await writeFile(join(root, B, 'events.jsonl'), line('session.start', { sessionId: B, startTime: new Date().toISOString() }))
    await writeFile(join(root, B, 'inuse.11.lock'), '')
    const reader = new SessionBindingReader(root, 10, async () => new Set([10, 11]), () => true)
    assert.deepEqual(await reader.read(A, B), { kind: 'bound', sessionId: B, ownerPid: 11, deliveryReady: true })
    const foreign = new SessionBindingReader(root, 20, async () => new Set([20, 21]), () => true)
    assert.deepEqual(await foreign.read(A, B), { kind: 'unknown' })
    const dead = new SessionBindingReader(root, 10, async () => new Set([10, 11]), () => false)
    assert.deepEqual(await dead.read(A, B), { kind: 'unknown' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a cold binding replays only the newest root resume epoch of this process, with exact UTF-8 byte boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-offset-'))
  const path = join(root, 'events.jsonl')
  const launched = Date.parse('2026-10-30T20:00:00Z')
  try {
    const history = line('session.start', { startTime: '2026-10-29T20:00:00Z' }) + line('user.message', { content: '旧的请求' })
    const first = line('session.resume', { resumeTime: '2026-10-30T20:00:01Z' }) + line('user.message', { content: 'older resumed prompt' })
    const latest = line('session.resume', { resumeTime: '2026-10-30T20:00:02Z' })
    await writeFile(path, history + first + latest + line('user.message', { content: 'start a meeting' })
      + line('session.resume', { resumeTime: '2026-10-30T20:00:03Z' }, { agentId: 'subagent' }))
    assert.equal(await sessionResumeOffset(path, launched), Buffer.byteLength(history + first))
    await writeFile(path, history)
    assert.equal(await sessionResumeOffset(path, launched), Buffer.byteLength(history), 'old history never authorizes')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a store above 10,000 sessions stays bound and repeated reads reuse discovery while verifying caller locks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-large-'))
  let scans = 0, now = 100
  const reader = new SessionBindingReader(root, 10, async () => new Set([10, 11]), () => true, {
    now: () => now,
    list: async directory => { scans++; return readdir(directory, { withFileTypes: true }) },
  })
  try {
    for (let first = 0; first < 10_001; first += 32) {
      await Promise.all(Array.from({ length: Math.min(32, 10_001 - first) }, (_, index) => mkdir(join(root, `old-${first + index}`))))
    }
    await mkdir(join(root, A))
    await mkdir(join(root, B))
    await writeFile(join(root, A, 'events.jsonl'), line('session.start', { sessionId: A, startTime: new Date().toISOString() }))
    await writeFile(join(root, A, 'inuse.11.lock'), '')
    await writeFile(join(root, B, 'events.jsonl'), line('session.start', { sessionId: B, startTime: new Date().toISOString() }))
    assert.deepEqual(await reader.read(A), { kind: 'bound', sessionId: A, ownerPid: 11, deliveryReady: true })
    assert.equal(reader.diagnostic.failure, null)
    for (let count = 0; count < 10; count++) assert.equal((await reader.read(A)).kind, 'bound')
    assert.equal(scans, 1, 'steady-state reads do not enumerate the whole store')
    await writeFile(join(root, B, 'inuse.11.lock'), '')
    assert.deepEqual(await reader.read(A, B), { kind: 'bound', sessionId: B, ownerPid: 11, deliveryReady: false }, 'resumed old directory is checked directly')
    assert.deepEqual(await reader.read(B, A), { kind: 'bound', sessionId: A, ownerPid: 11, deliveryReady: false }, 'retained hints remain known')
    await rm(join(root, B, 'inuse.11.lock'))
    assert.equal((await reader.read(A, B)).kind, 'unknown', 'a cache hit never verifies a removed lock')
    now += 30_000
    assert.equal((await reader.read(A)).kind, 'bound')
    assert.equal(scans, 2, 'slow sweep discovers changes in old directories')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed and unanchored process discovery backs off without preventing a newly created lock from binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-backoff-'))
  let queries = 0, now = 100
  const processes = new Set<number>()
  const reader = new SessionBindingReader(root, 10, async () => { queries++; return new Set(processes) }, () => true, { now: () => now })
  try {
    for (let count = 0; count < 3; count++) assert.equal((await reader.read(A)).kind, 'unavailable')
    assert.equal(queries, 1, 'failed snapshot is not retried on every helper request')
    processes.add(10); processes.add(11)
    now += 30_000
    for (let count = 0; count < 3; count++) assert.equal((await reader.read(A)).kind, 'unavailable')
    assert.equal(queries, 2, 'unanchored snapshots also back off')
    await mkdir(join(root, A))
    await writeFile(join(root, A, 'events.jsonl'), line('session.start', { sessionId: A, startTime: new Date().toISOString() }))
    await writeFile(join(root, A, 'inuse.11.lock'), '')
    assert.equal((await reader.read(A)).kind, 'bound', 'new locks are checked without a fresh process snapshot')
    assert.equal(queries, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an unavailable inventory keeps a verified known session observable with automatic delivery paused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-skipped-'))
  const reader = new SessionBindingReader(root, 10, async () => new Set([10, 11]), () => true, {
    list: async () => { throw new Error('inventory temporarily unavailable') },
  })
  try {
    await mkdir(join(root, A))
    await writeFile(join(root, A, 'events.jsonl'), line('session.start', { sessionId: A, startTime: new Date().toISOString() }))
    await writeFile(join(root, A, 'inuse.11.lock'), '')
    assert.deepEqual(await reader.read(A), { kind: 'bound', sessionId: A, ownerPid: 11, deliveryReady: false })
    assert.equal(reader.diagnostic.failure, 'session-inventory-unavailable')
    await rm(join(root, A, 'inuse.11.lock'))
    assert.deepEqual(await reader.read(A), { kind: 'deferred' }, 'a skipped scan does not report definite lost ownership')
  } finally { await rm(root, { recursive: true, force: true }) }
})
