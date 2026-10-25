import { useState, type JSX } from 'react'
import type { SessionHistoryEntry } from '../../main/types.js'
import { filterSessionHistory, folderName, formatLastUsed, historyTitle } from '../session-history.js'

/** The sessions Copilot stored, newest first, to find one again after its tab was closed and reopen it. */
export function SessionHistoryDialog({ entries, loadError, pendingSessionId, openError, now = Date.now(), onOpen, onClose }: {
  /** null while loading. */
  entries: SessionHistoryEntry[] | null
  loadError: string | null
  pendingSessionId: string | null
  openError: string | null
  now?: number
  onOpen: (sessionId: string) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const shown = entries ? filterSessionHistory(entries, query) : []
  const busy = pendingSessionId !== null
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="input-dialog session-history" role="dialog" aria-modal="true" aria-labelledby="session-history-title"
        onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() } }}>
        <h2 id="session-history-title">Session history</h2>
        <label htmlFor="session-history-search">Search name, prompts, branch or folder</label>
        <input id="session-history-search" type="search" autoFocus value={query} maxLength={200} disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && shown[0] && !busy) { event.preventDefault(); onOpen(shown[0].sessionId) } }} />
        {loadError && <p className="input-dialog-error" role="alert">{loadError}</p>}
        {openError && <p className="input-dialog-error" role="alert">{openError}</p>}
        <ul className="session-history-list" aria-label="Stored sessions" aria-busy={entries === null}>
          {entries === null && !loadError && <li className="session-history-empty">Reading stored sessions…</li>}
          {entries !== null && shown.length === 0 && (
            <li className="session-history-empty">{entries.length === 0 ? 'No stored sessions with a prompt yet.' : 'No session matches.'}</li>
          )}
          {shown.map((entry) => {
            const title = historyTitle(entry)
            const first = entry.firstPrompt && entry.firstPrompt !== title ? entry.firstPrompt : null
            const latest = entry.lastPrompt && entry.lastPrompt !== entry.firstPrompt ? entry.lastPrompt : null
            const project = entry.projectName ?? (entry.cwd ? folderName(entry.cwd) : null)
            return (
              <li key={entry.sessionId}>
                <button type="button" className="session-history-entry" disabled={busy} title={entry.cwd ?? undefined}
                  onClick={() => onOpen(entry.sessionId)}>
                  <span className="session-history-title">{title}</span>
                  {first && <span className="session-history-prompt">{first}</span>}
                  {latest && <span className="session-history-prompt">Latest: {latest}</span>}
                  <span className="session-history-meta">
                    {[project, entry.branch ? `⎇ ${entry.branch}` : null, formatLastUsed(entry.updatedAt, now)].filter(Boolean).join(' · ')}
                    {entry.openTabId ? <span className="session-history-badge">Open</span>
                      : entry.projectName === null && <span className="session-history-badge">Adds its project</span>}
                    {pendingSessionId === entry.sessionId && <span className="session-history-badge">Opening…</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="input-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
