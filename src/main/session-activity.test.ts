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

const stamped = (type: string, data: object, timestamp: string | undefined, extra = {}): string => JSON.stringify({ type, data, timestamp, ...extra })
// strict assert.equal narrows the `tracker.detail` property path; read through a call so later checks see the union again.
const detailOf = (tracker: SessionActivityTracker) => tracker.detail
const toolsOf = (tracker: SessionActivityTracker) => { const detail = tracker.detail; return detail?.kind === 'tools' ? detail.tools : [] }

test('detail tracks overlapping tools by call id, falls back to thinking between tools, and clears at turn end', () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0)
  const at = (ms: number) => new Date(now - ms).toISOString()
  const tracker = new SessionActivityTracker(() => now)
  assert.equal(tracker.detail, null)
  tracker.consume(stamped('assistant.turn_start', { turnId: '1' }, at(10_000)))
  assert.deepEqual(tracker.detail, { kind: 'thinking', since: now - 10_000 })
  tracker.consume(stamped('tool.execution_start', { toolCallId: 'a', toolName: 'powershell', arguments: { command: 'secret', description: 'secret' } }, at(8_000)))
  tracker.consume(stamped('tool.execution_start', { toolCallId: 'b', toolName: 'view', arguments: { path: 'D:\\repo\\src\\x.ts' } }, at(6_000)))
  assert.deepEqual(tracker.detail, {
    kind: 'tools', since: now - 8_000,
    tools: [{ title: 'Running command', detail: null }, { title: 'Viewing', detail: 'x.ts' }],
  })
  assert.ok(!JSON.stringify(tracker.detail).includes('secret'), 'shell arguments never reach the detail')
  tracker.consume(stamped('tool.execution_complete', { toolCallId: 'a' }, at(5_000)))
  assert.deepEqual(tracker.detail, { kind: 'tools', since: now - 6_000, tools: [{ title: 'Viewing', detail: 'x.ts' }] }, 'the clock follows the earliest tool still running')
  tracker.consume(stamped('tool.execution_complete', { toolCallId: 'unknown' }, at(4_500)))
  assert.equal(detailOf(tracker)?.kind, 'tools', 'completing an untracked id changes nothing')
  tracker.consume(stamped('tool.execution_complete', { toolCallId: 'b' }, at(4_000)))
  assert.deepEqual(tracker.detail, { kind: 'thinking', since: now - 4_000 })
  tracker.consume(stamped('tool.execution_start', { toolCallId: 'b' }, at(3_000)))
  assert.deepEqual(tracker.detail, { kind: 'tools', since: now - 3_000, tools: [{ title: 'Running tool', detail: null }] }, 'a reused id is a new tool once the old one completed')
  tracker.consume(stamped('assistant.message', { content: 'Done' }, at(2_000)))
  tracker.consume(stamped('assistant.turn_end', { turnId: '1' }, at(1_000)))
  assert.equal(tracker.detail, null)
  assert.equal(tracker.activity, 'idle')
})

test('detail ignores sub-agent and out-of-turn tool records, bounds the running set, and strips bidi text', () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0)
  const tracker = new SessionActivityTracker(() => now)
  tracker.consume(stamped('tool.execution_start', { toolCallId: 'early', toolName: 'view', arguments: { path: 'a.ts' } }, undefined))
  assert.equal(tracker.detail, null, 'a tool outside any turn is not current work')
  tracker.consume(stamped('assistant.turn_start', { turnId: 'main' }, undefined))
  tracker.consume(stamped('tool.execution_start', { toolCallId: 'child', toolName: 'view', arguments: { path: 'child.ts' } }, undefined, { agentId: 'sub' }))
  tracker.consume(stamped('tool.execution_start', { toolCallId: 'nested', toolName: 'view', arguments: { path: 'nested.ts' }, parentToolCallId: 'p' }, undefined))
  tracker.consume(stamped('tool.execution_start', { toolCallId: '', toolName: 'view', arguments: { path: 'blank.ts' } }, undefined))
  tracker.consume(stamped('tool.execution_start', { toolCallId: 7, toolName: 'view', arguments: { path: 'number.ts' } }, undefined))
  assert.deepEqual(tracker.detail, { kind: 'thinking', since: now })
  for (let index = 0; index < 20; index += 1) {
    tracker.consume(stamped('tool.execution_start', { toolCallId: `t${index}`, toolName: 'view', arguments: { path: `\u202E${index}.ts\u200B` } }, 'not a date'))
  }
  assert.equal(detailOf(tracker)?.kind, 'tools')
  assert.equal(toolsOf(tracker).length, 16)
  assert.equal(detailOf(tracker)?.since, now, 'an unparsable timestamp falls back to the clock')
  assert.ok(toolsOf(tracker).length > 0 && toolsOf(tracker).every((tool) => /^\d+\.ts$/.test(tool.detail ?? '')), 'bidi and zero-width characters are stripped')
  tracker.consume(stamped('tool.execution_complete', { toolCallId: 't19' }, undefined))
  assert.equal(toolsOf(tracker).length, 16, 'a tool dropped by the bound cannot be completed')
  assert.equal(tracker.finishReplay(), null)
  assert.equal(tracker.detail, null, 'historical running tools are not current work')
  tracker.consume(stamped('assistant.turn_start', { turnId: 'again' }, undefined))
  tracker.consume(stamped('tool.execution_start', { toolCallId: 'x', toolName: 'rg', arguments: { pattern: 'p' } }, undefined))
  assert.equal(detailOf(tracker)?.kind, 'tools')
  tracker.consume(stamped('abort', {}, undefined))
  assert.equal(tracker.detail, null)
  tracker.consume(stamped('assistant.turn_start', { turnId: 'reset' }, undefined))
  tracker.reset()
  assert.equal(tracker.detail, null)
})

test('the session folder follows the latest start or resume record, is bounded, and survives replay but not a reset', () => {
  const tracker = new SessionActivityTracker()
  assert.equal(tracker.sessionCwd, null)
  tracker.consume(stamped('session.start', { context: { cwd: 'D:\\repo' } }, undefined))
  assert.equal(tracker.sessionCwd, 'D:\\repo')
  tracker.consume(stamped('session.resume', { context: { cwd: 'D:\\repo.worktrees\\desktop-x' } }, undefined))
  assert.equal(tracker.sessionCwd, 'D:\\repo.worktrees\\desktop-x')
  tracker.consume(stamped('session.resume', { context: { cwd: 7 } }, undefined))
  tracker.consume(stamped('session.resume', { context: {} }, undefined))
  tracker.consume(stamped('session.resume', { context: { cwd: 'x'.repeat(5_000) } }, undefined))
  assert.equal(tracker.sessionCwd, 'D:\\repo.worktrees\\desktop-x', 'bad or oversized values change nothing')
  tracker.consume(stamped('session.start', { context: { cwd: 'D:\\sub' } }, undefined, { agentId: 'child' }))
  assert.equal(tracker.sessionCwd, 'D:\\repo.worktrees\\desktop-x', 'a sub-agent record is not the session')
  assert.equal(tracker.finishReplay(), null)
  assert.equal(tracker.sessionCwd, 'D:\\repo.worktrees\\desktop-x', 'history is the truth about where the session runs')
  tracker.reset()
  assert.equal(tracker.sessionCwd, null)
})
