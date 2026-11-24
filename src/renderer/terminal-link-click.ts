// An SGR mouse report, the form Copilot asks the terminal for: ESC [ < code ; column ; row, then M (press, motion) or m (release).
const SGR_MOUSE = /^\u001b\[<(\d+);\d+;\d+([Mm])$/
const BUTTON = 3, MOTION = 32, WHEEL = 64

/**
 * Keeps a click that opens a link from also reaching the CLI.
 *
 * Copilot turns mouse reporting on, so the terminal sends it every press and release. A click on a printed path or URL
 * opens it here, and the same click, reported to Copilot, moves its cursor or redraws its screen under the person's
 * hand. The press is held back until it is known what the gesture is: a release swallows both; a drag is Copilot's own
 * text selection, so the press is sent after all, ahead of the motion.
 */
export class LinkClickGate {
  private overLink = false
  private armed = false
  private primary = false
  private held: string | null = null
  private dragged = false

  /** The pointer entered or left a link. */
  hover(over: boolean): void { this.overLink = over }

  /** A mouse button went down on the terminal. Shift belongs to the terminal's own selection and sends no report. */
  press(button: number, shiftKey: boolean): void {
    // A press still held from a gesture that never finished here belongs to nothing now.
    this.reset()
    this.dragged = false
    this.primary = button === 0 && !shiftKey
    this.armed = this.primary && this.overLink
  }

  /**
   * Whether the gesture that just ended opens the link. Only an undragged primary click qualifies: non-primary buttons
   * (such as right-click Copy), Shift selections, and drags passed on to the CLI never open a link.
   */
  opens(): boolean { return this.primary && !this.dragged }

  /** What to send to the CLI for input the terminal produced. */
  filter(data: string): string[] {
    const report = SGR_MOUSE.exec(data)
    if (!report) return [data]
    const code = Number(report[1]), release = report[2] === 'm'
    const left = (code & BUTTON) === 0 && (code & WHEEL) === 0
    if (this.armed && left && !release && (code & MOTION) === 0) {
      this.armed = false
      this.held = data
      return []
    }
    if (this.held === null) return [data]
    const held = this.held
    this.held = null
    if (left && release) return []
    this.dragged = true
    return [held, data]
  }

  /** Forget a gesture that never finished, such as a press whose release happened outside the window. */
  reset(): void { this.armed = false; this.primary = false; this.held = null }
}
