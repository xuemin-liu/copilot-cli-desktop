import assert from 'node:assert/strict'
import test from 'node:test'
import { BracketedPasteTracker, isTerminalReply, sessionTaskBlocker, sessionTaskDecision, taskPasteSequence, dialogOnScreen } from './session-task.js'
import type { SessionTaskState } from './session-task.js'

const ready: SessionTaskState = {
  status: 'running', activity: 'idle', promptVisible: true, preset: 'default', sideChat: false, remote: false,
  draft: false, recentInput: false, picker: false, dialog: false, typing: false, bracketedPaste: true,
}

test('only complete terminal replies preserve an initial recipient; navigation and mixed input do not', () => {
  for (const reply of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[1;1R', '\x1b[?2004;1$y', '\x1b[0n', '\x1b[I\x1b[O',
    '\x1b]11;rgb:0000/aaaa/FFFF\x1b\\', '\x1b]4;3;rgb:ff/ff/ff\x07']) assert.equal(isTerminalReply(reply), true)
  for (const input of ['', '/resume other\r', '\x1b[A', '\x1b[<0;10;20M', '\x1b[?1;2c/resume other\r',
    '\x1b]11;anything\r/resume other\x07', '\x1b[?1;2', '\x1b]11;rgb:0000/0000/0000']) assert.equal(isTerminalReply(input), false)
})

test('a task is sent only when the session is idle and its prompt box is untouched', () => {
  assert.deepEqual(sessionTaskDecision(ready), { result: 'sent' })
  assert.deepEqual(sessionTaskDecision({ ...ready, activity: null }), { result: 'sent' }, 'before the first turn the prompt footer shows it is ready')
  for (const busy of [
    { activity: 'working' as const }, { activity: null, promptVisible: false }, { status: 'approval-needed' as const },
    { draft: true }, { recentInput: true }, { picker: true }, { dialog: true }, { typing: true }, { bracketedPaste: false },
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

test('a task that only asks for an answer (a meeting round) reaches read-only sessions and side chats, never remote ones', () => {
  assert.equal(sessionTaskDecision({ ...ready, preset: 'read-only' }, false).result, 'sent')
  assert.equal(sessionTaskDecision({ ...ready, sideChat: true }, false).result, 'sent')
  assert.equal(sessionTaskDecision({ ...ready, remote: true }, false).result, 'refused')
  assert.equal(sessionTaskDecision({ ...ready, status: 'crashed' }, false).result, 'refused')
})

test('a tab that runs another CLI never takes a task, whether it edits files or only asks for an answer', () => {
  const running = { status: 'running' as const, preset: null, sideChat: false, remote: false }
  for (const needsWrite of [true, false]) {
    assert.match(sessionTaskBlocker({ ...running, cli: 'claude' }, needsWrite) ?? '', /Tasks go to Copilot sessions; this one runs Claude Code/)
    assert.match(sessionTaskBlocker({ ...running, cli: 'codex' }, needsWrite) ?? '', /this one runs Codex CLI/)
  }
  assert.equal(sessionTaskBlocker({ ...running, preset: 'default' }), null)
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

test('a dialog is told by its key hints since the footer, and a missing footer alone proves nothing', () => {
  const footer = '\x1b[1m ← open sidebar\x1b[22m · Interactive · Manual Approval · / commands · ? help · tab next tab     ui-check-model'
  assert.equal(dialogOnScreen(`earlier output\r\n${footer}\x1b[?25h\x1b[12;3H`), false)
  assert.equal(dialogOnScreen('no footer, no hints'), false)
  // Real output: the footer is drawn once more as a dialog opens.
  assert.equal(dialogOnScreen(`${footer}\r\n ❯ ui-check-model ✓ \r\n ❯  Search models…\r\n ● Scanning local providers · ↑/↓ to navigate · enter to select`), true, '/model')
  assert.equal(dialogOnScreen(`${footer}\r\n /model  Select the AI model\r\n↑/↓ scroll · esc close`), true, '/help')
  assert.equal(dialogOnScreen(`${footer}\r\n / search · ↑/↓ navigate · enter open · r refresh`), true, 'the session picker')
  assert.equal(dialogOnScreen(`${footer}\r\n\x1b[3;1Henter\x1b[0m to \x1b[1mselect\x1b[0m · esc to cancel`), true, 'hints split up by colours')
  // Real output of /add-dir: it prints above the prompt and does not draw the footer again.
  assert.equal(dialogOnScreen(`${footer}\r\n ● Added directory to allowed list: C:\\m\\9XHV\r\n${'more printed text '.repeat(40)}\r\n❯`), false, 'a command that only prints')
  assert.equal(dialogOnScreen(`/model · ↑/↓ to navigate\r\n${footer}\r\n❯`), false, 'a dialog closed: the footer came after it')
})
