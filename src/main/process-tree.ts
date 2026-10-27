import { execFile } from 'node:child_process'
import { startPosixProcessWatchdog } from './posix-process-watchdog.js'
import { windowsSystemExecutable } from './resolve-copilot.js'
import { startWindowsProcessWatchdog, type ProcessWatchdogLease } from './windows-process-watchdog.js'

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
