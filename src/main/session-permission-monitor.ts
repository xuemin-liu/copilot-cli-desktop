import { open, stat } from 'node:fs/promises'
import { parsePermissionChangedEvent, type SessionPermissionMode } from './permission-modes.js'

const READ_CHUNK_BYTES = 64 * 1024
const MAX_PENDING_RECORD_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_BYTES = 8 * 1024 * 1024

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Tails Copilot's structured session event stream. Startup replays a bounded
 * suffix so sessions discovered after launch and resumed sessions are seeded
 * from Copilot's own durable state rather than desktop timing. */
export class SessionPermissionMonitor {
  private offset = 0
  private pending = Buffer.alloc(0)
  private timer: NodeJS.Timeout | null = null
  private activityTimer: NodeJS.Timeout | null = null
  private pollPromise: Promise<void> | null = null
  private stopped = false
  private discardPartialRecord = false

  constructor(
    private readonly path: string,
    private readonly onMode: (mode: SessionPermissionMode) => void,
    private readonly pollIntervalMs = 5_000,
    private readonly onDiagnostic: (message: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    if (this.stopped || this.timer) return
    try {
      const size = (await stat(this.path)).size
      this.offset = Math.max(0, size - MAX_HISTORY_BYTES)
      this.discardPartialRecord = this.offset > 0
    } catch (error) {
      if (!isMissing(error)) throw error
      this.offset = 0
    }
    if (this.stopped) return
    await this.poll()
    if (this.stopped) return
    this.timer = setInterval(() => {
      void this.poll().catch((error) => this.onDiagnostic(`Permission event poll failed: ${String(error)}`))
    }, this.pollIntervalMs)
    this.timer.unref()
  }

  notifyActivity(): void {
    if (this.stopped) return
    if (this.activityTimer) clearTimeout(this.activityTimer)
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null
      void this.poll().catch((error) => this.onDiagnostic(`Permission event poll failed: ${String(error)}`))
    }, 75)
    this.activityTimer.unref()
  }

  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.pollPromise ??= this.readAppendedEvents().finally(() => {
      this.pollPromise = null
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.activityTimer) clearTimeout(this.activityTimer)
    this.timer = null
    this.activityTimer = null
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
      this.discardPartialRecord = false
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
        const data = chunk.subarray(0, bytesRead)
        this.consume(this.pending.length === 0 ? data : Buffer.concat([this.pending, data]))
      }
    } finally {
      await file.close()
    }
  }

  private consume(buffer: Buffer): void {
    if (this.discardPartialRecord) {
      const newline = buffer.indexOf(10)
      if (newline === -1) return
      buffer = buffer.subarray(newline + 1)
      this.discardPartialRecord = false
    }
    let start = 0
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      const mode = parsePermissionChangedEvent(
        buffer.subarray(start, end).toString('utf8').trim(),
        (payload) => this.onDiagnostic(`Unknown session.permissions_changed payload: ${JSON.stringify(payload)}`),
      )
      if (mode) this.onMode(mode)
      start = end + 1
    }
    this.pending = Buffer.from(buffer.subarray(start))
    if (this.pending.length > MAX_PENDING_RECORD_BYTES) this.pending = Buffer.alloc(0)
  }
}
