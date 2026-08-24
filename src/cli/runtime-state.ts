import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { quarantineCorruptFile, writeFileAtomic } from '../main/atomic-file.js'

export type DaemonStatus = 'starting' | 'running' | 'restarting' | 'crashed' | 'stopping'

const DAEMON_STATUSES: readonly DaemonStatus[] = ['starting', 'running', 'restarting', 'crashed', 'stopping']

export interface DaemonState {
  version: 1
  pid: number
  controlPort: number
  token: string
  workspace: string
  processId: number | null
  status: DaemonStatus
  startedAt: string
  error: string | null
}

export type PublicDaemonState = Omit<DaemonState, 'token' | 'controlPort'>

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

  return {
    root,
    statePath: join(root, 'state.json'),
    lockPath: join(root, 'controller.lock'),
    logPath: join(root, 'copilot.log'),
  }
}

export async function ensureCliDirectories(paths: CliPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true })
}

/**
 * Every CLI command (status/logs/restart/stop/start) reads this file first,
 * so a truncated or otherwise corrupt write must not throw and brick the
 * whole CLI until a human manually deletes it. Move the bad file aside
 * (best effort) and treat it the same as "no state" rather than crashing.
 */
async function quarantineCorruptState(paths: CliPaths): Promise<void> {
  await quarantineCorruptFile(paths.statePath)
}

export async function readDaemonState(paths: CliPaths): Promise<DaemonState | null> {
  let raw: string
  try {
    raw = await readFile(paths.statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await quarantineCorruptState(paths)
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    await quarantineCorruptState(paths)
    return null
  }
  const state = parsed as Partial<DaemonState>
  if (
    state.version !== 1
    || typeof state.pid !== 'number' || !Number.isInteger(state.pid) || state.pid < 1
    || typeof state.controlPort !== 'number' || !Number.isInteger(state.controlPort) || state.controlPort < 1 || state.controlPort > 65_535
    || typeof state.token !== 'string' || state.token.length === 0
    || typeof state.workspace !== 'string'
    || typeof state.status !== 'string' || !DAEMON_STATUSES.includes(state.status)
    || typeof state.startedAt !== 'string'
    || (state.processId !== null && typeof state.processId !== 'number')
    || (state.error !== null && typeof state.error !== 'string')
  ) {
    await quarantineCorruptState(paths)
    return null
  }
  return state as DaemonState
}

export async function writeDaemonState(paths: CliPaths, state: DaemonState): Promise<void> {
  await writeFileAtomic(paths.statePath, `${JSON.stringify(state, null, 2)}\n`)
}

interface ControllerLock {
  version: 1
  pid: number
  token: string
  createdAt: string
}

async function readControllerLock(paths: CliPaths): Promise<ControllerLock | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.lockPath, 'utf8')) as Partial<ControllerLock>
    if (
      parsed.version !== 1
      || !Number.isInteger(parsed.pid)
      || typeof parsed.token !== 'string'
      || parsed.token.length < 32
      || typeof parsed.createdAt !== 'string'
    ) return null
    return parsed as ControllerLock
  } catch {
    return null
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function writeControllerLock(paths: CliPaths, lock: ControllerLock, exclusive: boolean): Promise<void> {
  if (!exclusive) {
    await writeFile(paths.lockPath, `${JSON.stringify(lock)}\n`, { mode: 0o600 })
    return
  }

  const handle = await open(paths.lockPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

export async function acquireControllerLock(paths: CliPaths): Promise<string> {
  await mkdir(paths.root, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomBytes(24).toString('hex')
    const lock: ControllerLock = {
      version: 1,
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    }
    try {
      await writeControllerLock(paths, lock, true)
      return token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readControllerLock(paths)
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(`Another copilot-desktop controller operation is active (PID ${existing.pid})`)
      }
      await rm(paths.lockPath, { force: true })
    }
  }
  throw new Error('Could not acquire the copilot-desktop controller lock')
}

export async function claimControllerLock(paths: CliPaths, token: string): Promise<void> {
  const existing = await readControllerLock(paths)
  if (!existing || existing.token !== token) throw new Error('The controller startup lock is missing or invalid')
  await writeControllerLock(paths, { ...existing, pid: process.pid }, false)
}

export async function releaseControllerLock(paths: CliPaths, token: string, expectedPid: number): Promise<boolean> {
  const existing = await readControllerLock(paths)
  if (!existing || existing.token !== token || existing.pid !== expectedPid) return false
  await rm(paths.lockPath, { force: true })
  return true
}

export async function removeDaemonState(paths: CliPaths): Promise<void> {
  await rm(paths.statePath, { force: true })
}

export function toPublicState(state: DaemonState): PublicDaemonState {
  const { token: _token, controlPort: _controlPort, ...publicState } = state
  return publicState
}
