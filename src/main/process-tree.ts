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

/** Kill a process and its descendants at once. Resolves when the kill has been sent (Windows: when taskkill finished). */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform, system: ProcessGroupSystem = posixSystem): Promise<void> {
  if (platform === 'win32') {
    return new Promise(resolve => {
      execFile(windowsSystemExecutable('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => resolve())
    })
  }
  return killProcessGroup(pid, system)
}

/**
 * Kill a whole process group. One signal to the group does it, when the system accepts it. It does not always: macOS
 * refuses to signal a group that holds a process which has exited and not been collected yet, and then nothing in the
 * group is signalled. Killing only the leader, as before, left the rest running (a cancelled `git commit` left its hook
 * running to the end). So when the group signal is refused, list the group's processes and kill each one.
 */
async function killProcessGroup(pid: number, system: ProcessGroupSystem): Promise<void> {
  // -1 would mean every process this user may signal, and 0 this process's own group.
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  try { system.kill(-pid, 'SIGKILL'); return } catch { /* Refused, or there is no such group. */ }
  // List before killing the leader: the listing still finds the others afterwards (they keep their group), but doing it
  // first means a failed listing has cost nothing.
  const members = await system.listGroups().then(snapshot => processGroupMembers(snapshot, pid), () => [])
  for (const member of members) if (member !== pid) { try { system.kill(member, 'SIGKILL') } catch { /* already gone */ } }
  try { system.kill(pid, 'SIGKILL') } catch { /* already gone */ }
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
