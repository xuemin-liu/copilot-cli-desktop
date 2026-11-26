import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MeetingReviewerError, MeetingReviewerRegistry, meetingReviewerBrief, meetingReviewerConsentDetail, meetingReviewerPromptLine,
} from './meeting-reviewers.js'

const run = (registry: MeetingReviewerRegistry, meetingId = 'K7QF', profileId = 'p1', clis: readonly ('claude' | 'codex' | 'antigravity' | 'copilot')[] = ['claude', 'codex']) =>
  registry.create({ meetingId, hostTabId: 'tab-1', profileId, projectPath: 'D:\\api', clis })

test('a run is recorded before anything starts, one per workspace and one per meeting', () => {
  const registry = new MeetingReviewerRegistry()
  const group = run(registry)
  assert.equal(group.stage, 'consent', 'recorded while the person is still being asked')
  assert.equal(group.allowAll, null, 'no permission mode until the person has answered')
  assert.deepEqual([...group.seats.keys()], ['claude', 'codex'])
  assert.equal(registry.activeForProfile('p1'), group)
  assert.equal(registry.forMeeting('K7QF'), group)
  assert.throws(() => run(registry, 'K7QF', 'p2'), /already has hidden reviewers/)
  assert.throws(() => run(registry, 'M2MM', 'p1'), /already running hidden reviewers for meeting K7QF/)
  assert.throws(() => run(registry, 'M2MM', 'p2', []), MeetingReviewerError)
  // Another workspace, another meeting: fine.
  assert.equal(run(registry, 'M2MM', 'p2').meetingId, 'M2MM')
  // Once a run is over its workspace is free again.
  registry.end(group.id, 'closed')
  assert.equal(registry.activeForProfile('p1'), null)
  assert.equal(run(registry, 'N3NN', 'p1').meetingId, 'N3NN')
})

test('a seat is joined only by its own meeting seat, and the run is settled when no seat is still starting', () => {
  const registry = new MeetingReviewerRegistry()
  const group = run(registry)
  group.stage = 'starting'
  const claude = group.seats.get('claude')!
  const codex = group.seats.get('codex')!
  claude.guestSeatId = 'guest:aaaaaaaaaaaaaaaa'
  codex.guestSeatId = 'guest:bbbbbbbbbbbbbbbb'
  assert.equal(registry.settled(group), false)
  assert.equal(registry.seatJoined('guest:cccccccccccccccc'), false, 'a seat the desktop did not make is not a managed one')
  assert.equal(registry.seatJoined('guest:aaaaaaaaaaaaaaaa'), true)
  assert.equal(claude.lifecycle, 'joined')
  assert.equal(registry.seatJoined('guest:aaaaaaaaaaaaaaaa'), false, 'joining twice changes nothing')
  assert.equal(registry.settled(group), false, 'the other seat is still starting')
  assert.equal(registry.failSeat(codex, codex.generation, 'It did not join in time.'), true)
  assert.equal(registry.settled(group), true)
  assert.equal(registry.joinedCount(group), 1)
  // A seat that already failed cannot join late, and a seat that joined cannot be failed by a late timer.
  assert.equal(registry.seatJoined('guest:bbbbbbbbbbbbbbbb'), false)
  assert.equal(registry.failSeat(claude, claude.generation, 'late timer'), false)
  assert.equal(claude.lifecycle, 'joined')
})

test('events of an earlier launch of a seat do not touch the launch that replaced it', () => {
  const registry = new MeetingReviewerRegistry()
  const group = run(registry)
  group.stage = 'active'
  const first = group.seats.get('claude')!
  first.guestSeatId = 'guest:aaaaaaaaaaaaaaaa'
  registry.seatJoined('guest:aaaaaaaaaaaaaaaa')
  assert.equal(registry.seatExited(first, first.generation, 'Its session ended.'), true)
  assert.equal(first.lifecycle, 'left')
  const { previous, next } = registry.replace(group.id, 'claude')
  assert.equal(previous, first)
  assert.equal(next.replacement, true, 'a replacement joins from the next round')
  assert.notEqual(next.generation, first.generation)
  assert.equal(group.seats.get('claude'), next)
  assert.equal(next.lifecycle, 'starting')
  // The old launch's timer or exit, arriving late, names the old generation.
  assert.equal(registry.failSeat(next, first.generation, 'old timer'), false)
  assert.equal(registry.seatExited(next, first.generation, 'old exit'), false)
  assert.equal(next.lifecycle, 'starting')
  // A session that ends before it joined is a failed start, not one that left.
  assert.equal(registry.seatExited(next, next.generation, 'Its session ended before it joined.'), true)
  assert.equal(next.lifecycle, 'failed')
})

test('nothing can be started again before the person has answered, and a closed tab ends its seat', () => {
  const registry = new MeetingReviewerRegistry()
  const group = run(registry)
  assert.throws(() => registry.replace(group.id, 'claude'), /Answer the question about hidden reviewers first/)
  assert.equal(group.seats.get('claude')!.replacement, false, 'the seat was not replaced')
  group.stage = 'active'
  const claude = group.seats.get('claude')!
  claude.guestSeatId = 'guest:aaaaaaaaaaaaaaaa'
  claude.tabId = 'tab-9'
  registry.seatJoined('guest:aaaaaaaaaaaaaaaa')
  assert.equal(registry.tabClosed('tab-404'), null)
  const closed = registry.tabClosed('tab-9')!
  assert.equal(closed.wasLive, true)
  assert.equal(claude.tabId, null)
  assert.equal(claude.lifecycle, 'left')
  assert.equal(claude.error, 'Its tab was closed.')
  assert.equal(registry.view(group).seats[0]!.tabId, null, 'no Peek for a tab that is gone')
  // A seat that had already failed only loses its tab.
  const codex = group.seats.get('codex')!
  codex.tabId = 'tab-10'
  registry.failSeat(codex, codex.generation, 'It did not join in time.')
  assert.equal(registry.tabClosed('tab-10')!.wasLive, false)
  assert.equal(codex.error, 'It did not join in time.')
  assert.equal(registry.replace(group.id, 'codex').next.replacement, true)
})

test('dismissing a seat takes it out of the run; ending a run stops what is left and is idempotent', () => {
  const registry = new MeetingReviewerRegistry()
  const group = run(registry, 'K7QF', 'p1', ['claude', 'codex', 'antigravity'])
  group.stage = 'starting'
  const removed = registry.dismiss(group.id, 'codex')
  assert.equal(removed.lifecycle, 'stopped')
  assert.deepEqual([...group.seats.keys()], ['claude', 'antigravity'])
  assert.throws(() => registry.dismiss(group.id, 'codex'), /not in this run/)
  group.seats.get('claude')!.guestSeatId = 'guest:aaaaaaaaaaaaaaaa'
  registry.seatJoined('guest:aaaaaaaaaaaaaaaa')
  assert.equal(registry.activeSeatCount(), 2)
  const seats = registry.end(group.id, 'closed')
  assert.deepEqual(seats.map((seat) => seat.lifecycle), ['stopped', 'stopped'])
  assert.equal(group.outcome, 'closed')
  assert.equal(registry.activeSeatCount(), 0)
  assert.deepEqual(registry.end(group.id, 'stopped', 'again'), [], 'ending twice hands nothing out again')
  assert.equal(group.outcome, 'closed')
  assert.throws(() => registry.replace(group.id, 'claude'), /over/)
  registry.forgetEnded(group.id)
  assert.equal(registry.group(group.id), null)
})

test('the sweep leaves the folder of a live seat alone and takes it once the run is over', () => {
  const registry = new MeetingReviewerRegistry()
  const group = run(registry)
  group.seats.get('claude')!.launchId = '11111111-1111-4111-8111-111111111111'
  assert.equal(registry.holdsLaunch('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(registry.holdsLaunch('22222222-2222-4222-8222-222222222222'), false)
  registry.end(group.id, 'stopped')
  assert.equal(registry.holdsLaunch('11111111-1111-4111-8111-111111111111'), false)
})

test('the bar and meeting_status show the seats of a meeting run', () => {
  const registry = new MeetingReviewerRegistry()
  const group = run(registry)
  assert.equal(registry.statusText('ZZZZ'), '')
  assert.match(registry.statusText('K7QF'), /waiting for the person to allow them/)
  group.stage = 'starting'
  group.commit = 'a'.repeat(40)
  const claude = group.seats.get('claude')!
  claude.guestSeatId = 'guest:aaaaaaaaaaaaaaaa'
  claude.tabId = 'tab-9'
  registry.seatJoined('guest:aaaaaaaaaaaaaaaa')
  registry.failSeat(group.seats.get('codex')!, group.seats.get('codex')!.generation, 'It did not join the meeting within 4 minute(s).')
  const view = registry.view(group)
  assert.equal(view.meetingId, 'K7QF')
  assert.equal(view.prLabel, 'Meeting K7QF')
  assert.equal(view.head, 'a'.repeat(40))
  assert.equal(view.stage, 'starting')
  assert.deepEqual(view.seats.map((seat) => [seat.cli, seat.verdict, seat.needsAttention, seat.tabId]), [['claude', 'reviewing', false, 'tab-9'], ['codex', 'failed', true, null]])
  const status = registry.statusText('K7QF')
  assert.match(status, /round 1 opens when each has joined or failed/)
  assert.match(status, /- Claude Code: in the meeting/)
  assert.match(status, /- Codex CLI: failed \(It did not join the meeting within 4 minute\(s\)\.\)/)
  // A run the person has not answered yet shows as starting in the bar.
  assert.equal(registry.view(run(registry, 'M2MM', 'p2')).stage, 'starting')
})

test('what a hidden reviewer is told holds its credential, the rules, and what its folder is', () => {
  const token = 'f'.repeat(64)
  const pinned = meetingReviewerBrief({ cli: 'claude', meetingId: 'K7QF', token, checkout: 'C:\\r\\checkout', commit: 'a'.repeat(40), serverName: 'copilot-meeting' })
  assert.match(pinned, new RegExp(`invitation: "${token}"`))
  assert.match(pinned, /`meeting_join` tool of the `copilot-meeting` MCP server/)
  assert.match(pinned, /until it says the meeting is closed/)
  assert.match(pinned, /detached checkout of the host's project at commit a{40}/)
  assert.match(pinned, /uncommitted changes are not in it/)
  assert.match(pinned, /Review only: do not edit, create or delete files/)
  const planOnly = meetingReviewerBrief({ cli: 'codex', meetingId: 'K7QF', token, checkout: 'C:\\r\\checkout', commit: null, serverName: 'copilot-meeting' })
  assert.match(planOnly, /There is no checkout of a project for this meeting/)
  assert.doesNotMatch(planOnly, /detached checkout/)
  // The command line names the file only: the credential is not on it.
  const line = meetingReviewerPromptLine('K7QF', 'C:\\r\\helper\\meeting-reviewer.md')
  assert.doesNotMatch(line, /f{64}/)
  assert.match(line, /meeting-reviewer\.md/)
})

test('the consent names the reviewers, what they are given, where it goes, and what full access means', () => {
  const flags = { claude: '--dangerously-skip-permissions', codex: '--dangerously-bypass-approvals-and-sandbox' }
  const on = meetingReviewerConsentDetail({ clis: ['claude', 'codex'], allowAll: true, allowAllFlags: flags, commit: 'abcdef0123456789'.padEnd(40, '0'), projectPath: 'D:\\api', hasChanges: true })
  assert.match(on, /Reviewers: Claude Code, Codex CLI\./)
  assert.match(on, /detached checkout of D:\\api at commit abcdef012345/)
  assert.match(on, /the attached changes/)
  assert.match(on, /including changes the host attaches later in this meeting/)
  assert.match(on, /Claude Code, Codex CLI send what they read to their own providers/)
  assert.match(on, /Claude Code \(--dangerously-skip-permissions\), Codex CLI \(--dangerously-bypass-approvals-and-sandbox\) run without permission prompts/)
  assert.match(on, /nothing prevents them from reading or changing files anywhere your account can/)
  assert.match(on, /not a sandbox/)
  const off = meetingReviewerConsentDetail({ clis: ['copilot'], allowAll: false, allowAllFlags: {}, commit: null, projectPath: 'D:\\notes', hasChanges: false })
  assert.match(off, /no Git commit to check out in D:\\notes/)
  assert.match(off, /start in an empty folder/)
  assert.doesNotMatch(off, /their own providers/, 'Copilot alone goes nowhere new')
  assert.doesNotMatch(off, /the attached changes/)
  assert.match(off, /is off: each reviewer uses its workspace permission settings/)
})
