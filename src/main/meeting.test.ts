import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { MeetingError, MeetingHub, joinRequest, type MeetingDelivery, type MeetingSettings, type MeetingTimers } from './meeting.js'

/** The Copilot session id behind each test tab; a saved meeting remembers sessions by these. */
const SESSIONS: Record<string, string> = {
  'tab-host': '11111111-1111-4111-8111-111111111111',
  'tab-b': '22222222-2222-4222-8222-222222222222',
  'tab-c': '33333333-3333-4333-8333-333333333333',
}

interface Harness {
  hub: MeetingHub
  delivered: Array<{ tabId: string } & MeetingDelivery>
  cancelled: Array<{ meetingId: string; tabId?: string }>
  files: Map<string, string>
  notes: string[]
  advance(ms: number): void
  /** What was delivered to a tab, add-dir commands left out. */
  to(tabId: string): Array<{ tabId: string } & MeetingDelivery>
  /** The latest message delivered to a tab: the one its next finished turn answers. */
  last(tabId: string): MeetingDelivery
}

const MEETINGS = 'C:\\meetings'
/** A path in the meetings folder, joined the way this platform joins them. */
const at = (...parts: string[]): string => join(MEETINGS, ...parts)

function harness(settings: MeetingSettings = { maxRounds: 6, roundTimeoutMinutes: 10 }, existingFolders: readonly string[] = []): Harness {
  let now = 1_000
  let timers: Array<{ at: number; callback: () => void; live: boolean }> = []
  const clock: MeetingTimers = {
    now: () => now,
    set: (callback, ms) => {
      const timer = { at: now + ms, callback, live: true }
      timers.push(timer)
      return () => { timer.live = false }
    },
  }
  const delivered: Harness['delivered'] = []
  const cancelled: Harness['cancelled'] = []
  const files = new Map<string, string>()
  const notes: string[] = []
  const ids = ['K7QF', 'M2NB', 'P3RT']
  const hub = new MeetingHub(() => MEETINGS, {
    deliver: (tabId, delivery) => delivered.push({ tabId, ...delivery }),
    cancel: (meetingId, tabId) => cancelled.push({ meetingId, ...(tabId === undefined ? {} : { tabId }) }),
    write: (_meetingId, path, text) => files.set(path, text),
    changed: () => {},
    notify: (_meetingId, message) => notes.push(message),
    sessionIdOf: (tabId) => SESSIONS[tabId] ?? null,
    folderExists: (id) => existingFolders.includes(id),
  }, () => settings, clock, (taken) => { while (taken(ids[0]!)) ids.shift(); return ids.shift()! })
  return {
    hub, delivered, cancelled, files, notes,
    advance(ms) {
      now += ms
      const due = timers.filter((timer) => timer.live && timer.at <= now)
      timers = timers.filter((timer) => !due.includes(timer))
      for (const timer of due) { timer.live = false; timer.callback() }
    },
    to: (tabId) => delivered.filter((delivery) => delivery.tabId === tabId && delivery.kind !== 'add-dir'),
    last: (tabId) => delivered.filter((delivery) => delivery.tabId === tabId && delivery.kind !== 'add-dir').at(-1)!,
  }
}

const host = { tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }
const reviewerB = { tabId: 'tab-b', title: 'review opus', folder: 'D:\\api' }
const reviewerC = { tabId: 'tab-c', title: 'review gpt', folder: 'D:\\web' }

test('a meeting opens with an id, waits for someone to join, and gives each session the meeting folder', () => {
  const h = harness()
  const view = h.hub.start(host, { topic: 'login plan', post: '# Plan\n1. lock\n2. retry', changes: null })
  assert.equal(view.id, 'K7QF')
  assert.equal(view.stage, 'waiting')
  assert.deepEqual(h.delivered, [{ tabId: 'tab-host', meetingId: 'K7QF', round: 1, kind: 'add-dir', text: at('K7QF') }])
  assert.equal(h.files.get(at('K7QF', 'round-1', 'post.md')), '# Plan\n1. lock\n2. retry')
  assert.match(h.files.get(at('K7QF', 'transcript.md'))!, /Opening post/)
  assert.throws(() => h.hub.start(host, { topic: '', post: 'again', changes: null }), MeetingError, 'one meeting per session')

  h.hub.join(reviewerB, 'K7QF')
  assert.equal(h.delivered.find((delivery) => delivery.tabId === 'tab-b')?.kind, 'add-dir', 'the folder comes before the material')
  const [post] = h.to('tab-b')
  assert.equal(post?.kind, 'post')
  assert.match(post!.text, /^\[meeting K7QF · round 1 · from the desktop\]/)
  assert.match(post!.text, /# Plan/)
  assert.deepEqual(h.hub.views()[0]!.waitingFor, ['tab-b'])
  assert.deepEqual(h.hub.meetingOf('tab-b'), { id: 'K7QF', role: 'participant' })
  assert.throws(() => h.hub.join(reviewerB, 'ZZZZ'), /no open meeting/)
  assert.throws(() => h.hub.join(host, 'K7QF'), /hosts meeting/)
})

test('a round collects every reply, then the host gets them together and answers with the next round', () => {
  const h = harness()
  h.hub.start(host, { topic: 'login plan', post: 'plan v1', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.join(reviewerC, 'K7QF')
  assert.throws(() => h.hub.post('tab-host', 'round', 'too early', null), /not all answered/)
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B: step 2 races with logout')
  assert.equal(h.to('tab-host').length, 0, 'the host waits for everyone')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'C: looks fine')
  const [digest] = h.to('tab-host')
  assert.equal(digest?.kind, 'digest')
  assert.match(digest!.text, /2 of 2 reviewers replied/)
  assert.match(digest!.text, /step 2 races with logout/)
  assert.match(digest!.text, /propose-close/)
  assert.equal(h.hub.views()[0]!.stage, 'host')

  const answer = h.hub.post('tab-host', 'round', 'plan v2: lock around logout too', '--- a/x\n+++ b/x')
  assert.match(answer, /Sent round 2 to 2 reviewers/)
  const round2 = h.to('tab-c').at(-1)!
  assert.match(round2.text, /round 2/)
  assert.ok(round2.text.includes(at('K7QF', 'round-1', 'replies.md')), 'reviewers see what the others said')
  assert.ok(round2.text.includes(at('K7QF', 'round-2', 'changes.patch')))
  assert.equal(h.files.get(at('K7QF', 'round-2', 'changes.patch')), '--- a/x\n+++ b/x')
})

test('everyone agreeing to the host\'s proposal closes the meeting and tells only the host', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.join(reviewerC, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'ok')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'ok')
  h.hub.post('tab-host', 'propose-close', '- lock around logout', null)
  const vote = h.to('tab-b').at(-1)!
  assert.equal(vote.kind, 'vote')
  assert.match(vote.text, /Start your reply with AGREE/)
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'OBJECT: retries are unbounded')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'AGREE')
  const objection = h.to('tab-host').at(-1)!
  assert.equal(objection.kind, 'digest', 'one objection sends it back to the host')
  assert.match(objection.text, /Not everyone agreed/)

  h.hub.post('tab-host', 'propose-close', '- lock around logout\n- at most 3 retries', null)
  h.hub.turnCompleted('tab-b', h.last('tab-b'), '**AGREE** now that retries are bounded')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'agree')
  const closed = h.to('tab-host').at(-1)!
  assert.equal(closed.kind, 'agreed')
  assert.match(closed.text, /All 2 reviewers agreed/)
  const view = h.hub.views()[0]!
  assert.equal(view.stage, 'closed')
  assert.equal(view.outcome, 'agreed')
  assert.equal(h.hub.meetingOf('tab-host'), null, 'everyone is free for another meeting')
  assert.ok(h.notes.some((note) => /Everyone agreed/.test(note)))
  assert.throws(() => h.hub.post('tab-host', 'round', 'more', null), /does not host an open meeting/)
})

test('a round that times out goes to the host without the silent reviewer, whose late reply joins the next digest', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.join(reviewerC, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B says')
  h.advance(10 * 60_000)
  const digest = h.to('tab-host').at(-1)!
  assert.match(digest.text, /1 of 2 reviewers replied/)
  assert.match(digest.text, /No reply in time from: "review gpt"/)
  assert.ok(h.cancelled.some((entry) => entry.tabId === 'tab-c'), 'its undelivered message is dropped')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'C was slow')
  h.hub.post('tab-host', 'round', 'v2', null)
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B2')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'C2')
  const next = h.to('tab-host').at(-1)!
  assert.match(next.text, /late reply to an earlier round/)
  assert.match(next.text, /C was slow/)
})

test('a vote still being answered when its round times out never counts for a later proposal', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'r1')
  h.hub.post('tab-host', 'propose-close', 'proposal A', null)
  const voteA = h.last('tab-b')
  h.advance(10 * 60_000)
  assert.equal(h.last('tab-host').kind, 'digest', 'round 2 timed out while B was still answering')
  h.hub.post('tab-host', 'propose-close', 'proposal B, materially changed', null)
  const voteB = h.last('tab-b')
  assert.equal(voteB.round, 3)
  h.hub.turnCompleted('tab-b', voteA, 'AGREE')
  let view = h.hub.views()[0]!
  assert.equal(view.stage, 'reviewing', 'an AGREE to proposal A does not close round 3')
  assert.deepEqual(view.waitingFor, ['tab-b'])
  assert.match(h.files.get(at('K7QF', 'transcript.md'))!, /Round 2: "review opus" \(D:\\api\) \(late, read in round 3\)/)
  h.hub.turnCompleted('tab-b', voteB, 'AGREE')
  view = h.hub.views()[0]!
  assert.equal(view.outcome, 'agreed')
  assert.equal(view.round, 3)
})

test('a round held at the round limit keeps its changes only as filtered, in memory and in the saved meeting', () => {
  const patch = [
    'diff --git a/config.txt b/config.txt', '--- a/config.txt', '+++ b/config.txt', '@@ -1 +1 @@', '+API_KEY=sk-live-0123456789abcdef0123456789',
    'diff --git a/.env b/.env', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', '+DATABASE_CONNECTION_STRING=Server=db;opaque-held-value-71', '',
  ].join('\n')
  const h = harness({ maxRounds: 1, roundTimeoutMinutes: 10 })
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'r1')
  assert.match(h.hub.post('tab-host', 'round', 'v2 with changes', patch), /reached its limit/)
  const saved = h.files.get(at('K7QF', 'meeting.json'))!
  assert.equal(JSON.parse(saved).stage, 'paused')
  assert.doesNotMatch(saved, /sk-live-0123456789abcdef|opaque-held-value-71/, 'the paused meeting.json holds no secret')
  assert.match(JSON.parse(saved).held.changes, /# Changes to \.env withheld/)
  h.hub.resume('K7QF')
  const shared = h.files.get(at('K7QF', 'round-2', 'changes.patch'))!
  assert.doesNotMatch(shared, /sk-live-0123456789abcdef|opaque-held-value-71/)
  assert.match(shared, /# Changes to \.env withheld/)
  assert.equal(shared.match(/^# 1 file that looks like it holds secrets/gm)?.length, 1, 'filtering twice adds no second note')

  // A meeting saved by an earlier build with the raw patch held is filtered when it is read back.
  const raw = JSON.parse(saved)
  raw.held.changes = patch
  const later = harness()
  later.hub.restore(raw, '', (sessionId) => ({ tabId: sessionId === SESSIONS['tab-host'] ? 'h2' : 'b2', title: 't', folder: null }))
  assert.doesNotMatch(later.files.get(at('K7QF', 'meeting.json'))!, /sk-live-0123456789abcdef|opaque-held-value-71/)
})

const DISCUSS: MeetingSettings = { maxRounds: 6, roundTimeoutMinutes: 10, discussion: true }

test('with discussion on, reviewers answer each other\'s reviews before the host gets reviews and discussion together', () => {
  const h = harness(DISCUSS)
  h.hub.start(host, { topic: 'plan', post: 'plan v1', changes: null })
  h.hub.join(reviewerB, 'K7QF', { role: 'security reviewer' })
  h.hub.join(reviewerC, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B: the token leaks into logs')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'C: retries are unbounded')
  assert.equal(h.to('tab-host').length, 0, 'the host waits for the discussion')
  const view = h.hub.views()[0]!
  assert.equal(view.discussing, true)
  assert.deepEqual(view.waitingFor.sort(), ['tab-b', 'tab-c'])
  const toB = h.last('tab-b')
  assert.equal(toB.kind, 'discussion')
  assert.equal(toB.round, 1)
  assert.match(toB.text, /^\[meeting K7QF · round 1 · discussion · from the desktop\]/)
  assert.match(toB.text, /C: retries are unbounded/, 'B reads C\'s review')
  assert.doesNotMatch(toB.text, /B: the token leaks/, 'not its own')
  assert.match(toB.text, /You review as: security reviewer/)
  assert.match(h.last('tab-c').text, /B: the token leaks into logs/)
  assert.match(h.files.get(at('K7QF', 'round-1', 'replies.md'))!, /B: the token leaks[\s\S]*C: retries are unbounded/, 'the reviews are on disk for the discussion')

  // A stale review reply (the post's turn) during the discussion counts as late, not as the discussion answer.
  h.hub.turnCompleted('tab-b', { meetingId: 'K7QF', round: 1, kind: 'post', text: '' }, 'B again')
  assert.deepEqual(h.hub.views()[0]!.waitingFor.sort(), ['tab-b', 'tab-c'])
  h.hub.turnCompleted('tab-b', toB, 'B: agree with C, cap retries at 3')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'C: the log leak matters more than retries')
  const digest = h.last('tab-host')
  assert.equal(digest.kind, 'digest')
  assert.match(digest.text, /The reviewers then read each other's replies and answered them/)
  assert.match(digest.text, /B: the token leaks[\s\S]*C: retries are unbounded[\s\S]*# Discussion: what the reviewers answered each other[\s\S]*B: agree with C[\s\S]*C: the log leak matters/)
  assert.match(digest.text, /B again/, 'the stale reply reaches the host as a late one')
  assert.equal(h.hub.views()[0]!.discussing, false)
  assert.match(h.files.get(at('K7QF', 'round-1', 'replies.md'))!, /# Discussion[\s\S]*cap retries at 3/)
  assert.match(h.files.get(at('K7QF', 'transcript.md'))!, /## Round 1 discussion: "review opus"/)
})

test('no discussion with a single review, on a vote, or with the setting off', () => {
  const single = harness(DISCUSS)
  single.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  single.hub.join(reviewerB, 'K7QF')
  single.hub.join(reviewerC, 'K7QF')
  single.hub.turnCompleted('tab-b', single.last('tab-b'), 'B only')
  single.advance(10 * 60_000)
  assert.equal(single.last('tab-host').kind, 'digest', 'C timed out: one review has nobody to discuss with')

  const vote = harness(DISCUSS)
  vote.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  vote.hub.join(reviewerB, 'K7QF')
  vote.hub.join(reviewerC, 'K7QF')
  vote.hub.turnCompleted('tab-b', vote.last('tab-b'), 'b')
  vote.hub.turnCompleted('tab-c', vote.last('tab-c'), 'c')
  for (const tab of ['tab-b', 'tab-c']) vote.hub.turnCompleted(tab, vote.last(tab), `${tab} on the others`)
  vote.hub.post('tab-host', 'propose-close', 'items', null)
  vote.hub.turnCompleted('tab-b', vote.last('tab-b'), 'AGREE')
  vote.hub.turnCompleted('tab-c', vote.last('tab-c'), 'AGREE')
  assert.equal(vote.hub.views()[0]!.outcome, 'agreed', 'votes go straight to the result')

  const off = harness()
  off.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  off.hub.join(reviewerB, 'K7QF')
  off.hub.join(reviewerC, 'K7QF')
  off.hub.turnCompleted('tab-b', off.last('tab-b'), 'b')
  off.hub.turnCompleted('tab-c', off.last('tab-c'), 'c')
  assert.equal(off.last('tab-host').kind, 'digest')
  assert.equal(off.delivered.some((delivery) => delivery.kind === 'discussion'), false)
})

test('a discussion that times out, a session joining during it, and a restart in the middle of it', () => {
  const h = harness(DISCUSS)
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.join(reviewerC, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B review')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'C review')
  h.hub.join({ tabId: 'tab-d', title: 'late joiner', folder: null }, 'K7QF')
  assert.equal(h.last('tab-d').kind, 'post', 'a late joiner gets the round itself')
  assert.equal(h.hub.views()[0]!.waitingFor.includes('tab-d'), false, 'and is not waited for in the discussion')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B on C')

  const saved = JSON.parse(h.files.get(at('K7QF', 'meeting.json'))!)
  assert.equal(saved.discussing, true)
  const tabs: Record<string, string> = { [SESSIONS['tab-host']!]: 'h2', [SESSIONS['tab-b']!]: 'b2', [SESSIONS['tab-c']!]: 'c2' }
  const after = harness(DISCUSS)
  after.hub.restore(saved, h.files.get(at('K7QF', 'transcript.md'))!, (sessionId) => tabs[sessionId] ? { tabId: tabs[sessionId]!, title: 't', folder: null } : null)
  assert.equal(after.hub.views()[0]!.discussing, true)
  assert.deepEqual(after.hub.views()[0]!.waitingFor, ['c2'])
  const resent = after.last('c2')
  assert.equal(resent.kind, 'discussion', 'C gets its discussion turn again')
  assert.match(resent.text, /B review/)
  after.hub.turnCompleted('c2', resent, 'C on B')
  assert.match(after.last('h2').text, /B review[\s\S]*C review[\s\S]*# Discussion[\s\S]*B on C[\s\S]*C on B/, 'reviews from before the restart and the discussion reach the host')

  h.advance(10 * 60_000)
  const digest = h.last('tab-host')
  assert.match(digest.text, /# Discussion[\s\S]*B on C[\s\S]*\(no reply in time\)/, 'a discussion that times out goes to the host with what came in')
})

test('a discussion everyone left is abandoned: the next reviewer\'s review counts and goes to the host alone', () => {
  const reviewD = { tabId: 'tab-d', title: 'review d', folder: null }
  const h = harness(DISCUSS)
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.join(reviewerC, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B stale review')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'C stale review')
  const saved = JSON.parse(h.files.get(at('K7QF', 'meeting.json'))!)
  h.hub.leave('tab-b')
  h.hub.leave('tab-c')
  let view = h.hub.views()[0]!
  assert.equal(view.stage, 'waiting')
  assert.equal(view.discussing, false)
  h.hub.join(reviewD, 'K7QF')
  assert.equal(h.last('tab-d').kind, 'post')
  h.hub.turnCompleted('tab-d', h.last('tab-d'), 'D fresh review')
  const digest = h.last('tab-host')
  assert.equal(digest.kind, 'digest', 'the answer counts at once, not after the timeout')
  assert.match(digest.text, /D fresh review/)
  assert.doesNotMatch(digest.text, /stale review|# Discussion/, 'the abandoned reviews do not reach the host with it')

  // The same after a restart where the saved reviewers are gone but the host is back.
  const after = harness(DISCUSS)
  after.hub.restore(saved, '', (sessionId) => sessionId === SESSIONS['tab-host'] ? { tabId: 'h2', title: 't', folder: null } : null)
  view = after.hub.views()[0]!
  assert.equal(view.stage, 'waiting')
  assert.equal(view.discussing, false)
  after.hub.join(reviewD, 'K7QF')
  after.hub.turnCompleted('tab-d', after.last('tab-d'), 'D after restart')
  assert.match(after.last('h2').text, /D after restart/)
  assert.doesNotMatch(after.last('h2').text, /stale review/)
})

test('a host turn answering an earlier round does not count as silence in the current one', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'r1')
  const digest1 = h.last('tab-host')
  h.hub.post('tab-host', 'round', 'v2', null)
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'r2')
  h.hub.turnCompleted('tab-host', digest1, 'answered round 1')
  assert.equal(h.last('tab-host').kind, 'digest', 'no reminder for an old turn')
})

test('the round cap pauses the meeting with the host\'s post held until the person allows more rounds', () => {
  const h = harness({ maxRounds: 2, roundTimeoutMinutes: 10 })
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'r1')
  h.hub.post('tab-host', 'round', 'v2', null)
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'r2')
  const sentBefore = h.to('tab-b').length
  assert.match(h.hub.post('tab-host', 'round', 'v3', null), /reached its limit of 2 rounds/)
  assert.equal(h.hub.views()[0]!.stage, 'paused')
  assert.equal(h.to('tab-b').length, sentBefore, 'nothing goes out while paused')
  assert.ok(h.notes.some((note) => /reached 2 rounds/.test(note)))
  h.hub.resume('K7QF')
  const view = h.hub.views()[0]!
  assert.equal(view.maxRounds, 5)
  assert.equal(view.round, 3)
  assert.match(h.to('tab-b').at(-1)!.text, /v3/)
})

test('a host that does not answer is reminded once, then the meeting pauses', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'r1')
  h.hub.turnCompleted('tab-host', h.last('tab-host'), 'I read it.')
  assert.equal(h.to('tab-host').at(-1)!.kind, 'reminder')
  h.hub.turnCompleted('tab-host', h.last('tab-host'), 'Still thinking.')
  assert.equal(h.hub.views()[0]!.stage, 'paused')
  assert.equal(h.hub.views()[0]!.pauseReason, 'host-silent')
})

test('closing sessions: a reviewer leaving finishes the round for the others; the host leaving closes the meeting', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.join(reviewerC, 'K7QF')
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B says')
  h.hub.leave('tab-c')
  assert.equal(h.to('tab-host').at(-1)!.kind, 'digest')
  assert.equal(h.hub.views()[0]!.participants.length, 1)
  h.hub.leave('tab-host')
  assert.equal(h.hub.views()[0]!.outcome, 'host-left')
  assert.ok(h.cancelled.some((entry) => entry.tabId === 'tab-b'))
})

test('the person can stop a meeting, which types nothing more anywhere', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  const count = h.delivered.length
  h.hub.stop('K7QF')
  assert.equal(h.delivered.length, count)
  assert.deepEqual(h.cancelled.filter((entry) => entry.meetingId === 'K7QF').map((entry) => entry.tabId).sort(), ['tab-b', 'tab-host'])
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'too late')
  assert.equal(h.to('tab-host').length, 0)
})

test('a post before anyone joined replaces the opening post; a vote needs someone to vote', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'v1', changes: null })
  assert.throws(() => h.hub.post('tab-host', 'propose-close', 'done', null), /Nobody has joined/)
  h.hub.post('tab-host', 'round', 'v1b', null)
  h.hub.join(reviewerB, 'K7QF')
  assert.match(h.to('tab-b')[0]!.text, /v1b/)
  assert.equal(h.hub.views()[0]!.round, 1)
})

test('a large post is referenced by its path instead of being typed', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'x'.repeat(20_000), changes: null })
  h.hub.join(reviewerB, 'K7QF')
  const message = h.to('tab-b')[0]!.text
  assert.ok(message.length < 11_000)
  assert.ok(message.includes(`too long to include here; read it in full from ${at('K7QF', 'round-1', 'post.md')}`))
})

test('join requests are read from what the person typed, with an optional role', () => {
  assert.deepEqual(joinRequest('join meeting K7QF'), { id: 'K7QF', role: null })
  assert.deepEqual(joinRequest('Please join the chat k7qf and review'), { id: 'K7QF', role: null })
  assert.deepEqual(joinRequest('join meeting #M2NB.'), { id: 'M2NB', role: null })
  assert.deepEqual(joinRequest('join meeting id: P3RT'), { id: 'P3RT', role: null })
  assert.deepEqual(joinRequest('join meeting K7QF as security reviewer'), { id: 'K7QF', role: 'security reviewer' })
  assert.deepEqual(joinRequest('join meeting K7QF, as a "performance" [skeptic].'), { id: 'K7QF', role: 'performance skeptic' })
  assert.ok(joinRequest(`join meeting K7QF as the ${'very '.repeat(30)}picky reviewer`)!.role!.length <= 60, 'bounded')
  assert.equal(joinRequest('join meeting K0QF'), null, 'not an id the desktop makes')
  assert.equal(joinRequest('the meeting K7QF went well'), null, 'no join asked')
  assert.equal(joinRequest('join meeting K7QFX'), null)
})

test('a reviewer\'s role is in its messages and in what the host and the others read', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF', { role: 'security reviewer' })
  h.hub.join(reviewerC, 'K7QF')
  assert.match(h.last('tab-b').text, /^You review as: security reviewer\. Look at the material from that angle first\.$/m)
  assert.doesNotMatch(h.last('tab-c').text, /You review as/)
  assert.deepEqual(h.hub.views()[0]!.participants.map((participant) => participant.role), ['security reviewer', null])
  h.hub.turnCompleted('tab-b', h.last('tab-b'), 'B: the token leaks into logs')
  h.hub.turnCompleted('tab-c', h.last('tab-c'), 'C: fine')
  assert.match(h.last('tab-host').text, /## "review opus" \(D:\\api\), as security reviewer\n\nB: the token leaks/)
  h.hub.post('tab-host', 'propose-close', '- no tokens in logs', null)
  assert.match(h.last('tab-b').text, /You review as: security reviewer/, 'the vote too')
})

test('the meeting\'s cost is what its sessions used since they joined, in AI credits', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null }, { nanoAiu: 5e9, premiumRequests: 2 })
  h.hub.join(reviewerB, 'K7QF', { usage: { nanoAiu: 40e9, premiumRequests: 10 } })
  h.hub.usage('tab-b', { nanoAiu: 41.5e9, premiumRequests: 11 })
  h.hub.usage('tab-host', { nanoAiu: 5.25e9, premiumRequests: 2 })
  assert.deepEqual(h.hub.views()[0]!.cost, { aiCredits: 1.75, premiumRequests: 1 })
  h.hub.usage('tab-b', { nanoAiu: 0.5e9, premiumRequests: 0 })
  assert.equal(h.hub.views()[0]!.cost.aiCredits, 2.25, 'totals that went down started over: all of the new value counts')
  h.hub.usage('tab-c', { nanoAiu: 99e9, premiumRequests: 9 })
  assert.equal(h.hub.views()[0]!.cost.aiCredits, 2.25, 'a session outside the meeting does not count')
  h.hub.stop('K7QF')
  h.hub.usage('tab-b', { nanoAiu: 9e9, premiumRequests: 0 })
  assert.equal(h.hub.views()[0]!.cost.aiCredits, 2.25, 'nothing counts after the meeting closed')
})

test('a new meeting never reuses the id of an older meeting\'s folder', () => {
  const h = harness(undefined, ['K7QF'])
  assert.equal(h.hub.start(host, { topic: 'plan', post: 'plan', changes: null }).id, 'M2NB')
})

test('a meeting saved mid-round goes on after a restart: new tabs, the open round sent again, its timeout started over', () => {
  const before = harness()
  before.hub.start(host, { topic: 'login plan', post: 'plan v1', changes: null }, { nanoAiu: 1e9, premiumRequests: 0 })
  before.hub.join(reviewerB, 'K7QF', { role: 'security reviewer' })
  before.hub.join(reviewerC, 'K7QF')
  before.hub.usage('tab-b', { nanoAiu: 3e9, premiumRequests: 0 })
  before.hub.turnCompleted('tab-b', before.last('tab-b'), 'B: needs a lock')
  const saved = JSON.parse(before.files.get(at('K7QF', 'meeting.json'))!)
  const transcript = before.files.get(at('K7QF', 'transcript.md'))!
  assert.equal(saved.host.sessionId, SESSIONS['tab-host'])
  assert.deepEqual(saved.outstanding.map((entry: { sessionId: string }) => entry.sessionId), [SESSIONS['tab-c']], 'only C has not answered')

  const after = harness()
  const tabs: Record<string, string> = { [SESSIONS['tab-host']!]: 'tab-host2', [SESSIONS['tab-b']!]: 'tab-b2', [SESSIONS['tab-c']!]: 'tab-c2' }
  const started = after.hub.restore(saved, transcript, (sessionId) => tabs[sessionId] ? { tabId: tabs[sessionId]!, title: `restored ${tabs[sessionId]}`, folder: null } : null)
  assert.deepEqual(started, ['tab-host2', 'tab-b2', 'tab-c2'])
  const view = after.hub.views()[0]!
  assert.equal(view.stage, 'reviewing')
  assert.deepEqual(view.waitingFor, ['tab-c2'])
  assert.equal(view.cost.aiCredits, 3, 'B joined without a known baseline, so its 3 credits count; the cost survives the restart')
  assert.deepEqual(view.participants.map((participant) => [participant.tabId, participant.role, participant.replied]), [['tab-b2', 'security reviewer', true], ['tab-c2', null, false]])
  assert.deepEqual(after.delivered.filter((delivery) => delivery.kind === 'add-dir').map((delivery) => delivery.tabId), ['tab-host2', 'tab-b2', 'tab-c2'], 'every session gets the folder again')
  const resent = after.to('tab-c2')
  assert.equal(resent.length, 1, 'C gets the round it had not answered')
  assert.equal(resent[0]!.round, 1)
  assert.match(resent[0]!.text, /plan v1/)
  assert.equal(after.to('tab-b2').length, 0, 'B had answered: nothing again')
  assert.match(after.files.get(at('K7QF', 'transcript.md'))!, /B: needs a lock[\s\S]*## Restored/)

  after.hub.turnCompleted('tab-c2', resent[0]!, 'C: agreed with B')
  const digest = after.last('tab-host2')
  assert.equal(digest.kind, 'digest')
  assert.match(digest.text, /2 of 2 reviewers replied/)
  assert.match(digest.text, /B: needs a lock/, 'the reply from before the restart is in the digest')

  const later = harness()
  later.hub.restore(saved, transcript, (sessionId) => tabs[sessionId] ? { tabId: tabs[sessionId]!, title: 't', folder: null } : null)
  later.advance(10 * 60_000)
  assert.equal(later.last('tab-host2').kind, 'digest', 'the restored round times out like any other')
})

test('after a restart a missing reviewer leaves the meeting and a missing host closes it', () => {
  const before = harness()
  before.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  before.hub.join(reviewerB, 'K7QF')
  before.hub.join(reviewerC, 'K7QF')
  before.hub.turnCompleted('tab-b', before.last('tab-b'), 'B says')
  const saved = JSON.parse(before.files.get(at('K7QF', 'meeting.json'))!)
  const transcript = before.files.get(at('K7QF', 'transcript.md'))!

  const withoutC = harness()
  withoutC.hub.restore(saved, transcript, (sessionId) => sessionId === SESSIONS['tab-c'] ? null : { tabId: sessionId === SESSIONS['tab-host'] ? 'h2' : 'b2', title: 't', folder: null })
  assert.equal(withoutC.last('h2').kind, 'digest', 'with C gone everyone left has answered: the round finishes')
  assert.match(withoutC.files.get(at('K7QF', 'transcript.md'))!, /"review gpt" \(D:\\web\) left[\s\S]*not open after the app restarted/)

  const withoutHost = harness()
  assert.equal(withoutHost.hub.restore(saved, transcript, (sessionId) => sessionId === SESSIONS['tab-host'] ? null : { tabId: 'x', title: 't', folder: null }), null)
  assert.equal(withoutHost.hub.views().length, 0)
  assert.equal(JSON.parse(withoutHost.files.get(at('K7QF', 'meeting.json'))!).stage, 'closed', 'saved as closed, so it is not restored again')
  assert.equal(withoutHost.delivered.length, 0)

  const closed = harness()
  before.hub.stop('K7QF')
  assert.equal(closed.hub.restore(JSON.parse(before.files.get(at('K7QF', 'meeting.json'))!), '', () => ({ tabId: 'x', title: 't', folder: null })), null, 'a closed meeting stays closed')
  assert.equal(closed.hub.restore({ version: 1, id: '../x' }, '', () => null), null, 'a malformed file restores nothing')
})
