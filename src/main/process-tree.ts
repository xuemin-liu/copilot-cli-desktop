import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startPosixProcessWatchdog } from './posix-process-watchdog.js'
import { windowsSystemExecutable } from './resolve-copilot.js'
import { startWindowsProcessWatchdog, type ProcessWatchdogLease } from './windows-process-watchdog.js'

/** Numeric process ancestry only. Never inspect command lines or process environments. */
export async function ownedProcessIds(rootPid: number): Promise<Set<number>> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return new Set()
  try {
    const result = process.platform === 'win32'
      ? await promisify(execFile)(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })
      : await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5_000, maxBuffer: 1024 * 1024 })
    return processDescendants(result.stdout, rootPid)
  } catch { return new Set() }
}

export function processDescendants(snapshot: string, rootPid: number): Set<number> {
  const parents = new Map<number, number>()
  for (const line of snapshot.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) parents.set(Number(match[1]), Number(match[2]))
  }
  const owned = new Set<number>()
  if (!parents.has(rootPid)) return owned
  owned.add(rootPid)
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, parent] of parents) if (!owned.has(pid) && owned.has(parent)) { owned.add(pid); changed = true }
  }
  return owned
}

/**
 * A child process and everything it starts, on every platform. On Windows the tree is found by `taskkill /T`. Elsewhere a
 * child the desktop owns leads its own process group (`detachedGroup()` when spawning it, or a terminal session), so the
 * group is the tree.
 */

/** Spawn option that makes a child lead its own process group outside Windows. On Windows it would open a console. */
export const detachedGroup = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32'

/** What `killProcessTree` uses outside Windows; replaceable in tests. */
export interface ProcessGroupSystem {
  /** `process.kill`: a negative pid means the process group. Throws when the signal could not be sent. */
  kill(pid: number, signal: NodeJS.Signals): void
  /** Every process with its group, one "pid pgid" pair a line. */
  listGroups(): Promise<string>
}
const posixSystem: ProcessGroupSystem = {
  kill: (pid, signal) => { process.kill(pid, signal) },
  listGroups: async () => (await promisify(execFile)('/bin/ps', ['-axo', 'pid=,pgid='], { timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout,
}

/** The processes of one group in a "pid pgid" listing. */
export function processGroupMembers(snapshot: string, group: number): number[] {
  const members: number[] = []
  for (const line of snapshot.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match && Number(match[2]) === group && Number(match[1]) > 1) members.push(Number(match[1]))
  }
  return members
}

/**
 * The rows of a "pid ppid pgid state" listing for the given processes, as "pid ppid pgid state". Only numbers and the
 * state are read and returned: a command line is never looked at, so nothing of another process is ever reported.
 */
export function processRows(snapshot: string, pids: readonly number[]): string[] {
  const wanted = new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 1))
  const rows: string[] = []
  for (const line of snapshot.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (match && wanted.has(Number(match[1]))) rows.push(`${match[1]} ${match[2]} ${match[3]} ${match[4]}`)
  }
  return rows
}

/** Kill a process and its descendants at once. Resolves when the kill has been sent (Windows: when taskkill finished). */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform, system: ProcessGroupSystem = posixSystem): Promise<void> {
  if (platform === 'win32') {
    return new Promise(resolve => {
      execFile(windowsSystemExecutable('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => resolve())
    })
  }
  return killProcessGroup(pid, system)
}

/** How the last few tree kills outside Windows went, newest last. Read by tests to explain a process that survived one. */
export const groupKillLog: { pid: number; outcome: string; members?: number[] }[] = []
function logged(entry: { pid: number; outcome: string; members?: number[] }): void {
  groupKillLog.push(entry)
  if (groupKillLog.length > 20) groupKillLog.shift()
}

/**
 * Kill a whole process group. One signal to the group does it, when the system accepts it. When the system says the
 * group does not exist, there is nothing left to kill. When it refuses for another reason (a group can hold a process
 * this user may not signal), killing only the leader, as before, would leave the rest running: so the leader is killed
 * at once, then the group's processes are listed and each one found in this group is killed.
 */
async function killProcessGroup(pid: number, system: ProcessGroupSystem): Promise<void> {
  // -1 would mean every process this user may signal, and 0 this process's own group.
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  let refusal: string
  try { system.kill(-pid, 'SIGKILL'); logged({ pid, outcome: 'group signalled' }); return } catch (error) { refusal = String((error as NodeJS.ErrnoException).code ?? error) }
  // No such group: it has ended. Its number may already belong to another process, so nothing more is signalled.
  if (refusal === 'ESRCH') { logged({ pid, outcome: 'no such group' }); return }
  // The group exists, so its number is still its leader's and cannot have gone to another process: the leader is killed
  // now, in the same turn. Listing takes time, and after it only processes the listing shows in this group are killed.
  try { system.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  const members = await system.listGroups().then(snapshot => processGroupMembers(snapshot, pid), () => null)
  logged({ pid, outcome: `group signal refused (${refusal})${members ? '' : ', listing failed'}`, ...(members ? { members } : {}) })
  for (const member of members ?? []) if (member !== pid) { try { system.kill(member, 'SIGKILL') } catch { /* already gone */ } }
}

/** Send a signal to a process group outside Windows, falling back to the process alone when it leads no group. */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // -1 would mean every process this user may signal, and 0 this process's own group.
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  try { process.kill(-pid, signal) } catch {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

/** Kill the child's tree if this process dies first, on every platform. */
export function startProcessWatchdog(pid: number): ProcessWatchdogLease {
  return process.platform === 'win32' ? startWindowsProcessWatchdog(pid) : startPosixProcessWatchdog(pid)
}
