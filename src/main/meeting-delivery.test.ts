import assert from 'node:assert/strict'
import test from 'node:test'
import { BEHIND_TURN_REASON, MeetingOutbox } from './meeting-delivery.js'
import type { SessionTaskSend } from './session-task.js'

function outbox(answers: Record<string, SessionTaskSend['result']>) {
  let now = 0
  const typed: string[] = []
  const refused: string[] = []
  let commandsAccepted = true
  const box = new MeetingOutbox({
    sendTask: (tabId, text) => {
      const result = answers[tabId] ?? 'sent'
      if (result === 'sent') typed.push(`${tabId}: ${text}`)
      return result === 'refused' ? { result, message: 'not running' } : result === 'busy' ? { result, message: 'busy' } : { result }
    },
    sendCommand: (tabId, command) => { if (commandsAccepted) typed.push(`${tabId}: ${command}`); return commandsAccepted },
    sent: () => {},
    refused: (tabId, delivery) => refused.push(`${tabId}: ${delivery.text}`),
    now: () => now,
  })
  return { box, typed, refused, advance: (ms: number) => { now += ms }, setCommands: (value: boolean) => { commandsAccepted = value } }
}

test('one prompt per session at a time: the next waits until the turn it started has ended', () => {
  const o = outbox({})
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'round 1' })
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'round 2' })
  assert.equal(o.box.pump(), true)
  assert.deepEqual(o.typed, ['tab-1: round 1'])
  assert.equal(o.box.inTurn('tab-1')?.text, 'round 1')
  o.box.pump()
  assert.equal(o.typed.length, 1)
  assert.equal(o.box.turnEnded('tab-1')?.text, 'round 1')
  assert.equal(o.box.pump(), false)
  assert.deepEqual(o.typed, ['tab-1: round 1', 'tab-1: round 2'])
})

test('a message that cannot be typed keeps its reason and since when, until it goes in', () => {
  const answers: Record<string, SessionTaskSend['result']> = { 'tab-1': 'busy' }
  const o = outbox(answers)
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'round 1' })
  assert.equal(o.box.undelivered('tab-1', 'K7QF'), true)
  assert.equal(o.box.undelivered('tab-1', 'M2NB'), false)
  assert.deepEqual(o.box.blockedDeliveries(), [], 'nothing has been tried yet')
  o.box.pump()
  assert.deepEqual(o.box.blockedDeliveries(), [{ tabId: 'tab-1', meetingId: 'K7QF', reason: 'busy', since: 0, behindTurn: false }])
  o.advance(5_000)
  o.box.pump()
  assert.equal(o.box.blockedDeliveries()[0]!.since, 0, 'the same stall')
  answers['tab-1'] = 'sent'
  o.box.pump()
  assert.deepEqual(o.box.blockedDeliveries(), [])
  assert.equal(o.box.undelivered('tab-1', 'K7QF'), false)
})

test('the reason the desktop can give wins, and a blocked folder command counts as blocked too, though not as undelivered', () => {
  const o = outbox({})
  o.setCommands(false)
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'add-dir', text: 'C:\\m' })
  assert.equal(o.box.undelivered('tab-1', 'K7QF'), false, 'no message is waiting yet')
  o.box.pump()
  assert.equal(o.box.blockedDeliveries()[0]!.reason, 'The session cannot take a command now.')
  let typed = false
  const told = new MeetingOutbox({
    sendTask: () => { typed = true; return { result: 'busy', message: 'The session is starting.' } },
    sendCommand: () => false, sent: () => {}, refused: () => {}, now: () => 0,
    blockReason: () => 'Its prompt box may hold text.',
  })
  told.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'round 1' })
  told.pump()
  assert.equal(typed, true)
  assert.equal(told.blockedDeliveries()[0]!.reason, 'Its prompt box may hold text.')
})

test('a busy session keeps its message for later; a refused one drops it; other sessions are not held up', () => {
  const o = outbox({ 'tab-busy': 'busy', 'tab-gone': 'refused' })
  o.box.enqueue('tab-busy', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'wait' })
  o.box.enqueue('tab-gone', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'never' })
  o.box.enqueue('tab-ok', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'go' })
  assert.equal(o.box.pump(), true, 'the busy one is still waiting')
  assert.deepEqual(o.typed, ['tab-ok: go'])
  assert.deepEqual(o.refused, ['tab-gone: never'])
  o.box.cancel('K7QF', 'tab-busy')
  assert.equal(o.box.hasWork(), false)
})

test('the meeting folder is added with a slash command, and the material follows once the CLI has taken it', () => {
  const o = outbox({})
  o.setCommands(false)
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'add-dir', text: 'C:\\Users\\me\\AppData\\Roaming\\Copilot CLI Desktop\\meetings\\K7QF' })
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'material' })
  o.box.pump()
  assert.deepEqual(o.typed, [], 'not while the prompt box is in use')
  o.setCommands(true)
  o.box.pump()
  assert.deepEqual(o.typed, ['tab-1: /add-dir C:\\Users\\me\\AppData\\Roaming\\Copilot CLI Desktop\\meetings\\K7QF'], 'unquoted: the CLI rejects quotes')
  o.box.pump()
  assert.equal(o.typed.length, 1, 'the command settles first')
  o.advance(1_500)
  o.box.pump()
  assert.deepEqual(o.typed.at(-1), 'tab-1: material')
})
test('settled journal deliveries leave the outbox without starting a duplicate turn',()=>{
  let sent=0
  const box=new MeetingOutbox({sendTask:()=>{sent++;return {result:'sent'}},sendCommand:()=>true,sent:()=>{},refused:()=>{},now:()=>0,settled:()=>true})
  box.enqueue('tab-1',{meetingId:'K7QF',round:1,kind:'post',text:'already answered',id:'stable'})
  assert.equal(box.hasMeetingWork('K7QF'),true);box.pump()
  assert.equal(sent,0);assert.equal(box.inTurn('tab-1'),null);assert.equal(box.hasMeetingWork('K7QF'),false)
})

test('a turn that never ends does not count as a message waiting to be typed, and the wait behind it is reported', () => {
  const o = outbox({})
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'round 1' })
  o.box.pump()
  assert.equal(o.box.inTurn('tab-1')?.text, 'round 1')
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 2, kind: 'post', text: 'round 2' })
  assert.equal(o.box.undelivered('tab-1', 'K7QF'), false, 'the session was asked something: the round may time out as usual')
  o.box.pump()
  assert.deepEqual(o.box.blockedDeliveries(), [{ tabId: 'tab-1', meetingId: 'K7QF', reason: BEHIND_TURN_REASON, since: 0, behindTurn: true }])
  o.advance(60 * 60_000)
  o.box.pump()
  assert.equal(o.box.blockedDeliveries()[0]!.since, 0, 'still the same wait')
  o.box.turnEnded('tab-1')
  assert.deepEqual(o.box.blockedDeliveries(), [], 'that wait is over')
  o.box.pump()
  assert.deepEqual(o.box.blockedDeliveries(), [])
  assert.deepEqual(o.typed, ['tab-1: round 1', 'tab-1: round 2'])
})

test('a refusal right after a long turn starts its own clock, so a normal delivery raises no notice', () => {
  const answers: Record<string, SessionTaskSend['result']> = {}
  const o = outbox(answers)
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 1, kind: 'post', text: 'round 1' })
  o.box.pump()
  o.box.enqueue('tab-1', { meetingId: 'K7QF', round: 2, kind: 'post', text: 'round 2' })
  o.box.pump()
  o.advance(60_000)
  o.box.turnEnded('tab-1')
  answers['tab-1'] = 'busy'
  o.box.pump()
  assert.deepEqual(o.box.blockedDeliveries(), [{ tabId: 'tab-1', meetingId: 'K7QF', reason: 'busy', since: 60_000, behindTurn: false }])
})
