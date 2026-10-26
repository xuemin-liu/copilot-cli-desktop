import assert from 'node:assert/strict'
import test from 'node:test'
import { MeetingError, MeetingHub, joinRequestId, type MeetingDelivery, type MeetingTimers } from './meeting.js'

interface Harness {
  hub: MeetingHub
  delivered: Array<{ tabId: string } & MeetingDelivery>
  cancelled: Array<{ meetingId: string; tabId?: string }>
  files: Map<string, string>
  notes: string[]
  advance(ms: number): void
  /** What was delivered to a tab, add-dir commands left out. */
  to(tabId: string): Array<{ tabId: string } & MeetingDelivery>
}

function harness(settings = { maxRounds: 6, roundTimeoutMinutes: 10 }): Harness {
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
  const hub = new MeetingHub(() => 'C:\\meetings', {
    deliver: (tabId, delivery) => delivered.push({ tabId, ...delivery }),
    cancel: (meetingId, tabId) => cancelled.push({ meetingId, ...(tabId === undefined ? {} : { tabId }) }),
    write: (_meetingId, path, text) => files.set(path, text),
    changed: () => {},
    notify: (_meetingId, message) => notes.push(message),
  }, () => settings, clock, () => ids.shift()!)
  return {
    hub, delivered, cancelled, files, notes,
    advance(ms) {
      now += ms
      const due = timers.filter((timer) => timer.live && timer.at <= now)
      timers = timers.filter((timer) => !due.includes(timer))
      for (const timer of due) { timer.live = false; timer.callback() }
    },
    to: (tabId) => delivered.filter((delivery) => delivery.tabId === tabId && delivery.kind !== 'add-dir'),
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
  assert.deepEqual(h.delivered, [{ tabId: 'tab-host', meetingId: 'K7QF', kind: 'add-dir', text: 'C:\\meetings\\K7QF' }])
  assert.equal(h.files.get('C:\\meetings\\K7QF\\round-1\\post.md'), '# Plan\n1. lock\n2. retry')
  assert.match(h.files.get('C:\\meetings\\K7QF\\transcript.md')!, /Opening post/)
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
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'B: step 2 races with logout')
  assert.equal(h.to('tab-host').length, 0, 'the host waits for everyone')
  h.hub.turnCompleted('tab-c', 'K7QF', 'post', 'C: looks fine')
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
  assert.match(round2.text, /round-1\\replies\.md/, 'reviewers see what the others said')
  assert.match(round2.text, /round-2\\changes\.patch/)
  assert.equal(h.files.get('C:\\meetings\\K7QF\\round-2\\changes.patch'), '--- a/x\n+++ b/x')
})

test('everyone agreeing to the host\'s proposal closes the meeting and tells only the host', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.join(reviewerC, 'K7QF')
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'ok')
  h.hub.turnCompleted('tab-c', 'K7QF', 'post', 'ok')
  h.hub.post('tab-host', 'propose-close', '- lock around logout', null)
  const vote = h.to('tab-b').at(-1)!
  assert.equal(vote.kind, 'vote')
  assert.match(vote.text, /Start your reply with AGREE/)
  h.hub.turnCompleted('tab-b', 'K7QF', 'vote', 'OBJECT: retries are unbounded')
  h.hub.turnCompleted('tab-c', 'K7QF', 'vote', 'AGREE')
  const objection = h.to('tab-host').at(-1)!
  assert.equal(objection.kind, 'digest', 'one objection sends it back to the host')
  assert.match(objection.text, /Not everyone agreed/)

  h.hub.post('tab-host', 'propose-close', '- lock around logout\n- at most 3 retries', null)
  h.hub.turnCompleted('tab-b', 'K7QF', 'vote', '**AGREE** now that retries are bounded')
  h.hub.turnCompleted('tab-c', 'K7QF', 'vote', 'agree')
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
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'B says')
  h.advance(10 * 60_000)
  const digest = h.to('tab-host').at(-1)!
  assert.match(digest.text, /1 of 2 reviewers replied/)
  assert.match(digest.text, /No reply in time from: "review gpt"/)
  assert.ok(h.cancelled.some((entry) => entry.tabId === 'tab-c'), 'its undelivered message is dropped')
  h.hub.turnCompleted('tab-c', 'K7QF', 'post', 'C was slow')
  h.hub.post('tab-host', 'round', 'v2', null)
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'B2')
  h.hub.turnCompleted('tab-c', 'K7QF', 'post', 'C2')
  const next = h.to('tab-host').at(-1)!
  assert.match(next.text, /late reply to an earlier round/)
  assert.match(next.text, /C was slow/)
})

test('the round cap pauses the meeting with the host\'s post held until the person allows more rounds', () => {
  const h = harness({ maxRounds: 2, roundTimeoutMinutes: 10 })
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'r1')
  h.hub.post('tab-host', 'round', 'v2', null)
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'r2')
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
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'r1')
  h.hub.turnCompleted('tab-host', 'K7QF', 'digest', 'I read it.')
  assert.equal(h.to('tab-host').at(-1)!.kind, 'reminder')
  h.hub.turnCompleted('tab-host', 'K7QF', 'reminder', 'Still thinking.')
  assert.equal(h.hub.views()[0]!.stage, 'paused')
  assert.equal(h.hub.views()[0]!.pauseReason, 'host-silent')
})

test('closing sessions: a reviewer leaving finishes the round for the others; the host leaving closes the meeting', () => {
  const h = harness()
  h.hub.start(host, { topic: 'plan', post: 'plan', changes: null })
  h.hub.join(reviewerB, 'K7QF')
  h.hub.join(reviewerC, 'K7QF')
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'B says')
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
  h.hub.turnCompleted('tab-b', 'K7QF', 'post', 'too late')
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
  assert.match(message, /too long to include here; read it in full from C:\\meetings\\K7QF\\round-1\\post\.md/)
})

test('join requests are read from what the person typed', () => {
  assert.equal(joinRequestId('join meeting K7QF'), 'K7QF')
  assert.equal(joinRequestId('Please join the chat k7qf and review'), 'K7QF')
  assert.equal(joinRequestId('join meeting #M2NB.'), 'M2NB')
  assert.equal(joinRequestId('join meeting id: P3RT'), 'P3RT')
  assert.equal(joinRequestId('join meeting K0QF'), null, 'not an id the desktop makes')
  assert.equal(joinRequestId('the meeting K7QF went well'), null, 'no join asked')
  assert.equal(joinRequestId('join meeting K7QFX'), null)
})
