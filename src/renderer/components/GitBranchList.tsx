import type { JSX } from 'react'
import { formatReviewText } from '../../main/git-review-format.js'
import { branchNameProblem } from '../../main/git-branch.js'
import type { GitBranchView } from '../../main/git-types.js'

export interface GitBranchListProps {
  /** Null while loading. */
  branches: readonly GitBranchView[] | null
  error: string | null
  /** A write is running, or the repository has no commit yet: nothing can be changed. */
  locked: boolean
  /** Why nothing can be changed, when `locked` is because of the repository rather than a running write. */
  lockedReason: string | null
  newName: string
  onNewNameChange(value: string): void
  onCreate(): void
  onSwitch(name: string): void
}

/** The distance from the upstream, as `↑2 ↓1`, or a note when there is none. */
export function upstreamLabel(branch: Pick<GitBranchView, 'upstream' | 'ahead' | 'behind' | 'upstreamGone'>): string {
  if (branch.upstreamGone) return 'upstream gone'
  if (branch.upstream === null) return 'local only'
  const parts = [(branch.ahead ?? 0) > 0 ? `↑${branch.ahead}` : '', (branch.behind ?? 0) > 0 ? `↓${branch.behind}` : ''].filter(Boolean)
  return parts.length > 0 ? `${branch.upstream} ${parts.join(' ')}` : `${branch.upstream} · in sync`
}

/** The local branches with Switch, and a form that creates a branch at the current commit. */
export function GitBranchList(props: GitBranchListProps): JSX.Element {
  const { branches, error, locked, newName } = props
  const problem = newName.trim() === '' ? null : branchNameProblem(newName)
  const canCreate = !locked && newName.trim() !== '' && problem === null
  return (
    <div className="git-branches">
      <form className="git-branch-new" onSubmit={event => { event.preventDefault(); if (canCreate) props.onCreate() }}>
        <input type="text" aria-label="New branch name" placeholder="New branch name" maxLength={200} spellCheck={false} value={newName}
          disabled={locked} onChange={event => props.onNewNameChange(event.target.value)} />
        <button type="submit" className="primary-button" disabled={!canCreate}
          title="Create the branch at the current commit and switch to it. No file changes.">Create and switch</button>
      </form>
      {problem && <p className="git-note" role="status">{problem}</p>}
      {props.lockedReason && <p className="git-note" role="status">{props.lockedReason}</p>}

      {error && <p className="git-message git-message-error" role="alert">{error}</p>}
      {branches === null && !error && <p className="git-message" role="status">Loading branches…</p>}
      {branches !== null && branches.length === 0 && <p className="git-message" role="status">No branches yet.</p>}
      {branches !== null && branches.length > 0 && (
        <ul className="git-branch-list" aria-label="Local branches">
          {branches.map(branch => (
            <li key={branch.name} className={branch.current ? 'git-branch-row git-branch-current' : 'git-branch-row'}>
              <div className="git-branch-main">
                <span className="git-branch-title" title={branch.name}>{formatReviewText(branch.name)}</span>
                {branch.current && <span className="git-branch-badge">current</span>}
                <span className="git-branch-track">{upstreamLabel(branch)}</span>
                <span className="git-branch-subject" title={branch.subject}>{formatReviewText(branch.subject)}</span>
              </div>
              {!branch.current && (
                <button type="button" disabled={locked} aria-label={`Switch to ${branch.name}`}
                  title="Change the files in your folder to match this branch. You will be asked to confirm, and it is refused while a Copilot session is working here."
                  onClick={() => props.onSwitch(branch.name)}>Switch</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
