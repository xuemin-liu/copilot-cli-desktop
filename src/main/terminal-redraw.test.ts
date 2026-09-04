import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIPBOARD_COPY_ARM_MS,
  CLIPBOARD_COPY_GESTURE_MS,
  CLIPBOARD_OUTPUT_SETTLE_MS,
  CLIPBOARD_REDRAW_GUARD_MS,
  NATIVE_KEYBOARD_SELECTION_MS,
  ClipboardRedrawRecovery,
  NativeCopyGestureTracker,
  clipboardRedrawOutput,
  findClipboardFooterRow,
  isClipboardOnlyViewport,
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

function createRecovery(
  scheduler: FakeScheduler,
  events: string[],
  collapsed: { value: boolean } = { value: false },
): ClipboardRedrawRecovery {
  return new ClipboardRedrawRecovery({
    captureSnapshot: () => {
      events.push('capture')
      return 'healthy-frame'
    },
    beginSynchronizedOutput: () => events.push('begin'),
    isViewportCollapsed: () => collapsed.value,
    completeSynchronizedOutput: (snapshot, showCopyStatus) => {
      events.push(`complete:${snapshot ?? 'none'}:${String(showCopyStatus)}`)
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })
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

test('recognizes only the collapsed copy/status viewport', () => {
  assert.equal(isClipboardOnlyViewport([
    '',
    ' copied to clipboard ',
    '',
    '← open sidebar · / commands · ? help · tab next tab                         Auto',
  ]), true)
  assert.equal(isClipboardOnlyViewport(['', 'ctrl+c / right-click copy']), true)
  assert.equal(isClipboardOnlyViewport(['', '']), false)
  assert.equal(isClipboardOnlyViewport(['copied to clipboard', 'new streamed response']), false)
})

test('finds the native footer row with model suffixes and wrapped footer text', () => {
  assert.equal(findClipboardFooterRow(['prompt', '', ' ctrl+c / right-click copy     model-name']), 2)
  assert.equal(findClipboardFooterRow(['prompt', '', ' ← open sidebar · / commands · ? help · tab next tab', 'model-name']), 2)
  assert.equal(findClipboardFooterRow(['prompt', '', 'open sidebar · / commands · ? help · tab next tab   Auto']), 2)
})

test('does not guess a footer from the collapsed status or ordinary content', () => {
  assert.equal(findClipboardFooterRow(['copied to clipboard', '', '']), null)
  assert.equal(findClipboardFooterRow(['ctrl+c / right-click copy', '', '', '', 'prompt']), null)
  assert.equal(findClipboardFooterRow(['response', 'Tip: copying text', 'prompt']), null)
  assert.equal(findClipboardFooterRow([]), null)
})

test('arms native drag copy only after an unmodified text-selection drag', () => {
  const tracker = new NativeCopyGestureTracker()

  assert.equal(tracker.consumeSelection(), false)
  tracker.onMouseDown(0, false, 10, 10)
  tracker.onMouseMove(1, 13, 13)
  tracker.onMouseUp(0, 13, 13)
  assert.equal(tracker.consumeSelection(), false)

  tracker.onMouseDown(0, false, 10, 10)
  tracker.onMouseMove(1, 15, 10)
  tracker.onMouseUp(0, 15, 10)
  assert.equal(tracker.consumeSelection(), true)
  assert.equal(tracker.consumeSelection(), false)

  tracker.onMouseDown(0, true, 10, 10)
  tracker.onMouseMove(1, 20, 10)
  tracker.onMouseUp(0, 20, 10)
  assert.equal(tracker.consumeSelection(), false)

  tracker.onMouseDown(0, false, 10, 10)
  tracker.onMouseUp(0, 20, 10)
  assert.equal(tracker.consumeSelection(), true)
})

test('arms native copy for double/triple-click selections without mouse travel', () => {
  for (const clickCount of [2, 3]) {
    const tracker = new NativeCopyGestureTracker()
    tracker.onMouseDown(0, false, 10, 10, clickCount)
    tracker.onMouseUp(0, 10, 10)
    tracker.onKeyDown('Control', false)
    assert.equal(tracker.consumeSelection(), true)
    assert.equal(tracker.consumeSelection(), false, 'copy authorization remains one-shot')
  }
})

test('drag then double-click does not lose native copy authorization', () => {
  let now = 100
  const tracker = new NativeCopyGestureTracker(() => now)
  tracker.onKeyDown('ArrowLeft', true)
  now += NATIVE_KEYBOARD_SELECTION_MS + 1
  tracker.onMouseDown(0, false, 10, 10)
  tracker.onMouseUp(0, 60, 10)
  for (const clickCount of [1, 2]) {
    tracker.onMouseDown(0, false, 30, 10, clickCount)
    tracker.onMouseUp(0, 30, 10)
  }
  tracker.onKeyDown('Control', false)
  assert.equal(tracker.consumeSelection(), true, 'mouse selection replaces expired keyboard evidence')
})

test('multi-click evidence excludes Shift/xterm and non-left mouse gestures', () => {
  for (const [button, shift] of [[0, true], [1, false], [2, false]] as const) {
    const tracker = new NativeCopyGestureTracker()
    tracker.onMouseDown(button, shift, 10, 10, 2)
    tracker.onMouseUp(button, 10, 10)
    assert.equal(tracker.consumeSelection(), false)
  }
})

test('typing or a later single click clears multi-click evidence', () => {
  const tracker = new NativeCopyGestureTracker()
  tracker.onMouseDown(0, false, 10, 10, 2)
  tracker.onMouseUp(0, 10, 10)
  tracker.onKeyDown('x', false)
  assert.equal(tracker.consumeSelection(), false)
  tracker.onMouseDown(0, false, 10, 10, 3)
  tracker.onMouseUp(0, 10, 10)
  tracker.onMouseDown(0, false, 40, 10, 1)
  tracker.onMouseUp(0, 40, 10)
  assert.equal(tracker.consumeSelection(), false)
})

test('arms native copy after keyboard-driven TUI selection', () => {
  let now = 100
  const tracker = new NativeCopyGestureTracker(() => now)
  tracker.onKeyDown('ArrowLeft', false)
  assert.equal(tracker.consumeSelection(), false)
  tracker.onKeyDown('ArrowLeft', true)
  tracker.onKeyDown('Control', false)
  assert.equal(tracker.consumeSelection(), true)

  tracker.onKeyDown('PageDown', true)
  assert.equal(tracker.consumeSelection(), false)
  tracker.onKeyDown('ArrowUp', true)
  now += NATIVE_KEYBOARD_SELECTION_MS + 1
  assert.equal(tracker.consumeSelection(), false)

  tracker.onKeyDown('ArrowRight', true)
  tracker.onKeyDown('x', false)
  assert.equal(tracker.consumeSelection(), false)

  tracker.onMouseDown(0, false, 10, 10)
  tracker.onMouseUp(0, 20, 10)
  tracker.onKeyDown('CapsLock', false)
  tracker.onKeyDown('NumLock', false)
  tracker.onKeyDown('ScrollLock', false)
  tracker.onKeyDown('Control', false)
  assert.equal(tracker.consumeSelection(), true)
})

test('normalizes Copilot selection backgrounds in a serialized snapshot', () => {
  assert.equal(
    normalizeClipboardSnapshot('a\u001b[38;5;15;48;5;25;1mselected\u001b[49m text'),
    'a\u001b[38;5;15;1;49mselected\u001b[49m text',
  )
  assert.equal(
    normalizeClipboardSnapshot('\u001b[38;2;48;148;255;48;2;38;79;120mselected'),
    '\u001b[38;2;48;148;255;49mselected',
  )
  assert.equal(normalizeClipboardSnapshot('\u001b[48;5;24mnot selection'), '\u001b[48;5;24mnot selection')
})

test('completion restores only a supplied frame before ending synchronized output', () => {
  assert.equal(
    clipboardRedrawOutput('healthy-frame'),
    '\u001b[2J\u001b[Hhealthy-frame\u001b[?2026l',
  )
  assert.equal(clipboardRedrawOutput(null), '\u001b[?2026l')
})

test('restores after xterm confirms a full erase and a collapsed viewport', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const recovery = createRecovery(scheduler, events, { value: true })

  assert.equal(recovery.onCopyGesture(), true)
  assert.equal(recovery.onClipboardCopy(), true)
  scheduler.advance(250)
  assert.equal(recovery.onCursorHome(), true)
  for (let row = 0; row < 47; row += 1) recovery.onEraseLine(48)
  recovery.onOutputParsed(true)
  scheduler.advance(CLIPBOARD_OUTPUT_SETTLE_MS)
  assert.deepEqual(events, ['capture', 'begin', 'complete:healthy-frame:true'])
})

test('does not restore for a generic cursor-home redraw', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const recovery = createRecovery(scheduler, events, { value: true })

  recovery.onCopyGesture()
  recovery.onClipboardCopy()
  recovery.onCursorHome()
  recovery.onEraseLine(48)
  recovery.onOutputParsed(true)
  scheduler.advance(CLIPBOARD_OUTPUT_SETTLE_MS)
  assert.deepEqual(events, ['capture', 'begin', 'complete:none:true'])
})

test('does not restore when live content survives a full erase', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const collapsed = { value: true }
  const recovery = createRecovery(scheduler, events, collapsed)

  recovery.onCopyGesture()
  recovery.onClipboardCopy()
  recovery.onCursorHome()
  for (let row = 0; row < 48; row += 1) recovery.onEraseLine(48)
  recovery.onOutputParsed(true)
  scheduler.advance(CLIPBOARD_OUTPUT_SETTLE_MS - 1)
  collapsed.value = false
  recovery.onOutputParsed(false)
  scheduler.advance(CLIPBOARD_OUTPUT_SETTLE_MS)
  assert.deepEqual(events, ['capture', 'begin', 'complete:none:true'])
})

test('continuous output cannot retain the recovery guard indefinitely', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const recovery = createRecovery(scheduler, events, { value: false })

  recovery.onCopyGesture()
  recovery.onClipboardCopy()
  recovery.onCursorHome()
  recovery.onOutputParsed(true)
  for (let elapsed = 0; elapsed < CLIPBOARD_REDRAW_GUARD_MS; elapsed += 100) {
    scheduler.advance(100)
    recovery.onOutputParsed(false)
  }
  assert.deepEqual(events, ['capture', 'begin', 'complete:none:true'])
})

test('a non-copy gesture times out, releases rendering, and re-arms', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const recovery = createRecovery(scheduler, events)

  recovery.onCopyGesture()
  scheduler.advance(CLIPBOARD_COPY_GESTURE_MS)
  assert.deepEqual(events, ['capture', 'begin', 'complete:none:false'])
  assert.equal(recovery.onCopyGesture(), true)
})

test('a late confirmed clipboard response starts a fresh synchronized frame', () => {
  const scheduler = new FakeScheduler()
  const inWindowEvents: string[] = []
  const inWindow = createRecovery(scheduler, inWindowEvents)

  inWindow.onCopyGesture()
  scheduler.advance(CLIPBOARD_COPY_GESTURE_MS - 1)
  assert.equal(inWindow.onClipboardCopy(), true)
  inWindow.rearm()
  assert.deepEqual(inWindowEvents, ['capture', 'begin', 'complete:none:false'])

  const lateEvents: string[] = []
  const late = createRecovery(scheduler, lateEvents)
  late.onCopyGesture()
  scheduler.advance(CLIPBOARD_COPY_GESTURE_MS)
  assert.equal(late.onClipboardCopy(), true)
  assert.deepEqual(lateEvents, ['capture', 'begin', 'complete:none:false', 'capture', 'begin'])
  late.rearm()
  assert.deepEqual(lateEvents, ['capture', 'begin', 'complete:none:false', 'capture', 'begin', 'complete:none:false'])
})

test('copy status scanning is requested only while a confirmed copy awaits evidence', () => {
  const scheduler = new FakeScheduler()
  const recovery = createRecovery(scheduler, [])

  assert.equal(recovery.isAwaitingCopyStatus(), false)
  recovery.onCopyGesture()
  assert.equal(recovery.isAwaitingCopyStatus(), false)
  recovery.onClipboardCopy()
  assert.equal(recovery.isAwaitingCopyStatus(), true)
  recovery.onCursorHome()
  assert.equal(recovery.isAwaitingCopyStatus(), true)
  recovery.onOutputParsed(true)
  assert.equal(recovery.isAwaitingCopyStatus(), false)
})

test('confirmed copy and redraw timeouts never restore stale content', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const recovery = createRecovery(scheduler, events, { value: true })

  recovery.onCopyGesture()
  recovery.onClipboardCopy()
  scheduler.advance(CLIPBOARD_COPY_ARM_MS)
  assert.deepEqual(events, ['capture', 'begin', 'complete:none:false'])

  const secondEvents: string[] = []
  const second = createRecovery(scheduler, secondEvents, { value: true })
  second.onCopyGesture()
  second.onClipboardCopy()
  second.onCursorHome()
  for (let row = 0; row < 48; row += 1) second.onEraseLine(48)
  scheduler.advance(CLIPBOARD_REDRAW_GUARD_MS)
  assert.deepEqual(secondEvents, ['capture', 'begin', 'complete:none:false'])
})

test('re-arm and disposal always release an active synchronized frame', () => {
  const scheduler = new FakeScheduler()
  const events: string[] = []
  const recovery = createRecovery(scheduler, events)

  recovery.onCopyGesture()
  recovery.onClipboardCopy()
  recovery.rearm()
  assert.deepEqual(events, ['capture', 'begin', 'complete:none:false'])
  assert.equal(recovery.onCopyGesture(), true)
  recovery.dispose()
  assert.deepEqual(events, [
    'capture',
    'begin',
    'complete:none:false',
    'capture',
    'begin',
    'complete:none:false',
  ])
})
