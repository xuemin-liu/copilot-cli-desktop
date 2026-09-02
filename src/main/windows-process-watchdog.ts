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

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function buildWatchdogEncodedCommand(pid: number, environment: NodeJS.ProcessEnv = process.env): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid watchdog process ID')
  const taskkill = quotePowerShellLiteral(windowsSystemExecutable('taskkill.exe', environment))
  const script = [
    '$release = [Console]::In.ReadToEnd()',
    "if ($release -ne 'release') {",
    `  & ${taskkill} /PID ${pid} /T /F | Out-Null`,
    '}',
  ].join('\n')
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * A detached, credential-free PowerShell process holds a pipe lease from the
 * owner. A normal PTY exit writes `release`; an abrupt owner death closes the
 * pipe without it, causing the watcher to terminate the whole PTY process tree.
 */
export function startWindowsProcessWatchdog(
  pid: number,
  environment: NodeJS.ProcessEnv = process.env,
  spawnWatchdog: SpawnWatchdog = spawn,
): ProcessWatchdogLease {
  const systemDirectory = windowsSystemDirectory(environment)
  const executable = windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe', environment)
  const child = spawnWatchdog(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-EncodedCommand', buildWatchdogEncodedCommand(pid, environment),
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
  child.on('error', () => undefined)
  child.stdin?.on('error', () => undefined)
  child.unref()
  ;(child.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null)?.unref?.()
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      if (child.stdin && !child.stdin.destroyed) child.stdin.end('release')
    },
  }
}
