/**
 * Safety bound once Copilot's destructive cursor-home redraw has begun. The
 * normal path completes as soon as its own copy-status output is parsed.
 */
export const CLIPBOARD_REDRAW_GUARD_MS = 2_000

/** Time to retain an OSC 52 recovery candidate before any redraw starts. */
export const CLIPBOARD_COPY_ARM_MS = 5_000

/** Whether public xterm CSI parameters address the top-left cell. */
export function isCursorHome(params: (number | number[])[]): boolean {
  if (params.length > 2) return false
  return params.every((value) => !Array.isArray(value) && (value === 0 || value === 1))
}

const CLIPBOARD_COPY_STATUS = /\u001b\[\d+;1H[^\u001b\r\n]{0,8}copied to clipboard/i
const COPY_STATUS_CARRY_LENGTH = 96

/**
 * Matches Copilot's positioned copy-status write across arbitrary PTY chunk
 * boundaries. Requiring a CSI row/column move avoids treating ordinary model
 * prose that happens to mention the same phrase as a redraw boundary.
 */
export class ClipboardCopyStatusMatcher {
  private carry = ''

  push(data: string): boolean {
    const candidate = this.carry + data
    const matched = CLIPBOARD_COPY_STATUS.test(candidate)
    this.carry = candidate.slice(-COPY_STATUS_CARRY_LENGTH)
    return matched
  }

  reset(): void {
    this.carry = ''
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
      } else {
        normalized.push(parameter)
      }
    }
    if (!removedSelectionBackground) return sequence
    normalized.push(49)
    return `\u001b[${normalized.join(';')}m`
  })
}

/** Build one atomic xterm update that removes the failed frame completely. */
export function clipboardRedrawOutput(rows: number, snapshot: string | null, showCopyStatus: boolean): string {
  // SerializeAddon writes populated cells but does not erase stale cells where
  // the snapshot was blank. Clear the viewport first so Copilot's erroneous
  // top-row status cannot bleed through the restored frame.
  const restore = snapshot === null ? '' : `\u001b[2J\u001b[H${snapshot}`
  // Clear the footer row before writing the replacement status; otherwise the
  // tail of "ctrl+c / right-click copy" remains after the shorter message.
  const copyStatus = showCopyStatus
    ? `\u001b7\u001b[${rows};1H\u001b[2Kcopied to clipboard\u001b8`
    : ''
  return `${restore}${copyStatus}\u001b[?2026l`
}

export interface ClipboardRedrawRecoveryHooks {
  captureSnapshot(): string
  completeSynchronizedOutput(snapshot: string | null, showCopyStatus: boolean): void
  schedule(callback: () => void, delayMs: number): number
  cancel(timerId: number): void
}

type ClipboardRedrawPhase = 'ready' | 'primed' | 'armed' | 'captured' | 'done'

/**
 * Coordinates the one first-copy workaround without assuming how long the
 * native clipboard attempt takes. OSC 52 captures the last healthy frame and
 * starts synchronized output; the actual top-left cursor move confirms the
 * destructive repaint; and Copilot's own positioned status write marks its
 * exact end.
 */
export class ClipboardRedrawRecovery {
  private phase: ClipboardRedrawPhase = 'ready'
  private snapshot: string | null = null
  private timerId: number | null = null

  constructor(private readonly hooks: ClipboardRedrawRecoveryHooks) {}

  /** Reserve the first-copy workaround before its PTY chunk enters xterm. */
  prepareClipboardCopy(): boolean {
    if (this.phase !== 'ready') return false
    this.phase = 'primed'
    return true
  }

  onClipboardCopy(): boolean {
    if (this.phase !== 'primed') return false
    // Capture before Copilot emits any post-copy cursor movement. The renderer
    // hook normalizes Copilot's selection-only background in this early frame,
    // so recovery preserves content without retaining the selected highlight.
    this.snapshot = this.hooks.captureSnapshot()
    this.phase = 'armed'
    // Synchronized output was inserted directly before this OSC 52 in the PTY
    // stream. Doing it here with terminal.write() would queue the mode change
    // behind the current chunk and allow Copilot's broken frame to flash.
    this.schedule(() => this.finish(null, false), CLIPBOARD_COPY_ARM_MS)
    return true
  }

  onCursorHome(): boolean {
    if (this.phase !== 'armed') return false
    this.phase = 'captured'
    this.schedule(() => this.complete(), CLIPBOARD_REDRAW_GUARD_MS)
    return true
  }

  isAwaitingCopyStatus(): boolean {
    return this.phase === 'captured'
  }

  /** Called after one PTY output chunk has completed xterm parsing. */
  onOutputParsed(copyStatusRendered: boolean): void {
    if (this.phase === 'captured' && copyStatusRendered) this.complete()
  }

  /** Re-arm the one-shot workaround for a replacement Copilot process. */
  rearm(): void {
    if (this.phase === 'primed' || this.phase === 'armed' || this.phase === 'captured') {
      this.hooks.completeSynchronizedOutput(null, false)
    }
    this.reset('ready')
  }

  dispose(): void {
    if (this.phase === 'primed' || this.phase === 'armed' || this.phase === 'captured') {
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

  private complete(): void {
    // Reaching this phase already requires the first valid OSC 52 write, a
    // subsequent top-left cursor move, and either Copilot's positioned copy
    // status or the redraw safety timeout. The old viewport-length heuristic
    // was unreliable because a destroyed frame can retain enough footer text
    // to look "healthy". Restore the known-good snapshot for this specific
    // sequence instead of exposing that intermediate frame.
    this.finish(this.snapshot, this.snapshot !== null)
  }

  private finish(snapshot: string | null, showCopyStatus: boolean): void {
    this.hooks.completeSynchronizedOutput(snapshot, showCopyStatus)
    this.reset('done')
  }

  private reset(phase: 'ready' | 'done'): void {
    this.clearTimer()
    this.phase = phase
    this.snapshot = null
  }
}
