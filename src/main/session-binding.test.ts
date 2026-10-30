import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
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
