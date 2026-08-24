import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { detectApprovalPrompt, extractSessionId } from './approval-heuristic.js'
import type { PtyLike, SpawnPtyFn } from './pty-backend.js'
import type { SessionLifecycleStatus } from './types.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_LINES = 500
// Bounds on top of the line count: a single newline-free burst (or one very
// long line) could otherwise grow `pendingLine`/`outputLines` without limit
// regardless of MAX_OUTPUT_LINES.
const MAX_LINE_CHARS = 8_000
const MAX_PENDING_CHARS = 64_000

export interface PtySessionOptions {
  file: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
  spawnPty: SpawnPtyFn
  forceKillTimeoutMs?: number
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
  private lastKnownSessionId: string | null = null

  constructor(options: PtySessionOptions) {
    super()
    this.options = {
      ...options,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      forceKillTimeoutMs: options.forceKillTimeoutMs ?? 3_000,
    }
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
  }

  async start(): Promise<void> {
    if (this.pty) throw new Error('This session has already started')
    this.setStatus('starting')
    const pty = await this.options.spawnPty(this.options.file, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      cols: this.options.cols,
      rows: this.options.rows,
    })
    this.pty = pty

    pty.onData((data: string) => {
      this.recordOutput(data)
      const sessionId = extractSessionId(data)
      if (sessionId) this.lastKnownSessionId = sessionId
      if (detectApprovalPrompt(data)) {
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
      this.pty = null
      const expected = this.stopping
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

    this.setStatus('running')
  }

  /** Send raw keystrokes/input to the pty. Also clears an approval-needed badge. */
  write(data: string): void {
    if (!this.pty) throw new Error('This session is not running')
    if (this.statusValue === 'approval-needed') this.setStatus('running')
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows)
  }

  async stop(): Promise<void> {
    const pty = this.pty
    if (!pty) {
      this.setStatus('completed')
      return
    }
    this.stopping = true
    this.setStatus('stopping')
    const exited = new Promise<void>((resolve) => {
      const done = (): void => resolve()
      pty.onExit(done)
    })

    if (process.platform === 'win32' && pty.pid) {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(pty.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 5_000,
        })
      } catch {
        pty.kill()
      }
    } else {
      pty.kill('SIGTERM')
    }

    const timedOut = await Promise.race([
      exited.then(() => false as const),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), this.options.forceKillTimeoutMs)),
    ])
    if (timedOut && this.pty === pty) {
      pty.kill('SIGKILL')
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    this.stopping = false
    this.outputLines.length = 0
    this.pendingLine = ''
    await this.start()
  }
}
