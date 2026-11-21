import { LogAppender } from './log-appender.js'
import { truncateUtf8 } from './utf8.js'

export const MAX_SESSION_LOG_BYTES = 5 * 1024 * 1024

interface Appender { append(filename: string, text: string): Promise<void> }

/**
 * The on-disk transcript of each session's terminal output. Chunks of one session are written one at a time, in the
 * order they arrived, and a session's file stops growing at a byte limit, with one line saying so.
 */
export class SessionLogs {
  private readonly written = new Map<string, number>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly pathFor: (tabId: string) => string,
    private readonly maxBytes = MAX_SESSION_LOG_BYTES,
    private readonly appender: Appender = new LogAppender(),
  ) {}

  /** Queue one chunk behind the session's earlier ones. The promise reports this chunk's own failure. */
  write(tabId: string, chunk: string): Promise<void> {
    const previous = this.queues.get(tabId) ?? Promise.resolve()
    const operation = previous.then(() => this.append(tabId, chunk))
    const tracked = operation.catch(() => undefined)
    this.queues.set(tabId, tracked)
    void tracked.finally(() => {
      if (this.queues.get(tabId) === tracked) this.queues.delete(tabId)
    })
    return operation
  }

  /** Everything queued for the session so far has been written, or has failed. */
  async settled(tabId: string): Promise<void> {
    await this.queues.get(tabId)
  }

  /** The session is closed: a later session with the same tab id starts counting from nothing. */
  forget(tabId: string): void {
    this.written.delete(tabId)
  }

  private async append(tabId: string, chunk: string): Promise<void> {
    const written = this.written.get(tabId) ?? 0
    if (written >= this.maxBytes) return
    const filename = this.pathFor(tabId)
    const chunkBytes = Buffer.byteLength(chunk, 'utf8')
    if (written + chunkBytes <= this.maxBytes) {
      await this.appender.append(filename, chunk)
      this.written.set(tabId, written + chunkBytes)
      return
    }
    const truncated = truncateUtf8(chunk, this.maxBytes - written)
    await this.appender.append(filename, `${truncated}\n[log truncated at ${this.maxBytes} bytes]\n`)
    this.written.set(tabId, this.maxBytes)
  }
}
