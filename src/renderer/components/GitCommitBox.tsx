import type { JSX } from 'react'
import { formatReviewText } from '../../main/git-review-format.js'

export interface GitCommitBoxProps {
  stagedCount: number
  conflictCount: number
  message: string
  onMessageChange(value: string): void
  /** The write running now, or null. While one runs, nothing else can be started. */
  busy: 'stage' | 'unstage' | 'commit' | 'fetch' | 'pull' | 'push' | 'branch' | 'discard' | null
  /** What the running write (a commit hook, usually) has printed so far. */
  progress: string
  canDraft: boolean
  draftTitle: string
  onDraft(): void
  onCommit(): void
  onCancel(): void
  /** Set when a commit would run repository hooks the person has not approved yet. */
  hooks: readonly string[] | null
  onApproveHooks(): void
  onDismissHooks(): void
}

/** Why Commit is unavailable, or null when it is available. */
export function commitBlocker(stagedCount: number, conflictCount: number, message: string): string | null {
  if (conflictCount > 0) return 'Resolve the conflicts and stage the result first.'
  if (stagedCount === 0) return 'Stage the files you want to commit.'
  if (message.trim() === '') return 'Write a commit message.'
  return null
}

/** The message box and Commit button, with the hook approval and live progress a commit can need. */
export function GitCommitBox(props: GitCommitBoxProps): JSX.Element {
  const { stagedCount, conflictCount, message, busy, hooks } = props
  const blocker = commitBlocker(stagedCount, conflictCount, message)
  const canCommit = blocker === null && busy === null && hooks === null
  // Fetch, pull and push show their own output and Cancel in the sync bar.
  const writing = busy === 'stage' || busy === 'unstage' || busy === 'commit'
  return (
    <section className="git-commit" aria-label="Commit">
      <textarea aria-label="Commit message" placeholder="Commit message (Ctrl+Enter to commit)" rows={3} maxLength={100_000} value={message}
        disabled={busy !== null} onChange={event => props.onMessageChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (canCommit) props.onCommit() }
        }} />

      {hooks && (
        <div className="git-hooks" role="alertdialog" aria-label="Approve repository hooks">
          <p><strong>This repository has hooks that a commit would run:</strong> {hooks.map(name => formatReviewText(name)).join(', ')}.</p>
          <p>Hooks are programs in the repository&rsquo;s hooks folder, and a commit runs them with your permissions. Allow them only if you recognise them. You will be asked again if any of them changes.</p>
          <div className="git-hooks-actions">
            <button type="button" className="primary-button" onClick={props.onApproveHooks}>Allow these hooks and commit</button>
            <button type="button" onClick={props.onDismissHooks}>Don&rsquo;t commit</button>
          </div>
        </div>
      )}

      <div className="git-commit-row">
        <button type="button" disabled={!props.canDraft || busy !== null} onClick={props.onDraft} title={props.draftTitle}>Draft with Copilot</button>
        {writing && <button type="button" onClick={props.onCancel} title="Stop what Git is doing now">Cancel</button>}
        <button type="button" className="primary-button git-commit-button" disabled={!canCommit} onClick={props.onCommit}>
          {busy === 'commit' ? 'Committing…' : `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`}
        </button>
      </div>
      {blocker && busy === null && hooks === null && <p className="git-note">{blocker}</p>}
      {writing && props.progress.trim() !== '' && <pre className="git-progress" aria-live="polite" aria-label="Output while Git works">{props.progress}</pre>}
    </section>
  )
}
