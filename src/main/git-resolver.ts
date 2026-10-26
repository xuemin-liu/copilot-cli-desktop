import type { GitResolverView } from './git-types.js'
import type { SessionTaskSend } from './session-task.js'

/** How long a task that was sent may take to show up as the session's turn before the claim lapses. */
const SENT_GRACE_MS = 60_000
/** A task that was only pasted, and never sent, stops claiming the repository after this. */
const UNSENT_LIMIT_MS = 30 * 60_000

interface Claim {
  folder: string
  tabId: string
  title: string
  sent: boolean
  at: number
  /** The session has been idle since the task arrived, so its next turn is the one that resolves. A task pasted into a busy
   * session waits for that turn to end first. */
  armed: boolean
  /** It has worked since being armed; the claim ends when it is idle again. */
  started: boolean
}

/** What main knows about a session: whether it is in the middle of something, or gone (closed, exited). */
export type SessionState = 'busy' | 'idle' | 'gone'

const folderKey = (folder: string): string => folder.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * The repositories a session was asked to resolve a pull in. Kept in the main process, so closing and reopening the Git panel
 * (or switching projects) does not forget them, and checked by the Git service before every write.
 */
export class GitResolverClaims {
  private readonly claims = new Map<string, Claim>()

  constructor(private readonly now: () => number = Date.now) {}

  claim(folder: string, tabId: string, title: string, sent: boolean, state: SessionState): void {
    this.claims.set(folderKey(folder), { folder, tabId, title, sent, at: this.now(), armed: sent || state !== 'busy', started: false })
  }

  /**
   * Hand a resolve task to a session and claim the repository for it, in one synchronous step. While a claim on the folder is
   * working, another request is refused before anything is typed: a second click must never replace the first task's claim
   * with a weaker one (pasted, not yet sent) and so release the lock while the first task runs.
   */
  request(folder: string, tabId: string, title: string, stateOf: (tabId: string) => SessionState, send: () => SessionTaskSend): SessionTaskSend {
    const existing = this.forFolder(folder, stateOf)
    if (existing?.working) return { result: 'refused', message: `Copilot is already working on this repository in “${existing.title}”. Wait for it to finish.` }
    const state = stateOf(tabId)
    const decision = send()
    if (decision.result !== 'refused') this.claim(folder, tabId, title, decision.result === 'sent', state)
    return decision
  }

  /** Move every claim on with what its session is doing now. Called on each activity change, so a turn that starts and ends
   * while no Git panel is open (nothing asks `forFolder`) is still seen. */
  observe(stateOf: (tabId: string) => SessionState): void {
    for (const claim of [...this.claims.values()]) this.forFolder(claim.folder, stateOf)
  }

  /** The claim on `folder`, after moving it on with what the session is doing now; null when there is none (any more). */
  forFolder(folder: string, stateOf: (tabId: string) => SessionState): GitResolverView | null {
    const key = folderKey(folder)
    const claim = this.claims.get(key)
    if (!claim) return null
    const state = stateOf(claim.tabId)
    const age = this.now() - claim.at
    if (state === 'gone' || (!claim.started && !claim.sent && age > UNSENT_LIMIT_MS)) { this.claims.delete(key); return null }
    if (!claim.armed) { if (state === 'idle') claim.armed = true }
    else if (state === 'busy') claim.started = true
    else if (claim.started) { this.claims.delete(key); return null }
    else if (claim.sent && age > SENT_GRACE_MS) { this.claims.delete(key); return null }
    // From the moment a task is sent until its turn ends; a pasted one only while that turn runs.
    const working = claim.armed && (state === 'busy' || (claim.sent && !claim.started))
    return { tabId: claim.tabId, title: claim.title, working }
  }
}
