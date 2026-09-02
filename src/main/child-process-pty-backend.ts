import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import type { PtyLike, SpawnOptions } from './pty-backend.js'
import { startWindowsProcessWatchdog } from './windows-process-watchdog.js'

/**
 * Headless backend for the background CLI daemon (src/cli/daemon.ts). Unlike
 * the desktop app's session tabs, the daemon has no renderer to stream a real
 * terminal into, so it deliberately avoids loading the native `node-pty`
 * addon at all (see node-pty-backend.ts for why that addon is safe to load
 * under Electron too) and spawns `copilot` as an ordinary piped child process
 * instead of a real pty. This keeps the background CLI's runtime dependency
 * surface smaller and avoids giving a detached, unattended process a pty it
 * has no UI to attach to.
 *
 * CAVEAT (documented, not verified against the real binary): interactive TUI
 * programs often detect the absence of a real tty and change behavior (for
 * example disabling color, cursor movement, or raw-mode key handling).
 * `copilot`'s behavior in this mode is unverified here. The desktop app's
 * session tabs use the real `node-pty` backend and are the supported way to
 * interact with Copilot CLI's full TUI; this backend exists so the background
 * CLI can still capture logs and status for headless start/status/restart/
 * stop/logs control without requiring a second native-module build.
 */
export function spawnChildProcessPty(file: string, args: string[], options: SpawnOptions): PtyLike {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // A child can exit between PtySession's liveness check and a stdin write.
  // Writable streams emit an unhandled `error` in that race unless a listener
  // is present, which would otherwise terminate the background daemon.
  child.stdin?.on('error', () => undefined)
  const watchdog = process.platform === 'win32' && child.pid
    ? startWindowsProcessWatchdog(child.pid)
    : null
  child.once('exit', () => watchdog?.release())

  return {
    pid: child.pid,
    onData: (listener) => {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')))
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')))
    },
    onExit: (listener) => {
      child.once('exit', (code, signal) => {
        // Node reports `code === null` precisely when the process was
        // terminated by a signal rather than exiting normally. Treating
        // that as exitCode 0 (as a naive `code ?? 0` would) reports an
        // unexpected kill — e.g. an OOM killer or an external `kill -9` — as
        // a clean, successful completion instead of a crash. Preserve a
        // conventional nonzero (128+signal) sentinel and the real signal
        // number so PtySession's exitCode === 0 check still works correctly.
        const signalNumber = signal ? constants.signals[signal] : undefined
        const exitCode = code ?? (signalNumber !== undefined ? 128 + signalNumber : 1)
        listener({ exitCode, signal: signalNumber })
      })
    },
    write: (data) => {
      if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return
      try {
        child.stdin.write(data)
      } catch {
        // The exit event will update the owning session; late input is dropped.
      }
    },
    // A plain piped child process has no pty to resize; COLUMNS/LINES were
    // already fixed at spawn time via the environment.
    resize: () => {},
    kill: (signal) => {
      child.kill(signal as NodeJS.Signals | undefined)
    },
    dispose: () => {
      watchdog?.release()
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    },
  }
}
