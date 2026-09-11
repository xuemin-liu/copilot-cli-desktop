import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getCliPaths, readDaemonState } from '../cli/runtime-state.js'
import { windowsSystemExecutable } from './resolve-copilot.js'

/** Read process identities only. Command lines never leave the system query. */
export async function assertMigrationWritersStopped(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Migration currently supports Windows to Windows only')
  const daemon = await readDaemonState(getCliPaths())
  if (daemon) {
    let alive = true
    try { process.kill(daemon.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error }
    if (alive) throw new Error('Stop the background controller with copilot-desktop stop before migration.')
  }
  const script = "$ErrorActionPreference = 'Stop'; $writers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^copilot(?:-.*)?\\.exe$' -or ($_.Name -match '^node(?:\\.exe)?$' -and $_.CommandLine -match '(?i)(@github[\\\\/]copilot|copilot[\\\\/]index|copilot[\\\\/]dist)') }); $writers.Count"
  let stdout: string
  try {
    ({ stdout } = await promisify(execFile)(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 }))
  } catch { throw new Error('Could not verify that external Copilot writers are stopped. Close external CLI sessions and retry.') }
  if (!/^\d+$/.test(stdout.trim())) throw new Error('Could not verify external Copilot processes')
  if (Number(stdout.trim()) > 0) throw new Error('Close all external Copilot CLI sessions before migration. Closing a tray window does not stop its sessions.')
}
