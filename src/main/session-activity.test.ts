import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionActivityTracker } from './session-activity.js'

const event = (type: string, data = {}, extra = {}): string => JSON.stringify({ type, data, ...extra })

test('tool-turn completion becomes unknown and only a final root response establishes idle', () => {
  const tracker = new SessionActivityTracker()
  assert.equal(tracker.consume(event('assistant.turn_start', { turnId: '1' })), 'working')
  tracker.consume(event('assistant.message', { content: 'Looking', toolRequests: [{ name: 'bash' }] }))
  tracker.consume(event('tool.execution_start'))
  tracker.consume(event('tool.execution_complete'))
  assert.equal(tracker.consume(event('assistant.turn_end', { turnId: '1' })), null)
  assert.equal(tracker.activity, null)
  assert.equal(tracker.consume(event('assistant.turn_start', { turnId: '2' })), 'working')
  tracker.consume(event('assistant.message', { content: 'Done.' }))
  assert.equal(tracker.consume(event('assistant.turn_end', { turnId: 'wrong' })), undefined)
  assert.equal(tracker.consume(event('assistant.turn_end', { turnId: '2' })), 'idle')
  assert.equal(tracker.consume(event('assistant.turn_start', { turnId: '3' })), 'working')
  assert.equal(tracker.consume(event('abort')), 'idle')
})

test('subagents, malformed records, and historical unfinished turns do not claim completion or current work', () => {
  const tracker = new SessionActivityTracker()
  tracker.consume(event('assistant.turn_start', { turnId: 'main' }))
  for (const extra of [{ agentId: 'child' }, { data: { turnId: 'main', content: 'Done', parentToolCallId: 'tool' } }]) {
    tracker.consume(event('assistant.message', { content: 'Done' }, extra))
    tracker.consume(event('assistant.turn_end', { turnId: 'main' }, extra))
  }
  for (const line of ['null', '[]', '{', event('assistant.message', { toolRequests: 'invalid' })]) tracker.consume(line)
  assert.equal(tracker.activity, 'working')
  assert.equal(tracker.finishReplay(), null)
  assert.equal(tracker.consume(event('assistant.turn_end', { turnId: 'main' })), undefined)
  tracker.consume(event('assistant.turn_start', { turnId: 'new' }))
  tracker.consume(event('assistant.message', { content: 'Finished', toolRequests: [] }))
  tracker.consume(event('assistant.turn_end', { turnId: 'new' }))
  assert.equal(tracker.finishReplay(), 'idle')
})

test('empty, error, and unsupported response shapes clear working when their turn ends', () => {
  const outcomes = [[], [event('session.error', { message: 'Request failed' })], [event('assistant.message', { content: [{ type: 'text', text: 'Done' }] })]]
  for (const records of outcomes) {
    const tracker = new SessionActivityTracker()
    tracker.consume(event('assistant.turn_start', { turnId: '1' }))
    for (const record of records) tracker.consume(record)
    assert.equal(tracker.consume(event('assistant.turn_end', { turnId: '1' })), null)
    assert.equal(tracker.activity, null)
    assert.equal(tracker.consume(event('assistant.turn_end', { turnId: '1' })), undefined)
    assert.equal(tracker.consume(event('assistant.turn_start', { turnId: '2' })), 'working')
  }
})
