import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowFollowups, type FollowupGrant, type FollowupHost } from './workflow-followups.js'
import { WorkflowDeliveries } from './workflow-deliveries.js'
import { WorkflowStore } from './workflow-store.js'
import { PrLoopPosts, PrPostRejected, receiptTag } from './pr-loop-posts.js'

const first = 'a'.repeat(40), second = 'd'.repeat(40), base = 'b'.repeat(40), base2 = 'e'.repeat(40)
const URL = 'https://github.com/owner/repo/pull/1'
const ME = 42

async function fixture(run: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  const h = await setup()
  try { await run(h) } finally { h.controller.close(); h.posts.close(); h.journal.close(); h.tasks.close(); await rm(h.dir, { recursive: true, force: true }) }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-loop-'))
  const tasks = new WorkflowStore(join(dir, 'tasks.sqlite'))
  const reviewerTask = tasks.submitted('reviewer-session', 'project', 'Review PR 1')
  const authorTask = tasks.submitted('author-session', 'project', 'Fix PR 1')
  const journal = new WorkflowDeliveries(join(dir, 'deliveries.sqlite'))
  let now = Date.parse('2026-11-02T12:00:00Z'), open = true, head = first, baseSha = base, fork = false
  const comments: Record<string, unknown>[] = [], conversation: Record<string, unknown>[] = [], reviews: Record<string, unknown>[] = []
  const injected: string[] = [], verified: string[] = []
  const github = {
    api: async (path: string): Promise<unknown> => {
      if (path === 'users/reviewer') return { id: ME, login: 'reviewer' }
      if (path === 'user') return { id: ME }
      if (path === 'repos/owner/repo/pulls/1') return { state: open ? 'open' : 'closed', merged: !open, user: { id: ME }, head: { sha: head, ref: 'feature', repo: { full_name: fork ? 'fork/repo' : 'owner/repo' } }, base: { sha: baseSha, repo: { full_name: 'owner/repo' } } }
      if (path === 'repos/owner/repo/pulls/1/comments?per_page=100') return [comments]
      if (path === 'repos/owner/repo/issues/1/comments?per_page=100') return [conversation]
      if (path === 'repos/owner/repo/pulls/1/reviews?per_page=100') return [reviews]
      const review = /^repos\/owner\/repo\/pulls\/1\/reviews\/(\d+)$/.exec(path)
      if (review) return reviews.find((r) => String(r.id) === review[1]) ?? null
      return [[]]
    },
  }
  const posts = new PrLoopPosts(join(dir, 'posts.sqlite'), { now: () => now, api: github.api as never,
    write: async (_method, path, body) => {
      const id = 9000 + reviews.length
      reviews.push({ id, user: { id: ME }, state: 'COMMENTED', commit_id: body.commit_id, submitted_at: new Date(now).toISOString(), body: body.body })
      return { id, html_url: `https://github.com/owner/repo/pull/1#pullrequestreview-${id}`, path }
    } })
  let controller: WorkflowFollowups
  const host: FollowupHost = { journal, task: (id) => tasks.list().find((t) => t.id === id) ?? null,
    permissionKey: () => 'a'.repeat(64), verifyRepository: async (_task, snapshot, role) => { if (role === 'reviewer') { const g = controller.list().find((x) => x.role === 'reviewer' && x.enabled); if (g) controller.markCheckedOut(g.id, snapshot.head, snapshot.base) } },
    now: () => now, changed: () => {}, interrupt: () => {}, postsSettled: (id) => posts.settled(id),
    verifiedApproval: async (grant, snapshot) => { verified.push(grant.id); return posts.verifiedApproval(grant.repository, grant.number, snapshot.head, snapshot.base) },
    api: github.api as never,
    send: async (delivery, grant) => {
      if (!journal.begin(delivery.id, () => controller.authorized(grant))) return 'busy'
      injected.push(delivery.id)
      return 'sent'
    },
  }
  controller = new WorkflowFollowups(join(dir, 'followups.sqlite'), host)
  const stamp = (): string => new Date(now + 1).toISOString()
  return { dir, tasks, reviewerTask, authorTask, journal, controller, posts, injected, verified,
    advance: (ms = 120_001) => { now += ms },
    push: () => { head = second }, moveBase: () => { baseSha = base2 }, close: () => { open = false }, makeFork: () => { fork = true },
    inline: (id: number, actor: number, body: string) => comments.push({ id, user: { id: actor }, body, updated_at: stamp(), commit_id: head, original_commit_id: head }),
    editReview: (id: number, body: string) => { const r = reviews.find((x) => x.id === id); if (r) r.body = body },
    answered: (id: string) => journal.answered(id),
  }
}
type Harness = Awaited<ReturnType<typeof setup>>
const enrollReview = (h: Harness) => h.controller.enroll(h.reviewerTask.id, URL, [], false, false, { role: 'reviewer' })
const finish = (h: Harness) => { for (const id of h.injected) { const d = h.journal.get(id); if (d?.state === 'submitted') h.answered(id) } }

test('a review loop refuses a PR from a fork', () => fixture(async (h) => {
  h.makeFork()
  await assert.rejects(enrollReview(h), /fork/)
  assert.equal(h.controller.list().length, 0)
}))

test('a push wakes the reviewer once, with the reviewed head; its own comments never do', () => fixture(async (h) => {
  const grant = await enrollReview(h)
  assert.equal(grant.role, 'reviewer'); assert.equal(grant.authorId, ME); assert.equal(grant.checkedOut, first)
  h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 0, 'the first review was the first prompt')
  h.controller.markReviewed(grant.id, first, base)
  h.inline(1, ME, 'Blocking: missing test')
  h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 0, 'an unmarked comment is the reviewer\'s own')
  h.push(); h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 1)
  const text = h.journal.get(h.injected[0]!)!.text
  assert.match(text, /reviewer of owner\/repo pull request #1/)
  assert.match(text, new RegExp(`Last head you reviewed: ${first}`))
  assert.match(text, /pr-review/)
  assert.equal(h.controller.grant(grant.id)?.checkedOut, second, 'the desktop moved the checkout before typing')
  finish(h); h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 1, 'the same head is not news twice')
}))

test('the author\'s marked reply and a base move are news for the reviewer', () => fixture(async (h) => {
  await enrollReview(h)
  h.inline(2, ME, '🤖 Fixed in 1234567')
  h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 1)
  finish(h)
  h.moveBase(); h.advance(); await h.controller.tick()
  assert.equal(h.injected.length, 2)
}))

test('reviewer posts name the checked-out head, never approve with findings, and are marked reviewed', () => fixture(async (h) => {
  const grant = await enrollReview(h)
  const current = (): FollowupGrant => h.controller.grant(grant.id)!
  const refused = async (request: Parameters<PrLoopPosts['review']>[2], pattern: RegExp, g: FollowupGrant | null = current(), session = 'reviewer-session') =>
    assert.rejects(h.posts.review(g, session, request, () => {}), (error: Error) => error instanceof PrPostRejected && pattern.test(error.message))
  await refused({ body: 'x', comments: [], approve: false }, /no active review loop/, null)
  await refused({ body: 'x', comments: [], approve: false }, /does not hold/, current(), 'author-session')
  await refused({ body: '🤖 x', comments: [], approve: false }, /never start with/)
  await refused({ body: 'ok', comments: [{ path: 'a.ts', line: 1, body: '🤖 x' }], approve: false }, /never start with/)
  await refused({ body: `Approved at ${first}`, comments: [], approve: false }, /never approves/)
  await refused({ body: 'Looks fine', comments: [], approve: true }, /starts with "Approved at/)
  await refused({ body: `Approved at ${first}`, comments: [{ path: 'a.ts', line: 1, body: 'Nit: x' }], approve: true }, /no findings/)
  await refused({ body: 'x', comments: [{ path: '../etc', line: 1, body: 'Nit' }], approve: false }, /invalid path/)
  await refused({ body: 'x', comments: [{ path: 'a.ts', line: 0, body: 'Nit' }], approve: false }, /invalid line/)
  await refused({ body: 'x', comments: [], approve: false }, /moved past/, { ...current(), checkedOut: second })
  const marked: string[] = []
  const receipt = await h.posts.review(current(), 'reviewer-session', { body: 'Two findings.', comments: [{ path: 'a.ts', line: 3, body: 'Blocking: x' }], approve: false }, (head, b) => { marked.push(`${head}/${b}`); h.controller.markReviewed(grant.id, head, b) })
  assert.equal(receipt.kind, 'review'); assert.equal(receipt.head, first); assert.equal(receipt.base, base)
  assert.deepEqual(marked, [`${first}/${base}`])
  assert.equal(current().reviewedHead, first)
}))

test('a receipted approval of the current head and base ends the fix loop by itself; an edited one does not', () => fixture(async (h) => {
  const review = await enrollReview(h)
  const fix = await h.controller.enroll(h.authorTask.id, URL, ['reviewer'], false, false, { role: 'author' })
  const approval = await h.posts.review(h.controller.grant(review.id), 'reviewer-session', { body: `Approved at ${first}\nRan the suite.`, comments: [], approve: true }, () => {})
  h.editReview(approval.githubId!, `Approved at ${first}\nedited ${receiptTag(approval.id)}`)
  h.advance(); await h.controller.tick()
  assert.equal(h.controller.grant(fix.id)?.enabled, true, 'an edited approval is not the one that was posted')
  h.editReview(approval.githubId!, `Approved at ${first}\nRan the suite.\n\n${receiptTag(approval.id)}`)
  h.moveBase(); h.advance(); await h.controller.tick()
  assert.equal(h.controller.grant(fix.id)?.enabled, true, 'a base move voids it')
}))

test('a receipted approval ends the fix loop without the person', () => fixture(async (h) => {
  const review = await enrollReview(h)
  const fix = await h.controller.enroll(h.authorTask.id, URL, ['reviewer'], false, false, { role: 'author' })
  await h.posts.review(h.controller.grant(review.id), 'reviewer-session', { body: `Approved at ${first}\nRan the suite.`, comments: [], approve: true }, () => {})
  h.advance(); await h.controller.tick()
  const ended = h.controller.grant(fix.id)!
  assert.equal(ended.enabled, false); assert.equal(ended.health, 'approved')
  assert.equal(h.controller.grant(review.id)?.enabled, true, 'the review loop keeps watching until merge')
  h.close(); h.advance(); await h.controller.tick()
  assert.equal(h.controller.grant(review.id)?.health, 'closed')
}))

test('a review loop stopped while its review was being checked posts nothing', () => fixture(async (h) => {
  const grant = await enrollReview(h)
  let live = true
  const host = h.posts['host' as never] as { api: (path: string) => Promise<unknown> }
  const api = host.api
  host.api = async (path: string) => { if (path === 'user') live = false; return api(path) }
  await assert.rejects(h.posts.review(h.controller.grant(grant.id), 'reviewer-session', { body: 'Findings.', comments: [], approve: false }, () => {}, () => live), /stopped or changed/)
  assert.equal(h.posts.list().filter((r) => r.state === 'posted').length, 0)
  assert.equal(h.posts.settled(grant.id), true)
}))

test('a receipted approval of an older base does not end the fix loop', () => fixture(async (h) => {
  const review = await enrollReview(h)
  const fix = await h.controller.enroll(h.authorTask.id, URL, ['reviewer'], false, false, { role: 'author' })
  await h.posts.review(h.controller.grant(review.id), 'reviewer-session', { body: `Approved at ${first}\nRan the suite.`, comments: [], approve: true }, () => {})
  h.moveBase()
  h.advance(); await h.controller.tick()
  assert.equal(h.controller.grant(fix.id)?.enabled, true, 'the approval covered the old base only')
  assert.equal(h.journal.list().filter((d) => d.scope === fix.id && d.state !== 'cancelled').length, 1, 'the approval text reaches the author as feedback instead')
}))

test('a review is refused when the base moved after the desktop presented the diff', () => fixture(async (h) => {
  const grant = await enrollReview(h)
  assert.equal(h.controller.grant(grant.id)?.checkedOutBase, base)
  h.moveBase()
  await assert.rejects(h.posts.review(h.controller.grant(grant.id), 'reviewer-session', { body: `Approved at ${first}`, comments: [], approve: true }, () => {}), /base moved/)
  assert.equal(h.posts.list().length, 0, 'no receipt for the newer base')
  h.advance(); await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.checkedOutBase, base2, 'the next continuation presents the new base')
  const receipt = await h.posts.review(h.controller.grant(grant.id), 'reviewer-session', { body: `Approved at ${first}`, comments: [], approve: true }, () => {})
  assert.equal(receipt.base, base2)
}))

test('a review GitHub refused (4xx) leaves nothing in doubt and can be corrected', () => fixture(async (h) => {
  const { GithubWriteRefused } = await import('./workflow-github.js')
  const grant = await enrollReview(h)
  const host = h.posts['host' as never] as { write: (...args: unknown[]) => Promise<unknown> }
  const write = host.write
  host.write = async () => { throw new GithubWriteRefused(422, 'pull_request_review_thread.line must be part of the diff (HTTP 422)') }
  await assert.rejects(h.posts.review(h.controller.grant(grant.id), 'reviewer-session', { body: 'One finding.', comments: [{ path: 'a.ts', line: 900, body: 'Nit: x' }], approve: false }, () => {}), /refused the review \(HTTP 422\)/)
  assert.equal(h.posts.settled(grant.id), true)
  host.write = write
  assert.equal((await h.posts.review(h.controller.grant(grant.id), 'reviewer-session', { body: 'One finding.', comments: [{ path: 'a.ts', line: 3, body: 'Nit: x' }], approve: false }, () => {})).state, 'posted')
}))
