import type { PtyLike, SpawnOptions } from './pty-backend.js'
import { startWindowsProcessWatchdog } from './windows-process-watchdog.js'

/**
 * Describe the renderer that actually consumes this PTY's output instead of
 * inheriting terminal flags from whichever shell happened to launch Electron.
 * In particular, Codex and some CI launchers export TERM=dumb; Copilot treats
 * that as a hard "no OSC" signal and disables its OSC 52 clipboard fallback.
 */
export function embeddedTerminalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
}

/**
 * Real interactive-terminal backend for the Electron main process, built on
 * `node-pty`. `node-pty` 1.x's native addon is built on `node-addon-api`
 * (N-API), which is ABI-stable across Node.js and Electron builds of the same
 * N-API version — verified in this repo's setup by loading the package's
 * prebuilt `win32-x64` binary both under plain Node and under
 * `electron --require` with `ELECTRON_RUN_AS_NODE=1`, with no rebuild step.
 * That means, unlike native modules built with the older NAN/V8 API, this one
 * does NOT need `@electron/rebuild` or any other ABI-specific rebuild.
 *
 * The import below is still dynamic (rather than a static top-level import)
 * so that files which merely reference this module's types — including the
 * background CLI daemon, which deliberately uses
 * `child-process-pty-backend.ts` instead for headless operation — never pay
 * the cost of loading the native addon unless `spawnNodePty` is actually
 * called.
 */
export async function spawnNodePty(file: string, args: string[], options: SpawnOptions): Promise<PtyLike> {
  const pty = await import('node-pty')
  const child = pty.spawn(file, args, {
    cwd: options.cwd,
    env: embeddedTerminalEnvironment(options.env) as { [key: string]: string },
    cols: options.cols,
    rows: options.rows,
    name: 'xterm-256color',
  })
  const watchdog = process.platform === 'win32' && child.pid
    ? startWindowsProcessWatchdog(child.pid)
    : null
  child.onExit(() => watchdog?.release())
  let disposed = false
  return {
    pid: child.pid,
    onData: (listener) => child.onData(listener),
    onExit: (listener) => child.onExit((event) => listener({ exitCode: event.exitCode, signal: event.signal })),
    write: (data) => child.write(data),
    resize: (cols, rows) => {
      try {
        child.resize(cols, rows)
      } catch {
        // Resizing a pty that has already exited throws; ignore.
      }
    },
    kill: (signal) => child.kill(signal),
    dispose: () => {
      if (disposed) return
      disposed = true
      watchdog?.release()
      try { child.kill() } catch { /* The process may already have exited. */ }
    },
  }
}
