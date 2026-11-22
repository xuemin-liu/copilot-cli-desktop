import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrReviewQueue, QUEUE_DAILY_STARTS, QUEUE_TOTAL_STARTS } from './pr-review-queue.js'
import type { ReviewCandidate } from './types.js'

const pr = (number: number, reason: string | null = null): ReviewCandidate => ({ number, title: `PR ${number}`, author: 'me', url: `https://github.com/owner/repo/pull/${number}`, reason })

async function fixture(run: (h: { queue: PrReviewQueue; open: ReviewCandidate[]; started: string[]; advance: (ms: number) => void; failNext: () => void; failList: () => void; path: string }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-queue-'))
  const open: ReviewCandidate[] = [], started: string[] = []
  let now = Date.parse('2026-11-02T12:00:00Z'), failStart = false, failListing = false
  const path = join(dir, 'queue.json')
  const queue = new PrReviewQueue(path, {
    now: () => now,
    candidates: async () => { if (failListing) { failListing = false; throw new Error('GitHub is unavailable') } return structuredClone(open) },
    start: async (url) => { if (failStart) { failStart = false; throw new Error('clone failed') } started.push(url) },
  })
  try { await run({ queue, open, started, advance: (ms) => { now += ms }, failNext: () => { failStart = true }, failList: () => { failListing = true }, path }) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('turning the queue on takes no backlog; a new qualifying PR starts once', () => fixture(async (h) => {
  h.open.push(pr(1), pr(2))
  await h.queue.enable('project')
  await h.queue.tick()
  assert.deepEqual(h.started, [], 'PRs open before the opt-in are not reviewed')
  h.open.push(pr(3))
  await h.queue.tick(); await h.queue.tick()
  assert.deepEqual(h.started, ['https://github.com/owner/repo/pull/3'])
}))

test('a fork or someone else\'s PR waits, and starts once it qualifies; PRs out of order are not missed', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.open.push(pr(9, 'Not your pull request'), pr(7))
  await h.queue.tick()
  assert.deepEqual(h.started, ['https://github.com/owner/repo/pull/7'], 'the lower number first, the one that qualifies')
  assert.deepEqual(h.queue.views().project!.waiting, [9])
  h.open[0] = pr(9)
  await h.queue.tick()
  assert.deepEqual(h.started.at(-1), 'https://github.com/owner/repo/pull/9')
}))

test('one start per pass, three a day and ten in all', () => fixture(async (h) => {
  await h.queue.enable('project')
  for (let n = 1; n <= 12; n++) h.open.push(pr(n))
  for (let pass = 0; pass < 5; pass++) await h.queue.tick()
  assert.equal(h.started.length, QUEUE_DAILY_STARTS)
  for (let d = 0; d < 5; d++) { h.advance(86_400_000); for (let pass = 0; pass < 4; pass++) await h.queue.tick() }
  assert.equal(h.started.length, QUEUE_TOTAL_STARTS)
}))

test('a failed start is recorded and not retried by itself; a failed listing starts nothing', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.open.push(pr(4)); h.failNext()
  await h.queue.tick()
  assert.match(h.queue.views().project!.lastError ?? '', /#4: clone failed/)
  await h.queue.tick()
  assert.deepEqual(h.started, [])
  h.open.push(pr(5)); h.failList()
  await h.queue.tick()
  assert.match(h.queue.views().project!.lastError ?? '', /unavailable/)
  await h.queue.tick()
  assert.deepEqual(h.started, ['https://github.com/owner/repo/pull/5'])
}))

test('turning it off stops starts; the state survives a restart; a broken file enables nothing', () => fixture(async (h) => {
  await h.queue.enable('project')
  h.open.push(pr(6))
  await h.queue.disable('project')
  await h.queue.tick()
  assert.deepEqual(h.started, [])
  const again = new PrReviewQueue(h.path, { candidates: async () => [pr(6)], start: async () => { throw new Error('must not start') } })
  await again.load(); assert.equal(again.views().project!.enabled, false)
  await writeFile(h.path, '{"project":{"enabled":true,"total":99}}')
  const broken = new PrReviewQueue(h.path, { candidates: async () => [pr(6)], start: async () => { throw new Error('must not start') } })
  await broken.tick(); assert.deepEqual(broken.views(), {})
}))

test('a paused project starts nothing until it resumes', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-queue-pause-'))
  let paused = true
  const started: string[] = []
  try {
    const queue = new PrReviewQueue(join(dir, 'q.json'), { candidates: async () => [pr(11)], start: async (url) => { started.push(url) }, paused: () => paused })
    await queue.enable('project')
    const fresh = new PrReviewQueue(join(dir, 'q.json'), { candidates: async () => [pr(11), pr(12)], start: async (url) => { started.push(url) }, paused: () => paused })
    await fresh.tick(); assert.deepEqual(started, [])
    paused = false
    await fresh.tick(); assert.deepEqual(started, ['https://github.com/owner/repo/pull/12'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
