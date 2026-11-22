import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXPECTED_PR_WAIT_MS, PrReviewQueue, QUEUE_FILE, startupReopens, type QueueListing } from './pr-review-queue.js'
import type { ReviewCandidate } from './types.js'

const T0 = Date.parse('2026-11-02T12:00:00Z')
const url = (number: number): string => `https://github.com/owner/repo/pull/${number}`

interface Harness {
  queue: PrReviewQueue; open: ReviewCandidate[]; started: string[]; path: string
  /** A PR opened now (after the queue was turned on, unless `at` says otherwise). */
  pr: (number: number, reason?: string | null, at?: number) => ReviewCandidate
  advance: (ms: number) => void; failNext: () => void; failList: () => void
  setOrigin: (repository: string) => void
  /** The next listing waits until `release` runs. */
  holdList: () => { release: () => void }
}
async function fixture(run: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-queue-'))
  const open: ReviewCandidate[] = [], started: string[] = []
  let now = T0, failStart = false, failListing = false, origin = 'owner/repo', hold: Promise<void> | null = null
  const path = join(dir, 'queue.json')
  const queue = new PrReviewQueue(path, {
    now: () => now,
    candidates: async (): Promise<QueueListing> => {
      if (hold) { const wait = hold; hold = null; await wait }
      if (failListing) { failListing = false; throw new Error('GitHub is unavailable') }
      return { repository: origin, pulls: structuredClone(open) }
    },
    start: async (target) => { if (failStart) { failStart = false; throw new Error('clone failed') } started.push(target) },
  })
  const pr = (number: number, reason: string | null = null, at = now + 1): ReviewCandidate => ({ number, title: `PR ${number}`, author: 'me', url: url(number), reason, createdAt: at })
  try {
    await run({ queue, open, started, path, pr, advance: (ms) => { now += ms }, failNext: () => { failStart = true }, failList: () => { failListing = true },
      setOrigin: (repository) => { origin = repository },
      holdList: () => { let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve }); return { release } } })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('turning the queue on takes no backlog; a new qualifying PR starts once', () => fixture(async (h) => {
  h.open.push(h.pr(1, null, T0 - 1000), h.pr(2, null, T0 - 1000))
  await h.queue.enable('project')
  await h.queue.tick()
  assert.deepEqual(h.started, [], 'PRs open before the opt-in are not reviewed')
  h.open.push(h.pr(3))
  await h.queue.tick(); await h.queue.tick()
  assert.deepEqual(h.started, [url(3)])
}))

test('an old PR that the listing missed when the queue was turned on is never taken for a new one', () => fixture(async (h) => {
  await h.queue.enable('project')
  // PR 1 was open all along (a page the first listing did not show, say): opened before the queue was on.
  h.open.push(h.pr(1, null, T0 - 86_400_000), h.pr(2))
  await h.queue.tick(); await h.queue.tick()
  assert.deepEqual(h.started, [url(2)])
}))

test('asking again while it is on changes nothing, and keeps PRs that opened meanwhile', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.advance(1000); h.open.push(h.pr(4))
  const again = await h.queue.enable('project')
  assert.equal(again.activatedAt, T0, 'the same queue, not a new baseline')
  await h.queue.tick()
  assert.deepEqual(h.started, [url(4)])
}))

test('a fork or someone else\'s PR waits, and starts once it qualifies; PRs out of order are not missed', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.open.push(h.pr(9, 'Not your pull request'), h.pr(7))
  await h.queue.tick()
  assert.deepEqual(h.started, [url(7)], 'the lower number first, the one that qualifies')
  assert.deepEqual(h.queue.views().project!.waiting, [9])
  h.open[0] = { ...h.open[0]!, reason: null }
  await h.queue.tick()
  assert.deepEqual(h.started.at(-1), url(9))
}))

test('one start per pass, with no daily or total cap', () => fixture(async (h) => {
  await h.queue.enable('project')
  for (let n = 1; n <= 12; n++) h.open.push(h.pr(n))
  await h.queue.tick()
  assert.equal(h.started.length, 1)
  for (let pass = 0; pass < 15; pass++) await h.queue.tick()
  assert.equal(h.started.length, 12)
}))

test('a failed start is recorded and not retried by itself; a failed listing starts nothing', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.open.push(h.pr(4)); h.failNext()
  await h.queue.tick()
  assert.match(h.queue.views().project!.lastError ?? '', /#4: clone failed/)
  await h.queue.tick()
  assert.deepEqual(h.started, [])
  h.open.push(h.pr(5)); h.failList()
  await h.queue.tick()
  assert.match(h.queue.views().project!.lastError ?? '', /unavailable/)
  await h.queue.tick()
  assert.deepEqual(h.started, [url(5)])
}))

test('Stop during a check that is under way wins, also when that check fails', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.open.push(h.pr(6))
  let held = h.holdList()
  const tick = h.queue.tick()
  await new Promise((resolve) => setImmediate(resolve))
  await h.queue.disable('project')
  held.release(); await tick
  assert.equal(h.queue.views().project!.enabled, false, 'the check did not write the old state back')
  await h.queue.tick()
  assert.deepEqual(h.started, [], 'and nothing started later')
  // The error path: turned on again, a failing check is under way when Stop comes.
  await h.queue.enable('project')
  h.open.push(h.pr(7))
  held = h.holdList(); h.failList()
  const failing = h.queue.tick()
  await new Promise((resolve) => setImmediate(resolve))
  await h.queue.disable('project')
  held.release(); await failing
  assert.equal(h.queue.views().project!.enabled, false)
  assert.equal(h.queue.views().project!.lastError, null, 'the stale failure is not recorded either')
}))

test('a changed origin starts nothing until the person asks again', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.setOrigin('owner/new'); h.open.push(h.pr(8))
  await h.queue.tick()
  assert.deepEqual(h.started, [])
  assert.match(h.queue.views().project!.lastError ?? '', /owner\/new, not owner\/repo/)
  await assert.rejects(h.queue.enable('project', 'owner/repo'), /origin is owner\/new/, 'a review of the old repository cannot turn it on')
  await h.queue.enable('project')
  assert.equal(h.queue.views().project!.repository, 'owner/new')
}))

test('a queue with no open PRs still knows its repository', () => fixture(async (h) => {
  const state = await h.queue.enable('project')
  assert.equal(state.repository, 'owner/repo')
}))

test('a PR asked for before it exists starts when it appears, within the hour', () => fixture(async (h) => {
  await h.queue.expect('project', 'owner/repo', 20)
  await h.queue.tick()
  assert.deepEqual(h.started, [])
  assert.equal(h.queue.views().project!.enabled, false, 'waiting for one PR does not turn on the new-PR queue')
  h.advance(60_000); h.open.push(h.pr(20))
  await h.queue.tick()
  assert.deepEqual(h.started, [url(20)])
  await h.queue.expect('project', 'owner/repo', 21)
  h.advance(EXPECTED_PR_WAIT_MS + 1); h.open.push(h.pr(21))
  await h.queue.tick()
  assert.deepEqual(h.started, [url(20)], 'too late')
  assert.match(h.queue.views().project!.lastError ?? '', /did not appear within the hour/)
}))

test('turning it off stops starts; the state survives a restart; a broken or old file enables nothing', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.open.push(h.pr(6))
  await h.queue.disable('project')
  await h.queue.tick()
  assert.deepEqual(h.started, [])
  const none = async (): Promise<QueueListing> => ({ repository: 'owner/repo', pulls: [h.pr(6)] })
  const again = new PrReviewQueue(h.path, { candidates: none, start: async () => { throw new Error('must not start') } })
  await again.load(); assert.equal(again.views().project!.enabled, false)
  await writeFile(h.path, '{"project":{"enabled":true,"total":99}}')
  const broken = new PrReviewQueue(h.path, { candidates: none, start: async () => { throw new Error('must not start') } })
  await broken.tick(); assert.deepEqual(broken.views(), {})
  await writeFile(h.path, JSON.stringify({ project: { enabled: true, repository: null, activatedAt: T0, seen: [], waiting: [], day: 1, dayStarts: 0, total: 0, lastError: null } }))
  const old = new PrReviewQueue(h.path, { candidates: none, start: async () => { throw new Error('must not start') } })
  await old.tick(); assert.deepEqual(old.views(), {}, 'a queue saved without its repository is dropped')
}))

test('a paused project starts nothing until it resumes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-queue-pause-'))
  let paused = true, now = T0
  const started: string[] = []
  const pr = (number: number): ReviewCandidate => ({ number, title: '', author: 'me', url: url(number), reason: null, createdAt: now + 1 })
  try {
    const queue = new PrReviewQueue(join(dir, 'q.json'), { now: () => now, candidates: async () => ({ repository: 'owner/repo', pulls: [pr(11)] }), start: async (target) => { started.push(target) }, paused: () => paused })
    await queue.enable('project')
    now += 1000
    const twelve = pr(12)
    const fresh = new PrReviewQueue(join(dir, 'q.json'), { now: () => now, candidates: async () => ({ repository: 'owner/repo', pulls: [{ ...pr(11), createdAt: T0 - 1 }, twelve] }), start: async (target) => { started.push(target) }, paused: () => paused })
    await fresh.tick(); assert.deepEqual(started, [])
    paused = false
    await fresh.tick(); assert.deepEqual(started, [url(12)])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('requested PRs that appear together start one per pass, none dropped', () => fixture(async (h) => {
  await h.queue.expect('project', 'owner/repo', 30)
  await h.queue.expect('project', 'owner/repo', 31)
  h.open.push(h.pr(30), h.pr(31))
  await h.queue.tick()
  assert.deepEqual(h.started, [url(30)])
  await h.queue.tick()
  assert.deepEqual(h.started, [url(30), url(31)], 'the second request was kept for the next pass')
}))

test('Stop or a pause while a start is being recorded holds that start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-queue-start-'))
  let now = T0, paused = false, holdNext = false
  const hold: { gate: (() => void) | null } = { gate: null }
  const started: string[] = [], pulls: ReviewCandidate[] = []
  const queue = new PrReviewQueue(join(dir, 'q.json'), {
    now: () => now, paused: () => paused,
    candidates: async () => ({ repository: 'owner/repo', pulls: structuredClone(pulls) }),
    start: async (target) => { started.push(target) },
    write: async (path, text) => {
      if (holdNext) { holdNext = false; await new Promise<void>((resolve) => { hold.gate = resolve }) }
      const { writeFile } = await import('node:fs/promises'); await writeFile(path, text)
    },
  })
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))
  try {
    await queue.enable('project')
    now += 1000; pulls.push({ number: 40, title: '', author: 'me', url: url(40), reason: null, createdAt: now })
    holdNext = true
    const tick = queue.tick()
    await settle()
    assert.ok(hold.gate, 'the start is being recorded')
    // Stop takes effect at once; its save waits behind the check's slower one, and is written after it.
    const stop = queue.disable('project')
    await settle()
    hold.gate!(); await tick; await stop
    assert.deepEqual(started, [], 'Stop came while the start was recorded: it never runs')
    const reloaded = new PrReviewQueue(join(dir, 'q.json'), { candidates: async () => ({ repository: 'owner/repo', pulls: [] }), start: async () => { throw new Error('must not start') } })
    await reloaded.load()
    assert.equal(reloaded.views().project!.enabled, false, 'Stop is what the file holds after a restart')
    // Asking again while it is on changes nothing, so a start being recorded meanwhile carries on.
    await queue.enable('project')
    now += 1000; pulls.push({ number: 42, title: '', author: 'me', url: url(42), reason: null, createdAt: now })
    holdNext = true; hold.gate = null
    const kept = queue.tick()
    await settle()
    await queue.enable('project')
    hold.gate!(); await kept
    assert.deepEqual(started, [url(42)], 'a no-op enable does not cancel the start')
    // A pause at that moment holds the start for the next pass instead of losing it.
    await queue.disable('project')
    await queue.enable('project')
    now += 1000; pulls.push({ number: 41, title: '', author: 'me', url: url(41), reason: null, createdAt: now })
    holdNext = true; hold.gate = null
    const paused1 = queue.tick()
    await settle()
    paused = true
    hold.gate!(); await paused1
    assert.deepEqual(started, [url(42)], 'held by the pause')
    paused = false
    await queue.tick()
    assert.deepEqual(started, [url(42), url(41)])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a queue turned on before any review ran restarts from its own file, with no follow-up database', async () => {
  const { existsSync } = await import('node:fs')
  const data = await mkdtemp(join(tmpdir(), 'pr-review-queue-restart-'))
  const listing = (pulls: ReviewCandidate[]) => async (): Promise<QueueListing> => ({ repository: 'owner/repo', pulls })
  const pr = (number: number): ReviewCandidate => ({ number, title: '', author: 'me', url: url(number), reason: null, createdAt: Date.now() + 60_000 })
  try {
    assert.deepEqual(startupReopens((name) => existsSync(join(data, name))), { followups: false, queue: false }, 'a fresh profile reopens nothing')
    // "review new PRs" and "review PR 50" (not open yet) on a fresh profile: only the queue's own file is written.
    const first = new PrReviewQueue(join(data, QUEUE_FILE), { candidates: listing([]), start: async () => {} })
    await first.enable('project')
    await first.expect('project', 'owner/repo', 50)
    assert.deepEqual(startupReopens((name) => existsSync(join(data, name))), { followups: false, queue: true }, 'the restart reopens the queue')
    const started: string[] = []
    const reopened = new PrReviewQueue(join(data, QUEUE_FILE), { candidates: listing([pr(50), pr(51)]), start: async (target) => { started.push(target) } })
    await reopened.tick(); await reopened.tick()
    assert.deepEqual(started, [url(50), url(51)], 'the PR it waited for, then a new one')
  } finally { await rm(data, { recursive: true, force: true }) }
})
