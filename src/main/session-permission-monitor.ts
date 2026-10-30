import { open, stat } from 'node:fs/promises'
import { parsePermissionChangedEvent, type SessionPermissionMode } from './permission-modes.js'
import { sameActivityDetail, type ActivityDetail } from './activity-label.js'
import { SessionActivityTracker, type SessionActivity } from './session-activity.js'

const READ_CHUNK_BYTES = 64 * 1024
const MAX_PENDING_RECORD_BYTES = 8 * 1024 * 1024

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Streams session history with bounded memory, then tails permission and task events. */
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
  private historyBoundary = 0
  private fileIdentity: string | null = null
  private replayingTruncation = false
  private seededMode: SessionPermissionMode | null = null
  private readonly activity = new SessionActivityTracker()
  private lastDetail: ActivityDetail | null = null
  private lastCwd: string | null = null

  constructor(
    private readonly path: string,
    private readonly onMode: (mode: SessionPermissionMode) => void,
    private readonly pollIntervalMs = 5_000,
    private readonly onDiagnostic: (message: string) => void = () => {},
    private readonly onActivity: (activity: SessionActivity | null) => void = () => {},
    private readonly onDetail: (detail: ActivityDetail | null) => void = () => {},
    private readonly onCwd: (cwd: string | null) => void = () => {},
    /** Each complete record, before activity sees it (meetings read the turns and usage). `live` is false while the history
     * the session already had is read, true for records appended since. */
    private readonly onRecord: (line: string, live: boolean) => void = () => {},
    /** true: snapshot existing history; false: a new owned log is live; a byte offset: replay only bytes before it. */
    private readonly replayHistory: boolean | number = true,
    private readonly onReset: (reason: string) => void = () => {},
  ) {}

  /** Bytes read, including a partial record. On rebinding, a record crossing this boundary remains historical. */
  get position(): number { return this.offset }
  get checkpoint(): { position: number; identity: string } | null {
    return this.fileIdentity === null ? null : { position: this.offset, identity: this.fileIdentity }
  }

  start(): Promise<void> {
    return this.startPromise ??= this.initialize()
  }

  private async initialize(): Promise<void> {
    if (this.stopped || this.timer) return
    this.historyBoundary = typeof this.replayHistory === 'number' ? this.replayHistory
      : this.replayHistory ? await stat(this.path).then(info => info.size, error => { if (isMissing(error)) return 0; throw error }) : 0
    this.seeding = this.historyBoundary > 0
    await this.poll()
    this.finishSeeding()
    this.publishDetail()
    this.publishCwd()
    if (this.stopped) return
    this.timer = setInterval(() => {
      void this.poll().catch((error) => this.onDiagnostic(`Permission event poll failed: ${String(error)}`))
    }, this.pollIntervalMs)
    this.timer.unref()
  }

  private finishSeeding(): void {
    if (!this.seeding) return
    this.seeding = false
    if (!this.stopped && this.seededMode) this.onMode(this.seededMode)
    const activity = this.activity.finishReplay()
    if (!this.stopped && activity) this.onActivity(activity)
    this.publishDetail()
    this.publishCwd()
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

  /** Detail changes on every tool start and completion, not only when the coarse activity flips. */
  private publishDetail(): void {
    if (this.seeding || this.stopped) return
    const detail = this.activity.detail
    if (sameActivityDetail(detail, this.lastDetail)) return
    this.lastDetail = detail
    this.onDetail(detail)
  }

  /** The session's folder is published after seeding (history is the truth here) and whenever a later record changes it. */
  private publishCwd(): void {
    if (this.seeding || this.stopped) return
    const cwd = this.activity.sessionCwd
    if (cwd === this.lastCwd) return
    this.lastCwd = cwd
    this.onCwd(cwd)
  }

  private async readAppendedEvents(): Promise<void> {
    let size: number
    let identity: string
    try {
      const info = await stat(this.path)
      size = info.size
      identity = `${info.dev}:${info.ino}`
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    const replaced = this.fileIdentity !== null && this.fileIdentity !== identity
    this.fileIdentity = identity
    if (replaced || size < this.offset) {
      this.offset = 0
      this.pending = Buffer.alloc(0)
      this.discardPartialRecord = false
      this.historyBoundary = size
      this.replayingTruncation = !replaced
      if (replaced) this.seeding = true
      this.activity.reset()
      this.onReset(replaced ? 'event-log-replaced' : 'event-log-truncated')
      if (replaced || !this.seeding) this.onActivity(null)
      this.publishDetail()
      this.publishCwd()
    }
    if (size === this.offset) return

    const file = await open(this.path, 'r')
    try {
      while (!this.stopped && this.offset < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - this.offset)
        const chunk = Buffer.allocUnsafe(length)
        const { bytesRead } = await file.read(chunk, 0, length, this.offset)
        if (bytesRead === 0) break
        const bufferStart = this.offset - this.pending.length
        this.offset += bytesRead
        const data = chunk.subarray(0, bytesRead)
        this.consume(this.pending.length === 0 ? data : Buffer.concat([this.pending, data]), bufferStart)
      }
    } finally {
      this.replayingTruncation = false
      await file.close()
    }
  }

  private consume(buffer: Buffer, bufferStart: number): void {
    if (this.discardPartialRecord) {
      const newline = buffer.indexOf(10)
      if (newline === -1) return
      bufferStart += newline + 1
      buffer = buffer.subarray(newline + 1)
      this.discardPartialRecord = false
    }
    let start = 0
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      const line = buffer.subarray(start, end).toString('utf8').trim()
      const live = bufferStart + start >= this.historyBoundary
      if (live) this.finishSeeding()
      if (line) this.onRecord(line, live)
      // A record that was partial at attachment is still history when its newline arrives later.
      if (!live && !this.seeding && !this.replayingTruncation) { start = end + 1; continue }
      const activity = this.activity.consume(line)
      if (!this.seeding && activity !== undefined) this.onActivity(activity)
      this.publishDetail()
      this.publishCwd()
      const mode = parsePermissionChangedEvent(
        line,
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
      this.activity.reset()
      this.onReset('oversized-event-gap')
      if (!this.seeding) this.onActivity(null)
      this.publishDetail()
      this.publishCwd()
      this.onDiagnostic(`Skipped session event exceeding ${MAX_PENDING_RECORD_BYTES} bytes; task activity is unknown`)
    }
  }
}
