/**
 * Safety bound once Copilot's destructive cursor-home redraw has begun. The
 * normal path completes as soon as its own copy-status output is parsed.
 */
export const CLIPBOARD_REDRAW_GUARD_MS = 2_000

/** Time to retain an OSC 52 recovery candidate before any redraw starts. */
export const CLIPBOARD_COPY_ARM_MS = 5_000

/**
 * How long a proven copy gesture may wait for Copilot's OSC 52 response.
 * Keep the visual hold short; the independent clipboard gate remains open
 * longer and starts a new synchronized frame if OSC 52 arrives afterward.
 */
export const CLIPBOARD_COPY_GESTURE_MS = 500

/** How recently keyboard selection must have changed before Ctrl+C copies. */
export const NATIVE_KEYBOARD_SELECTION_MS = 2_000

/** Quiet period after Copilot's status before the completed frame is shown. */
export const CLIPBOARD_OUTPUT_SETTLE_MS = 150

/** Minimum mouse travel that identifies a Copilot-owned text selection drag. */
export const NATIVE_SELECTION_DRAG_PX = 4

const MODIFIER_KEYS = new Set([
  'Alt', 'AltGraph', 'CapsLock', 'Control', 'Meta', 'NumLock', 'OS', 'ScrollLock', 'Shift',
])

/** Whether public xterm CSI parameters address the top-left cell. */
export function isCursorHome(params: (number | number[])[]): boolean {
  if (params.length > 2) return false
  return params.every((value) => !Array.isArray(value) && (value === 0 || value === 1))
}

const COPY_STATUS_LINE = /^copied to clipboard$/i
const COPY_HELP_LINE = /^ctrl\+c \/ right-click copy(?:\s+auto)?$/i
const NAVIGATION_LINE = /^(?:←\s*)?open sidebar · \/ commands · \? help · tab next tab(?:\s+auto)?$/i

/**
 * Confirm the known failed Copilot frame from xterm's parsed viewport. This is
 * deliberately narrow: any prompt, response, or streaming content prevents a
 * saved frame from replacing the current terminal. A fully blank viewport is
 * intentionally insufficient evidence because blank/alternate-screen frames
 * are legitimate; restoring one from a stale snapshot causes the regression
 * this guard is designed to prevent.
 */
export function isClipboardOnlyViewport(lines: string[]): boolean {
  let chromeLines = 0
  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/\s+/g, ' ')
    if (line === '') continue
    if (!COPY_STATUS_LINE.test(line) && !COPY_HELP_LINE.test(line) && !NAVIGATION_LINE.test(line)) {
      return false
    }
    chromeLines += 1
  }
  return chromeLines > 0
}

/**
 * Tracks the mouse selection that precedes Copilot's native copy command. This lets
 * Ctrl+C remain an immediate interrupt when no selection was made, while still
 * arming synchronized output before a selected-text copy reaches the PTY.
 */
export class NativeCopyGestureTracker {
  private dragOrigin: { x: number; y: number } | null = null
  private selectionPending = false
  private keyboardSelectionExpiresAt = 0

  constructor(private readonly now: () => number = Date.now) {}

  onMouseDown(button: number, shiftKey: boolean, x: number, y: number, clickCount = 1): void {
    if (button !== 0) return
    if (shiftKey) {
      this.dragOrigin = null
      this.selectionPending = false
      return
    }
    this.dragOrigin = { x, y }
    // Double/triple-clicks select text in the native TUI without any drag.
    // A preceding click clears the old evidence, so record the new selection
    // from the DOM click count rather than relying on mouse travel alone.
    this.selectionPending = clickCount >= 2
    this.keyboardSelectionExpiresAt = 0
  }

  onMouseMove(buttons: number, x: number, y: number): void {
    if (this.dragOrigin === null || (buttons & 1) === 0) return
    this.recordDragDistance(x, y)
  }

  onMouseUp(button: number, x: number, y: number): void {
    if (button !== 0) return
    // Some input paths coalesce mousemove events. The release coordinates are
    // the authoritative fallback, so a real selection drag is still detected.
    this.recordDragDistance(x, y)
    this.dragOrigin = null
  }

  onKeyDown(key: string, shiftKey: boolean): void {
    if (shiftKey && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(key)) {
      this.selectionPending = true
      this.keyboardSelectionExpiresAt = this.now() + NATIVE_KEYBOARD_SELECTION_MS
    } else if (!shiftKey && !MODIFIER_KEYS.has(key)) {
      this.selectionPending = false
      this.keyboardSelectionExpiresAt = 0
    }
  }

  consumeSelection(): boolean {
    if (this.keyboardSelectionExpiresAt > 0 && this.now() > this.keyboardSelectionExpiresAt) {
      this.selectionPending = false
    }
    if (!this.selectionPending) return false
    this.selectionPending = false
    this.keyboardSelectionExpiresAt = 0
    return true
  }

  private recordDragDistance(x: number, y: number): void {
    if (this.dragOrigin === null) return
    if (
      Math.abs(x - this.dragOrigin.x) >= NATIVE_SELECTION_DRAG_PX
      || Math.abs(y - this.dragOrigin.y) >= NATIVE_SELECTION_DRAG_PX
    ) {
      this.selectionPending = true
    }
  }
}

/** Remove Copilot's native blue selection background from a saved frame. */
export function normalizeClipboardSnapshot(snapshot: string): string {
  return snapshot.replace(/\u001b\[([0-9;]*)m/g, (sequence, rawParameters: string) => {
    const parameters = rawParameters === '' ? [0] : rawParameters.split(';').map(Number)
    const normalized: number[] = []
    let removedSelectionBackground = false
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]
      if (parameter === undefined) break
      if (parameter === 48 && parameters[index + 1] === 5 && parameters[index + 2] === 25) {
        removedSelectionBackground = true
        index += 2
      } else if (
        parameter === 48
        && parameters[index + 1] === 2
        && parameters[index + 2] === 38
        && parameters[index + 3] === 79
        && parameters[index + 4] === 120
      ) {
        removedSelectionBackground = true
        index += 4
      } else {
        normalized.push(parameter)
      }
    }
    if (!removedSelectionBackground) return sequence
    normalized.push(49)
    return `\u001b[${normalized.join(';')}m`
  })
}

/** Finish one atomic xterm update, restoring the confirmed failed frame only. */
export function clipboardRedrawOutput(snapshot: string | null): string {
  const restore = snapshot === null ? '' : `\u001b[2J\u001b[H${snapshot}`
  return `${restore}\u001b[?2026l`
}

export interface ClipboardRedrawRecoveryHooks {
  captureSnapshot(): string
  beginSynchronizedOutput(): void
  isViewportCollapsed(): boolean
  completeSynchronizedOutput(snapshot: string | null, showCopyStatus: boolean): void
  schedule(callback: () => void, delayMs: number): number
  cancel(timerId: number): void
}

type ClipboardRedrawPhase = 'ready' | 'gesture' | 'armed' | 'redrawing' | 'settling' | 'done'

/**
 * Coordinates the one first-copy workaround without parsing OSC sequences a
 * second time or restoring a stale terminal snapshot. The user's copy gesture
 * starts synchronized output before Copilot can answer. xterm remains the sole
 * OSC parser, and the latest live buffer is revealed after Copilot's status and
 * subsequent output have settled.
 */
export class ClipboardRedrawRecovery {
  private phase: ClipboardRedrawPhase = 'ready'
  private snapshot: string | null = null
  private erasedLines = 0
  private fullViewportErase = false
  private timerId: number | null = null
  private settleTimerId: number | null = null
  private settleGuardTimerId: number | null = null

  constructor(private readonly hooks: ClipboardRedrawRecoveryHooks) {}

  /** Start the guard before a Ctrl+C or right-button event reaches the PTY. */
  onCopyGesture(): boolean {
    if (this.phase !== 'ready') return false
    this.phase = 'gesture'
    this.snapshot = this.hooks.captureSnapshot()
    this.hooks.beginSynchronizedOutput()
    this.schedule(() => this.finish(false, 'ready'), CLIPBOARD_COPY_GESTURE_MS)
    return true
  }

  onClipboardCopy(): boolean {
    // The clipboard authorization intentionally outlives the short visual
    // gesture hold. If OSC 52 arrives later, begin a fresh synchronized frame
    // at that confirmed-copy boundary before Copilot's destructive redraw.
    if (this.phase === 'ready') {
      this.phase = 'gesture'
      this.snapshot = this.hooks.captureSnapshot()
      this.hooks.beginSynchronizedOutput()
    }
    if (this.phase !== 'gesture') return false
    this.phase = 'armed'
    this.schedule(() => this.finish(false, 'done'), CLIPBOARD_COPY_ARM_MS)
    return true
  }

  onCursorHome(): boolean {
    if (this.phase === 'armed') {
      this.phase = 'redrawing'
      this.erasedLines = 0
      this.schedule(() => this.finish(false, 'done'), CLIPBOARD_REDRAW_GUARD_MS)
      return true
    }
    return false
  }

  /**
   * Count the EL sequence present in the captured failing Copilot trace. Do not
   * treat generic ED/CSI J clears as equivalent: full-screen apps use those for
   * healthy redraws, so they are not copy-specific restoration evidence.
   */
  onEraseLine(viewportRows: number): void {
    if (this.phase !== 'redrawing') return
    this.erasedLines += 1
    if (this.erasedLines >= Math.max(1, viewportRows - 1)) this.fullViewportErase = true
  }

  /** Whether the next parsed frame can contain the copy-status evidence. */
  isAwaitingCopyStatus(): boolean {
    return this.phase === 'armed' || this.phase === 'redrawing'
  }

  /** Called after one PTY output chunk has completed xterm parsing. */
  onOutputParsed(copyStatusRendered: boolean): void {
    if (copyStatusRendered && (this.phase === 'armed' || this.phase === 'redrawing')) {
      this.clearTimer()
      this.phase = 'settling'
      this.scheduleSettle()
      this.settleGuardTimerId = this.hooks.schedule(() => {
        this.settleGuardTimerId = null
        this.completeAfterStatus()
      }, CLIPBOARD_REDRAW_GUARD_MS)
      return
    }
    if (this.phase === 'settling') {
      this.scheduleSettle()
    }
  }

  /** Re-arm the one-shot workaround for a replacement Copilot process. */
  rearm(): void {
    if (this.isActive()) {
      this.hooks.completeSynchronizedOutput(null, false)
    }
    this.reset('ready')
  }

  dispose(): void {
    if (this.isActive()) {
      this.hooks.completeSynchronizedOutput(null, false)
    }
    this.reset('done')
  }

  private schedule(callback: () => void, delayMs: number): void {
    this.clearTimer()
    this.timerId = this.hooks.schedule(() => {
      this.timerId = null
      callback()
    }, delayMs)
  }

  private clearTimer(): void {
    if (this.timerId === null) return
    this.hooks.cancel(this.timerId)
    this.timerId = null
  }

  private isActive(): boolean {
    return this.phase === 'gesture'
      || this.phase === 'armed'
      || this.phase === 'redrawing'
      || this.phase === 'settling'
  }

  private scheduleSettle(): void {
    if (this.settleTimerId !== null) this.hooks.cancel(this.settleTimerId)
    this.settleTimerId = this.hooks.schedule(() => {
      this.settleTimerId = null
      this.completeAfterStatus()
    }, CLIPBOARD_OUTPUT_SETTLE_MS)
  }

  private clearSettleTimers(): void {
    if (this.settleTimerId !== null) this.hooks.cancel(this.settleTimerId)
    if (this.settleGuardTimerId !== null) this.hooks.cancel(this.settleGuardTimerId)
    this.settleTimerId = null
    this.settleGuardTimerId = null
  }

  private completeAfterStatus(): void {
    const snapshot = this.fullViewportErase && this.hooks.isViewportCollapsed()
      ? this.snapshot
      : null
    this.finish(true, 'done', snapshot)
  }

  private finish(
    showCopyStatus: boolean,
    nextPhase: 'ready' | 'done',
    snapshot: string | null = null,
  ): void {
    this.hooks.completeSynchronizedOutput(snapshot, showCopyStatus)
    this.reset(nextPhase)
  }

  private reset(phase: 'ready' | 'done'): void {
    this.clearTimer()
    this.clearSettleTimers()
    this.phase = phase
    this.snapshot = null
    this.erasedLines = 0
    this.fullViewportErase = false
  }
}
