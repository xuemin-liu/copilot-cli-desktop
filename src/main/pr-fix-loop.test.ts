import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WorkflowFollowups, type FollowupHost } from './workflow-followups.js'
import { WorkflowDeliveries } from './workflow-deliveries.js'
import { WorkflowStore } from './workflow-store.js'

const first = 'a'.repeat(40), second = 'd'.repeat(40), base = 'b'.repeat(40)
const URL = 'https://github.com/owner/repo/pull/1'
const AUTHOR = 42, REVIEWER = 7

async function fixture(run: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  const h = await setup()
  try { await run(h) } finally { h.controller.close(); h.journal.close(); h.tasks.close(); await rm(h.dir, { recursive: true, force: true }) }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pr-fix-loop-'))
  const tasks = new WorkflowStore(join(dir, 'tasks.sqlite'))
  const task = tasks.submitted('session', 'project', 'Fix the checkout bug')
  const other = tasks.submitted('session-2', 'project', 'Another task')
  const journal = new WorkflowDeliveries(join(dir, 'deliveries.sqlite'))
  let now = Date.parse('2026-11-02T12:00:00Z'), open = true, head = first, baseSha = base, checksFail = false, settled = true, checkReads = 0
  const comments: Record<string, unknown>[] = [], conversation: Record<string, unknown>[] = [], reviews: Record<string, unknown>[] = []
  const injected: string[] = []
  let controller: WorkflowFollowups
  const host: FollowupHost = { journal, task: (id) => tasks.list().find((t) => t.id === id) ?? null,
    permissionKey: () => 'a'.repeat(64), verifyRepository: async () => {}, now: () => now, changed: () => {}, interrupt: () => {},
    postsSettled: () => settled,
    api: async (path) => {
      if (path === 'users/reviewer') return { id: REVIEWER, login: 'reviewer' }
      if (path === 'user') return { id: AUTHOR }
      if (path === 'repos/owner/repo/pulls/1') return { state: open ? 'open' : 'closed', merged: !open, user: { id: AUTHOR }, head: { sha: head, ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { sha: baseSha } }
      if (path.includes('/check-runs') || path.includes('/statuses')) { checkReads++; if (checksFail) throw new Error('CI unavailable'); return path.includes('/check-runs') ? [{ check_runs: [] }] : [[]] }
      if (path === 'repos/owner/repo/pulls/1/comments?per_page=100') return [comments]
      if (path === 'repos/owner/repo/issues/1/comments?per_page=100') return [conversation]
      if (path === 'repos/owner/repo/pulls/1/reviews?per_page=100') return [reviews]
      return [[]]
    },
    send: async (delivery, grant) => {
      if (!journal.begin(delivery.id, () => controller.authorized(grant))) return 'busy'
      injected.push(delivery.id)
      return 'sent'
    },
  }
  controller = new WorkflowFollowups(join(dir, 'followups.sqlite'), host)
  const stamp = (): string => new Date(now + 1).toISOString()
  return { dir, tasks, task, other, journal, controller, host, injected,
    advance: (ms = 120_001) => { now += ms },
    push: () => { head = second },
    moveBase: () => { baseSha = 'e'.repeat(40) },
    close: () => { open = false },
    failChecks: () => { checksFail = true },
    checkReads: () => checkReads,
    unsettle: () => { settled = false },
    inline: (id: number, actor = REVIEWER, body = `Finding ${id}`, commit = head) => comments.push({ id, user: { id: actor }, body, updated_at: stamp(), commit_id: commit, original_commit_id: commit }),
    talk: (id: number, actor = REVIEWER, body = `Note ${id}`) => conversation.push({ id, user: { id: actor }, body, updated_at: stamp() }),
    review: (id: number, actor: number, state: string, commit = head, body = '') => reviews.push({ id, user: { id: actor }, state, commit_id: commit, submitted_at: stamp(), body }),
  }
}
const enrollFix = (h: Awaited<ReturnType<typeof setup>>, includeExisting = false) =>
  h.controller.enroll(h.task.id, URL, ['reviewer'], false, false, { role: 'author', includeExisting })

test('a fix loop records the account, the marker and its own budget, and needs named reviewers', () => fixture(async (h) => {
  await assert.rejects(h.controller.enroll(h.task.id, URL, [], true, false, { role: 'author' }), /Name the reviewers/)
  const grant = await enrollFix(h)
  assert.equal(grant.role, 'author'); assert.equal(grant.accountId, AUTHOR); assert.equal(grant.marker, '🤖 '); assert.equal(grant.limit, 30)
  await assert.rejects(h.controller.enroll(h.task.id, URL, ['reviewer'], false, false, { role: 'owner' as 'author' }), /Invalid/)
  await assert.rejects(h.controller.enroll(h.task.id, URL, ['reviewer'], false, false, { includeExisting: true }), /Invalid/, 'only a fix loop takes existing feedback')
}))

test('one fix loop per PR, and a legacy follow-up shares a PR with nothing', () => fixture(async (h) => {
  await enrollFix(h)
  await assert.rejects(h.controller.enroll(h.other.id, URL, ['reviewer'], false, false, { role: 'author' }), /already has a loop/)
  await assert.rejects(h.controller.enroll(h.other.id, URL, ['reviewer'], false), /already belongs/)
}))

test('marked replies never wake the author; findings on older commits still do', () => fixture(async (h) => {
  await enrollFix(h)
  h.advance()
  h.inline(1, REVIEWER, '🤖 Fixed in 1234567')
  h.talk(2, AUTHOR, '🤖 My summary')
  await h.controller.tick()
  assert.equal(h.journal.list().length, 0)
  h.inline(3, REVIEWER, 'Blocking: missing test', 'c'.repeat(40))
  h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 1)
  const text = h.journal.list()[0]!.text
  assert.match(text, /fix loop/)
  assert.match(text, /pr-reply/)
  assert.doesNotMatch(text, /post GitHub comments/)
}))

test('a queued batch is carried to the new head after a push instead of being dropped', () => fixture(async (h) => {
  await enrollFix(h)
  h.host.ready = () => false
  h.advance(); h.inline(1); await h.controller.tick()
  const queued = h.journal.list()[0]!
  assert.equal(queued.state, 'queued')
  h.push()
  h.host.ready = () => true
  h.advance(); await h.controller.tick()
  const live = h.journal.list().filter((d) => d.state !== 'cancelled')
  assert.equal(live.length, 1)
  assert.equal(live[0]!.batch!.head, second)
  assert.equal(live[0]!.batch!.reservation, queued.batch!.reservation, 'the same budget reservation')
  assert.equal(h.journal.get(queued.id)?.state, 'cancelled')
  h.advance(10_001); await h.controller.tick()
  assert.equal(h.injected.length, 1)
  assert.equal(h.journal.get(h.injected[0]!)?.batch?.head, second)
}))

test('a formal approval waits for the person, who confirms it only for the current head', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  h.advance(); h.review(10, REVIEWER, 'APPROVED'); await h.controller.tick()
  const pending = h.controller.grant(grant.id)!
  assert.equal(pending.health, 'approval-pending')
  assert.equal(pending.approval?.kind, 'review')
  assert.equal(pending.enabled, true, 'nothing ends by itself')
  h.push()
  await assert.rejects(h.controller.confirmApproval(grant.id, h.controller.grant(grant.id)!.approval!), /newer head/)
  assert.equal(h.controller.grant(grant.id)?.approval, null)
  h.advance(); h.review(11, REVIEWER, 'APPROVED'); await h.controller.tick()
  const confirmed = await h.controller.confirmApproval(grant.id, h.controller.grant(grant.id)!.approval!)
  assert.equal(confirmed.enabled, false); assert.equal(confirmed.health, 'approved'); assert.equal(confirmed.head, second)
}))

test('a base that moved after the approval was shown must be shown again before it can be confirmed', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  h.advance(); h.review(10, REVIEWER, 'APPROVED'); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.approval?.base, base)
  h.moveBase()
  await assert.rejects(h.controller.confirmApproval(grant.id, h.controller.grant(grant.id)!.approval!), /base changed/)
  const shown = h.controller.grant(grant.id)!
  assert.equal(shown.enabled, true); assert.equal(shown.approval?.base, 'e'.repeat(40), 'the person now sees the new base')
  const confirmed = await h.controller.confirmApproval(grant.id, h.controller.grant(grant.id)!.approval!)
  assert.equal(confirmed.health, 'approved')
}))

test('a poll replaces a shown approval when its base changes, even from the same review', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  h.advance(); h.review(10, REVIEWER, 'APPROVED'); await h.controller.tick()
  h.moveBase(); h.advance(); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.approval?.base, 'e'.repeat(40))
}))

test('an approval withdrawn on GitHub since the last poll cannot be confirmed', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  h.advance(); h.review(10, REVIEWER, 'APPROVED'); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.health, 'approval-pending')
  h.review(11, REVIEWER, 'CHANGES_REQUESTED')
  await assert.rejects(h.controller.confirmApproval(grant.id, h.controller.grant(grant.id)!.approval!), /changed on GitHub/)
  const after = h.controller.grant(grant.id)!
  assert.equal(after.enabled, true); assert.equal(after.approval, null); assert.equal(after.health, 'watching')
}))

test('approval settlement waits for queued feedback and unsettled replies', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  h.host.ready = () => false
  h.advance(); h.inline(1); h.review(10, REVIEWER, 'APPROVED'); await h.controller.tick()
  await assert.rejects(h.controller.confirmApproval(grant.id, h.controller.grant(grant.id)!.approval!), /still queued/)
  h.journal.cancelScope(grant.id)
  h.unsettle()
  await assert.rejects(h.controller.confirmApproval(grant.id, h.controller.grant(grant.id)!.approval!), /not been confirmed/)
}))

test('changes requested after an approval, an author self-approval, and a text approval of a prefix show nothing', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  h.advance(); h.review(10, REVIEWER, 'APPROVED'); h.review(11, REVIEWER, 'CHANGES_REQUESTED'); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.approval, null)
  h.advance(); h.talk(20, REVIEWER, `Approved at ${first.slice(0, 12)}`); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.approval, null)
}))

test('a text approval of the full head is shown, from the reviewer account, but not from a marked reply', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  h.advance(); h.talk(20, REVIEWER, `🤖 Approved at ${first}`); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.approval, null)
  h.advance(); h.talk(21, REVIEWER, `Approved at ${first}\nRan the suite.`); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.approval?.kind, 'text')
}))

test('a spent fix loop takes no feedback but still sees approval and closure; the person can allow more', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  const db = new DatabaseSync(join(h.dir, 'followups.sqlite'))
  const stored = JSON.parse((db.prepare('SELECT value FROM followups WHERE id=?').get(grant.id) as { value: string }).value)
  db.prepare('UPDATE followups SET value=? WHERE id=?').run(JSON.stringify({ ...stored, total: 30 }), grant.id); db.close()
  h.advance(); h.inline(1); await h.controller.tick()
  assert.equal(h.journal.list().length, 0)
  assert.equal(h.controller.grant(grant.id)?.health, 'limit')
  // Still spent: an approval is seen, and a merge or close ends the loop.
  h.advance(); h.review(10, REVIEWER, 'APPROVED'); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.approval?.kind, 'review', 'a spent loop still sees the approval')
  const more = h.controller.extendLimit(grant.id)
  assert.equal(more.limit, 40)
  h.close(); h.advance(); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.health, 'closed')
}))

test('a spent fix loop that was never extended still ends when the PR closes', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  const db = new DatabaseSync(join(h.dir, 'followups.sqlite'))
  const stored = JSON.parse((db.prepare('SELECT value FROM followups WHERE id=?').get(grant.id) as { value: string }).value)
  db.prepare('UPDATE followups SET value=? WHERE id=?').run(JSON.stringify({ ...stored, total: 30 }), grant.id); db.close()
  h.close(); h.advance(); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.health, 'closed')
  assert.equal(h.controller.grant(grant.id)?.enabled, false)
}))

test('the existing-feedback choice takes the backlog once', () => fixture(async (h) => {
  h.inline(1); h.inline(2, REVIEWER, '🤖 old reply'); h.talk(3, 999, 'stranger')
  await enrollFix(h, true)
  await h.controller.tick()
  assert.equal(h.injected.length, 1)
  const members = h.journal.list()[0]!.batch!.members.map((m) => m.source)
  assert.deepEqual(members, ['github/owner/repo/pull/1/inline/1'])
  h.advance(); await h.controller.tick()
  assert.equal(h.journal.list().length, 1)
}))

test('a fix loop without CI never reads checks, so a CI outage cannot hold back reviews', () => fixture(async (h) => {
  await enrollFix(h)
  h.failChecks()
  h.advance(); h.inline(1); await h.controller.tick()
  assert.equal(h.injected.length, 1)
  assert.equal(h.checkReads(), 0)
}))

test('stored fix loops are validated: their limit, total and approval', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  const db = new DatabaseSync(join(h.dir, 'followups.sqlite'))
  const read = (): Record<string, unknown> => JSON.parse((db.prepare('SELECT value FROM followups WHERE id=?').get(grant.id) as { value: string }).value)
  const write = (value: Record<string, unknown>): void => { db.prepare('UPDATE followups SET value=? WHERE id=?').run(JSON.stringify(value), grant.id) }
  const valid = read()
  write({ ...valid, total: 25 }); assert.equal(h.controller.grant(grant.id)?.total, 25, 'above the legacy ten')
  for (const broken of [{ total: 31 }, { limit: 5 }, { limit: 101 }, { marker: '' }, { accountId: 0 }, { role: 'reviewer' }, { health: 'approval-pending', approval: null },
    { approval: { kind: 'magic', head: first, base, ref: '1', at: 0 } }]) {
    write({ ...valid, ...broken })
    assert.throws(() => h.controller.grant(grant.id), /Invalid stored/, JSON.stringify(broken))
  }
  const legacy = { ...valid }; for (const key of ['role', 'marker', 'accountId', 'limit', 'approval']) delete legacy[key]
  write({ ...legacy, total: 11 }); assert.throws(() => h.controller.grant(grant.id), /Invalid stored/, 'a legacy grant keeps its ten')
  write({ ...legacy, health: 'approved' }); assert.throws(() => h.controller.grant(grant.id), /Invalid stored/)
  write(valid); db.close()
}))

test('a poll that refreshes the approval during the confirmation cannot make the old click confirm the new evidence', () => fixture(async (h) => {
  const grant = await enrollFix(h)
  h.advance(); h.review(10, REVIEWER, 'APPROVED'); await h.controller.tick()
  const shown = h.controller.grant(grant.id)!.approval!
  h.moveBase()
  // A poll runs while the confirmation is reading GitHub: it stores the same review on the new base.
  const original = h.host.api
  let polled = false
  h.host.api = async (path, paged) => {
    if (!polled && path === 'repos/owner/repo/pulls/1') { polled = true; h.host.api = original; h.advance(); await h.controller.tick() }
    return original(path, paged)
  }
  await assert.rejects(h.controller.confirmApproval(grant.id, shown), /changed/)
  const after = h.controller.grant(grant.id)!
  assert.equal(after.enabled, true)
  assert.equal(after.approval?.base, 'e'.repeat(40), 'the new base is shown for a new click')
}))

test('a PR loop reads its PR every twenty seconds; a follow-up keeps two minutes', () => fixture(async (h) => {
  await enrollFix(h)
  const legacy = await h.controller.enroll(h.other.id, 'https://github.com/owner/repo/pull/2', ['reviewer'], false).catch(() => null)
  void legacy
  h.advance(); await h.controller.tick()
  h.inline(1)
  h.advance(20_001); await h.controller.tick()
  assert.equal(h.injected.length, 1, 'a review comment reaches the author within twenty seconds')
}))

test('confirmation keeps feedback arriving between the last poll and the click', () => fixture(async h => {
  const grant = await enrollFix(h)
  h.advance(); h.review(10, REVIEWER, 'APPROVED'); await h.controller.tick()
  const shown = h.controller.grant(grant.id)!.approval!
  h.inline(20)
  await assert.rejects(h.controller.confirmApproval(grant.id, shown), /feedback/i)
  assert.equal(h.controller.grant(grant.id)!.enabled, true)
  h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 1)
}))

test('extending a head with three answered batches delivers its fourth batch', () => fixture(async h => {
  const grant = await enrollFix(h)
  for (let id = 1; id <= 4; id++) {
    h.advance(); h.inline(id); await h.controller.tick()
    for (const delivery of h.journal.list()) if (delivery.state === 'submitted') h.journal.answered(delivery.id)
  }
  assert.equal(h.injected.length, 3)
  assert.equal(h.controller.grant(grant.id)!.health, 'limit')
  h.controller.extendLimit(grant.id)
  h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 4)
  assert.equal(h.controller.grant(grant.id)!.headCounts[first], 4)
}))
