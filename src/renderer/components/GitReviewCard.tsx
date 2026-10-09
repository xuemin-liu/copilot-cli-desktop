import type { JSX } from 'react'
import { MAX_REVIEW_VALUE_CHARS, formatReviewText, isReviewable } from '../../main/git-review-format.js'
import type { GitReviewItem } from '../../main/git-types.js'

export interface GitReviewCardProps {
  items: readonly GitReviewItem[]
  working: boolean
  onTrust(): void
}

/**
 * Lists a repository's own settings that can make Git run programs, in full, and offers to trust exactly those. What is
 * trusted is the hash of the complete values, so nothing is shortened here: a value can hide a command behind padding.
 */
export function GitReviewCard({ items, working, onTrust }: GitReviewCardProps): JSX.Element {
  const reviewable = isReviewable(items)
  return (
    <section className="git-review" aria-label="Review repository settings">
      <h3>This repository needs your review</h3>
      <p>Its own settings can make Git run programs. Nothing in it has been read yet. Trust it only if you recognise every setting below, in full.</p>
      <ul>
        {items.map(item => (
          <li key={`${item.key}=${item.value}`}>
            <code className="git-review-key">{formatReviewText(item.key)}</code>
            <code className="git-review-value">{formatReviewText(item.value)}</code>
            {item.value.length > 200 && <small>{item.value.length.toLocaleString()} characters, shown in full</small>}
          </li>
        ))}
      </ul>
      <p className="git-review-legend">Text in ⟦ ⟧ marks something that would otherwise be invisible, such as a long run of spaces or a line break.</p>
      {!reviewable && (
        <p className="git-review-blocked" role="alert">
          A setting here is longer than {MAX_REVIEW_VALUE_CHARS.toLocaleString()} characters, which is too long to review properly. Inspect this repository&rsquo;s configuration in a terminal instead.
        </p>
      )}
      <button type="button" className="primary-button" disabled={working || !reviewable} onClick={onTrust}>Trust this repository</button>
    </section>
  )
}
