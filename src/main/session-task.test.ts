import assert from 'node:assert/strict'
import test from 'node:test'
import { BracketedPasteTracker, sessionTaskDecision, taskPasteSequence } from './session-task.js'
import type { SessionTaskState } from './session-task.js'

const ready: SessionTaskState = {
  status: 'running', activity: 'idle', promptVisible: true, preset: 'default', sideChat: false, remote: false,
  draft: false, recentInput: false, picker: false, typing: false, bracketedPaste: true,
}

test('a task is sent only when the session is idle and its prompt box is untouched', () => {
  assert.deepEqual(sessionTaskDecision(ready), { result: 'sent' })
  assert.deepEqual(sessionTaskDecision({ ...ready, activity: null }), { result: 'sent' }, 'before the first turn the prompt footer shows it is ready')
  for (const busy of [
    { activity: 'working' as const }, { activity: null, promptVisible: false }, { status: 'approval-needed' as const },
    { draft: true }, { recentInput: true }, { picker: true }, { typing: true }, { bracketedPaste: false },
  ]) assert.equal(sessionTaskDecision({ ...ready, ...busy }).result, 'busy', JSON.stringify(busy))
})

test('a session that cannot edit files or run Git here is refused, not pasted into', () => {
  for (const [refused, reason] of [
    [{ preset: 'read-only' as const }, /read-only/], [{ sideChat: true }, /side chat/], [{ remote: true }, /another machine/],
    [{ status: 'starting' as const }, /not running/], [{ status: 'crashed' as const }, /not running/],
  ] as const) {
    const decision = sessionTaskDecision({ ...ready, ...refused })
    assert.equal(decision.result, 'refused')
    assert.match(decision.result === 'refused' ? decision.message : '', reason)
  }
})

test('the task is one bracketed paste that its own text cannot end early', () => {
  assert.equal(taskPasteSequence('one\r\ntwo\rthree'), '\u001b[200~one\ntwo\nthree\u001b[201~')
  assert.equal(taskPasteSequence('a\u001b[201~\rrm -rf\u0003'), '\u001b[200~a[201~\nrm -rf\u001b[201~', 'ESC and Ctrl+C are removed')
  assert.equal(taskPasteSequence('x'.repeat(20_000)).length, 12_000 + 12)
})

test('bracketed paste is tracked across chunks that split the sequence', () => {
  const tracker = new BracketedPasteTracker()
  assert.equal(tracker.on, false)
  tracker.note('banner\u001b[?20')
  tracker.note('04hprompt')
  assert.equal(tracker.on, true)
  tracker.note('output without the sequence')
  assert.equal(tracker.on, true)
  tracker.note('\u001b[?2004l\u001b[?2004h\u001b[?2004l')
  assert.equal(tracker.on, false, 'the last one wins')
})
