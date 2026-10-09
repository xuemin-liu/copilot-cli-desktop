import type { JSX } from 'react'
import { formatReviewText } from '../../main/git-review-format.js'

export type GitSyncKind = 'fetch' | 'pull' | 'push'

export interface GitSyncBarProps {
  /** The branch's upstream, or null when it has none. */
  upstream: string | null
  ahead: number
  behind: number
  /** No current branch (detached HEAD) or no commits yet: nothing to pull or push. */
  noBranch: boolean
  /** Another write is running; only the one that owns it can be cancelled. */
  locked: boolean
  /** The network operation running now, or null. */
  running: GitSyncKind | null
  /** What it has printed so far. */
  progress: string
  /** Set when the branch has no upstream and the person has to say where to publish it. */
  publish: { branch: string; remotes: readonly string[]; remote: string } | null
  onSync(kind: GitSyncKind): void
  onChooseRemote(remote: string): void
  onPublish(): void
  onDismissPublish(): void
  onCancel(): void
}

/** Why Pull is unavailable, or null when it is available. */
export function pullBlocker(upstream: string | null, behind: number, noBranch: boolean): string | null {
  if (noBranch) return 'There is no current branch to pull into.'
  if (upstream === null) return 'This branch has no upstream to pull from.'
  if (behind === 0) return 'Nothing to pull. Fetch first to look for new commits.'
  return null
}

/** Why Push is unavailable, or null when it is available. A branch with no upstream can be published. */
export function pushBlocker(upstream: string | null, ahead: number, noBranch: boolean): string | null {
  if (noBranch) return 'There is no current branch to push.'
  if (upstream !== null && ahead === 0) return 'Nothing to push.'
  return null
}

/** Fetch, Pull and Push for the selected repository, with the confirmation a first push needs and live output while one runs. */
export function GitSyncBar(props: GitSyncBarProps): JSX.Element {
  const { upstream, ahead, behind, noBranch, locked, running, publish } = props
  const pull = pullBlocker(upstream, behind, noBranch)
  const push = pushBlocker(upstream, ahead, noBranch)
  return (
    <section className="git-sync" aria-label="Sync">
      <div className="git-sync-row">
        <button type="button" disabled={locked} onClick={() => props.onSync('fetch')} title="Look for new commits on the remote. No file in this folder changes.">
          {running === 'fetch' ? 'Fetching…' : 'Fetch'}
        </button>
        <button type="button" disabled={locked || pull !== null} onClick={() => props.onSync('pull')}
          title={pull ?? `Move this branch forward to ${upstream ?? 'its upstream'}. Refused, and nothing changes, unless it is a fast-forward.`}>
          {running === 'pull' ? 'Pulling…' : behind > 0 ? `Pull ↓${behind}` : 'Pull'}
        </button>
        <button type="button" disabled={locked || push !== null} onClick={() => props.onSync('push')}
          title={push ?? (upstream === null ? 'Publish this branch to a remote' : `Send the ${ahead} new commit${ahead === 1 ? '' : 's'} to ${upstream}. Never forced.`)}>
          {running === 'push' ? 'Pushing…' : upstream === null ? 'Publish…' : ahead > 0 ? `Push ↑${ahead}` : 'Push'}
        </button>
        {running !== null && <button type="button" onClick={props.onCancel} title="Stop what Git is doing now">Cancel</button>}
      </div>

      {publish && (
        <div className="git-publish" role="alertdialog" aria-label="Publish this branch">
          <p><strong>Publish &ldquo;{formatReviewText(publish.branch)}&rdquo;?</strong> It is not on any remote yet. This sends the branch&rsquo;s commits to the remote you choose and makes it this branch&rsquo;s upstream.</p>
          <label className="git-publish-remote">Remote
            <select value={publish.remote} onChange={event => props.onChooseRemote(event.target.value)}>
              {publish.remotes.map(name => <option key={name} value={name}>{formatReviewText(name)}</option>)}
            </select>
          </label>
          <div className="git-hooks-actions">
            <button type="button" className="primary-button" disabled={locked} onClick={props.onPublish}>Publish to {formatReviewText(publish.remote)}</button>
            <button type="button" onClick={props.onDismissPublish}>Not now</button>
          </div>
        </div>
      )}

      {running !== null && props.progress.trim() !== '' && <pre className="git-progress" aria-live="polite" aria-label="Output while Git works">{props.progress}</pre>}
    </section>
  )
}
