import { spawn, type ChildProcess } from 'node:child_process'
import type { ProcessWatchdogLease } from './windows-process-watchdog.js'
import { POSIX_PROBE_DIRECTORY } from './posix-executables.js'

type SpawnWatchdog = (
  file: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess

/**
 * The macOS and Linux counterpart of the Windows watchdog: one detached `/bin/sh` reads `track <pid>` and `release <pid>`
 * lines, and when its input closes (this process died without releasing them) it kills each tracked process group. Every
 * tracked process leads its own group (started `detached`, or a terminal session), so its children go with it.
 */
export const POSIX_WATCHDOG_SCRIPT = [
  "tracked=' '",
  'while IFS= read -r line; do',
  '  case "$line" in',
  "    'track '*) pid=${line#track }; case \"$pid\" in ''|*[!0-9]*) ;; *) tracked=\"$tracked$pid \" ;; esac ;;",
  "    'release '*) pid=${line#release }; next=' '; for p in $tracked; do [ \"$p\" = \"$pid\" ] || next=\"$next$p \"; done; tracked=$next ;;",
  '  esac',
  'done',
  'for pid in $tracked; do kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null; done',
].join('\n')

interface SharedWatchdog { child: ChildProcess }

let sharedWatchdog: SharedWatchdog | null = null
const trackedPids = new Set<number>()
let failureReported = false
let failureReporter: (message: string) => void = (message) => console.error(message)

export function configurePosixProcessWatchdogReporter(reporter: (message: string) => void): void {
  failureReporter = reporter
}

function reportFailure(error: unknown): void {
  if (failureReported) return
  failureReported = true
  failureReporter(`Child-process watchdog is unavailable: ${error instanceof Error ? error.message : String(error)}`)
}

function createSharedWatchdog(spawnWatchdog: SpawnWatchdog): SharedWatchdog | null {
  try {
    const child = spawnWatchdog('/bin/sh', ['-c', POSIX_WATCHDOG_SCRIPT], {
      cwd: POSIX_PROBE_DIRECTORY,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { PATH: '/usr/bin:/bin' },
    })
    const watcher: SharedWatchdog = { child }
    child.once('error', reportFailure)
    child.stdin?.once('error', reportFailure)
    child.once('exit', (code, signal) => {
      if (sharedWatchdog === watcher) sharedWatchdog = null
      if (code !== 0 || signal) reportFailure(`watcher exited unexpectedly (code ${String(code)}, signal ${String(signal ?? 'none')})`)
    })
    child.unref()
    ;(child.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null)?.unref?.()
    for (const trackedPid of trackedPids) child.stdin?.write(`track ${trackedPid}\n`)
    return watcher
  } catch (error) {
    reportFailure(error)
    return null
  }
}

export function startPosixProcessWatchdog(pid: number, spawnWatchdog: SpawnWatchdog = spawn): ProcessWatchdogLease {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid watchdog process ID')
  let existingWatcher = sharedWatchdog
  trackedPids.add(pid)
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    trackedPids.delete(pid)
    const activeInput = sharedWatchdog?.child.stdin
    if (activeInput && !activeInput.destroyed) activeInput.write(`release ${pid}\n`)
  }
  if (existingWatcher && (!existingWatcher.child.stdin || existingWatcher.child.stdin.destroyed)) {
    if (sharedWatchdog === existingWatcher) sharedWatchdog = null
    existingWatcher = null
  }
  const watcher = existingWatcher ?? createSharedWatchdog(spawnWatchdog)
  if (!watcher?.child.stdin || watcher.child.stdin.destroyed) {
    reportFailure('watcher input pipe is unavailable')
    return { release }
  }
  sharedWatchdog = watcher
  if (existingWatcher) watcher.child.stdin.write(`track ${pid}\n`)
  return { release }
}
