import { open, readdir } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { isValidSessionId } from './session-id.js'

/**
 * Finds the id of a session the desktop could not name itself. Copilot CLI refuses `--worktree` together with
 * `--session-id`, so a worktree session picks its own id; the only place it appears is the session store, as a new
 * `<id>/events.jsonl` whose first record is `session.start`. This watches the store for exactly that: a directory that
 * was not there before the spawn, with a start time not before it, running somewhere other than the launch folder.
 *
 * Everything read here is data written by the CLI: only the directory name (which must be a UUID), the record type, its
 * start time and its cwd are looked at, from the first few kilobytes of the file.
 */

export interface StoreDiscoveryOptions {
  /** The session store (`copilotSessionRoot`). */
  root: string
  /** Spawn time; a session that started earlier is someone else's. */
  since: number
  /** The folder the process was spawned in. A worktree session runs elsewhere, so a session there is not it. */
  launchCwd: string
  pollMs?: number
  timeoutMs?: number
  /** A small tolerance for clocks: the CLI stamps its own time. */
  slackMs?: number
}

const FIRST_RECORD_BYTES = 4_096

export interface SessionStartRecord {
  startTime: number
  cwd: string | null
}

/** The `session.start` record at the head of an events file, or null when the file does not begin with one. */
export async function readSessionStart(path: string): Promise<SessionStartRecord | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(FIRST_RECORD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    if (newline === -1) return null
    const record = JSON.parse(text.slice(0, newline)) as { type?: unknown; data?: { startTime?: unknown; context?: { cwd?: unknown } } }
    if (record?.type !== 'session.start') return null
    const startTime = typeof record.data?.startTime === 'string' ? Date.parse(record.data.startTime) : Number.NaN
    if (!Number.isFinite(startTime)) return null
    const cwd = record.data?.context?.cwd
    return { startTime, cwd: typeof cwd === 'string' ? cwd : null }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function sameFolder(left: string, right: string): boolean {
  return win32.resolve(left).replace(/[\\/]+$/, '').toLowerCase() === win32.resolve(right).replace(/[\\/]+$/, '').toLowerCase()
}

async function listSessionIds(root: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(root)).filter((name) => isValidSessionId(name)))
  } catch {
    return new Set()
  }
}

/** Takes the "already there" snapshot now; `find()` resolves with the new session's id, or null when none appeared in
 * time or `cancel()` was called. */
export class SessionStoreDiscovery {
  private readonly baseline: Promise<Set<string>>
  private cancelled = false
  private readonly pollMs: number
  private readonly timeoutMs: number
  private readonly slackMs: number

  constructor(private readonly options: StoreDiscoveryOptions) {
    this.baseline = listSessionIds(options.root)
    this.pollMs = options.pollMs ?? 500
    this.timeoutMs = options.timeoutMs ?? 90_000
    this.slackMs = options.slackMs ?? 5_000
  }

  cancel(): void {
    this.cancelled = true
  }

  async find(): Promise<string | null> {
    const known = new Set(await this.baseline)
    const deadline = Date.now() + this.timeoutMs
    while (!this.cancelled && Date.now() < deadline) {
      for (const id of await listSessionIds(this.options.root)) {
        if (known.has(id)) continue
        const start = await readSessionStart(join(this.options.root, id, 'events.jsonl'))
        if (!start) continue // not written yet, or not a session; look again next poll
        // Decided once per directory: a session that started before the spawn, or runs in the launch folder, is not ours.
        known.add(id)
        if (start.startTime < this.options.since - this.slackMs) continue
        if (start.cwd !== null && sameFolder(start.cwd, this.options.launchCwd)) continue
        if (this.cancelled) return null
        return id
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
    }
    return null
  }
}
