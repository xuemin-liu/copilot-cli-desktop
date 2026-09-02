import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runCopilotCommand } from './copilot-command.js'
import { findWindowsExecutable, windowsSystemDirectory } from './resolve-copilot.js'
import { withoutSensitiveEnvironment } from './secure-credentials.js'
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
    const wingetPath = await findWindowsExecutable('winget')
    if (!wingetPath) throw new Error('WinGet is unavailable. Install GitHub Copilot CLI from a trusted package source and retry detection.')
    const winget = await execFileAsync(wingetPath, [
      'install', '--id', 'GitHub.Copilot', '--exact', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements', '--silent', '--disable-interactivity',
    ], {
      cwd: windowsSystemDirectory(),
      env: withoutSensitiveEnvironment(process.env),
      timeout: 10 * 60_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    return `${winget.stdout}\n${winget.stderr}`.trim()
  }
  throw new Error('Automatic installation is supported only on Windows through WinGet. Install Copilot CLI from a trusted package source.')
}

export async function updateCopilotCli(resolution: CopilotResolution): Promise<string> {
  const result = await runCopilotCommand(resolution, ['update'], {
    env: withoutSensitiveEnvironment(process.env),
    timeout: 10 * 60_000,
  })
  return `${result.stdout}\n${result.stderr}`.trim()
}
