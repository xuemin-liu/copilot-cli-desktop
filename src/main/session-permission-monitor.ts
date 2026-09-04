import { open, stat } from 'node:fs/promises'
import { parsePermissionChangedEvent, type SessionPermissionMode } from './permission-modes.js'

const READ_CHUNK_BYTES = 64 * 1024
const MAX_PENDING_RECORD_BYTES = 8 * 1024 * 1024

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Tails Copilot's structured session event stream from the point this
 * process attaches. Historical permission events are deliberately ignored;
 * restored tabs already carry their last observed mode in desktop config. */
export class SessionPermissionMonitor {
  private offset = 0
  private pending = Buffer.alloc(0)
  private timer: NodeJS.Timeout | null = null
  private pollPromise: Promise<void> | null = null
  private stopped = false

  constructor(
    private readonly path: string,
    private readonly onMode: (mode: SessionPermissionMode) => void,
    private readonly pollIntervalMs = 250,
  ) {}

  async start(): Promise<void> {
    if (this.stopped || this.timer) return
    try {
      this.offset = (await stat(this.path)).size
    } catch (error) {
      if (!isMissing(error)) throw error
      this.offset = 0
    }
    if (this.stopped) return
    this.timer = setInterval(() => void this.poll().catch(() => {}), this.pollIntervalMs)
    this.timer.unref()
  }

  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pollPromise) return this.pollPromise
    const operation = this.readAppendedEvents()
    this.pollPromise = operation
    void operation.then(() => {
      if (this.pollPromise === operation) this.pollPromise = null
    }, () => {
      if (this.pollPromise === operation) this.pollPromise = null
    })
    return operation
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async readAppendedEvents(): Promise<void> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    if (size < this.offset) {
      this.offset = 0
      this.pending = Buffer.alloc(0)
    }
    if (size === this.offset) return

    const file = await open(this.path, 'r')
    try {
      while (!this.stopped && this.offset < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - this.offset)
        const chunk = Buffer.allocUnsafe(length)
        const { bytesRead } = await file.read(chunk, 0, length, this.offset)
        if (bytesRead === 0) break
        this.offset += bytesRead
        this.consume(Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]))
      }
    } finally {
      await file.close()
    }
  }

  private consume(buffer: Buffer): void {
    let start = 0
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      const mode = parsePermissionChangedEvent(buffer.subarray(start, end).toString('utf8').trim())
      if (mode) this.onMode(mode)
      start = end + 1
    }
    this.pending = Buffer.from(buffer.subarray(start))
    if (this.pending.length > MAX_PENDING_RECORD_BYTES) this.pending = Buffer.alloc(0)
  }
}
