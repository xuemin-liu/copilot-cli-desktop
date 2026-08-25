import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runCopilotCommand } from './copilot-command.js'
import type { CopilotResolution } from './types.js'

const execFileAsync = promisify(execFile)

export type CopilotMaintenanceStatus = 'idle' | 'running' | 'succeeded' | 'failed'

export interface CopilotMaintenanceState {
  status: CopilotMaintenanceStatus
  operation: 'install' | 'update' | null
  message: string
}

export const DEFAULT_COPILOT_MAINTENANCE_STATE: CopilotMaintenanceState = {
  status: 'idle',
  operation: null,
  message: 'Install or update the official @github/copilot CLI independently of the desktop app.',
}

export async function installCopilotCli(): Promise<string> {
  if (process.platform === 'win32') {
    try {
      const winget = await execFileAsync('winget.exe', [
        'install', '--id', 'GitHub.Copilot', '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements', '--silent', '--disable-interactivity',
      ], { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
      return `${winget.stdout}\n${winget.stderr}`.trim()
    } catch (wingetError) {
      // WinGet is the official Windows path and does not require a separate
      // Node.js installation. Fall back to npm for machines where WinGet is
      // unavailable or its package source is disabled.
      const wingetMessage = wingetError instanceof Error ? wingetError.message : String(wingetError)
      try {
        const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
        const result = await execFileAsync(
          comspec,
          ['/d', '/s', '/c', 'call', 'npm.cmd', 'install', '--global', '@github/copilot@latest'],
          { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        )
        return `${result.stdout}\n${result.stderr}`.trim()
      } catch (npmError) {
        const npmMessage = npmError instanceof Error ? npmError.message : String(npmError)
        throw new Error(`WinGet installation failed: ${wingetMessage}. npm fallback failed: ${npmMessage}`)
      }
    }
  }
  const result = await execFileAsync(
    'npm',
    ['install', '--global', '@github/copilot@latest'],
    { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  )
  return `${result.stdout}\n${result.stderr}`.trim()
}

export async function updateCopilotCli(resolution: CopilotResolution): Promise<string> {
  const result = await runCopilotCommand(resolution, ['update'], { timeout: 10 * 60_000 })
  return `${result.stdout}\n${result.stderr}`.trim()
}
