import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIPBOARD_COPY_ARM_MS,
  CLIPBOARD_REDRAW_GUARD_MS,
  ClipboardCopyStatusMatcher,
  ClipboardRedrawRecovery,
  clipboardRedrawOutput,
  isCursorHome,
  normalizeClipboardSnapshot,
} from '../renderer/terminal-redraw.js'

class FakeScheduler {
  private now = 0
  private nextId = 1
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()

  schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId
    this.nextId += 1
    this.tasks.set(id, { at: this.now + delayMs, callback })
    return id
  }

  cancel = (id: number): void => {
    this.tasks.delete(id)
  }

  advance(ms: number): void {
    const target = this.now + ms
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (!next) break
      const [id, task] = next
      this.tasks.delete(id)
      this.now = task.at
      task.callback()
    }
    this.now = target
  }
}

test('recognizes only CUP parameters that address the top-left cell', () => {
  assert.equal(isCursorHome([]), true)
  assert.equal(isCursorHome([0]), true)
  assert.equal(isCursorHome([1]), true)
  assert.equal(isCursorHome([1, 1]), true)
  assert.equal(isCursorHome([3, 28]), false)
  assert.equal(isCursorHome([1, 2]), false)
  assert.equal(isCursorHome([[1], 1]), false)
})

test('recognizes a positioned Copilot copy status split across PTY chunks', () => {
  const matcher = new ClipboardCopyStatusMatcher()
  assert.equal(matcher.push('\u001b[?25l\u001b[3;1H copied to clip'), false)
  assert.equal(matcher.push('board      \u001b[46;3H'), true)
  matcher.reset()
  assert.equal(matcher.push('Copilot says it copied to clipboard'), false)
  assert.equal(matcher.push('\u001b[48;1H ctrl+c / right-click copy'), false)
})

test('normalizes Copilot selection backgrounds in a serialized snapshot', () => {
  assert.equal(
    normalizeClipboardSnapshot('a\u001b[38;5;15;48;5;25;1mselected\u001b[49m text'),
    'a\u001b[38;5;15;1;49mselected\u001b[49m text',
  )
  assert.equal(normalizeClipboardSnapshot('\u001b[48;5;24mnot selection'), '\u001b[48;5;24mnot selection')
})

test('restoration clears stale viewport cells and the complete footer row', () => {
  assert.equal(
    clipboardRedrawOutput(48, 'healthy-frame', true),
    '\u001b[2J\u001b[Hhealthy-frame\u001b7\u001b[48;1H\u001b[2Kcopied to clipboard\u001b8\u001b[?2026l',
  )
  assert.equal(clipboardRedrawOutput(48, null, false), '\u001b[?2026l')
})

test('recovers when Copilot delays its destructive copy redraw beyond 100 ms', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const recovery = new ClipboardRedrawRecovery({
    captureSnapshot: () => {
      events.push('capture')
      return 'healthy-frame'
    },
    completeSynchronizedOutput: (snapshot, showCopyStatus) => {
      events.push(`complete:${snapshot ?? 'none'}:${String(showCopyStatus)}`)
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  assert.equal(recovery.prepareClipboardCopy(), true)
  assert.equal(recovery.prepareClipboardCopy(), false)
  assert.equal(recovery.onClipboardCopy(), true)
  scheduler.advance(250)
  assert.deepEqual(events, ['capture'])

  assert.equal(recovery.onCursorHome(), true)
  assert.deepEqual(events, ['capture'])
  assert.equal(recovery.isAwaitingCopyStatus(), true)
  recovery.onOutputParsed(false)
  assert.deepEqual(events, ['capture'])
  recovery.onOutputParsed(true)
  assert.deepEqual(events, ['capture', 'complete:healthy-frame:true'])
})

test('releases synchronized output when an armed copy never redraws', () => {
  const scheduler = new FakeScheduler()
  const completions: Array<{ snapshot: string | null; showCopyStatus: boolean }> = []
  const recovery = new ClipboardRedrawRecovery({
    captureSnapshot: () => 'unused',
    completeSynchronizedOutput: (snapshot, showCopyStatus) => completions.push({ snapshot, showCopyStatus }),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  assert.equal(recovery.prepareClipboardCopy(), true)
  assert.equal(recovery.onClipboardCopy(), true)
  scheduler.advance(CLIPBOARD_COPY_ARM_MS)
  assert.deepEqual(completions, [{ snapshot: null, showCopyStatus: false }])
  assert.equal(recovery.prepareClipboardCopy(), false)
  assert.equal(recovery.onClipboardCopy(), false)
})

test('the redraw guard restores a collapsed viewport if Copilot omits its status', () => {
  const scheduler = new FakeScheduler()
  const completions: Array<{ snapshot: string | null; showCopyStatus: boolean }> = []
  const recovery = new ClipboardRedrawRecovery({
    captureSnapshot: () => 'healthy-frame',
    completeSynchronizedOutput: (snapshot, showCopyStatus) => completions.push({ snapshot, showCopyStatus }),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  recovery.prepareClipboardCopy()
  recovery.onClipboardCopy()
  recovery.onCursorHome()
  scheduler.advance(CLIPBOARD_REDRAW_GUARD_MS)
  assert.deepEqual(completions, [{ snapshot: 'healthy-frame', showCopyStatus: true }])
})

test('re-arms first-copy recovery for a replacement Copilot process', () => {
  const scheduler = new FakeScheduler()
  const completions: Array<{ snapshot: string | null; showCopyStatus: boolean }> = []
  const recovery = new ClipboardRedrawRecovery({
    captureSnapshot: () => 'healthy-frame',
    completeSynchronizedOutput: (snapshot, showCopyStatus) => completions.push({ snapshot, showCopyStatus }),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  assert.equal(recovery.prepareClipboardCopy(), true)
  assert.equal(recovery.onClipboardCopy(), true)
  recovery.rearm()
  assert.deepEqual(completions, [{ snapshot: null, showCopyStatus: false }])
  assert.equal(recovery.prepareClipboardCopy(), true)
  assert.equal(recovery.onClipboardCopy(), true)
})
