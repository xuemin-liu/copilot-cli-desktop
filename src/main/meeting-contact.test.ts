import assert from 'node:assert/strict'
import test from 'node:test'
import { GUEST_QUIET_MS, GuestStallNotices, guestContactKey, guestQuiet, guestStalled, meetingStalls, meetingWaitingOn, type GuestContact } from './meeting-contact.js'
import type { MeetingView } from './meeting.js'

const NOW = 100 * 60_000
const LONG_AGO = NOW - GUEST_QUIET_MS - 1
const contact = (extra: Partial<GuestContact> = {}): GuestContact => ({ lastSeenAt: LONG_AGO, waiting: false, holding: false, ...extra })

const HOST = 'guest:0000000000000000'
const REVIEWER = 'guest:1111111111111111'

const meeting = (extra: Partial<MeetingView> = {}): MeetingView => ({
  id: 'K7QF', hostTabId: HOST, hostTitle: 'Codex (guest)', hostGuest: contact(), topic: 'plan', stage: 'host', round: 1, maxRounds: 6, vote: false, discussing: false,
  participants: [{ tabId: REVIEWER, title: 'Claude Code (guest)', role: null, replied: true, guest: contact() }], waitingFor: [], pauseReason: null, outcome: null, folder: 'C:\\m\\K7QF',
  cost: { aiCredits: 0, premiumRequests: 0 }, ...extra,
})

test('a guest is quiet only with no request for a while and none open; it has stalled only if it holds nothing to work on', () => {
  assert.equal(guestQuiet(contact({ lastSeenAt: NOW - GUEST_QUIET_MS }), NOW), false, 'exactly at the limit is not yet quiet')
  assert.equal(guestQuiet(contact(), NOW), true)
  assert.equal(guestQuiet(contact({ waiting: true }), NOW), false, 'a helper wait can be healthy for up to 540 s')
  assert.equal(guestQuiet(contact({ lastSeenAt: null }), NOW), false, 'invited, not connected yet')
  assert.equal(guestStalled(contact(), NOW), true)
  assert.equal(guestStalled(contact({ holding: true }), NOW), false, 'it may be reading code')
  assert.equal(guestQuiet(contact({ holding: true }), NOW), true, 'the bar still shows the last contact')
  assert.equal(guestStalled(contact(), NOW, NOW - 1), false, 'the desktop just started: agents get time to reconnect')
})

test('the bar is told when anything it shows of a seat changes, a newer contact included, and not otherwise', () => {
  const seat = { id: HOST, ...contact() }
  const key = guestContactKey([seat])
  assert.equal(guestContactKey([{ ...seat }]), key)
  assert.notEqual(guestContactKey([{ ...seat, lastSeenAt: NOW }]), key, 'it asked for its status: "no contact since" has to clear')
  assert.notEqual(guestContactKey([{ ...seat, waiting: true }]), key)
  assert.notEqual(guestContactKey([{ ...seat, holding: true }]), key)
  assert.notEqual(guestContactKey([]), key, 'the seat is gone')
})

test('the person hears about a host or reviewer that stopped, but not of a paused meeting, a closed one, or a host alone', () => {
  assert.deepEqual(meetingStalls([meeting()], NOW).map(({ seatId, host }) => ({ seatId, host })), [{ seatId: HOST, host: true }, { seatId: REVIEWER, host: false }])
  const reviewer = { tabId: REVIEWER, title: 'Claude Code (guest)', role: null, replied: false, guest: contact({ holding: true }) }
  assert.deepEqual(meetingStalls([meeting({ stage: 'reviewing', waitingFor: [REVIEWER], participants: [reviewer] })], NOW).map((stall) => stall.seatId), [HOST], 'the host stopped while the reviewer works: no need to wait for the digest')
  assert.deepEqual(meetingStalls([meeting({ stage: 'paused', pauseReason: 'host-silent' })], NOW), [])
  assert.deepEqual(meetingStalls([meeting({ stage: 'closed', outcome: 'agreed' })], NOW), [])
  assert.deepEqual(meetingStalls([meeting({ stage: 'waiting', participants: [] })], NOW), [], 'a host may wait as long as nobody has joined')
  const { hostGuest: _none, ...tabHosted } = meeting({ hostTabId: 'tab-host', hostTitle: 'host' })
  assert.deepEqual(meetingStalls([tabHosted], NOW).map((stall) => stall.seatId), [REVIEWER], 'the desktop drives a Copilot tab itself')
})

test('one notice per quiet spell, and another only after the seat was heard from', () => {
  const notices = new GuestStallNotices()
  const [hostStall, reviewerStall] = meetingStalls([meeting()], NOW)
  assert.deepEqual(notices.take([hostStall!]), [hostStall])
  assert.deepEqual(notices.take([hostStall!]), [], 'told already')
  assert.deepEqual(notices.take([hostStall!, reviewerStall!]), [reviewerStall], 'only the new one')
  assert.deepEqual(notices.take([reviewerStall!]), [], 'the host was heard from')
  assert.deepEqual(notices.take([hostStall!, reviewerStall!]), [hostStall], 'a new spell of the host')
})

test('whom the meeting waits for, in the words of the party asking', () => {
  assert.equal(meetingWaitingOn(meeting({ stage: 'waiting', participants: [] }), HOST), 'Nobody has joined yet.')
  assert.equal(meetingWaitingOn(meeting(), REVIEWER), 'Waiting for the host, Codex (guest).')
  assert.equal(meetingWaitingOn(meeting(), HOST), 'Waiting for your answer.')
  const reviewing = meeting({ stage: 'reviewing', waitingFor: [REVIEWER, 'tab-b'], participants: [...meeting().participants, { tabId: 'tab-b', title: 'review tab', role: null, replied: false }] })
  assert.equal(meetingWaitingOn(reviewing, HOST), 'Waiting for Claude Code (guest), review tab.')
  assert.equal(meetingWaitingOn(reviewing, REVIEWER), 'Waiting for review tab.', 'not for itself')
  assert.equal(meetingWaitingOn(meeting({ stage: 'reviewing', waitingFor: [REVIEWER] }), REVIEWER), 'Waiting for the round to finish.')
  assert.equal(meetingWaitingOn(meeting({ stage: 'paused', pauseReason: 'round-limit' }), REVIEWER), 'The meeting is paused; the person decides whether it goes on.')
})
