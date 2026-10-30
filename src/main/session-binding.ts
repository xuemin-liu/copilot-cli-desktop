import { open, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidSessionId } from './session-id.js'
import { readSessionStart } from './session-store-discovery.js'
import { ownedProcessIds } from './process-tree.js'
import { visitSessionHistoryLines } from './session-history.js'

export type SessionBinding = { kind: 'bound'; sessionId: string; ownerPid: number; deliveryReady: boolean }
  | { kind: 'unknown' } | { kind: 'unavailable' }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** A CLI can retain several background sessions. The helper supplies COPILOT_AGENT_SESSION_ID as a routing hint;
 * OS ancestry and the CLI's in-use lock verify ownership, then the log's live person-turn guard still decides authorization.
 * No credentials, control-state files, terminal banners, newest-log guesses, or model-supplied paths are used. */
export class SessionBindingReader {
  private ownerPid: number | null = null
  private failure: string | null = null
  constructor(private readonly root: string, private readonly rootPid: number,
    private readonly processes: (pid: number) => Promise<Set<number>> = ownedProcessIds,
    private readonly isAlive: (pid: number) => boolean = alive) {}

  get diagnostic(): { rootPid: number; ownerPid: number | null; failure: string | null } {
    return { rootPid: this.rootPid, ownerPid: this.ownerPid, failure: this.failure }
  }

  private async holds(sessionId: string, pid: number): Promise<boolean> {
    try {
      const directory = join(this.root, sessionId)
      return (await lstat(directory)).isDirectory() && (await lstat(join(directory, `inuse.${pid}.lock`))).isFile()
    } catch { return false }
  }

  private async rootSession(sessionId: string): Promise<boolean> {
    const path = join(this.root, sessionId, 'events.jsonl')
    try {
      if (!(await lstat(path)).isFile()) return false
      const start = await readSessionStart(path)
      if (!start) return false
      // Child/detached sessions are not foreground conversations, even when they share the CLI PID.
      const file = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(4096)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]!)
        return record.data?.sessionId === sessionId && !record.agentId && !record.data?.parentToolCallId
          && !record.data?.detachedFromSpawningParentSessionId
      } finally { await file.close() }
    } catch { return false }
  }

  async read(currentSessionId: string | null, requestSessionId?: string): Promise<SessionBinding> {
    this.failure = null
    if (requestSessionId !== undefined && !isValidSessionId(requestSessionId)) { this.failure = 'invalid-session-id'; return { kind: 'unknown' } }
    if (!this.isAlive(this.rootPid)) { this.failure = 'tab-process-not-running'; return { kind: this.ownerPid === null && requestSessionId === undefined ? 'unavailable' : 'unknown' } }
    if (this.ownerPid === null) {
      const processes = await this.processes(this.rootPid)
      if (!processes.has(this.rootPid)) { this.failure = 'process-tree-unavailable'; return { kind: 'unavailable' } }
      const candidates = []
      if (currentSessionId) for (const pid of processes) if (await this.holds(currentSessionId, pid)) candidates.push(pid)
      // A /resume before the original session's first prompt may leave it without a lock. Verify the actual caller instead.
      if (!candidates.length && requestSessionId) {
        for (const pid of processes) if (await this.holds(requestSessionId, pid)) candidates.push(pid)
        // Without the original-session anchor, a nested CLI must not become the tab's owner merely by sending a hint.
        if (candidates.length === 1) {
          const entries = await readdir(this.root, { withFileTypes: true })
          if (entries.length > 10_000) return { kind: 'unknown' }
          for (const entry of entries) {
            if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue
            for (const pid of processes) {
              if (pid !== candidates[0] && await this.holds(entry.name, pid) && await this.rootSession(entry.name)) {
                this.failure = 'cli-owner-not-unique'
                return { kind: 'unknown' }
              }
            }
          }
        }
      }
      if (candidates.length !== 1) { this.failure = 'cli-owner-not-unique'; return { kind: requestSessionId ? 'unknown' : 'unavailable' } }
      this.ownerPid = candidates[0]!
    }
    const ownerPid = this.ownerPid
    // Pin once for this PTY's lifetime. Repeated CIM launches can time out under load; they must not erase a valid turn.
    // Never adopt a replacement PID after the pinned CLI exits, even if another descendant owns a matching session.
    if (!this.isAlive(this.rootPid) || !this.isAlive(ownerPid)) { this.failure = 'cli-owner-not-running'; return { kind: 'unknown' } }
    // Never guess among multiple sessions or another process's locks.
    const sessions: string[] = []
    const names = await readdir(this.root, { withFileTypes: true })
    if (names.length > 10_000) return { kind: 'unknown' }
    for (let index = 0; index < names.length; index += 16) {
      const matches = await Promise.all(names.slice(index, index + 16).map(async entry => {
        if (!entry.isDirectory() || !isValidSessionId(entry.name) || !await this.holds(entry.name, ownerPid)) return null
        return await this.rootSession(entry.name) ? entry.name : null
      }))
      sessions.push(...matches.filter((id): id is string => id !== null))
    }
    const sessionId = requestSessionId ?? (currentSessionId && sessions.includes(currentSessionId) ? currentSessionId : sessions.length === 1 ? sessions[0] : undefined)
    if (!sessionId || !sessions.includes(sessionId)) { this.failure = 'requested-session-not-owned'; return { kind: 'unknown' } }
    // A tab's terminal input cannot target one of several retained sessions. Pause automatic deliveries in that case.
    return { kind: 'bound', sessionId, ownerPid, deliveryReady: sessions.length === 1 }
  }
}

/** On the first visit to a stored session, only this process's new resume/start epoch can supply live records.
 * Warm switches instead use the last consumed byte offset, so returning cannot replay an old request. */
export async function sessionResumeOffset(path: string, startedAt: number): Promise<number> {
  let resumeOffset: number | null = null
  const snapshot = await visitSessionHistoryLines(path, (line, offset) => {
    let record
    try { record = JSON.parse(line) } catch { return }
    if (!record || record.agentId || record.data?.parentToolCallId) return
    if (record.type !== 'session.resume' && record.type !== 'session.start') return
    const timestamp = record.type === 'session.resume' ? record.data?.resumeTime : record.data?.startTime
    resumeOffset = typeof timestamp === 'string' && Date.parse(timestamp) >= startedAt ? offset : null
  }, { allowPartial: true, allowEmpty: true })
  return resumeOffset ?? snapshot.size
}
