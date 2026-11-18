import type { JSX } from 'react'

/** Keep the summary and Cancel visible even when a hook or remote prints a long transcript. */
export function GitOutput({ text, live = false }: { text: string; live?: boolean }): JSX.Element | null {
  if (!text.trim()) return null
  return (
    <details className="git-output-details">
      <summary>{live ? 'Live Git output' : 'Git output'}</summary>
      <pre aria-live={live ? 'polite' : undefined} className={live ? 'git-progress' : 'git-output'} aria-label={live ? 'Output while Git works' : 'What Git printed'}>{text}</pre>
    </details>
  )
}
