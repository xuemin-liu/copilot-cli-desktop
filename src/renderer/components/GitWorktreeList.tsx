import type { JSX } from 'react'
import { formatReviewText } from '../../main/git-review-format.js'
import type { GitWorktreeView } from '../../main/git-types.js'

export interface WorktreeSession {
  /** Canonical worktree folder the session runs in. */
  path: string
  title: string
}

export interface GitWorktreeListProps {
  /** Null while loading. */
  worktrees: readonly GitWorktreeView[] | null
  error: string | null
  /** Desktop sessions that run in a worktree, so each entry can say who uses it. */
  sessions: readonly WorktreeSession[]
  /** A write is running: nothing can be removed. */
  locked?: boolean
  onRemove?(path: string): void
}

const samePath = (left: string, right: string): boolean => left.replace(/[\\/]+$/, '').toLowerCase() === right.replace(/[\\/]+$/, '').toLowerCase()

/** What is notable about a worktree, in the order a reader needs it. */
export function worktreeFlags(worktree: GitWorktreeView, sessions: readonly WorktreeSession[]): string[] {
  const flags: string[] = []
  if (worktree.main) flags.push('main worktree')
  if (worktree.bare) flags.push('bare')
  if (worktree.detached) flags.push('detached')
  if (worktree.locked !== null) flags.push(worktree.locked === 'locked' ? 'locked' : `locked: ${worktree.locked}`)
  if (worktree.prunable !== null) flags.push(worktree.prunable === 'prunable' ? 'prunable' : `prunable: ${worktree.prunable}`)
  const using = sessions.filter(session => samePath(session.path, worktree.path)).map(session => session.title)
  if (using.length > 0) flags.push(`used by ${using.join(', ')}`)
  return flags
}

/** Why a worktree cannot be removed from the panel, or null when it can be offered (the service checks again, and asks). */
export function removeBlocker(worktree: GitWorktreeView, sessions: readonly WorktreeSession[]): string | null {
  if (worktree.main) return 'The main worktree is the repository itself.'
  if (worktree.current) return 'This is the worktree shown in the panel. Choose its repository first.'
  if (worktree.locked !== null) return 'It is locked.'
  if (worktree.prunable !== null) return 'Git already considers it prunable; run git worktree prune from a terminal.'
  if (worktree.merged === null) return 'There is no default branch to check its branch against.'
  if (!worktree.merged) return 'Its branch is not merged into the default branch.'
  const using = sessions.filter(session => samePath(session.path, worktree.path)).map(session => session.title)
  if (using.length > 0) return `It is used by ${using.join(', ')}.`
  return null
}

/** The repository's worktrees: where each is, what it has checked out, which session uses it, and Remove for a merged, unused one. */
export function GitWorktreeList({ worktrees, error, sessions, locked = false, onRemove }: GitWorktreeListProps): JSX.Element {
  return (
    <section className="git-worktrees" aria-label="Worktrees">
      <h3 className="git-section-title">Worktrees</h3>
      {error && <p className="git-message git-message-error" role="alert">{error}</p>}
      {worktrees === null && !error && <p className="git-message" role="status">Loading worktrees…</p>}
      {worktrees !== null && worktrees.length <= 1 && <p className="git-note" role="status">No linked worktrees. A session started with the worktree launch option gets one.</p>}
      {worktrees !== null && worktrees.length > 1 && (
        <ul className="git-worktree-list">
          {worktrees.map(worktree => (
            <li key={worktree.path} className={worktree.current ? 'git-worktree-row git-worktree-current' : 'git-worktree-row'}>
              <span className="git-worktree-branch" title={worktree.branch ?? (worktree.detached ? 'detached HEAD' : '')}>
                {formatReviewText(worktree.branch ?? (worktree.detached ? `detached at ${worktree.head?.slice(0, 7) ?? '?'}` : '(no branch)'))}
              </span>
              {worktree.current && <span className="git-branch-badge">shown</span>}
              <span className="git-worktree-path" title={worktree.path}>{formatReviewText(worktree.path)}</span>
              {worktreeFlags(worktree, sessions).length > 0 && <span className="git-worktree-flags">{worktreeFlags(worktree, sessions).map(formatReviewText).join(' · ')}</span>}
              {onRemove && !worktree.main && (() => {
                const blocker = removeBlocker(worktree, sessions)
                return <button type="button" className="git-worktree-remove" disabled={locked || blocker !== null} aria-label={`Remove worktree ${worktree.branch ?? worktree.path}`}
                  title={blocker ?? 'Delete this worktree\'s folder, including files Git ignores there. Its branch is kept. You will be asked to confirm, and Git refuses if it has uncommitted changes.'}
                  onClick={() => onRemove(worktree.path)}>Remove</button>
              })()}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
