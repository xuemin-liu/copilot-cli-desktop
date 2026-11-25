import { turnLabel, type CheckpointStore } from './checkpoint-store.js'

/**
 * Decides when a session's working folder is snapshotted: once when a turn starts and once when it ends.
 *
 * A turn starts at the live prompt, or just before the desktop pastes a task it composed, and ends when the session
 * becomes idle. A second prompt before the session is idle joins the running turn. Nothing here waits: a snapshot is
 * taken in the background and a prompt is never held back for one.
 */

/** Where a tab's session works. */
export interface TurnTarget {
  sessionId: string
  /** The root of the repository or worktree the session works in. */
  worktreeRoot: string
  /** The project folder the tab belongs to, for checking the repository again later. */
  projectPath: string
}

export interface TurnCheckpointsOptions {
  store: CheckpointStore
  enabled(): boolean
  /** The tab's target, or null when its session gets no checkpoints (no repository, a side chat, another CLI). */
  resolve(tabId: string): Promise<TurnTarget | null>
  /**
   * Why Git must not be run in the target's repository right now, or null when it may. Asked right before every
   * snapshot, the end one too: the agent can change the repository's settings and pointers during a turn.
   */
  gate(target: TurnTarget): Promise<string | null>
  onError?(error: unknown): void
  now?: () => number
}

interface Started { target: TurnTarget; turn: number; order: number }

interface OpenTurn {
  /** The turn's target and number, or null when it gets no checkpoints. */
  started: Promise<Started | null>
  label: string
  /** Known once the target is worked out. */
  root: string | null
  /** The feature was turned off while this turn was open: it gets nothing more. */
  cancelled: boolean
}

/** An end snapshot that is not saved yet. */
interface PendingEnd { tabId: string; worktreeRoot: string | null; superseded: boolean }

export const SUPERSEDED_NOTE = 'Another prompt started before this turn’s end was captured'

export class TurnCheckpoints {
  private readonly open = new Map<string, OpenTurn>()
  private readonly pendingEnds = new Set<PendingEnd>()
  private readonly work = new Set<Promise<unknown>>()
  /** Where each tab last worked, so a new prompt can invalidate another tab's end snapshot of that folder at once. */
  private readonly lastRoot = new Map<string, string>()
  /** Every turn gets a number when its prompt arrives; each folder remembers the newest one that started in it. */
  private sequence = 0
  private readonly newestStart = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly options: TurnCheckpointsOptions) { this.now = options.now ?? Date.now }

  private track<T>(promise: Promise<T>): Promise<T> {
    const guarded = promise.catch(error => { try { this.options.onError?.(error) } catch { /* a reporter must not break a turn */ } })
    this.work.add(guarded)
    void guarded.then(() => this.work.delete(guarded))
    return promise
  }

  /**
   * An end snapshot that is not saved yet would now include the new turn's edits, so it is not saved. That holds while
   * it waits in the queue and while Git is still reading files for it.
   */
  private supersede(match: (pending: PendingEnd) => boolean): void {
    for (const pending of this.pendingEnds) if (match(pending)) pending.superseded = true
  }

  private begin(tabId: string, label: string): void {
    if (!this.options.enabled()) return
    const known = this.lastRoot.get(tabId)
    this.supersede(pending => pending.tabId === tabId || (known !== undefined && pending.worktreeRoot === known))
    const turn: OpenTurn = { label, started: Promise.resolve(null), root: null, cancelled: false }
    const order = ++this.sequence
    this.open.set(tabId, turn)
    turn.started = this.track((async () => {
      const target = await this.options.resolve(tabId)
      if (!target || turn.cancelled || !this.options.enabled()) { if (this.open.get(tabId) === turn) this.open.delete(tabId); return null }
      turn.root = target.worktreeRoot
      this.lastRoot.set(tabId, target.worktreeRoot)
      this.newestStart.set(target.worktreeRoot, Math.max(this.newestStart.get(target.worktreeRoot) ?? 0, order))
      // Another tab may work in the same folder.
      this.supersede(pending => pending.worktreeRoot === target.worktreeRoot)
      const n = await this.options.store.beginTurn(target.worktreeRoot, target.sessionId, turn.label)
      void this.track(this.options.store.capture(target.worktreeRoot, target.sessionId, n, 'before', {
        gate: () => this.options.gate(target),
        // Turned off meanwhile: the snapshots are being deleted, so none is added.
        skip: () => turn.cancelled || !this.options.enabled(),
      }))
      return { target, turn: n, order }
    })()).catch(() => { if (this.open.get(tabId) === turn) this.open.delete(tabId); return null })
  }

  /** The desktop is about to paste a task it composed into the session: the turn starts now, before the paste. */
  preSend(tabId: string): void {
    if (!this.open.has(tabId)) this.begin(tabId, '')
  }

  /** The paste was taken back before Enter: no turn ran. */
  sendAborted(tabId: string): void {
    this.close(tabId, 'The task was not sent')
  }

  /** A live prompt reached the session. */
  promptStarted(tabId: string, prompt: string): void {
    const turn = this.open.get(tabId)
    if (!turn) { this.begin(tabId, prompt); return }
    // The prompt of a turn the desktop started fills in its label; a second prompt joins the running turn.
    if (turn.label !== '') return
    turn.label = prompt
    void this.track(turn.started.then(started => started && this.options.store.updateTurn(started.target.worktreeRoot, started.target.sessionId, started.turn, record => {
      if (record.label !== '') return false
      record.label = turnLabel(prompt)
      return true
    })))
  }

  /** The session became idle: the turn is over. */
  idle(tabId: string): void {
    this.close(tabId, null)
  }

  /** The tab closed, or its session stopped, restarted or switched to another conversation, with a turn still running. */
  tabClosed(tabId: string): void {
    this.close(tabId, 'The session ended during this turn')
  }

  /** The feature was turned off: no open turn gets another snapshot, and none that is being taken is saved. */
  turnedOff(): void {
    for (const turn of this.open.values()) turn.cancelled = true
    this.open.clear()
    this.supersede(() => true)
  }

  private close(tabId: string, incomplete: string | null): void {
    const turn = this.open.get(tabId)
    if (!turn) return
    this.open.delete(tabId)
    // Registered at once, with the folder when it is known, so a prompt that arrives now still counts as coming first.
    const pending: PendingEnd | null = incomplete === null ? { tabId, worktreeRoot: turn.root, superseded: false } : null
    if (pending) this.pendingEnds.add(pending)
    void this.track(turn.started.then(async started => {
      if (!started || !pending) { if (pending) this.pendingEnds.delete(pending) }
      if (!started || turn.cancelled) { if (pending) this.pendingEnds.delete(pending); return }
      const { target, turn: n } = started
      const store = this.options.store
      const markIncomplete = (note: string): Promise<void> => store.updateTurn(target.worktreeRoot, target.sessionId, n, record => {
        record.state = 'incomplete'
        record.note = note
        record.endedAt = this.now()
      })
      if (incomplete !== null || !pending) { await markIncomplete(incomplete ?? SUPERSEDED_NOTE); return }
      try {
        // The folder was not known when this end was registered, so a prompt that arrived there after this turn's own was missed.
        if (pending.worktreeRoot === null && (this.newestStart.get(target.worktreeRoot) ?? 0) > started.order) pending.superseded = true
        pending.worktreeRoot = target.worktreeRoot
        // Turned off while the turn ran: its snapshots are being deleted, so none is added.
        if (!this.options.enabled()) return
        const taken = await store.capture(target.worktreeRoot, target.sessionId, n, 'after', {
          gate: () => this.options.gate(target),
          skip: () => pending.superseded || !this.options.enabled(),
        })
        if (taken === null && this.options.enabled()) await markIncomplete(SUPERSEDED_NOTE)
      } finally { this.pendingEnds.delete(pending) }
    }))
  }

  /** Resolves when every snapshot asked for so far has been taken. */
  async settled(): Promise<void> {
    while (this.work.size > 0) await Promise.all([...this.work])
  }
}
