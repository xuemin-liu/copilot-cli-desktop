import { execFile } from 'node:child_process'
import { isProcessAlive } from './runtime-core.js'

/** When a process started, in milliseconds since the epoch, or null when the system would not say. */
export type ProcessStartReader = (pid: number) => Promise<number | null>

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolveRun) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, ...(env ? { env } : {}) }, (error, stdout) => resolveRun(error ? null : stdout.trim()))
  })
}

export const readProcessStartTime: ProcessStartReader = async (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return null
  const text = process.platform === 'win32'
    ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`])
    // `lstart` in the C locale is a date `Date.parse` reads ("Sat Nov 21 09:41:00 2026"), on Linux and macOS alike.
    : await run('ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, LC_ALL: 'C' })
  if (!text) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : null
}

/**
 * A process started this long after a record was written is still taken for the one that wrote it. A controller writes
 * its record moments after it starts, and a lock written by an older version carries the time of the command that
 * started the controller, so the real gap is seconds at most.
 */
export const REUSED_PID_MARGIN_MS = 60_000

/**
 * Whether the process that wrote a record (the controller's state, or its lock) at `recordedAt` can still be the one
 * running under `pid`. A process id is reused once its process has ended, typically after the computer restarts, so
 * "something has this id" is not enough: a process that started after the record was written cannot have written it.
 * When the start time cannot be read, the holder is taken to be alive, which is what was assumed before.
 */
export async function recordHolderAlive(pid: number, recordedAt: string, readStartTime: ProcessStartReader = readProcessStartTime): Promise<boolean> {
  if (!isProcessAlive(pid)) return false
  const recorded = Date.parse(recordedAt)
  if (!Number.isFinite(recorded)) return true
  const started = await readStartTime(pid).catch(() => null)
  if (started === null) return true
  return started <= recorded + REUSED_PID_MARGIN_MS
}
