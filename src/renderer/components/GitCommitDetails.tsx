import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { GitCommitDetails, GitLogEntry } from '../../main/git-types.js'
import { errorMessage } from '../errors.js'
import { GitDiffView } from './GitDiffView.js'

type ChangedFile = GitCommitDetails['files'][number]
interface CommitProps { profileId: string; repoId: string; entry: GitLogEntry }

function CommitPatch({ profileId, repoId, entry, file }: CommitProps & { file: ChangedFile }): JSX.Element {
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    if (!file.binary) window.copilotDesktop.gitCommitDiff(profileId, repoId, entry.hash, file.path)
      .then(value => { if (!stale) setPatch(value) })
      .catch((cause: unknown) => { if (!stale) setError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, repoId, entry.hash, file])
  if (error) return <p role="alert" className="git-message git-message-error">{error}</p>
  if (!patch && !file.binary) return <p role="status">Loading diff…</p>
  return <GitDiffView diff={{ entryId: entry.hash, path: file.path, kind: file.binary ? 'binary' : patch?.text ? 'text' : 'empty',
    text: patch?.text ?? '', truncated: patch?.truncated ?? false, added: file.added, deleted: file.deleted }} />
}

export function CommitDetails({ profileId, repoId, entry }: CommitProps): JSX.Element {
  const [details, setDetails] = useState<GitCommitDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    window.copilotDesktop.gitCommitDetails(profileId, repoId, entry.hash)
      .then(value => { if (!stale) setDetails(value) })
      .catch((cause: unknown) => { if (!stale) setError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, repoId, entry.hash])
  return <section className="git-commit-details" aria-label="Commit details">
    <code>{entry.hash}</code>
    {entry.parents.length > 1 && <p>Changes against first parent {entry.parents[0]?.slice(0, 7)}</p>}
    {error && <p role="alert" className="git-message git-message-error">{error}</p>}
    {!error && !details && <p role="status">Loading commit…</p>}
    {details?.body && <pre className="git-commit-body">{details.body}</pre>}
    {details && details.files.length === 0 && !details.truncated && <p>No files changed.</p>}
    {details && details.files.map(file => <div key={file.path}>
      <button type="button" className="git-commit-file" aria-expanded={path === file.path}
        onClick={() => setPath(path === file.path ? null : file.path)}>{file.path}</button>
      {path === file.path && <CommitPatch profileId={profileId} repoId={repoId} entry={entry} file={file} />}
    </div>)}
    {details?.truncated && <p role="status">The changed file list was cut short.</p>}
  </section>
}
