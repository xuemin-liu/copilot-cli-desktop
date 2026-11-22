import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrLoopPosts, PrPostRejected, receiptTag, type PostHost } from './pr-loop-posts.js'
import type { FollowupGrant } from './workflow-followups.js'

const grant = (overrides: Partial<FollowupGrant> = {}): FollowupGrant => ({ id: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222', sessionId: 'session',
  projectId: 'project', scopeRevision: 1, permissionKey: 'a'.repeat(64), repository: 'owner/repo', number: 5, reviewers: [{ id: 7, login: 'reviewer' }], failedChecks: false,
  enabled: true, activatedAt: 0, seen: {}, head: 'a'.repeat(40), headCounts: {}, total: 0, health: 'watching', checks: 'absent', role: 'author', marker: '🤖 ', accountId: 42,
  limit: 30, approval: null, ...overrides })

async function fixture(run: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  const h = await setup()
  try { await run(h) } finally { h.posts.close(); await rm(h.dir, { recursive: true, force: true }) }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pr-loop-posts-'))
  let now = 1_000_000, account = 42, state = 'open', writeFails = false
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = []
  const github: { id: number; body: string; html_url: string }[] = []
  const host: PostHost = {
    now: () => now,
    api: async (path) => {
      if (path === 'user') return { id: account }
      if (path === 'repos/owner/repo/pulls/5') return { state }
      if (path === 'repos/owner/repo/pulls/comments/100') return { pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/5' }
      if (path === 'repos/owner/repo/pulls/comments/200') return { pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/6' }
      if (path === 'repos/owner/repo/pulls/5/comments?per_page=100') return [github.filter((c) => c.id < 5000)]
      if (path === 'repos/owner/repo/issues/5/comments?per_page=100') return [github.filter((c) => c.id >= 5000)]
      throw new Error(`unexpected ${path}`)
    },
    write: async (method, path, body) => {
      writes.push({ method, path, body })
      const posted = { id: path.includes('/issues/') ? 5000 + writes.length : 1000 + writes.length, body: String(body.body), html_url: `https://github.com/owner/repo/pull/5#c${writes.length}` }
      github.push(posted)
      if (writeFails) throw new Error('timeout after the write landed')
      return posted
    },
  }
  const posts = new PrLoopPosts(join(dir, 'posts.sqlite'), host)
  return { dir, posts, writes, github, advance: (ms = 91_000) => { now += ms }, switchAccount: () => { account = 43 }, closePull: () => { state = 'closed' }, failWrites: () => { writeFails = true } }
}

test('a checked reply is posted once, tagged with its receipt, to the thread on this PR', () => fixture(async (h) => {
  const receipt = await h.posts.reply(grant(), 'session', { to: '100', body: '🤖 Fixed in 1234567.' })
  assert.equal(receipt.state, 'posted')
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0]!.path, 'repos/owner/repo/pulls/5/comments/100/replies')
  assert.equal(h.writes[0]!.body.body, `🤖 Fixed in 1234567.\n\n${receiptTag(receipt.id)}`)
  const conversation = await h.posts.reply(grant(), 'session', { to: 'conversation', body: '🤖 Summary of fixes.' })
  assert.equal(h.writes[1]!.path, 'repos/owner/repo/issues/5/comments')
  assert.equal(conversation.kind, 'comment')
  assert.equal(h.posts.settled(grant().id), true)
}))

test('every rule is checked before anything is written', () => fixture(async (h) => {
  const refused = async (g: FollowupGrant | null, session: string, to: string, body: string, pattern: RegExp): Promise<void> => {
    await assert.rejects(h.posts.reply(g, session, { to, body }), (error: Error) => error instanceof PrPostRejected && pattern.test(error.message), `${to} ${body}`)
  }
  await refused(null, 'session', '100', '🤖 x', /no active fix loop/)
  await refused(grant({ role: 'follow-up' }), 'session', '100', '🤖 x', /no active fix loop/)
  await refused(grant({ enabled: false }), 'session', '100', '🤖 x', /no active fix loop/)
  await refused(grant(), 'other-session', '100', '🤖 x', /does not hold/)
  await refused(grant(), 'session', '100', 'Fixed it.', /Start the reply/)
  await refused(grant(), 'session', '100', '🤖 Approved, ship it', /approval/)
  await refused(grant(), 'session', '100', `🤖 x ${receiptTag('33333333-3333-4333-8333-333333333333')}`, /receipt tag/)
  await refused(grant(), 'session', '100', '   ', /empty/)
  await refused(grant(), 'session', '100', `🤖 ${'x'.repeat(60_001)}`, /too long/)
  await refused(grant(), 'session', 'abc', '🤖 x', /comment id/)
  await refused(grant(), 'session', '200', '🤖 x', /not on this pull request/)
  h.switchAccount()
  await refused(grant(), 'session', '100', '🤖 x', /different account/)
  assert.equal(h.writes.length, 0)
}))

test('a closed PR takes no reply', () => fixture(async (h) => {
  h.closePull()
  await assert.rejects(h.posts.reply(grant(), 'session', { to: '100', body: '🤖 x' }), /not open/)
  assert.equal(h.writes.length, 0)
}))

test('an unconfirmed write stays an intent, blocks further replies, and is found later by its tag', () => fixture(async (h) => {
  h.failWrites()
  await assert.rejects(h.posts.reply(grant(), 'session', { to: '100', body: '🤖 Fixed.' }), /do not post it again/)
  const [receipt] = h.posts.list()
  assert.equal(receipt!.state, 'intent')
  assert.equal(h.posts.settled(grant().id), false)
  await assert.rejects(h.posts.reply(grant(), 'session', { to: '100', body: '🤖 Again.' }), /Needs you/)
  assert.equal(h.writes.length, 1, 'never posted twice')
  await h.posts.reconcile()
  assert.equal(h.posts.list()[0]!.state, 'intent', 'too soon: the write may still be in flight')
  h.advance()
  await h.posts.reconcile()
  assert.equal(h.posts.list()[0]!.state, 'posted')
  assert.equal(h.posts.list()[0]!.githubId, 1001)
  assert.equal(h.posts.settled(grant().id), true)
}))

test('a missing, copied or edited post becomes uncertain, and only the person settles it', () => fixture(async (h) => {
  h.failWrites()
  await assert.rejects(h.posts.reply(grant(), 'session', { to: '100', body: '🤖 Fixed.' }))
  const id = h.posts.list()[0]!.id
  h.github[0]!.body = h.github[0]!.body.replace('Fixed', 'Edited')
  h.advance(); await h.posts.reconcile()
  assert.equal(h.posts.list()[0]!.state, 'uncertain', 'edited')
  h.posts.dismiss(id)
  assert.equal(h.posts.settled(grant().id), true)
  assert.throws(() => h.posts.dismiss(id), /no uncertain/)

  await assert.rejects(h.posts.reply(grant(), 'session', { to: '100', body: '🤖 Second.' }))
  const second = h.posts.list()[1]!
  h.github.push({ id: 7000, body: `copied ${receiptTag(second.id)}`, html_url: '' })
  h.advance(); await h.posts.reconcile()
  assert.equal(h.posts.list()[1]!.state, 'uncertain', 'two comments carry the tag')

  h.posts.dismiss(second.id)
  await assert.rejects(h.posts.reply(grant(), 'session', { to: '100', body: '🤖 Third.' }))
  h.github.splice(0)
  h.advance(); await h.posts.reconcile()
  assert.equal(h.posts.list()[2]!.state, 'uncertain', 'not found')
  assert.equal(h.writes.length, 3)
}))
