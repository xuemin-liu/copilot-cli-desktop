import { useState } from 'react'
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

export interface NumberedDiffLine {
  text: string
  kind: DiffLineKind
  /** Line number in the old file (deleted and context lines), or null. */
  oldLine: number | null
  /** Line number in the new file (added and context lines), or null. */
  newLine: number | null
  /** Where the line sits in the new file, the same however much context the diff carries: its new line number, or for a
   * deleted line, half a line before the new line that follows it. Null for lines without a number. */
  position: number | null
}

/** Give each diff line its file line numbers from the hunk headers. Inside a hunk, a line is content classified by its
 * first character for as long as the header's counts say the hunk continues (so `+++i;` is an added line, not a file
 * header); `\ No newline at end of file` markers carry no number. Headers, metadata and lines outside any hunk carry
 * none either. */
export function numberDiffLines(lines: readonly string[]): NumberedDiffLine[] {
  let oldNext = 0
  let newNext = 0
  let oldLeft = 0
  let newLeft = 0
  return lines.map(text => {
    if (oldLeft === 0 && newLeft === 0) {
      const kind = diffLineKind(text)
      if (kind === 'hunk') {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
        if (header) {
          oldNext = Number(header[1]); oldLeft = header[2] === undefined ? 1 : Number(header[2])
          newNext = Number(header[3]); newLeft = header[4] === undefined ? 1 : Number(header[4])
        }
      }
      return { text, kind, oldLine: null, newLine: null, position: null }
    }
    if (text.startsWith('\\')) return { text, kind: 'context', oldLine: null, newLine: null, position: null }
    if (text.startsWith('+') && newLeft > 0) { newLeft -= 1; return { text, kind: 'add', oldLine: null, newLine: newNext, position: newNext++ } }
    if (text.startsWith('-') && oldLeft > 0) { oldLeft -= 1; return { text, kind: 'del', oldLine: oldNext++, newLine: null, position: newNext - 0.5 } }
    oldLeft = Math.max(0, oldLeft - 1)
    newLeft = Math.max(0, newLeft - 1)
    return { text, kind: 'context', oldLine: oldNext++, newLine: newNext, position: newNext++ }
  })
}

/** The added and deleted lines of a diff with their line numbers, as one string: equal for two diffs of the same change
 * whatever context they carry, so switching to the whole file does not look like the change moved. */
export function diffChangeSignature(text: string): string {
  return numberDiffLines(text.replace(/\r\n/g, '\n').split('\n'))
    .filter(line => line.kind === 'add' || line.kind === 'del')
    .map(line => `${line.oldLine ?? ''}:${line.newLine ?? ''}:${line.text}`)
    .join('\n')
}

export interface DiffCommentAnchor {
  side: 'new' | 'old'
  line: number
  /** The diff line as shown. */
  quote: string
  /** Index of the line in the diff as shown, to place it relative to private-key blocks. */
  order: number
  /** `NumberedDiffLine.position`, so comments can be sent in reading order whichever view they were written in. */
  position: number
}

/** The key a comment is stored under: the side and line it belongs to. Null for lines that cannot take a comment. */
export function diffCommentKey(line: NumberedDiffLine): string | null {
  if (line.newLine !== null) return `new:${line.newLine}`
  if (line.oldLine !== null) return `old:${line.oldLine}`
  return null
}

export interface DiffCommentsProps {
  /** Comment text by `diffCommentKey`. */
  items: ReadonlyMap<string, string>
  /** `text` null removes the comment. */
  onChange(key: string, anchor: DiffCommentAnchor, text: string | null): void
}

const NOTICE: Record<string, string> = {
  binary: 'Binary file: no text diff.',
  directory: 'Untracked folder. Its files are listed once Git sees them individually.',
  'too-large': 'This file is too large to show.',
  empty: 'No textual change.',
}

const MAX_COMMENT_INPUT = 2_000

function CommentEditor({ initial, onSave, onCancel, onRemove }: { initial: string; onSave(text: string): void; onCancel(): void; onRemove: (() => void) | null }): JSX.Element {
  const [draft, setDraft] = useState(initial)
  return (
    <span className="git-diff-comment-editor">
      <textarea className="git-diff-comment-input" value={draft} maxLength={MAX_COMMENT_INPUT} rows={2} autoFocus
        aria-label="Comment on this line" placeholder="What should change here?"
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); onCancel() }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onSave(draft) }
        }} />
      <span className="git-diff-comment-actions">
        <button type="button" onClick={() => onSave(draft)} title="Save this comment (Ctrl+Enter)">Save</button>
        <button type="button" onClick={onCancel} title="Discard the edit (Esc)">Cancel</button>
        {onRemove && <button type="button" onClick={onRemove} title="Remove this comment">Remove</button>}
      </span>
    </span>
  )
}

/** A unified diff as plain text lines. Every line is a text node: nothing from the repository is ever parsed as markup.
 * With `comments`, each numbered line can take a comment, kept by the caller and shown under the line. */
export function GitDiffView({ diff, comments, cursorKey, onCursor }: {
  diff: GitDiff; comments?: DiffCommentsProps; cursorKey?: string | null; onCursor?: (anchor: DiffCommentAnchor) => void
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  if (diff.kind !== 'text') return <p className="git-diff-notice" role="status">{NOTICE[diff.kind] ?? 'Nothing to show.'}</p>
  const lines = diff.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const shown = numberDiffLines(lines.slice(0, MAX_RENDERED_LINES))
  const cutOff = lines.length > shown.length || diff.truncated
  return (
    <div className="git-diff" role="region" aria-label={`Diff of ${diff.path}`}>
      <div className="git-diff-stats" aria-hidden={diff.added === null}>
        {diff.added !== null && <span className="git-diff-added">+{diff.added}</span>}
        {diff.deleted !== null && <span className="git-diff-deleted">−{diff.deleted}</span>}
      </div>
      <pre className="git-diff-lines">
        {shown.map((line, index) => {
          const key = diffCommentKey(line)
          const existing = key !== null ? comments?.items.get(key) : undefined
          const where = line.newLine !== null ? `line ${line.newLine}` : `old line ${line.oldLine}`
          const anchor = (): DiffCommentAnchor => ({ side: line.newLine !== null ? 'new' : 'old', line: line.newLine ?? line.oldLine ?? 0, quote: line.text, order: index, position: line.position ?? 0 })
          return (
            <span key={index} className={`git-diff-row${existing !== undefined ? ' git-diff-row-commented' : ''}`}>
              <span className={`git-diff-line git-diff-${line.kind}${key !== null && key === cursorKey ? ' git-diff-cursor' : ''}`}
                onMouseEnter={() => { if (key !== null) onCursor?.(anchor()) }}
                onClick={() => { if (key !== null) onCursor?.(anchor()) }}>
                {key !== null && comments && (
                  <button type="button" className="git-diff-gutter" aria-label={`Comment on ${where}`} title={existing !== undefined ? 'Edit the comment on this line' : 'Comment on this line'}
                    onClick={() => setEditing(current => current === key ? null : key)}>{existing !== undefined ? '✎' : '+'}</button>
                )}
                {line.text === '' ? ' ' : line.text}{'\n'}
              </span>
              {key !== null && comments && editing === key && (
                <CommentEditor initial={existing ?? ''}
                  onSave={text => { comments.onChange(key, anchor(), text.trim() === '' ? null : text); setEditing(null) }}
                  onCancel={() => setEditing(null)}
                  onRemove={existing !== undefined ? () => { comments.onChange(key, anchor(), null); setEditing(null) } : null} />
              )}
              {key !== null && comments && editing !== key && existing !== undefined && (
                <span className="git-diff-comment" role="note" aria-label={`Comment on ${where}`}>
                  <span className="git-diff-comment-text">{existing}</span>
                  <button type="button" className="git-diff-comment-edit" onClick={() => setEditing(key)} title="Edit this comment">Edit</button>
                </span>
              )}
            </span>
          )
        })}
      </pre>
      {cutOff && (
        <p className="git-diff-notice" role="status">
          {lines.length > shown.length ? `Showing the first ${shown.length.toLocaleString()} of ${lines.length.toLocaleString()} lines.` : 'The diff is larger than the panel reads, so it ends early.'}
          {comments ? ' Lines past this point cannot be commented on.' : ''}
        </p>
      )}
    </div>
  )
}
