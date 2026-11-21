import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import type { PtyLike, SpawnOptions } from './pty-backend.js'
import { detachedGroup, signalProcessGroup, startProcessWatchdog } from './process-tree.js'

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
    detached: detachedGroup(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // A child can exit between PtySession's liveness check and a stdin write.
  // Writable streams emit an unhandled `error` in that race unless a listener
  // is present, which would otherwise terminate the background daemon.
  child.stdin?.on('error', () => undefined)
  const watchdog = child.pid ? startProcessWatchdog(child.pid) : null
  child.once('exit', () => watchdog?.release())

  // Spawn failures (ENOENT/EACCES) emit `error` and never `exit`; without a
  // listener they would crash the daemon, and with one alone the session would
  // wait forever. `error` is also emitted when a kill or IPC send fails while
  // the process is still alive; those must not be reported as an exit (the pid
  // is only unset on spawn failure).
  //
  // How the process ended is recorded here, from the moment it exists, and
  // handed to `onExit` whenever that is called. The caller waits for `ready`
  // before it asks, and a program can start and be gone again by then: an exit
  // listened for only from `onExit` would be missed, and the session would
  // stay "running" for good.
  type ExitEvent = { exitCode: number; signal?: number | undefined }
  let ended: ExitEvent | null = null
  let spawnFailed = false
  const exitListeners = new Set<(event: ExitEvent) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  const end = (event: ExitEvent): void => {
    if (ended) return
    ended = event
    for (const listener of exitListeners) listener(event)
    exitListeners.clear()
  }
  child.on('error', (error) => {
    if (child.pid !== undefined) return
    spawnFailed = true
    for (const listener of errorListeners) listener(error)
    end({ exitCode: 1 })
  })
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
    // 'exit' can precede the last buffered stdout/stderr (typically the
    // crash message), and PtySession disposes the streams on exit. Wait
    // for 'close' so output is delivered first, but only briefly: a
    // grandchild that inherited the pipes would otherwise hold it open.
    const finish = (): void => end({ exitCode, signal: signalNumber })
    const timer = setTimeout(finish, 250)
    child.once('close', () => { clearTimeout(timer); finish() })
  })
  // Node reports a missing program or working folder a moment after `spawn()` returns, with no process id. Until then the
  // caller cannot tell a starting process from one that will never exist.
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.once('spawn', () => resolveReady())
    errorListeners.add(rejectReady)
  })
  // Whoever does not ask must not turn a failed start into an unhandled rejection; `onExit` reports it too.
  ready.catch(() => undefined)
  // Stream output through a decoder so multibyte characters split across
  // chunks are not replaced with U+FFFD.
  const forward = (stream: NodeJS.ReadableStream | null, listener: (data: string) => void): void => {
    if (!stream) return
    const decoder = new StringDecoder('utf8')
    stream.on('data', (chunk: Buffer) => {
      const text = decoder.write(chunk)
      if (text) listener(text)
    })
    stream.on('end', () => {
      const rest = decoder.end()
      if (rest) listener(rest)
    })
  }

  // Output is read from the start and kept until someone asks for it. Node throws away what a finished process
  // printed if nobody was listening, and the caller listens only once it knows the program started.
  const EARLY_OUTPUT_CHARS = 1_000_000
  const early: string[] = []
  let earlyChars = 0
  const dataListeners = new Set<(data: string) => void>()
  const deliver = (text: string): void => {
    if (dataListeners.size > 0) { for (const listener of dataListeners) listener(text); return }
    early.push(text)
    earlyChars += text.length
    while (earlyChars > EARLY_OUTPUT_CHARS && early.length > 1) earlyChars -= early.shift()!.length
  }
  forward(child.stdout, deliver)
  forward(child.stderr, deliver)

  return {
    get pid() { return child.pid },
    ready,
    onData: (listener) => {
      dataListeners.add(listener)
      // What it printed before anyone listened, in order, then whatever comes.
      for (const text of early.splice(0)) listener(text)
    },
    onExit: (listener) => {
      // It may have ended before anyone asked; its output was kept and handed over by `onData` above.
      if (ended) listener(ended)
      else exitListeners.add(listener)
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
      // Outside Windows the child leads its own group: signal the group so the commands it started stop too.
      if (detachedGroup() && child.pid && child.exitCode === null && child.signalCode === null) {
        signalProcessGroup(child.pid, (signal ?? 'SIGTERM') as NodeJS.Signals)
      } else child.kill(signal as NodeJS.Signals | undefined)
    },
    dispose: () => {
      watchdog?.release()
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    },
  }
}
