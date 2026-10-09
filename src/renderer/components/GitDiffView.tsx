import type { JSX } from 'react'
import type { GitDiffView as GitDiff } from '../../main/git-types.js'

const MAX_RENDERED_LINES = 4_000

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context'

/** Classify one line of a unified diff for colouring. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity ') || line.startsWith('rename ') || line.startsWith('old mode') || line.startsWith('new mode')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

const NOTICE: Record<string, string> = {
  binary: 'Binary file: no text diff.',
  directory: 'Untracked folder. Its files are listed once Git sees them individually.',
  'too-large': 'This file is too large to show.',
  empty: 'No textual change.',
}

/** A unified diff as plain text lines. Every line is a text node: nothing from the repository is ever parsed as markup. */
export function GitDiffView({ diff }: { diff: GitDiff }): JSX.Element {
  if (diff.kind !== 'text') return <p className="git-diff-notice" role="status">{NOTICE[diff.kind] ?? 'Nothing to show.'}</p>
  const lines = diff.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const shown = lines.slice(0, MAX_RENDERED_LINES)
  return (
    <div className="git-diff" role="region" aria-label={`Diff of ${diff.path}`}>
      <div className="git-diff-stats" aria-hidden={diff.added === null}>
        {diff.added !== null && <span className="git-diff-added">+{diff.added}</span>}
        {diff.deleted !== null && <span className="git-diff-deleted">−{diff.deleted}</span>}
      </div>
      <pre className="git-diff-lines">
        {shown.map((line, index) => <span key={index} className={`git-diff-line git-diff-${diffLineKind(line)}`}>{line === '' ? ' ' : line}{'\n'}</span>)}
      </pre>
      {(lines.length > shown.length || diff.truncated) && (
        <p className="git-diff-notice" role="status">
          {lines.length > shown.length ? `Showing the first ${shown.length.toLocaleString()} of ${lines.length.toLocaleString()} lines.` : 'The diff is larger than the panel reads, so it ends early.'}
        </p>
      )}
    </div>
  )
}
