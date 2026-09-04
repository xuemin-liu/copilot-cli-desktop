import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { windowsSystemExecutable } from './resolve-copilot.js'
import { detectApprovalPrompt, extractSessionId } from './approval-heuristic.js'
import { copilotSessionRoot } from './session-fork.js'
import { SessionPermissionMonitor } from './session-permission-monitor.js'
import type { PtyLike, SpawnPtyFn } from './pty-backend.js'
import type { SessionLifecycleStatus } from './types.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_LINES = 500
// Bounds on top of the line count: a single newline-free burst (or one very
// long line) could otherwise grow `pendingLine`/`outputLines` without limit
// regardless of MAX_OUTPUT_LINES.
const MAX_LINE_CHARS = 8_000
const MAX_PENDING_CHARS = 64_000
const MAX_HEURISTIC_CHARS = 16_000

export interface PtySessionOptions {
  file: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
  spawnPty: SpawnPtyFn
  forceKillTimeoutMs?: number
  sessionId?: string | null
  discoverSessionIdFromOutput?: boolean
  monitorSessionPermissions?: boolean
}

export interface PtySessionExit {
  exitCode: number
  signal: number | undefined
  expected: boolean
}

/**
 * Owns exactly one spawned `copilot` process (via either the real `node-pty`
 * backend or the headless child-process backend — see pty-backend.ts) and
 * tracks its best-effort lifecycle status. Mirrors the reference project's
 * EventEmitter-based process supervisor: 'status', 'log', 'desktop-event', and
 * 'exit' events, with a bounded ring buffer of recent output for diagnostics.
 */
export class PtySession extends EventEmitter {
  private readonly options: Required<Pick<PtySessionOptions, 'cols' | 'rows' | 'forceKillTimeoutMs'>> & PtySessionOptions
  private pty: PtyLike | null = null
  private statusValue: SessionLifecycleStatus = 'starting'
  private stopping = false
  private readonly outputLines: string[] = []
  private pendingLine = ''
  private heuristicBuffer = ''
  private lastKnownSessionId: string | null
  private permissionMonitor: SessionPermissionMonitor | null = null
  private exitHandled = false
  private exitCompletion: Promise<void> | null = null
  private permissionDrain: Promise<void> | null = null

  constructor(options: PtySessionOptions) {
    super()
    this.options = {
      ...options,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      forceKillTimeoutMs: options.forceKillTimeoutMs ?? 3_000,
    }
    this.lastKnownSessionId = options.sessionId ?? null
  }

  get status(): SessionLifecycleStatus {
    return this.statusValue
  }

  get processId(): number | null {
    return this.pty?.pid ?? null
  }

  get recentOutput(): readonly string[] {
    return this.outputLines
  }

  /**
   * Best-effort reconstruction of the retained output as one string, for a
   * renderer that subscribes to live output after the session has already
   * produced some (e.g. a terminal pane mounting after the pty's startup
   * banner or an approval prompt already streamed). Approximate: lines are
   * rejoined with '\n', which does not perfectly reproduce the original raw
   * chunk boundaries, but is faithful enough for terminal replay.
   */
  get recentOutputText(): string {
    return this.outputLines.map((line) => `${line}\n`).join('') + this.pendingLine
  }

  get lastSessionId(): string | null {
    return this.lastKnownSessionId
  }

  /** The size this session was last told to use — either its construction
   * default or the most recent `resize()` call. A caller that replaces this
   * session (e.g. restarting the underlying process) needs this to spawn the
   * new one at the terminal's actual current size instead of silently
   * reverting to the 80x24 construction default. */
  get dimensions(): { cols: number; rows: number } {
    return { cols: this.options.cols, rows: this.options.rows }
  }

  private setStatus(status: SessionLifecycleStatus): void {
    if (this.statusValue === status) return
    this.statusValue = status
    this.emit('status', status)
  }

  private pushOutputLine(line: string): void {
    this.outputLines.push(
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[truncated]` : line,
    )
    if (this.outputLines.length > MAX_OUTPUT_LINES) this.outputLines.shift()
  }

  private recordOutput(text: string): void {
    this.pendingLine += text
    const parts = this.pendingLine.split(/\r?\n/)
    this.pendingLine = parts.pop() ?? ''
    for (const line of parts) this.pushOutputLine(line)
    // No newline arrived and the pending fragment kept growing (e.g.
    // newline-free or attacker-influenced tool output) — flush it into the
    // bounded line buffer instead of letting it accumulate without limit.
    while (this.pendingLine.length > MAX_PENDING_CHARS) {
      this.pushOutputLine(this.pendingLine.slice(0, MAX_LINE_CHARS))
      this.pendingLine = this.pendingLine.slice(MAX_LINE_CHARS)
    }
    this.emit('log', text)
    this.permissionMonitor?.notifyActivity()
  }

  private reportPermissionMonitorError(error: unknown): void {
    this.emit('permission-monitor-error', String(error))
  }

  private async attachPermissionMonitor(sessionId: string): Promise<void> {
    if (this.options.monitorSessionPermissions !== true) return
    this.permissionMonitor?.stop()
    const environment = { ...process.env, ...this.options.env }
    const monitor = new SessionPermissionMonitor(
      join(copilotSessionRoot(environment), sessionId, 'events.jsonl'),
      (mode) => this.emit('permission-mode', mode),
      5_000,
      (message) => this.emit('permission-monitor-error', message),
    )
    this.permissionMonitor = monitor
    try {
      await monitor.start()
    } catch (error) {
      if (this.permissionMonitor === monitor) this.permissionMonitor = null
      monitor.stop()
      this.reportPermissionMonitorError(error)
    }
  }

  private drainPermissionMonitor(): Promise<void> {
    if (this.permissionDrain) return this.permissionDrain
    const monitor = this.permissionMonitor
    this.permissionMonitor = null
    return this.permissionDrain = monitor
      ? monitor.finish().catch((error) => this.reportPermissionMonitorError(error))
      : Promise.resolve()
  }

  async start(): Promise<void> {
    if (this.pty) throw new Error('This session has already started')
    this.setStatus('starting')
    if (this.lastKnownSessionId) await this.attachPermissionMonitor(this.lastKnownSessionId)
    const spawnCols = this.options.cols
    const spawnRows = this.options.rows
    let pty: PtyLike
    try {
      pty = await this.options.spawnPty(this.options.file, this.options.args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        cols: spawnCols,
        rows: spawnRows,
      })
    } catch (error) {
      await this.drainPermissionMonitor()
      throw error
    }
    this.pty = pty
    // A resize() that arrives while spawnPty() is still resolving updates
    // this.options (so a later restart still reads the latest size) but has
    // no live pty to forward to yet — this.pty is still null at that point.
    // Reconcile now against whatever was actually passed to spawnPty above,
    // so the new pty doesn't stay stuck at a size it was told to abandon
    // before it ever existed.
    if (this.options.cols !== spawnCols || this.options.rows !== spawnRows) {
      pty.resize(this.options.cols, this.options.rows)
    }

    pty.onData((data: string) => {
      this.recordOutput(data)
      // PTY reads can split a prompt or session-id banner at any byte boundary.
      // Scan a bounded rolling stream so the heuristics see text spanning
      // adjacent reads rather than treating transport chunks as message lines.
      this.heuristicBuffer = `${this.heuristicBuffer}${data}`.slice(-MAX_HEURISTIC_CHARS)
      if (this.lastKnownSessionId === null && this.options.discoverSessionIdFromOutput === true) {
        const discoveredSessionId = extractSessionId(this.heuristicBuffer)
        if (discoveredSessionId) {
          this.lastKnownSessionId = discoveredSessionId
          this.emit('session-id', discoveredSessionId)
          void this.attachPermissionMonitor(discoveredSessionId)
        }
      }
      if (this.statusValue !== 'approval-needed' && detectApprovalPrompt(this.heuristicBuffer)) {
        this.setStatus('approval-needed')
        this.emit('desktop-event', { type: 'approval-needed' })
      } else if (this.statusValue !== 'running' && this.statusValue !== 'approval-needed') {
        // Only transition out of a non-running starting state on ordinary
        // output. An approval-needed badge must stay up until write() (the
        // user actually responded), exit, or another explicit transition —
        // not just because the next output chunk (e.g. a cursor escape code
        // or a split prompt) happened not to match the approval heuristic.
        this.setStatus('running')
      }
    })

    pty.onExit(({ exitCode, signal }) => {
      if (this.exitHandled) return
      this.exitHandled = true
      this.pty = null
      pty.dispose?.()
      const expected = this.stopping
      this.exitCompletion = this.drainPermissionMonitor().then(() => {
        if (!expected) {
          if (exitCode === 0) {
            this.setStatus('completed')
            this.emit('desktop-event', { type: 'session-completed' })
          } else {
            this.setStatus('crashed')
            this.emit('desktop-event', {
              type: 'session-crashed',
              message: `copilot exited unexpectedly (code ${exitCode}, signal ${String(signal ?? 'none')})`,
            })
          }
        }
        this.emit('exit', { exitCode, signal, expected } satisfies PtySessionExit)
      })
    })

    this.setStatus('running')
  }

  /** Send raw keystrokes/input to the pty. Also clears an approval-needed badge. */
  write(data: string): void {
    if (!this.pty) return
    if (this.statusValue === 'approval-needed') this.setStatus('running')
    this.heuristicBuffer = ''
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    // ConPTY can redraw even for an unchanged size. In Copilot's native copy
    // mode that redraw can replace the conversation with clipboard status.
    if (cols === this.options.cols && rows === this.options.rows) return
    this.options.cols = cols
    this.options.rows = rows
    this.pty?.resize(cols, rows)
  }

  async stop(): Promise<void> {
    const pty = this.pty
    if (!pty) {
      await this.exitCompletion
      await this.drainPermissionMonitor()
      this.setStatus('completed')
      return
    }
    this.stopping = true
    this.setStatus('stopping')
    const exited = new Promise<void>((resolve) => this.once('exit', resolve))

    if (process.platform === 'win32' && pty.pid) {
      try {
        await execFileAsync(windowsSystemExecutable('taskkill.exe'), ['/PID', String(pty.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 5_000,
        })
      } catch {
        try { pty.kill() } catch { pty.dispose?.() }
      }
    } else {
      pty.kill('SIGTERM')
    }

    const timedOut = await Promise.race([
      exited.then(() => false as const),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), this.options.forceKillTimeoutMs)),
    ])
    if (timedOut && this.pty === pty) {
      try {
        if (process.platform === 'win32') pty.kill()
        else pty.kill('SIGKILL')
      } catch {
        pty.dispose?.()
      }
    }
    // Even a backend that never acknowledges kill must release its monitor.
    await this.drainPermissionMonitor()
    await this.exitCompletion
  }

}
