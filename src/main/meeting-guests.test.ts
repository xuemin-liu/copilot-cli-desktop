import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MeetingHub, type MeetingDelivery, type MeetingTimers } from './meeting.js'
import {
  GUEST_ENDPOINT_FILE, GUEST_HELPER, GUEST_HELPER_SH, GUEST_PAGE_CHARS, GUEST_UNUSED_SEAT_MS, GuestMailbox, guestHelperCommand,
  guestDeliveryText, guestHostInvitation, guestInvitation, guestMessage, guestReplyPath, handleGuestRequest, type GuestChannel, type GuestDeps, type GuestSeat,
} from './meeting-guests.js'
import { MeetingControlServer } from './meeting-session.js'
import { postMessage, roundPaths, voteMessage } from './meeting-messages.js'

const MEETINGS = join('C:', 'meetings')
const GUESTS = join('C:', 'guests')
const HOST_SESSION = '11111111-1111-4111-8111-111111111111'

function clock(): MeetingTimers & { advance(ms: number): void } {
  let now = 1_000
  let timers: Array<{ at: number; callback: () => void; live: boolean }> = []
  return {
    now: () => now,
    set: (callback, ms) => {
      const timer = { at: now + ms, callback, live: true }
      timers.push(timer)
      return () => { timer.live = false }
    },
    advance(ms) {
      now += ms
      const due = timers.filter((timer) => timer.live && timer.at <= now)
      timers = timers.filter((timer) => !due.includes(timer))
      for (const timer of due) { timer.live = false; timer.callback() }
    },
  }
}

const delivery = (round: number, text = `message ${round}`, kind: MeetingDelivery['kind'] = 'post'): MeetingDelivery => ({ meetingId: 'K7QF', round, kind, text })

test('a seat gets one message at a time, and the same one again until it answers', () => {
  const mailbox = new GuestMailbox(clock())
  const { seat } = mailbox.invite('K7QF', 'Claude Code', 'security reviewer')
  assert.match(seat.id, /^guest:[0-9a-f]{16}$/)
  assert.equal(mailbox.take(seat.id), null)
  mailbox.enqueue(seat.id, delivery(1))
  mailbox.enqueue(seat.id, delivery(2))
  assert.equal(mailbox.take(seat.id)?.round, 1)
  assert.equal(mailbox.take(seat.id)?.round, 1, 'a guest whose call timed out is handed the same message')
  mailbox.cancel('K7QF', seat.id)
  assert.equal(mailbox.take(seat.id)?.round, 1, 'cancel drops what was not handed out, never the message being answered')
  assert.equal(mailbox.answer(seat.id)?.round, 1)
  assert.equal(mailbox.take(seat.id), null, 'round 2 was cancelled')
  assert.equal(mailbox.answer(seat.id), null)
})

test('tokens are kept only as hashes; a seat is found by its own token and no other', () => {
  const mailbox = new GuestMailbox(clock())
  const a = mailbox.invite('K7QF', 'Claude Code', null)
  const b = mailbox.invite('K7QF', 'Codex', null)
  assert.match(a.token, /^[0-9a-f]{64}$/)
  assert.equal(mailbox.seatOf(a.token)?.id, a.seat.id)
  assert.equal(mailbox.seatOf(b.token)?.id, b.seat.id)
  assert.equal(mailbox.seatOf('f'.repeat(64)), null)
  assert.equal(mailbox.seatOf(`${a.token} `), null)
  const saved = mailbox.serialize()
  assert.ok(!saved.includes(a.token) && !saved.includes(b.token), 'no token on disk')
  const restored = new GuestMailbox(clock())
  restored.restore(JSON.parse(saved))
  assert.equal(restored.seatOf(a.token)?.name, 'Claude Code', 'a restored seat still knows its token')
})

test('waiting ends when a message arrives, the seat closes, the time is up, or the desktop quits', async () => {
  const timers = clock()
  const mailbox = new GuestMailbox(timers)
  const { seat } = mailbox.invite('K7QF', 'Claude Code', null)
  const arrived = mailbox.wait(seat.id, 100_000)
  mailbox.enqueue(seat.id, delivery(1))
  assert.equal(await arrived, true)
  assert.equal(mailbox.take(seat.id)?.round, 1)
  mailbox.answer(seat.id)

  const timedOut = mailbox.wait(seat.id, 100_000)
  timers.advance(100_000)
  assert.equal(await timedOut, false)

  const quitting = mailbox.wait(seat.id, 100_000)
  mailbox.release()
  assert.equal(await quitting, false)

  const closing = mailbox.wait(seat.id, 100_000)
  mailbox.close(seat.id, 'The person removed you from the meeting.')
  assert.equal(await closing, true)
  assert.equal(mailbox.seat(seat.id)?.closed, 'The person removed you from the meeting.')
  mailbox.enqueue(seat.id, delivery(2))
  assert.equal(mailbox.take(seat.id), null, 'a closed seat gets nothing more')
})

test('an unused invitation expires, and a closed seat is forgotten an hour later', () => {
  const timers = clock()
  const mailbox = new GuestMailbox(timers)
  const unused = mailbox.invite('K7QF', 'Claude Code', null)
  const used = mailbox.invite('K7QF', 'Codex', null)
  mailbox.joined(used.seat)
  timers.advance(GUEST_UNUSED_SEAT_MS + 1)
  assert.deepEqual(mailbox.sweep(), [])
  assert.match(mailbox.seat(unused.seat.id)?.closed ?? '', /expired/)
  assert.equal(mailbox.seat(used.seat.id)?.closed, null, 'a guest that joined does not expire')
  assert.deepEqual(mailbox.views().map((view) => view.name), ['Codex'])
  timers.advance(60 * 60_000 + 1)
  assert.deepEqual(mailbox.sweep().map((seat) => seat.id), [unused.seat.id])
  assert.equal(mailbox.seatOf(unused.token), null)
})

test('names and roles are one line, without quotes or brackets', () => {
  const mailbox = new GuestMailbox(clock())
  const { seat } = mailbox.invite('K7QF', '  Claude "Code"\n[desktop]  ', 'security <reviewer>')
  assert.equal(seat.name, 'Claude Code desktop')
  assert.equal(seat.role, 'security reviewer')
  assert.equal(mailbox.invite('K7QF', '   ', null).seat.name, 'Outside agent')
})

test('a guest message names show commands instead of meeting files, only in the desktop\'s header', () => {
  const folder = join(MEETINGS, 'K7QF')
  const round2 = roundPaths(folder, 2)
  const text = [
    '[meeting K7QF · round 2 · from the desktop]',
    `The host's uncommitted changes for this round: ${round2.changes}`,
    `What the reviewers said in round 1: ${roundPaths(folder, 1).replies}`,
    `You joined while the meeting was under way; earlier rounds are in ${round2.transcript}.`,
    `The host's post for round 2 is below (also in ${round2.post}).`,
    '-----',
    `A post that mentions ${round2.post} itself.`,
  ].join('\n')
  const seatId = 'guest:0123456789abcdef'
  const replyPath = guestReplyPath(GUESTS, seatId, delivery(2))
  assert.equal(replyPath, join(GUESTS, '0123456789abcdef', 'reply-2-post.md'))
  const message = guestMessage(text, folder, 2, { via: 'helper', path: replyPath })
  assert.match(message, /changes for this round: the output of: show -Name changes -Round 2$/m)
  assert.match(message, /round 1: the output of: show -Name replies -Round 1$/m)
  assert.match(message, /earlier rounds are in the output of: show -Name transcript\.$/m)
  assert.ok(message.includes(`A post that mentions ${round2.post} itself.`), 'model-written material is never rewritten')
  assert.ok(!message.split('\n-----\n')[0]!.includes(folder), 'no meeting path left in the header')
  assert.ok(message.endsWith(`To answer, write your whole reply to ${replyPath} and run the reply command from your invitation with -File "${replyPath}".`))
})

test('a guest gets the same evidence rule as a desktop reviewer, for reviews and votes', () => {
  const folder = join(MEETINGS, 'K7QF')
  const host = { title: 'host', folder: null }
  const post = postMessage({ id: 'K7QF', round: 1, topic: 'plan', host, post: 'plan', folder, hasChanges: false, previousReplies: false, joinedLate: false })
  const vote = voteMessage({ id: 'K7QF', round: 2, host, summary: '- lock around logout', folder, joinedLate: false })
  assert.match(guestMessage(post, folder, 1, { via: 'mcp' }), /For each finding, say what supports it/)
  assert.match(guestMessage(vote, folder, 2, { via: 'mcp' }), /After OBJECT, name each open item and what supports it/)
})

test('the invitation tells the agent how to poll, read and reply, with its token and the helper', () => {
  const helper = guestHelperCommand('C:\\data\\meeting-guest\\meeting-guest.ps1', true)
  assert.equal(helper, 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\data\\meeting-guest\\meeting-guest.ps1"')
  assert.equal(guestHelperCommand('/data/meeting-guest/meeting-guest.sh', false), 'sh "/data/meeting-guest/meeting-guest.sh"')
  const text = guestInvitation({ meetingId: 'K7QF', role: 'security "reviewer"', token: 'a'.repeat(64), helper })
  assert.match(text, /review meeting K7QF in Copilot CLI Desktop as security reviewer\./)
  assert.ok(text.includes(`1. Run: ${helper} next -Token ${'a'.repeat(64)}`))
  assert.ok(text.includes(`${helper} reply -File "<that file>" -Token ${'a'.repeat(64)}`))
  assert.match(text, /Review only: do not edit files/)
  assert.match(text, /Do not end your turn until the meeting is closed/)
})

test('a short invitation, for an agent that has the meeting tools, names only them and keeps the rules', () => {
  const token = 'b'.repeat(64)
  const helper = guestHelperCommand('C:\\data\\meeting-guest\\meeting-guest.ps1', true)
  const full = guestInvitation({ meetingId: 'K7QF', role: 'security reviewer', token, helper, tools: true })
  const short = guestInvitation({ meetingId: 'K7QF', role: 'security reviewer', token, helper, tools: true, toolsOnly: true })
  assert.match(short, /^Review meeting K7QF in Copilot CLI Desktop as security reviewer with the copilot-meeting tools: call meeting_join with invitation "b{64}"/)
  assert.match(short, /meeting_next.*meeting_show.*meeting_reply/)
  assert.match(short, /Review only: do not edit files/)
  assert.match(short, /Do not end your turn until the meeting is closed/)
  assert.ok(!short.includes('meeting-guest.ps1') && !short.includes('-Token'), 'no helper in it')
  assert.ok(short.length * 3 < full.length, `a third of the full one or less (${short.length} of ${full.length})`)
  assert.equal(guestInvitation({ meetingId: 'K7QF', role: null, token, helper, tools: false, toolsOnly: true }), guestInvitation({ meetingId: 'K7QF', role: null, token, helper }),
    'without the tools served, the full invitation: the helper is all the agent has')

  const host = guestHostInvitation({ token, helper, tools: true, toolsOnly: true, folder: 'D:\\api' })
  assert.match(host, /^Host a review meeting in Copilot CLI Desktop with the copilot-meeting tools: call meeting_start with invitation "b{64}"/)
  assert.match(host, /changes: true attaches your uncommitted changes in D:\\api/)
  assert.match(host, /meeting_round.*meeting_propose_close.*meeting_end/s)
  assert.ok(!host.includes('meeting-guest.ps1') && host.length * 2 < guestHostInvitation({ token, helper, tools: true, folder: 'D:\\api' }).length)
  assert.ok(!guestHostInvitation({ token, helper, tools: true, toolsOnly: true, folder: null }).includes('changes: true'), 'no folder, no changes')
})

/** The patch a host seat's folder gives, in these tests. */
const FOLDER_PATCH = 'diff --git a/login.cfg b/login.cfg\n--- a/login.cfg\n+++ b/login.cfg\n-retry = 1\n+retry = 3\n'

/** The host's part of `GuestDeps`, wired to a hub as main wires it. */
function hostDeps(hub: () => MeetingHub): Pick<GuestDeps, 'start' | 'post' | 'end' | 'status' | 'changes'> {
  return {
    start: (seat, topic, post, changes) => {
      try { return { meetingId: hub().start({ tabId: seat.id, title: `${seat.name} (guest)`, folder: seat.folder }, { topic, post, changes }).id } }
      catch (error) { return { error: (error as Error).message } }
    },
    post: (seat, kind, text, changes) => {
      try { return { ok: true, message: hub().post(seat.id, kind, text, changes) } } catch (error) { return { ok: false, message: (error as Error).message } }
    },
    end: (seat) => { hub().end(seat.id); return { ok: true, message: 'The meeting is closed.' } },
    status: (seat) => `status of ${seat.meetingId}`,
    changes: async () => FOLDER_PATCH,
  }
}

/** For tests whose guests never host. */
const NO_HOST: Pick<GuestDeps, 'start' | 'post' | 'end' | 'status' | 'changes'> = {
  start: () => ({ error: 'not here' }), post: () => ({ ok: false, message: 'not here' }), end: () => ({ ok: false, message: 'not here' }),
  status: () => '', changes: async () => '',
}

/** A hub with a host, and a mailbox whose guests take part through `handleGuestRequest`, wired as main wires them. */
function meeting(): {
  hub: MeetingHub; mailbox: GuestMailbox; timers: ReturnType<typeof clock>; files: Map<string, string>; toHost: MeetingDelivery[]
  call(seat: GuestSeat, command: Parameters<typeof handleGuestRequest>[3], fields?: Record<string, unknown>, via?: GuestChannel): Promise<string>
} {
  const timers = clock()
  const files = new Map<string, string>()
  const toHost: MeetingDelivery[] = []
  let mailbox!: GuestMailbox
  const hub = new MeetingHub(() => MEETINGS, {
    deliver: (tabId, item) => {
      if (tabId === 'tab-host') { if (item.kind !== 'add-dir') toHost.push(item); return }
      if (item.kind === 'add-dir') return
      mailbox.enqueue(tabId, item)
    },
    cancel: (meetingId, tabId) => mailbox.cancel(meetingId, tabId),
    write: (_meetingId, path, text) => files.set(path, text),
    changed: () => mailbox?.closeEnded((id) => hub.isOpen(id)),
    notify: () => {},
    sessionIdOf: (tabId) => tabId === 'tab-host' ? HOST_SESSION : tabId,
  }, () => ({ maxRounds: 6, roundTimeoutMinutes: 10 }), timers, () => 'K7QF')
  mailbox = new GuestMailbox(timers, () => {}, (seat, item) => guestDeliveryText(seat, item, hub.folderOf(item.meetingId), GUESTS))
  const deps: GuestDeps = {
    ready: () => true,
    isOpen: (id) => hub.isOpen(id),
    join: (seat) => { try { hub.join({ tabId: seat.id, title: `${seat.name} (guest)`, folder: null }, seat.meetingId, { role: seat.role }); return null } catch (error) { return (error as Error).message } },
    leave: (seat) => hub.leave(seat.id),
    turnCompleted: (seat, item, reply) => hub.turnCompleted(seat.id, item, reply),
    material: async (id, name, round) => {
      const paths = roundPaths(hub.folderOf(id)!, round)
      return files.get(name === 'transcript' ? paths.transcript : paths[name]) ?? null
    },
    ...hostDeps(() => hub),
  }
  return {
    hub, mailbox, timers, files, toHost,
    call: async (seat, command, fields = {}, via = 'helper') => {
      // A next with nothing to hand out waits on the fake clock: move it on by the wait, and only then.
      let settled = false
      const answer = handleGuestRequest(mailbox, deps, seat, command, fields, undefined, via).finally(() => { settled = true })
      for (let tick = 0; tick < 20 && !settled; tick++) await Promise.resolve()
      if (!settled) timers.advance(Number(fields.wait ?? 100) * 1000)
      const result = await answer
      return result.ok ? result.message : `ERROR ${result.message}`
    },
  }
}

test('a guest joins with its first next, reviews, pages a long patch, votes, and hears that the meeting closed', async () => {
  const { hub, mailbox, call, toHost } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const { seat } = mailbox.invite('K7QF', 'Claude Code', 'security reviewer')
  assert.equal(hub.views()[0]!.participants.length, 0, 'an invitation alone does not join')

  const post = await call(seat, 'next', { wait: '100' })
  assert.match(post, /^\[meeting K7QF · round 1 · from the desktop\]/)
  assert.match(post, /You review as: security reviewer/)
  assert.match(post, /reply-1-post\.md/)
  assert.deepEqual(hub.views()[0]!.participants.map((participant) => participant.title), ['Claude Code (guest)'])
  assert.equal(await call(seat, 'next'), post, 'the same message until it is answered')
  assert.equal(await call(seat, 'reply', { text: '  ' }), 'ERROR The reply is empty. Write your whole answer to the file, then run reply again.')
  assert.equal(await call(seat, 'reply', { text: 'Review: the cache is keyed by user.' }), 'Reply sent. Run next for the next message.')
  assert.match(toHost.at(-1)!.text, /Review: the cache is keyed by user\./, 'the host gets the guest\'s review')
  assert.equal(await call(seat, 'next', { wait: 1 }), 'Nothing yet. Run next again.')

  const patch = 'x'.repeat(GUEST_PAGE_CHARS + 5)
  hub.post('tab-host', 'round', 'Plan v2', patch)
  const round2 = await call(seat, 'next')
  assert.match(round2, /the output of: show -Name changes -Round 2/)
  const first = await call(seat, 'show', { name: 'changes', round: '2' })
  assert.ok(first.endsWith(`[5 more characters: show -Name changes -Round 2 -Offset ${GUEST_PAGE_CHARS}]`))
  assert.equal(await call(seat, 'show', { name: 'changes', round: 2, offset: GUEST_PAGE_CHARS }), 'xxxxx\n[end]')
  assert.equal(await call(seat, 'show', { name: 'secrets', round: 2 }), 'ERROR The name takes one of: post, changes, replies, transcript.')
  assert.match(await call(seat, 'show', { name: 'post', round: 9 }), /^ERROR Round 9 has no post\./)
  await call(seat, 'reply', { text: 'Looks right now.' })

  hub.post('tab-host', 'propose-close', 'Agreed: key by session.', null)
  assert.match(await call(seat, 'next'), /· vote · from the desktop\]/)
  await call(seat, 'reply', { text: 'AGREE' })
  assert.equal(hub.views()[0]!.outcome, 'agreed')
  assert.equal(await call(seat, 'next'), 'The meeting is closed.')
  assert.equal(mailbox.views().length, 0)
})

test('a guest that leaves, or that the person removes, is out of the round and hears why', async () => {
  const { hub, mailbox, call, toHost } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const a = mailbox.invite('K7QF', 'Claude Code', null).seat
  const b = mailbox.invite('K7QF', 'Codex', null).seat
  await call(a, 'next')
  await call(b, 'next')
  assert.equal(await call(a, 'leave'), 'You left the meeting.')
  assert.equal(await call(a, 'next'), 'You left the meeting.')
  hub.leave(b.id)
  mailbox.close(b.id, 'The person removed you from the meeting.')
  assert.equal(await call(b, 'reply', { text: 'late' }), 'The person removed you from the meeting.')
  assert.equal(hub.views()[0]!.stage, 'waiting', 'nobody is left to answer: the round starts over for whoever joins next')
  assert.equal(toHost.length, 0)
})

test('a meeting with a guest is saved by its seat id and restored with it', async () => {
  const { hub, mailbox, call, files } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const { seat } = mailbox.invite('K7QF', 'Claude Code', 'security reviewer')
  await call(seat, 'next')
  const saved = JSON.parse(files.get(join(MEETINGS, 'K7QF', 'meeting.json'))!)
  assert.equal(saved.participants[0].sessionId, seat.id)
  assert.equal(saved.outstanding[0].sessionId, seat.id, 'what the guest has not answered is saved by its seat id')

  const after = meeting()
  after.mailbox.restore(JSON.parse(mailbox.serialize()))
  const restoredSeat = after.mailbox.seat(seat.id)!
  const tabs = after.hub.restore(saved, '', (sessionId) => sessionId === HOST_SESSION
    ? { tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }
    : after.mailbox.seat(sessionId) ? { tabId: sessionId, title: 'Claude Code (guest)', folder: null } : null)
  assert.deepEqual(tabs, ['tab-host', seat.id])
  assert.match(await after.call(restoredSeat, 'next'), /^\[meeting K7QF · round 1 · from the desktop\]/, 'the unanswered round is sent again')
  assert.equal(after.hub.views()[0]!.participants[0]!.role, 'security reviewer')
})

test('a guest is told to wait while the desktop starts, and an invitation to a closed meeting says so', async () => {
  const mailbox = new GuestMailbox(clock())
  const { seat } = mailbox.invite('K7QF', 'Claude Code', null)
  let ready = false
  const deps: GuestDeps = {
    ready: () => ready, isOpen: () => false, join: () => null, leave: () => {}, turnCompleted: () => {}, material: async () => null, ...NO_HOST,
  }
  assert.match((await handleGuestRequest(mailbox, deps, seat, 'next', {})).message, /The desktop is starting/)
  assert.equal(mailbox.seat(seat.id)?.closed, null)
  ready = true
  assert.equal((await handleGuestRequest(mailbox, deps, seat, 'next', {})).message, 'The meeting is closed.')
  assert.equal(mailbox.seat(seat.id)?.closed, 'The meeting is closed.')
})

function post(port: number, path: string, token: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePost, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolvePost({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

/** The real endpoint with real timers: a guest's `next` waits there until main hands it something. */
function endpoint(mailbox: GuestMailbox, onListening?: (port: number) => void, replied: (text: string) => void = () => {}): MeetingControlServer {
  const deps: GuestDeps = {
    ready: () => true, isOpen: () => true, join: () => null, leave: () => {}, turnCompleted: (_seat, _delivery, text) => replied(text),
    material: async (_id, name) => name === 'post' ? 'the post' : null, ...NO_HOST,
  }
  return new MeetingControlServer(() => ({ ok: true, message: 'host command' }), {
    handle: async (token, command, fields, signal) => {
      const seat = mailbox.seatOf(token)
      return seat ? handleGuestRequest(mailbox, deps, seat, command, fields, signal) : null
    },
    release: () => mailbox.release(),
  }, onListening)
}

test('a seat has one waiting next: a newer call takes over, and a call whose client left stops waiting', async () => {
  const timers = clock()
  const mailbox = new GuestMailbox(timers)
  const { seat } = mailbox.invite('K7QF', 'Claude Code', null)
  const older = mailbox.wait(seat.id, 100_000)
  const newer = mailbox.wait(seat.id, 100_000)
  assert.equal(await older, false, 'the older call ends at once')
  assert.equal(mailbox.waiting(seat.id), true)
  mailbox.enqueue(seat.id, delivery(1))
  assert.equal(await newer, true)
  assert.equal(mailbox.waiting(seat.id), false)
  assert.equal(mailbox.take(seat.id)?.round, 1)
  mailbox.answer(seat.id)

  const left = new AbortController()
  const abandoned = mailbox.wait(seat.id, 100_000, left.signal)
  left.abort()
  assert.equal(await abandoned, false)
  assert.equal(mailbox.waiting(seat.id), false, 'nothing is left waiting for a client that went away')
  mailbox.enqueue(seat.id, delivery(2))
  assert.equal(mailbox.take(seat.id)?.round, 2, 'the message stays for the next call')
})

test('the endpoint stops a guest\'s wait when its connection closes, however many times it retried', async () => {
  const mailbox = new GuestMailbox({ now: () => Date.now(), set: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) } })
  const { seat, token } = mailbox.invite('K7QF', 'Claude Code', null)
  const server = endpoint(mailbox)
  try {
    const port = await server.port()
    const abandoned = Array.from({ length: 5 }, () => {
      const outgoing = request({ host: '127.0.0.1', port, path: '/guest/next', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } })
      outgoing.on('error', () => {})
      outgoing.end(JSON.stringify({ wait: 540 }))
      return outgoing
    })
    await until(() => mailbox.waiting(seat.id), 'a next is waiting')
    for (const outgoing of abandoned) outgoing.destroy()
    await until(() => !mailbox.waiting(seat.id), 'the abandoned waits ended')
    mailbox.enqueue(seat.id, delivery(1, 'round one'))
    assert.deepEqual(JSON.parse((await post(port, '/guest/next', token, JSON.stringify({ wait: 5 }))).body), { ok: true, message: 'round one' }, 'the next call still gets the message')
  } finally {
    await server.close()
  }
})

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise((resolveSoon) => setTimeout(resolveSoon, 20)) }
  throw new Error(`Timed out: ${label}`)
}

test('the endpoint keeps guest and session tokens apart, and a waiting next answers when a message arrives or the app quits', async () => {
  const mailbox = new GuestMailbox({ now: () => Date.now(), set: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) } })
  const { seat, token } = mailbox.invite('K7QF', 'Claude Code', null)
  let announced = 0
  const server = endpoint(mailbox, (port) => { announced = port })
  try {
    const session = await server.register('tab-a')
    assert.equal(announced, session.port, 'main learns the port when the server starts listening')
    assert.equal((await post(session.port, '/guest/next', session.token, '{}')).status, 401, 'a session token is not a guest token')
    assert.equal((await post(session.port, '/status', token, '{}')).status, 401, 'a guest token cannot run host commands')
    assert.equal((await post(session.port, '/guest/nope', token, '{}')).status, 404)
    assert.match(JSON.parse((await post(session.port, '/guest/start', token, '{}')).body).message, /This invitation is for reviewing/, 'a reviewer token cannot start a meeting')

    const waiting = post(session.port, '/guest/next', token, JSON.stringify({ wait: 30 }))
    await new Promise((resolveSoon) => setTimeout(resolveSoon, 100))
    mailbox.enqueue(seat.id, delivery(1, 'round one'))
    assert.deepEqual(JSON.parse((await waiting).body), { ok: true, message: 'round one' })
    await post(session.port, '/guest/reply', token, JSON.stringify({ text: 'ok' }))

    const quitting = post(session.port, '/guest/next', token, JSON.stringify({ wait: 30 }))
    await new Promise((resolveSoon) => setTimeout(resolveSoon, 100))
    await server.close()
    assert.deepEqual(JSON.parse((await quitting).body), { ok: true, message: 'Nothing yet. Run next again.' }, 'closing the app does not wait out a guest\'s poll')
  } finally {
    await server.close()
  }
})

test('the guest helper polls, pages and replies through the real endpoint', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'meeting-guest-'))
  const mailbox = new GuestMailbox({ now: () => Date.now(), set: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) } })
  const { seat, token } = mailbox.invite('K7QF', 'Claude Code', null)
  const windows = process.platform === 'win32'
  const helper = join(folder, windows ? 'meeting-guest.ps1' : 'meeting-guest.sh')
  let replied = ''
  const server = endpoint(mailbox, (port) => { void writeFile(join(folder, GUEST_ENDPOINT_FILE), JSON.stringify({ pid: process.pid, port })) }, (text) => { replied = text })
  const run = (...args: string[]): Promise<{ code: number; out: string; err: string }> => new Promise((resolveRun) => {
    const [shell, ...shellArgs] = windows ? ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] : ['sh']
    execFile(shell!, [...shellArgs, helper, ...args], { encoding: 'utf8', timeout: 60_000 }, (error, out, err) => resolveRun({ code: error ? Number(error.code ?? 1) : 0, out: out.trim(), err: err.trim() }))
  })
  try {
    await writeFile(helper, windows ? GUEST_HELPER : GUEST_HELPER_SH)
    await server.port()
    await new Promise((resolveSoon) => setTimeout(resolveSoon, 100))
    assert.equal((await run('next', '-Token', 'nope')).err, 'Meeting command failed: Pass -Token with the token from your invitation.')
    assert.equal((await run('next', '-Token', token, '-Wait', '1')).out, 'Nothing yet. Run next again.')
    mailbox.enqueue(seat.id, delivery(1, '[meeting K7QF · round 1 · from the desktop]\nReview "this" — café'))
    assert.equal((await run('next', '-Token', token)).out, '[meeting K7QF · round 1 · from the desktop]\nReview "this" — café')
    assert.equal((await run('show', '-Token', token, '-Name', 'post')).out, 'the post\n[end]')
    const answer = join(folder, 'reply-1-post.md')
    await writeFile(answer, 'Looks fine — merci.\n')
    const reply = await run('reply', '-Token', token, '-File', answer)
    assert.equal(reply.out, 'Reply sent. Run next for the next message.', reply.err)
    assert.equal(replied.replace(/\r\n/g, '\n'), 'Looks fine — merci.\n', 'the reply file reaches the desktop as written')
    assert.deepEqual(await run('reply', '-Token', token, '-File', answer), { code: 1, out: 'There is no message to answer. Run next.', err: '' }, 'a refusal is printed and fails the command')
    assert.equal((await run('next', '-Token', 'f'.repeat(64), '-Wait', '1')).err, 'Meeting command failed: This invitation is not known to the desktop. Ask the person for a new one.')
  } finally {
    await server.close()
    await rm(folder, { recursive: true, force: true })
  }
})

test('an outside host starts a meeting, answers the rounds, is reminded when it lets a turn pass, and hears the agreement once', async () => {
  const { hub, mailbox, call } = meeting()
  const host = mailbox.invite('', 'Claude Code', null, { kind: 'host', folder: 'D:\\api' }).seat
  const reviewer = mailbox.invite('K7QF', 'Codex', null).seat
  assert.equal(host.meetingId, '')
  assert.equal(await call(reviewer, 'start', { text: 'x' }), 'ERROR This invitation is for reviewing. Hosting a meeting needs a host invitation from the person.')
  assert.equal(await call(host, 'next'), 'ERROR Start the meeting first, with start.')
  assert.equal(await call(host, 'start', { topic: 'login', text: ' ' }), 'ERROR The post is empty. Send your whole plan, answer or agreed items.')

  const started = await call(host, 'start', { topic: 'login race', text: 'Plan v1', changes: '1' })
  assert.match(started, /^Meeting K7QF is open\. The person adds the reviewers from the desktop\. Run next to wait for their replies/)
  assert.equal(host.meetingId, 'K7QF')
  const view = hub.views()[0]!
  assert.equal(view.hostTabId, host.id)
  assert.equal(view.hostTitle, 'Claude Code (guest)')
  assert.equal(await call(host, 'start', { text: 'again' }), 'ERROR This invitation already started meeting K7QF.')
  assert.equal(await call(host, 'reply', { text: 'x' }), 'ERROR As the host, answer with round, propose-close or end.')

  const post = await call(reviewer, 'next')
  assert.match(post, /the output of: show -Name changes -Round 1/, 'the folder\'s changes went with the opening post')
  assert.match(await call(reviewer, 'show', { name: 'changes', round: 1 }), /\+retry = 3/)
  await call(reviewer, 'reply', { text: 'Review: retry 3 is fine.' })

  const digest = await call(host, 'next')
  assert.match(digest, /^\[meeting K7QF · round 1 · replies · from the desktop\]/)
  assert.match(digest, /Review: retry 3 is fine\./)
  assert.match(digest, /^ {2}round -File <your answer\.md> \[-Changes\]$/m, 'the host\'s commands as the outside host runs them')
  assert.ok(!digest.includes('COPILOT_DESKTOP_MEETING_HELPER'), 'no Copilot helper command in what an outside host reads')
  assert.match(digest, /Run them with the helper and token from your invitation, then run next/)

  // It asks for the replies again without answering: its turn has passed. A reminder, then a pause.
  assert.match(await call(host, 'next'), /^\[meeting K7QF · reminder · from the desktop\]/)
  assert.equal(await call(host, 'next', { wait: 1 }), 'Nothing yet. Run next again.')
  assert.equal(hub.views()[0]!.stage, 'paused')
  assert.equal(hub.views()[0]!.pauseReason, 'host-silent')
  hub.resume('K7QF')
  assert.match(await call(host, 'next'), /reminder · from the desktop\]/)

  assert.equal(await call(host, 'round', { text: 'Plan v2: lock on logout.', changes: true }), 'Sent round 2 to 1 reviewer. Run next to wait for their replies.')
  assert.equal(mailbox.given(host.id), null, 'answering the round answered what it had been given')
  assert.match(await call(reviewer, 'next'), /round 2 · from the desktop\]/)
  await call(reviewer, 'reply', { text: 'Good.' })
  await call(host, 'next')
  assert.equal(await call(host, 'status'), 'status of K7QF')
  assert.match(await call(host, 'propose-close', { text: 'Lock on logout.' }), /^Sent round 3/)
  await call(reviewer, 'next')
  await call(reviewer, 'reply', { text: 'AGREE' })
  assert.equal(hub.views()[0]!.outcome, 'agreed')
  assert.match(await call(host, 'next'), /^\[meeting K7QF · closed · from the desktop\]\nAll 1 reviewers agreed\./, 'the agreed message, once')
  assert.equal(await call(host, 'next'), 'The meeting is closed.')
})

test('a host can attach changes only from a folder the person picked', async () => {
  const { mailbox, call } = meeting()
  const host = mailbox.invite('', 'Claude Code', 'ignored role', { kind: 'host' }).seat
  assert.equal(host.folder, null)
  assert.equal(host.role, null, 'a host has no reviewer role')
  assert.match(await call(host, 'start', { topic: 't', text: 'Plan', changes: true }), /^ERROR The person picked no project folder for this meeting/)
  assert.match(await call(host, 'start', { topic: 't', text: 'Plan' }), /^Meeting K7QF is open/)
})

test('a host seat is saved before and after its meeting starts, with its folder and its pending agreed message', () => {
  const mailbox = new GuestMailbox(clock())
  const unstarted = mailbox.invite('', 'Claude Code', null, { kind: 'host', folder: 'D:\\api' })
  const started = mailbox.invite('', 'Codex', null, { kind: 'host', folder: null })
  mailbox.started(started.seat, 'K7QF')
  mailbox.enqueue(started.seat.id, { meetingId: 'K7QF', round: 2, kind: 'agreed', text: 'All agreed.' })
  mailbox.closeEnded(() => false)
  assert.equal(mailbox.seat(unstarted.seat.id)?.closed, null, 'a host seat with no meeting yet is not closed with the meetings')
  const restored = new GuestMailbox(clock())
  restored.restore(JSON.parse(mailbox.serialize()))
  assert.deepEqual(restored.seat(unstarted.seat.id), unstarted.seat)
  const back = restored.seatOf(started.token)!
  assert.equal(back.kind, 'host')
  assert.equal(restored.closing(back), 'All agreed.')
  assert.equal(restored.closing(back), 'The meeting is closed.')
})

test('an unanswered message is worded for the channel that reads it, when a guest falls back from the tools to the helper', async () => {
  const { hub, mailbox, call } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: 'diff --git a/x b/x\n+y\n' })
  const { seat } = mailbox.invite('K7QF', 'Claude Code', null)
  const withTools = await call(seat, 'next', { wait: 5 }, 'mcp')
  assert.match(withTools, /the result of meeting_show\(name: "changes", round: 1\)/)
  assert.ok(withTools.endsWith('To answer, call meeting_reply with your whole reply.'))
  // The tools are gone (their port taken after a restart): the helper asks for the same, unanswered message.
  const withHelper = await call(seat, 'next', { wait: 5 }, 'helper')
  assert.match(withHelper, /the output of: show -Name changes -Round 1/)
  assert.ok(withHelper.endsWith(`run the reply command from your invitation with -File "${guestReplyPath(GUESTS, seat.id, { meetingId: 'K7QF', round: 1, kind: 'post', text: '' })}".`), 'a reply file to answer with')
  assert.equal(withHelper.split('\n-----\n')[1], withTools.split('\n-----\n')[1], 'the same material, unchanged')
  assert.equal(await call(seat, 'reply', { text: 'Fine.' }), 'Reply sent. Run next for the next message.')
})

test('a host\'s agreed message is worded for its channel when the meeting closes', () => {
  const mailbox = new GuestMailbox(clock(), () => {}, (seat, delivery) => `${seat.via}: ${delivery.text}`)
  const { seat } = mailbox.invite('', 'Claude Code', null, { kind: 'host' })
  mailbox.started(seat, 'K7QF')
  mailbox.seen(seat, 'mcp')
  mailbox.enqueue(seat.id, { meetingId: 'K7QF', round: 2, kind: 'agreed', text: 'All agreed.' })
  mailbox.close(seat.id, 'The meeting is closed.')
  assert.equal(mailbox.closing(seat), 'mcp: All agreed.')
})
