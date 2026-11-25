import { turnLabel, type CheckpointStore } from './checkpoint-store.js'

/**
 * Decides when a session's working folder is snapshotted: once when a turn starts and once when it ends.
 *
 * A turn starts at the live prompt, or just before the desktop pastes a task it composed, and ends when the session
 * becomes idle. A second prompt before the session is idle joins the running turn. Nothing here waits: a snapshot is
 * taken in the background and a prompt is never held back for one.
 */

/** Where a tab's session works, and whether its repository may be snapshotted. */
export interface TurnTarget {
  sessionId: string
  /** The root of the repository or worktree the session works in. */
  worktreeRoot: string
  /** Why Git must not be run there (the trust gate said no); the turn is recorded with this reason and no snapshot. */
  refused: string | null
}

export interface TurnCheckpointsOptions {
  store: CheckpointStore
  enabled(): boolean
  /** The tab's target, or null when its session gets no checkpoints (no repository, a side chat, another CLI). */
  resolve(tabId: string): Promise<TurnTarget | null>
  onError?(error: unknown): void
  now?: () => number
}

interface OpenTurn {
  /** The turn's target and number, or null when it gets no checkpoints. */
  started: Promise<{ target: TurnTarget; turn: number } | null>
  label: string
}

/** An end snapshot that waits for its place in a worktree's queue. */
interface PendingEnd { tabId: string; worktreeRoot: string | null; superseded: boolean; running: boolean }

export const SUPERSEDED_NOTE = 'Another prompt started before this turn’s end was captured'

export class TurnCheckpoints {
  private readonly open = new Map<string, OpenTurn>()
  private readonly pendingEnds = new Set<PendingEnd>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly now: () => number

  constructor(private readonly options: TurnCheckpointsOptions) { this.now = options.now ?? Date.now }

  private track<T>(promise: Promise<T>): Promise<T> {
    const guarded = promise.catch(error => { try { this.options.onError?.(error) } catch { /* a reporter must not break a turn */ } })
    this.work.add(guarded)
    void guarded.then(() => this.work.delete(guarded))
    return promise
  }

  /** An end snapshot not yet taken would now include the new turn's edits, so it is not taken. */
  private supersede(match: (pending: PendingEnd) => boolean): void {
    for (const pending of this.pendingEnds) if (!pending.running && match(pending)) pending.superseded = true
  }

  private begin(tabId: string, label: string): void {
    if (!this.options.enabled()) return
    this.supersede(pending => pending.tabId === tabId)
    const turn: OpenTurn = { label, started: Promise.resolve(null) }
    this.open.set(tabId, turn)
    turn.started = this.track((async () => {
      const target = await this.options.resolve(tabId)
      if (!target || !this.options.enabled()) { if (this.open.get(tabId) === turn) this.open.delete(tabId); return null }
      // Another tab may work in the same folder.
      this.supersede(pending => pending.worktreeRoot === target.worktreeRoot)
      const n = await this.options.store.beginTurn(target.worktreeRoot, target.sessionId, turn.label)
      void this.track(this.options.store.capture(target.worktreeRoot, target.sessionId, n, 'before', { refused: target.refused }))
      return { target, turn: n }
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

  /** The tab closed or its session ended with a turn still running. */
  tabClosed(tabId: string): void {
    this.close(tabId, 'The session ended during this turn')
  }

  private close(tabId: string, incomplete: string | null): void {
    const turn = this.open.get(tabId)
    if (!turn) return
    this.open.delete(tabId)
    // Registered at once, so a prompt that arrives before the start is worked out still counts as coming first.
    const pending: PendingEnd | null = incomplete === null ? { tabId, worktreeRoot: null, superseded: false, running: false } : null
    if (pending) this.pendingEnds.add(pending)
    void this.track(turn.started.then(async started => {
      if (!started || !pending) { if (pending) this.pendingEnds.delete(pending) }
      if (!started) return
      const { target, turn: n } = started
      const store = this.options.store
      const markIncomplete = (note: string): Promise<void> => store.updateTurn(target.worktreeRoot, target.sessionId, n, record => {
        record.state = 'incomplete'
        record.note = note
        record.endedAt = this.now()
      })
      if (incomplete !== null || !pending) { await markIncomplete(incomplete ?? SUPERSEDED_NOTE); return }
      // Turned off while the turn ran: its snapshots are being deleted, so none is added.
      if (!this.options.enabled()) { this.pendingEnds.delete(pending); return }
      pending.worktreeRoot = target.worktreeRoot
      try {
        const taken = await store.capture(target.worktreeRoot, target.sessionId, n, 'after', {
          refused: target.refused,
          skip: () => { pending.running = true; return pending.superseded },
        })
        if (taken === null) await markIncomplete(SUPERSEDED_NOTE)
      } finally { this.pendingEnds.delete(pending) }
    }))
  }

  /** Resolves when every snapshot asked for so far has been taken. */
  async settled(): Promise<void> {
    while (this.work.size > 0) await Promise.all([...this.work])
  }
}
