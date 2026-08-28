/**
 * Safety bound once Copilot's destructive cursor-home redraw has begun. The
 * normal path completes as soon as its own copy-status output is parsed.
 */
export const CLIPBOARD_REDRAW_GUARD_MS = 2_000

/** Time to retain an OSC 52 recovery candidate before any redraw starts. */
export const CLIPBOARD_COPY_ARM_MS = 5_000

/** How long a copy gesture may wait for Copilot's OSC 52 response. */
export const CLIPBOARD_COPY_GESTURE_MS = 500

/** Quiet period after Copilot's status before the completed frame is shown. */
export const CLIPBOARD_OUTPUT_SETTLE_MS = 150

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
 * saved frame from replacing the current terminal.
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

  /** Count xterm-parsed EL commands after the copy's top-left cursor move. */
  onEraseLine(viewportRows: number): void {
    if (this.phase !== 'redrawing') return
    this.erasedLines += 1
    if (this.erasedLines >= Math.max(1, viewportRows - 1)) this.fullViewportErase = true
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
