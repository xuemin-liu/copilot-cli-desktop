import { spawn, type ChildProcess } from 'node:child_process'
import { windowsSystemDirectory, windowsSystemExecutable } from './resolve-copilot.js'

export interface ProcessWatchdogLease {
  release(): void
}

type SpawnWatchdog = (
  file: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess

interface SharedWatchdog {
  child: ChildProcess
}

let sharedWatchdog: SharedWatchdog | null = null
const trackedPids = new Set<number>()
let failureReported = false
let failureReporter: (message: string) => void = (message) => console.error(message)

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function configureWindowsProcessWatchdogReporter(reporter: (message: string) => void): void {
  failureReporter = reporter
}

function reportFailure(error: unknown): void {
  if (failureReported) return
  failureReported = true
  failureReporter(`Windows child-process watchdog is unavailable: ${error instanceof Error ? error.message : String(error)}`)
}

/** Fixed shared watcher program; PIDs arrive as validated decimal line messages. */
export function buildWatchdogEncodedCommand(environment: NodeJS.ProcessEnv = process.env): string {
  const taskkill = quotePowerShellLiteral(windowsSystemExecutable('taskkill.exe', environment))
  const script = [
    '$tracked = [System.Collections.Generic.HashSet[int]]::new()',
    'while (($line = [Console]::In.ReadLine()) -ne $null) {',
    "  if ($line -match '^track ([1-9][0-9]*)$') { [void]$tracked.Add([int]$Matches[1]) }",
    "  elseif ($line -match '^release ([1-9][0-9]*)$') { [void]$tracked.Remove([int]$Matches[1]) }",
    '}',
    'foreach ($processId in $tracked) {',
    `  & ${taskkill} /PID $processId /T /F | Out-Null`,
    '}',
  ].join('\n')
  return Buffer.from(script, 'utf16le').toString('base64')
}

function createSharedWatchdog(
  environment: NodeJS.ProcessEnv,
  spawnWatchdog: SpawnWatchdog,
): SharedWatchdog | null {
  try {
    const systemDirectory = windowsSystemDirectory(environment)
    const executable = windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe', environment)
    const child = spawnWatchdog(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-EncodedCommand', buildWatchdogEncodedCommand(environment),
    ], {
      cwd: systemDirectory,
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        SystemRoot: environment.SystemRoot ?? environment.windir ?? 'C:\\Windows',
        windir: environment.windir ?? environment.SystemRoot ?? 'C:\\Windows',
      },
    })
    const watcher: SharedWatchdog = { child }
    child.once('error', reportFailure)
    child.stdin?.once('error', reportFailure)
    child.once('exit', (code, signal) => {
      if (sharedWatchdog === watcher) sharedWatchdog = null
      // Exit code 0 is the expected stdin-EOF path when the owning Node
      // process is itself shutting down; its remaining PIDs are killed then.
      if (code !== 0 || signal) {
        reportFailure(`watcher exited unexpectedly (code ${String(code)}, signal ${String(signal ?? 'none')})`)
      }
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

/**
 * One detached, credential-free PowerShell process tracks every child owned by
 * this Node/Electron process. Normal exits release individual PIDs; abrupt
 * owner death closes the shared pipe and terminates every remaining tree.
 */
export function startWindowsProcessWatchdog(
  pid: number,
  environment: NodeJS.ProcessEnv = process.env,
  spawnWatchdog: SpawnWatchdog = spawn,
): ProcessWatchdogLease {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid watchdog process ID')
  const existingWatcher = sharedWatchdog
  trackedPids.add(pid)
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    trackedPids.delete(pid)
    const activeInput = sharedWatchdog?.child.stdin
    if (activeInput && !activeInput.destroyed) activeInput.write(`release ${pid}\n`)
  }
  const watcher = existingWatcher ?? createSharedWatchdog(environment, spawnWatchdog)
  if (!watcher?.child.stdin || watcher.child.stdin.destroyed) {
    reportFailure('watcher input pipe is unavailable')
    return { release }
  }
  sharedWatchdog = watcher
  if (existingWatcher) watcher.child.stdin.write(`track ${pid}\n`)
  return { release }
}
