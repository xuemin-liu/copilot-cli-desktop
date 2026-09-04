import { open, stat } from 'node:fs/promises'
import { parsePermissionChangedEvent, type SessionPermissionMode } from './permission-modes.js'

const READ_CHUNK_BYTES = 64 * 1024
const MAX_PENDING_RECORD_BYTES = 8 * 1024 * 1024

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Streams session history with bounded memory, then tails appended events. */
export class SessionPermissionMonitor {
  private offset = 0
  private pending = Buffer.alloc(0)
  private timer: NodeJS.Timeout | null = null
  private activityTimer: NodeJS.Timeout | null = null
  private pollPromise: Promise<void> | null = null
  private stopped = false
  private discardPartialRecord = false
  private startPromise: Promise<void> | null = null
  private finishPromise: Promise<void> | null = null
  private seeding = true
  private seededMode: SessionPermissionMode | null = null

  constructor(
    private readonly path: string,
    private readonly onMode: (mode: SessionPermissionMode) => void,
    private readonly pollIntervalMs = 5_000,
    private readonly onDiagnostic: (message: string) => void = () => {},
  ) {}

  start(): Promise<void> {
    return this.startPromise ??= this.initialize()
  }

  private async initialize(): Promise<void> {
    if (this.stopped || this.timer) return
    await this.poll()
    this.seeding = false
    if (!this.stopped && this.seededMode) this.onMode(this.seededMode)
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

  finish(): Promise<void> {
    return this.finishPromise ??= (async () => {
      try {
        await this.startPromise
        // An in-flight poll may have captured the file size before the
        // process exited. Complete it, then take one fresh size snapshot.
        await this.pollPromise
        await this.poll()
      } finally {
        this.stop()
      }
    })()
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
      if (mode) {
        if (this.seeding) this.seededMode = mode
        else this.onMode(mode)
      }
      start = end + 1
    }
    this.pending = Buffer.from(buffer.subarray(start))
    if (this.pending.length > MAX_PENDING_RECORD_BYTES) {
      this.pending = Buffer.alloc(0)
      this.discardPartialRecord = true
    }
  }
}
