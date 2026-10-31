import assert from 'node:assert/strict'
import test from 'node:test'
import { MeetingTurnReader } from './meeting-turns.js'

const record = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): string => JSON.stringify({ type, data, ...extra })
const user = (content: string, interactionId = 'i1'): string => record('user.message', { content, interactionId })
const assistant = (data: Record<string, unknown>): string => record('assistant.message', { interactionId: 'i1', ...data })

test('the final answer is the reply; commentary and tool-call messages before it are not', () => {
  const reader = new MeetingTurnReader()
  assert.deepEqual(reader.consume(user('Review this')), { content: 'Review this', desktop: false })
  reader.consume(assistant({ content: 'I will look at the files.', phase: 'commentary', toolRequests: [{ id: 't' }] }))
  reader.consume(record('assistant.turn_end', { turnId: '1' }))
  reader.consume(assistant({ content: 'Step 2 is racy.', phase: 'final_answer', toolRequests: [] }))
  reader.consume(assistant({ content: '', toolRequests: [] }))
  assert.deepEqual(reader.finish(), { content: 'Review this', desktop: false, reply: 'Step 2 is racy.' })
  assert.equal(reader.finish(), null, 'reported once')
})

test('without a phase (older CLIs) the reply is the last message with text and no tool requests', () => {
  const reader = new MeetingTurnReader()
  reader.consume(user('Review this'))
  reader.consume(assistant({ content: 'Looking.', toolRequests: [{ id: 't' }] }))
  reader.consume(assistant({ content: 'First thought.', toolRequests: [] }))
  reader.consume(assistant({ content: 'Final answer.' }))
  assert.equal(reader.finish()?.reply, 'Final answer.')
})

test('the prompt the desktop typed is marked as the desktop\'s; the next one the person types is not', () => {
  const reader = new MeetingTurnReader()
  reader.expectDesktopPrompt()
  assert.equal(reader.consume(user('[Pasted text] ...'))?.desktop, true, 'by expectation, whatever the CLI recorded')
  assert.equal(reader.answeringPerson, false)
  reader.finish()
  assert.equal(reader.consume(user('join meeting K7QF', 'i2'))?.desktop, false)
  assert.equal(reader.answeringPerson, true)
  assert.equal(reader.consume(user('[meeting K7QF · round 1 · from the desktop]\n...', 'i3'))?.desktop, true, 'by its marker')
})

test('subagent records, other interactions and unreadable lines are ignored; chunked messages are joined', () => {
  const reader = new MeetingTurnReader()
  reader.consume(user('Review this'))
  reader.consume(record('assistant.message', { content: 'subagent', phase: 'final_answer', interactionId: 'i1' }, { agentId: 'a1' }))
  reader.consume(record('assistant.message', { content: 'nested', phase: 'final_answer', interactionId: 'i1', parentToolCallId: 't' }))
  reader.consume(record('assistant.message', { content: 'other', phase: 'final_answer', interactionId: 'i9' }))
  reader.consume('{not json')
  reader.consume(assistant({ content: 'world', phase: 'final_answer', messageId: 'm', chunkIndex: 1, chunkCount: 2 }))
  reader.consume(assistant({ content: 'hello ', phase: 'final_answer', messageId: 'm', chunkIndex: 0, chunkCount: 2 }))
  assert.equal(reader.finish()?.reply, 'hello world')
})

test('usage totals come from checkpoints, in history too; only history never yields a prompt', () => {
  const reader = new MeetingTurnReader()
  const checkpoint = (nanoAiu: number, premium: number): string => record('session.usage_checkpoint', { totalNanoAiu: nanoAiu, totalPremiumRequests: premium })
  assert.equal(reader.usage, null)
  assert.equal(reader.consume(user('join meeting K7QF'), false), null, 'a prompt in history is not acted on')
  reader.consume(checkpoint(2e9, 1), false)
  assert.deepEqual(reader.usage, { nanoAiu: 2e9, premiumRequests: 1 })
  assert.equal(reader.takeUsageChange(), null, 'history is the baseline, not a change')
  reader.consume(checkpoint(3e9, 1))
  assert.deepEqual(reader.takeUsageChange(), { nanoAiu: 3e9, premiumRequests: 1 })
  assert.equal(reader.takeUsageChange(), null, 'once')
  reader.consume(record('session.usage_checkpoint', { totalNanoAiu: 'lots', totalPremiumRequests: -4 }))
  assert.deepEqual(reader.usage, { nanoAiu: 0, premiumRequests: 0 }, 'unreadable values count as nothing')
})

test('a turn that ends without an answer (aborted) reports an empty reply', () => {
  const reader = new MeetingTurnReader()
  reader.consume(user('Review this'))
  reader.consume(assistant({ content: '', toolRequests: [{ id: 't' }] }))
  assert.equal(reader.finish()?.reply, '')
})

test('rejection diagnostics distinguish history, Desktop turns and idle without including conversation text', () => {
  const reader = new MeetingTurnReader()
  assert.match(reader.startRejection!, /no active user turn observed/)
  reader.consume(user('PRIVATE historical request', 'history'), false)
  assert.equal(reader.answeringPerson, false)
  assert.equal(reader.diagnostic.live, false)
  reader.expectDesktopPrompt()
  reader.consume(user('PRIVATE desktop prompt', 'desktop'))
  assert.match(reader.startRejection!, /Desktop-generated turn/)
  assert.equal(reader.diagnostic.currentInteractionId, 'desktop')
  assert.equal(reader.diagnostic.currentDesktop, true)
  reader.consume(record('assistant.turn_end', { turnId: 't', interactionId: 'desktop' }))
  reader.finish()
  assert.deepEqual(reader.diagnostic.lastClearedCurrent, {
    reason: 'idle', event: { type: 'assistant.turn_end', live: true, eventId: null, interactionId: 'desktop', turnId: 't' },
  })
  assert.match(reader.startRejection!, /no active user turn observed/)
  reader.consume(user('PRIVATE explicit request', 'person'))
  assert.equal(reader.startRejection, null)
  reader.expectDesktopPrompt()
  reader.reset('monitor-attached')
  assert.equal(reader.diagnostic.expectingDesktop, false)
  assert.equal(reader.diagnostic.live, null, 'a new monitor cannot report the old monitor\'s live/history flag')
  assert.equal(reader.answeringPerson, false, 'a replaced monitor cannot retain authorization')
  reader.consume(user('try to start the meeting again', 'next'))
  assert.equal(reader.startRejection, null)
  assert.doesNotMatch(JSON.stringify(reader.diagnostic), /PRIVATE|try to start/)
})
