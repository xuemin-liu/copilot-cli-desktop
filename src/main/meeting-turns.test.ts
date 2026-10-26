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

test('a turn that ends without an answer (aborted) reports an empty reply', () => {
  const reader = new MeetingTurnReader()
  reader.consume(user('Review this'))
  reader.consume(assistant({ content: '', toolRequests: [{ id: 't' }] }))
  assert.equal(reader.finish()?.reply, '')
})
