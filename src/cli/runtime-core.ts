import { homedir } from 'node:os'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

// Shared control helpers have no controller-lock or third-party dependencies.
export interface CliPaths {
  root: string
  statePath: string
  lockPath: string
  logPath: string
}

export function getCliPaths(environment: NodeJS.ProcessEnv = process.env): CliPaths {
  const root = environment.COPILOT_DESKTOP_CLI_HOME
    ?? (process.platform === 'win32'
      ? join(environment.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'copilot-cli-desktop', 'cli')
      : join(environment.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'copilot-cli-desktop', 'cli'))
  return { root, statePath: join(root, 'state.json'), lockPath: join(root, 'controller.lock'), logPath: join(root, 'copilot.log') }
}

export function constantTimeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
