import assert from 'node:assert/strict'
import test from 'node:test'
import { MeetingOutbox } from './meeting-delivery.js'
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
