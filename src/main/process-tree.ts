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
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })
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

/** Kill a process and its descendants at once. Resolves when the kill has been sent (Windows: when taskkill finished). */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise(resolve => {
    if (platform === 'win32') {
      execFile(windowsSystemExecutable('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => resolve())
      return
    }
    signalProcessGroup(pid, 'SIGKILL')
    resolve()
  })
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
export function startProcessWatchdog(pid: number, environment: NodeJS.ProcessEnv = process.env): ProcessWatchdogLease {
  return process.platform === 'win32' ? startWindowsProcessWatchdog(pid, environment) : startPosixProcessWatchdog(pid)
}
