/**
 * Safety bound once Copilot's destructive cursor-home redraw has begun. The
 * normal path completes as soon as its own copy-status output is parsed.
 */
export const CLIPBOARD_REDRAW_GUARD_MS = 2_000

/** Time to retain an OSC 52 recovery candidate before any redraw starts. */
export const CLIPBOARD_COPY_ARM_MS = 5_000

/**
 * Copilot 1.0.80 and 1.0.81 can leave only their copy status line after the
 * first selected-text copy. Avoid disturbing a healthy viewport: request
 * recovery only when a previously substantial screen loses more than two
 * thirds of its visible text.
 */
export function clipboardCopyNeedsRedraw(before: number, after: number): boolean {
  return before >= 40 && after * 3 < before
}

/** Whether public xterm CSI parameters address the top-left cell. */
export function isCursorHome(params: (number | number[])[]): boolean {
  if (params.length > 2) return false
  return params.every((value) => !Array.isArray(value) && (value === 0 || value === 1))
}

/** Identify the final chunk in Copilot's destructive first-copy repaint. */
export function hasClipboardCopyStatus(data: string): boolean {
  return data.toLowerCase().includes('copied to clipboard')
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
  viewportContentLength(): number
  captureSnapshot(): string
  beginSynchronizedOutput(): void
  completeSynchronizedOutput(snapshot: string | null, showCopyStatus: boolean): void
  schedule(callback: () => void, delayMs: number): number
  cancel(timerId: number): void
}

type ClipboardRedrawPhase = 'idle' | 'armed' | 'captured'

/**
 * Coordinates the one first-copy workaround without assuming how long the
 * native clipboard attempt takes. OSC 52 captures the last healthy frame and
 * arms recovery; the actual top-left cursor move starts synchronized output;
 * and Copilot's own status write marks the exact end of the destructive frame.
 */
export class ClipboardRedrawRecovery {
  private firstCopyPending = true
  private phase: ClipboardRedrawPhase = 'idle'
  private contentBeforeCopy = 0
  private snapshot: string | null = null
  private timerId: number | null = null

  constructor(private readonly hooks: ClipboardRedrawRecoveryHooks) {}

  onClipboardCopy(): boolean {
    if (!this.firstCopyPending || this.phase !== 'idle') return false
    this.firstCopyPending = false
    this.contentBeforeCopy = this.hooks.viewportContentLength()
    // Capture before Copilot emits any post-copy cursor movement. In 1.0.81
    // the first cursor-home handler can already observe cells from the damaged
    // frame, so waiting for that boundary preserves the erroneous top status.
    this.snapshot = this.hooks.captureSnapshot()
    this.phase = 'armed'
    this.schedule(() => this.reset(), CLIPBOARD_COPY_ARM_MS)
    return true
  }

  onCursorHome(): boolean {
    if (this.phase !== 'armed') return false
    this.phase = 'captured'
    this.hooks.beginSynchronizedOutput()
    this.schedule(() => this.complete(), CLIPBOARD_REDRAW_GUARD_MS)
    return true
  }

  /** Called after one PTY output chunk has completed xterm parsing. */
  onOutputParsed(copyStatusRendered: boolean): void {
    if (this.phase === 'captured' && copyStatusRendered) this.complete()
  }

  dispose(): void {
    this.clearTimer()
    this.phase = 'idle'
    this.snapshot = null
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
    if (this.phase === 'idle') return
    const needsRedraw = this.phase === 'captured'
      && this.snapshot !== null
      && clipboardCopyNeedsRedraw(this.contentBeforeCopy, this.hooks.viewportContentLength())
    this.hooks.completeSynchronizedOutput(needsRedraw ? this.snapshot : null, needsRedraw)
    this.reset()
  }

  private reset(): void {
    this.clearTimer()
    this.phase = 'idle'
    this.snapshot = null
  }
}
