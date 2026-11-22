export interface TerminalOutputChunk { data: string; sequence: number }

/**
 * The history snapshot is rebuilt from output split into lines, so every line ends in a bare LF. The terminal does not
 * turn LF into CR LF (live ConPTY output relies on that), so a replayed line would start where the last one ended.
 */
export function historyLineEndings(data: string): string {
  return data.replace(/\r?\n/g, '\r\n')
}

/** Join an asynchronous history snapshot to the ordered live output stream. */
export class TerminalReplay {
  private sequence: number | null = null
  private pending: TerminalOutputChunk[] = []
  private disposed = false

  constructor(private readonly history: (data: string) => void, private readonly live: (data: string) => void) {}

  push(chunk: TerminalOutputChunk): void {
    if (this.disposed) return
    if (this.sequence === null) { this.pending.push(chunk); return }
    if (chunk.sequence <= this.sequence) return
    this.sequence = chunk.sequence
    this.live(chunk.data)
  }

  restore(snapshot: TerminalOutputChunk): void {
    if (this.disposed || this.sequence !== null) return
    this.sequence = snapshot.sequence
    if (snapshot.data) this.history(snapshot.data)
    const pending = this.pending
    this.pending = []
    for (const chunk of pending) this.push(chunk)
  }

  /**
   * Join the history a request answers. A request that fails has no history to show, but the live output queued while it
   * was pending, and everything after it, must still reach the terminal.
   */
  join(snapshot: Promise<TerminalOutputChunk>): Promise<void> {
    return snapshot.then(value => this.restore(value), () => this.restore({ data: '', sequence: 0 }))
  }

  dispose(): void { this.disposed = true; this.pending = [] }
}
