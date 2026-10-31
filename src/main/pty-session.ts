import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { windowsSystemExecutable } from './resolve-copilot.js'
import { detectApprovalPrompt, extractSessionId } from './approval-heuristic.js'
import { copilotSessionRoot } from './session-fork.js'
import { SessionPermissionMonitor } from './session-permission-monitor.js'
import { SessionStoreDiscovery } from './session-store-discovery.js'
import type { StoreDiscoveryOptions } from './session-store-discovery.js'
import type { PtyLike, SpawnPtyFn } from './pty-backend.js'
import type { SessionLifecycleStatus } from './types.js'
import type { SessionActivity } from './session-activity.js'
import type { ActivityDetail } from './activity-label.js'
import { BracketedPasteTracker, isTerminalReply } from './session-task.js'
import { SessionBindingReader, sessionResumeOffset, type SessionBinding } from './session-binding.js'
import { stat } from 'node:fs/promises'

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
  worktreeTimeoutMinutes?: number
  forceKillTimeoutMs?: number
  sessionId?: string | null
  discoverSessionIdFromOutput?: boolean
  /** Watch the session store for the new session's directory (a worktree launch cannot be given an id). */
  discoverSessionIdFromStore?: StoreDiscoveryOptions
  monitorSessionPermissions?: boolean
  /** A backend may provide verified session ownership; the native backend defaults to CLI PID/registry evidence. */
  sessionBindingReader?: Pick<SessionBindingReader, 'read'> & Partial<Pick<SessionBindingReader, 'diagnostic' | 'initialRecipientReady'>>
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
  private activityValue: SessionActivity | null = null
  private activityDetailValue: ActivityDetail | null = null
  private sessionCwdValue: string | null = null
  private stopping = false
  private readonly startupAbort = new AbortController()
  private readonly outputLines: string[] = []
  private pendingLine = ''
  private heuristicBuffer = ''
  private readonly bracketedPasteTracker = new BracketedPasteTracker()
  private lastKnownSessionId: string | null
  private permissionMonitor: SessionPermissionMonitor | null = null
  private monitoredSession: { sessionId: string; logPath: string; replayHistory: boolean | number } | null = null
  private bindingReader: PtySessionOptions['sessionBindingReader'] | null = null
  private bindingState: SessionBinding = { kind: 'unavailable' }
  private bindingRefresh: Promise<void> | null = null
  private bindingTimer: NodeJS.Timeout | null = null
  private bindingStartedAt = 0
  private deliveryRevision = 0
  private initialDeliverySessionId: string | null
  private pendingSessionId: string | null = null
  private readonly bindingPositions = new Map<string, { position: number; identity: string }>()
  private storeDiscovery: SessionStoreDiscovery | null = null
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
    // Only Desktop's explicit launch target can anchor first delivery; persisted ids or output hints alone cannot.
    this.initialDeliverySessionId = options.sessionId && options.args.some(arg => arg === `--resume=${options.sessionId}` || arg === `--session-id=${options.sessionId}`)
      ? options.sessionId : null
  }

  get status(): SessionLifecycleStatus {
    return this.statusValue
  }

  get activity(): SessionActivity | null { return this.activityValue }

  /** Running tools or thinking inside the current turn; null when idle or unknown. */
  get activityDetail(): ActivityDetail | null { return this.activityDetailValue }

  /** The folder the CLI reports the session runs in (a worktree, for a worktree launch); null until its log says. */
  get sessionCwd(): string | null { return this.sessionCwdValue }

  /** Whether the CLI has bracketed paste on (DECSET 2004), as the terminal pane sees it. */
  get bracketedPaste(): boolean { return this.bracketedPasteTracker.on }

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

  get monitorDiagnostic(): { sessionId: string; logPath: string; replayHistory: boolean | number } | null {
    return this.monitoredSession
  }

  get bindingDiagnostic(): SessionBinding { return this.bindingState }
  get bindingOwnershipDiagnostic(): SessionBindingReader['diagnostic'] | null { return this.bindingReader?.diagnostic ?? null }
  get sessionBindingPending(): boolean { return this.pendingSessionId !== null }
  get sessionBindingReady(): boolean { return this.pendingSessionId === null && (this.bindingState.kind === 'unavailable' || (this.bindingState.kind === 'bound' && this.bindingState.deliveryReady)) }

  /** A cached monitoring inventory cannot prove the shared terminal's recipient. Verify immediately before each
   * outbox pump, then invalidate the result if any input, output or binding change happens while other tabs await I/O. */
  async prepareMeetingDelivery(sessionId: string): Promise<() => boolean> {
    if (this.bindingRefresh) await this.bindingRefresh
    const revision = this.deliveryRevision
    const unchanged = (): boolean => !this.stopping && !this.exitHandled && this.lastKnownSessionId === sessionId
      && this.pendingSessionId === null && this.deliveryRevision === revision && this.bindingRefresh === null
    if (!unchanged() || !this.sessionBindingReady) return () => false
    if (!this.bindingReader) return () => unchanged() && this.sessionBindingReady
    let verified: SessionBinding
    try { verified = await this.bindingReader.read(sessionId, undefined, true) }
    catch { verified = { kind: 'deferred' } }
    if (!unchanged()) return () => false
    // This check changes delivery readiness only. Monitoring and user-turn authorization keep their own lifecycle.
    this.bindingState = verified
    if (verified.kind === 'unavailable' && this.initialDeliverySessionId === sessionId && this.bindingReader.initialRecipientReady) {
      const initialReady = await this.bindingReader.initialRecipientReady(sessionId)
      return () => initialReady && unchanged() && this.initialDeliverySessionId === sessionId && this.bindingState.kind === 'unavailable'
    }
    return () => unchanged() && this.sessionBindingReady && verified.kind === 'bound' && verified.sessionId === sessionId && verified.deliveryReady
  }

  /** Publish a caller-routed binding only after its user-turn authorization passed (or it matches the existing meeting). */
  commitSessionBinding(): void {
    if (this.pendingSessionId === null || this.pendingSessionId !== this.lastKnownSessionId) return
    this.pendingSessionId = null
    this.emit('session-id', this.lastKnownSessionId)
  }

  /** A control command must see complete events already on disk, even before the next output/poll timer. */
  async refreshSessionRecords(requestSessionId?: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.refreshSessionBinding(requestSessionId)
      const monitor = this.permissionMonitor
      if (!monitor) return
      await monitor.start()
      await monitor.poll()
      // poll() may have joined a read with an older size snapshot. Take a fresh one too.
      await monitor.poll()
      await this.refreshSessionBinding(requestSessionId)
      if (this.permissionMonitor === monitor) return
    }
    this.suspendSessionRecords('binding-kept-changing')
  }

  private suspendSessionRecords(reason: string): void {
    this.deliveryRevision++
    this.initialDeliverySessionId = null
    const monitor = this.permissionMonitor
    if (monitor?.checkpoint && this.monitoredSession) this.bindingPositions.set(this.monitoredSession.sessionId, monitor.checkpoint)
    this.permissionMonitor = null
    this.monitoredSession = null
    monitor?.stop()
    this.activityValue = null
    this.activityDetailValue = null
    this.sessionCwdValue = null
    this.emit('session-record-reset', reason)
    this.emit('activity', null)
    this.emit('activity-detail', null)
    this.emit('session-cwd', null)
  }

  private async refreshSessionBinding(requestSessionId?: string): Promise<void> {
    if (!this.bindingReader || this.stopping || this.exitHandled) return Promise.resolve()
    if (this.bindingRefresh) {
      await this.bindingRefresh
      if (requestSessionId === undefined) return
    }
    const work = (async () => {
      let binding: SessionBinding
      try { binding = await this.bindingReader!.read(this.lastKnownSessionId, requestSessionId) }
      catch { binding = { kind: 'unknown' } }
      if (this.stopping || this.exitHandled) return
      this.bindingState = binding
      if (binding.kind === 'unavailable' || binding.kind === 'deferred') return
      if (binding.kind === 'unknown') {
        if (this.permissionMonitor) this.suspendSessionRecords('binding-unverified')
        return
      }
      if (binding.sessionId === this.lastKnownSessionId && this.permissionMonitor) {
        if (requestSessionId === undefined && binding.deliveryReady) this.commitSessionBinding()
        return
      }
      this.suspendSessionRecords('session-binding-changed')
      const environment = { ...process.env, ...this.options.env }
      const path = join(copilotSessionRoot(environment), binding.sessionId, 'events.jsonl')
      const info = await stat(path)
      const previous = this.bindingPositions.get(binding.sessionId)
      const position = previous
        ? previous.identity === `${info.dev}:${info.ino}` && previous.position <= info.size ? previous.position : info.size
        : await sessionResumeOffset(path, this.bindingStartedAt)
      // Ownership may have changed while history was scanned. Never publish or consume an obsolete binding.
      const confirmed = await this.bindingReader!.read(this.lastKnownSessionId, requestSessionId)
      if (this.stopping || this.exitHandled) return
      if (confirmed.kind !== 'bound' || confirmed.ownerPid !== binding.ownerPid || confirmed.sessionId !== binding.sessionId) {
        this.bindingState = { kind: 'unknown' }
        return
      }
      this.lastKnownSessionId = binding.sessionId
      if (requestSessionId === undefined) { this.pendingSessionId = null; this.emit('session-id', binding.sessionId) }
      else this.pendingSessionId = binding.sessionId
      await this.attachPermissionMonitor(binding.sessionId, position)
    })().catch(() => {
      if (!this.stopping && !this.exitHandled) {
        this.bindingState = { kind: 'unknown' }
        this.suspendSessionRecords('binding-read-failed')
        this.reportPermissionMonitorError('Session binding could not be verified')
      }
    })
    this.bindingRefresh = work
    try { await work } finally { if (this.bindingRefresh === work) this.bindingRefresh = null }
  }

  private stopBindingWatch(): void {
    if (this.bindingTimer) clearInterval(this.bindingTimer)
    this.bindingTimer = null
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
    this.deliveryRevision++
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

  private async attachPermissionMonitor(sessionId: string, replayHistory: boolean | number = true): Promise<void> {
    if (this.options.monitorSessionPermissions !== true) return
    this.permissionMonitor?.stop()
    const environment = { ...process.env, ...this.options.env }
    const logPath = join(copilotSessionRoot(environment), sessionId, 'events.jsonl')
    const monitor = new SessionPermissionMonitor(
      logPath,
      (mode) => { if (this.permissionMonitor === monitor && !this.stopping && !this.exitHandled) this.emit('permission-mode', mode) },
      5_000,
      (message) => this.emit('permission-monitor-error', message),
      (activity) => {
        if (this.permissionMonitor !== monitor || this.stopping || this.exitHandled) return
        this.activityValue = activity
        if (activity === 'idle' && this.statusValue === 'approval-needed') {
          this.heuristicBuffer = ''
          this.setStatus('running')
        }
        this.emit('activity', activity)
      },
      (detail) => {
        if (this.permissionMonitor !== monitor || this.stopping || this.exitHandled) return
        this.activityDetailValue = detail
        this.emit('activity-detail', detail)
      },
      (cwd) => {
        if (this.permissionMonitor !== monitor || this.stopping || this.exitHandled) return
        this.sessionCwdValue = cwd
        this.emit('session-cwd', cwd)
      },
      (line, live) => {
        if (this.permissionMonitor !== monitor || this.stopping || this.exitHandled) return
        this.emit('session-record', line, live)
      },
      replayHistory,
      (reason) => {
        if (this.permissionMonitor === monitor && !this.stopping && !this.exitHandled) this.emit('session-record-reset', reason)
      },
    )
    this.permissionMonitor = monitor
    this.monitoredSession = { sessionId, logPath, replayHistory }
    this.emit('session-record-reset', 'monitor-attached')
    try {
      await monitor.start()
    } catch (error) {
      if (this.permissionMonitor === monitor) { this.permissionMonitor = null; this.monitoredSession = null }
      monitor.stop()
      this.reportPermissionMonitorError(error)
    }
  }

  private drainPermissionMonitor(): Promise<void> {
    if (this.permissionDrain) return this.permissionDrain
    const monitor = this.permissionMonitor
    this.permissionMonitor = null
    this.monitoredSession = null
    return this.permissionDrain = monitor
      ? monitor.finish().catch((error) => this.reportPermissionMonitorError(error))
      : Promise.resolve()
  }

  async start(): Promise<void> {
    if (this.pty) throw new Error('This session has already started')
    this.startupAbort.signal.throwIfAborted()
    this.setStatus('starting')
    if (this.lastKnownSessionId) await this.attachPermissionMonitor(this.lastKnownSessionId)
    // The snapshot of what is already in the store must be complete before the spawn, or the new session could be in it.
    if (this.lastKnownSessionId === null && this.options.discoverSessionIdFromStore) {
      this.storeDiscovery = new SessionStoreDiscovery(this.options.discoverSessionIdFromStore)
      await this.storeDiscovery.ready()
    }
    const spawnCols = this.options.cols
    const spawnRows = this.options.rows
    let pty: PtyLike
    try {
      this.bindingStartedAt = Date.now()
      pty = await this.options.spawnPty(this.options.file, this.options.args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        cols: spawnCols,
        rows: spawnRows,
        signal: this.startupAbort.signal,
        worktreeTimeoutMinutes: this.options.worktreeTimeoutMinutes,
      })
      if (this.stopping) {
        pty.kill()
        pty.dispose?.()
        throw new Error('Session startup cancelled')
      }
    } catch (error) {
      this.storeDiscovery?.cancel()
      await this.drainPermissionMonitor()
      throw error
    }
    this.pty = pty
    if (this.options.monitorSessionPermissions === true) {
      this.bindingReader = this.options.sessionBindingReader ?? (pty.pid && pty.pid > 1
        ? new SessionBindingReader(copilotSessionRoot({ ...process.env, ...this.options.env }), pty.pid) : null)
      if (this.bindingReader) {
        this.bindingTimer = setInterval(() => { void this.refreshSessionBinding() }, 30_000)
        this.bindingTimer.unref()
      }
    }
    if (this.storeDiscovery) {
      const discovery = this.storeDiscovery
      void discovery.find().then((sessionId) => {
        if (sessionId === null || this.storeDiscovery !== discovery || this.lastKnownSessionId !== null || this.exitHandled) return
        this.lastKnownSessionId = sessionId
        this.emit('session-id', sessionId)
        // Store discovery proves this directory did not exist before spawn and belongs to this launch's unique worktree.
        void this.attachPermissionMonitor(sessionId, false)
        void this.refreshSessionBinding()
      }).catch((error) => this.emit('permission-monitor-error', `Session store discovery failed: ${String(error)}`))
    }
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
      this.bracketedPasteTracker.note(data)
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
          void this.refreshSessionBinding()
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
      this.stopBindingWatch()
      this.pty = null
      this.storeDiscovery?.cancel()
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

  /** Terminal replies and known non-switching commands preserve the initial recipient. Prompts and all other input revoke
   * that anchor, including the first automatic meeting prompt. Attachment shortcuts do not answer approvals. */
  write(data: string, source?: 'add-dir' | 'rename'): void {
    if (!this.pty || !data || data === '\u001b[200~\u001b[201~') return
    this.deliveryRevision++
    if (source === undefined && !isTerminalReply(data)) this.initialDeliverySessionId = null
    if (data !== '\u001bv' && data !== '\u0016') {
      if (this.statusValue === 'approval-needed') this.setStatus('running')
      this.heuristicBuffer = ''
    }
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
    this.stopping = true
    this.stopBindingWatch()
    this.startupAbort.abort()
    this.storeDiscovery?.cancel()
    const pty = this.pty
    if (!pty) {
      await this.exitCompletion
      await this.drainPermissionMonitor()
      this.setStatus('completed')
      return
    }
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
