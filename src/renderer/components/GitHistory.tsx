import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { GitLogEntry } from '../../main/git-types.js'
import { errorMessage } from '../errors.js'

const PAGE_SIZE = 50

/** The parent remounts History when the repository or its observed tip changes. */
export function GitHistory({ profileId, repoId, headOid }: { profileId: string; repoId: string; headOid: string | null }): JSX.Element {
  const [entries, setEntries] = useState<GitLogEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [request, setRequest] = useState<{ skip: number; cursor: string | null }>({ skip: 0, cursor: null })
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!headOid) return
    let stale = false
    window.copilotDesktop.gitLogPage(profileId, repoId, headOid, PAGE_SIZE, request.skip, request.cursor)
      .then(page => {
        if (stale) return
        if (page.headOid !== headOid) throw new Error('History changed. Reload this page.')
        setEntries(current => page.restart ? page.entries : [...current, ...page.entries])
        setCursor(page.cursor)
        setDone(page.entries.length < PAGE_SIZE)
      })
      .catch((cause: unknown) => { if (!stale) setError(errorMessage(cause)) })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [profileId, repoId, headOid, request])

  const nextPage = (): void => {
    setError(null)
    setLoading(true)
    setRequest({ skip: entries.length, cursor })
  }
  return (
    <div className="git-history">
      {error && <p className="git-message git-message-error" role="alert">{error}</p>}
      {!headOid && <p className="git-message" role="status">No commits yet.</p>}
      {entries.length > 0 && <ol className="git-log">
        {entries.map(entry => (
          <li key={entry.hash}>
            <span className="git-log-subject" title={entry.subject}>{entry.subject}</span>
            {entry.refs.length > 0 && <span className="git-log-refs">{entry.refs.join(', ')}</span>}
            <span className="git-log-meta"><code>{entry.hash.slice(0, 7)}</code> · {entry.author} · {new Date(entry.date).toLocaleDateString()}</span>
          </li>
        ))}
      </ol>}
      {headOid && !done && <button type="button" disabled={loading} onClick={nextPage}>{loading ? 'Loading…' : error ? 'Retry' : 'Load more'}</button>}
    </div>
  )
}
