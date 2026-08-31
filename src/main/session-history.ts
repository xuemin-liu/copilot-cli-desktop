import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'

const MAX_HISTORY_BYTES = 128 * 1024 * 1024
const MAX_RECORD_BYTES = 8 * 1024 * 1024

/** Keep content/format failures distinct from filesystem failures. */
export class SessionHistoryValidationError extends Error {
  override name = 'SessionHistoryValidationError'
}

/** Bound memory to one record plus a 64 KiB input chunk. Yield between chunks
 * so validation cannot monopolize Electron's terminal/IPC event loop.
 * A snapshot captures a fixed byte boundary and drops only the final partial
 * record; validation of a completed child rejects an incomplete final record.
 */
export async function scanSessionHistory(path: string, sessionId: string, snapshotPath?: string): Promise<{ digest: string; messages: number }> {
  const info = await lstat(path)
  if (!info.isFile()) throw new SessionHistoryValidationError('History must be a regular file')
  const input = await open(path, 'r')
  let output: Awaited<ReturnType<typeof open>> | undefined
  try {
    const { size } = await input.stat()
    if (!size || size > MAX_HISTORY_BYTES) throw new SessionHistoryValidationError('History must contain saved records and be no larger than 128 MiB')
    if (snapshotPath) output = await open(snapshotPath, 'wx')
    const hash = createHash('sha256')
    let messages = 0
    let hasStart = false
    let completeBytes = 0
    let bytesRead = 0
    let parts: Buffer[] = []
    let recordBytes = 0
    const append = (part: Buffer): void => {
      recordBytes += part.length
      if (recordBytes > MAX_RECORD_BYTES) throw new SessionHistoryValidationError('A history record exceeds the 8 MiB safe-fork limit')
      if (part.length) parts.push(part)
    }
    // Let async iteration observe stream-close failures too. The outer
    // finally still covers failures before stream creation and is idempotent.
    const stream = input.createReadStream({ autoClose: true, start: 0, end: size - 1, highWaterMark: 64 * 1024 })
    try {
      for await (const chunk of stream) {
        const buffer = chunk as Buffer
        if (output) await output.writeFile(buffer)
        let start = 0
        for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
          append(buffer.subarray(start, end))
          const line = Buffer.concat(parts, recordBytes).toString('utf8').trim()
          if (line) {
            let event: { type?: string; data?: { sessionId?: string; content?: unknown } }
            try {
              event = JSON.parse(line)
              if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error()
            } catch { throw new SessionHistoryValidationError('History contains a malformed saved record') }
            if (event.type === 'session.start' && event.data?.sessionId === sessionId) hasStart = true
            if (event.type === 'user.message' || event.type === 'assistant.message') {
              // The delimiter is unambiguous: JSON escapes embedded newlines.
              hash.update(JSON.stringify([event.type, event.data?.content]) + '\n')
              messages++
            }
          }
          parts = []
          recordBytes = 0
          start = end + 1
          completeBytes = bytesRead + start
        }
        append(buffer.subarray(start))
        bytesRead += buffer.length
        await setImmediate()
      }
    } finally { stream.destroy() }
    if (!snapshotPath && recordBytes) throw new SessionHistoryValidationError('Fork history ends with an incomplete record')
    if (!hasStart) throw new SessionHistoryValidationError('History has no matching session start record')
    if (output) await output.truncate(completeBytes)
    return { digest: hash.digest('hex'), messages }
  } finally {
    try { await output?.close() }
    finally { await input.close() }
  }
}
