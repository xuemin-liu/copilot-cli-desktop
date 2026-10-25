import { randomBytes } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { isValidSessionId } from './session-id.js'
import { worktreeNamePrefix } from './session-name.js'

/**
 * Finds the id of a session the desktop could not name itself. Copilot CLI refuses `--worktree` together with
 * `--session-id`, so a worktree session picks its own id; the only place it appears is the session store, as a new
 * `<id>/events.jsonl` whose first record is `session.start`. This watches the store for exactly that: a directory that
 * was not there before the spawn, with a start time not before it, running somewhere other than the launch folder.
 *
 * Everything read here is data written by the CLI: only the directory name (which must be a UUID), the record type, its
 * start time and its cwd are looked at, from the first few kilobytes of the file.
 *
 * Ownership is established by the worktree's name: the desktop names the worktree it asks for (`--worktree=<name>`,
 * unique per launch), and only a session whose cwd ends in that folder name is this launch's. Two launches at once, or a
 * session someone starts elsewhere meanwhile, cannot be confused with it.
 */

export interface StoreDiscoveryOptions {
  /** The session store (`copilotSessionRoot`). */
  root: string
  /** Spawn time; a session that started earlier is someone else's. */
  since: number
  /** The folder the process was spawned in. A worktree session runs elsewhere, so a session there is not it. */
  launchCwd: string
  /** The worktree folder name this launch asked for; the session's cwd must end in it. */
  worktreeName: string
  /** Tests replace the directory listing to control its timing. */
  listSessions?(root: string): Promise<Set<string>>
  /** Tests replace the clock and the wait between polls, so the polling schedule does not depend on real time. */
  now?(): number
  sleep?(ms: number): Promise<void>
  pollMs?: number
  /** After this long without a match, look less often: an unnamed session may not be stored for a long time. */
  slowAfterMs?: number
  slowPollMs?: number
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

/** A worktree (and branch) name for a launch: `desktop-<title slug>-<6 hex>`. Only characters git accepts in a branch
 * name, bounded, and unique per launch, so a session's cwd identifies the launch that asked for it. */
export function worktreeNameFor(title: string, random: () => string = () => randomBytes(3).toString('hex')): string {
  return `${worktreeNamePrefix(title)}-${random()}`
}

/** The last path segment, ignoring a trailing separator. */
function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/')) + 1)
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

/** Starts the "already there" snapshot now; await `ready()` before spawning, or the new session could be in it.
 * `find()` resolves with the new session's id, or null when none appeared in time or `cancel()` was called. */
export class SessionStoreDiscovery {
  private readonly baseline: Promise<Set<string>>
  private readonly list: (root: string) => Promise<Set<string>>
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private cancelled = false
  private readonly pollMs: number
  private readonly slowAfterMs: number
  private readonly slowPollMs: number
  private readonly timeoutMs: number
  private readonly slackMs: number

  constructor(private readonly options: StoreDiscoveryOptions) {
    this.list = options.listSessions ?? listSessionIds
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.baseline = this.list(options.root)
    this.pollMs = options.pollMs ?? 500
    this.slowAfterMs = options.slowAfterMs ?? 90_000
    this.slowPollMs = options.slowPollMs ?? 3_000
    this.timeoutMs = options.timeoutMs ?? 90_000
    this.slackMs = options.slackMs ?? 5_000
  }

  /** Resolves once the pre-spawn snapshot is complete. */
  async ready(): Promise<void> {
    await this.baseline
  }

  cancel(): void {
    this.cancelled = true
  }

  async find(): Promise<string | null> {
    const known = new Set(await this.baseline)
    const begun = this.now()
    const deadline = begun + this.timeoutMs
    while (!this.cancelled && this.now() < deadline) {
      for (const id of await this.list(this.options.root)) {
        if (known.has(id)) continue
        const start = await readSessionStart(join(this.options.root, id, 'events.jsonl'))
        if (!start) continue // not written yet, or not a session; look again next poll
        // Decided once per directory: a session that started before the spawn, has no cwd, runs in the launch folder, or
        // runs in any folder but the worktree this launch named, is not ours.
        known.add(id)
        if (start.startTime < this.options.since - this.slackMs) continue
        if (start.cwd === null || sameFolder(start.cwd, this.options.launchCwd)) continue
        if (folderName(start.cwd).toLowerCase() !== this.options.worktreeName.toLowerCase()) continue
        if (this.cancelled) return null
        return id
      }
      await this.sleep(this.now() - begun >= this.slowAfterMs ? this.slowPollMs : this.pollMs)
    }
    return null
  }
}
