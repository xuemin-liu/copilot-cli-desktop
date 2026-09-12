export interface TerminalOutputChunk { data: string; sequence: number }

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

  dispose(): void { this.disposed = true; this.pending = [] }
}
