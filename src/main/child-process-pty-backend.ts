import { spawn } from 'node:child_process'
import type { PtyLike, SpawnOptions } from './pty-backend.js'

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

  return {
    pid: child.pid,
    onData: (listener) => {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')))
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')))
    },
    onExit: (listener) => {
      child.once('exit', (code, signal) => {
        listener({ exitCode: code ?? 0, signal: signal ? 1 : undefined })
      })
    },
    write: (data) => {
      child.stdin?.write(data)
    },
    // A plain piped child process has no pty to resize; COLUMNS/LINES were
    // already fixed at spawn time via the environment.
    resize: () => {},
    kill: (signal) => {
      child.kill(signal as NodeJS.Signals | undefined)
    },
  }
}
