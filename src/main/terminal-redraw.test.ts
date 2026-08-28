import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIPBOARD_COPY_ARM_MS,
  CLIPBOARD_REDRAW_GUARD_MS,
  ClipboardRedrawRecovery,
  clipboardCopyNeedsRedraw,
  clipboardRedrawOutput,
  hasClipboardCopyStatus,
  isCursorHome,
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

test('requests recovery when a populated viewport collapses to a copy status line', () => {
  assert.equal(clipboardCopyNeedsRedraw(240, 19), true)
})

test('leaves a normally updated viewport alone', () => {
  assert.equal(clipboardCopyNeedsRedraw(240, 235), false)
  assert.equal(clipboardCopyNeedsRedraw(60, 25), false)
})

test('does not treat a naturally sparse viewport as a failed redraw', () => {
  assert.equal(clipboardCopyNeedsRedraw(30, 5), false)
})

test('recognizes only CUP parameters that address the top-left cell', () => {
  assert.equal(isCursorHome([]), true)
  assert.equal(isCursorHome([0]), true)
  assert.equal(isCursorHome([1]), true)
  assert.equal(isCursorHome([1, 1]), true)
  assert.equal(isCursorHome([3, 28]), false)
  assert.equal(isCursorHome([1, 2]), false)
  assert.equal(isCursorHome([[1], 1]), false)
})

test('recognizes Copilot copy-status output without depending on ANSI placement', () => {
  assert.equal(hasClipboardCopyStatus('\u001b[3;1H copied to clipboard      '), true)
  assert.equal(hasClipboardCopyStatus('\u001b[3;1H COPIED TO CLIPBOARD'), true)
  assert.equal(hasClipboardCopyStatus('\u001b[48;1H ctrl+c / right-click copy'), false)
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
  let viewportLength = 240
  const recovery = new ClipboardRedrawRecovery({
    viewportContentLength: () => viewportLength,
    captureSnapshot: () => {
      events.push('capture')
      return 'healthy-frame'
    },
    beginSynchronizedOutput: () => events.push('begin'),
    completeSynchronizedOutput: (snapshot, showCopyStatus) => {
      events.push(`complete:${snapshot ?? 'none'}:${String(showCopyStatus)}`)
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  assert.equal(recovery.onClipboardCopy(), true)
  scheduler.advance(250)
  assert.deepEqual(events, ['capture'])

  assert.equal(recovery.onCursorHome(), true)
  assert.deepEqual(events, ['capture', 'begin'])
  viewportLength = 19
  recovery.onOutputParsed(false)
  assert.deepEqual(events, ['capture', 'begin'])
  recovery.onOutputParsed(true)
  assert.deepEqual(events, ['capture', 'begin', 'complete:healthy-frame:true'])
})

test('expires an armed healthy copy without entering synchronized output', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const completions: Array<{ snapshot: string | null; showCopyStatus: boolean }> = []
  const recovery = new ClipboardRedrawRecovery({
    viewportContentLength: () => 240,
    captureSnapshot: () => 'unused',
    beginSynchronizedOutput: () => events.push('begin'),
    completeSynchronizedOutput: (snapshot, showCopyStatus) => completions.push({ snapshot, showCopyStatus }),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  assert.equal(recovery.onClipboardCopy(), true)
  scheduler.advance(CLIPBOARD_COPY_ARM_MS)
  assert.deepEqual(events, [])
  assert.deepEqual(completions, [])
  assert.equal(recovery.onClipboardCopy(), false)
})

test('the redraw guard restores a collapsed viewport if Copilot omits its status', () => {
  const scheduler = new FakeScheduler()
  let viewportLength = 240
  const completions: Array<{ snapshot: string | null; showCopyStatus: boolean }> = []
  const recovery = new ClipboardRedrawRecovery({
    viewportContentLength: () => viewportLength,
    captureSnapshot: () => 'healthy-frame',
    beginSynchronizedOutput: () => {},
    completeSynchronizedOutput: (snapshot, showCopyStatus) => completions.push({ snapshot, showCopyStatus }),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  recovery.onClipboardCopy()
  recovery.onCursorHome()
  viewportLength = 19
  scheduler.advance(CLIPBOARD_REDRAW_GUARD_MS)
  assert.deepEqual(completions, [{ snapshot: 'healthy-frame', showCopyStatus: true }])
})
