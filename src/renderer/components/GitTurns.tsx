import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { TurnFiles, TurnSummary } from '../../main/checkpoint-store.js'
import { errorMessage } from '../errors.js'
import { GitDiffView } from './GitDiffView.js'

type ChangedFile = TurnFiles['files'][number]
interface TurnProps { profileId: string; repoId: string; turn: TurnSummary }

const turnKey = (turn: TurnSummary): string => `${turn.sessionId}\n${turn.n}`

function TurnPatch({ profileId, repoId, turn, file }: TurnProps & { file: ChangedFile }): JSX.Element {
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    if (!file.binary) window.copilotDesktop.gitTurnDiff(profileId, repoId, turn.sessionId, turn.n, file.path)
      .then(value => { if (!stale) setPatch(value) })
      .catch((cause: unknown) => { if (!stale) setError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, repoId, turn.sessionId, turn.n, file])
  if (error) return <p role="alert" className="git-message git-message-error">{error}</p>
  if (!patch && !file.binary) return <p role="status">Loading diff…</p>
  return <GitDiffView diff={{ entryId: `${turnKey(turn)}\n${file.path}`, path: file.path, kind: file.binary ? 'binary' : patch?.text ? 'text' : 'empty',
    text: patch?.text ?? '', truncated: patch?.truncated ?? false, added: file.added, deleted: file.deleted }} />
}

function TurnDetails({ profileId, repoId, turn }: TurnProps): JSX.Element {
  const [details, setDetails] = useState<TurnFiles | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    if (turn.diffable && !turn.unchanged) window.copilotDesktop.gitTurnFiles(profileId, repoId, turn.sessionId, turn.n)
      .then(value => { if (!stale) setDetails(value) })
      .catch((cause: unknown) => { if (!stale) setError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, repoId, turn.sessionId, turn.n, turn.diffable, turn.unchanged])
  return <section className="git-commit-details" aria-label="Turn details">
    {turn.state === 'open' && <p role="status">This turn is still running. Its changes can be shown when it ends.</p>}
    {turn.state === 'incomplete' && <p role="status">No changes to show: {turn.note ?? 'this turn has no snapshot of its end'}.</p>}
    {turn.unchanged && <p>No files changed during this turn.</p>}
    {turn.diffable && !turn.unchanged && <p className="git-turn-observed">Changes observed during this turn. They can include edits you or another session made at the same time.</p>}
    {error && <p role="alert" className="git-message git-message-error">{error}</p>}
    {turn.diffable && !turn.unchanged && !error && !details && <p role="status">Loading changes…</p>}
    {details && details.files.length === 0 && !details.truncated && <p>No files changed during this turn.</p>}
    {details && details.files.map(file => <div key={file.path}>
      <button type="button" className="git-commit-file" aria-expanded={path === file.path}
        onClick={() => setPath(path === file.path ? null : file.path)}>{file.path}</button>
      {path === file.path && <TurnPatch profileId={profileId} repoId={repoId} turn={turn} file={file} />}
    </div>)}
    {details?.truncated && <p role="status">The changed file list was cut short.</p>}
    {turn.notCaptured > 0 && <p role="status" title={turn.notCapturedSample.join('\n')}>
      {turn.notCaptured === 1 ? '1 path was' : `${turn.notCaptured} paths were`} left out of the snapshot (links, files over 25 MB, submodules or embedded repositories).
    </p>}
  </section>
}

const stateLabel = (turn: TurnSummary): string => turn.state === 'open' ? 'Running' : turn.state === 'incomplete' ? 'No snapshot' : turn.unchanged ? 'No changes' : ''

/**
 * The turns of the sessions that worked in this repository, newest first, each with the changes observed between its
 * start and its end. The parent remounts it when the repository changes; `refreshKey` reloads the list.
 */
export function GitTurns({ profileId, repoId, refreshKey }: { profileId: string; repoId: string; refreshKey: unknown }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<{ available: boolean; turns: TurnSummary[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const refresh = useCallback(() => setReload(value => value + 1), [])

  useEffect(() => {
    let stale = false
    window.copilotDesktop.gitTurns(profileId, repoId)
      .then(value => { if (!stale) { setView(value); setError(null) } })
      .catch((cause: unknown) => { if (!stale) setError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, repoId, refreshKey, reload])

  return (
    <div className="git-turns">
      {error && <p className="git-message git-message-error" role="alert">{error}</p>}
      {!error && !view && <p className="git-message" role="status">Loading turns…</p>}
      {view && !view.available && <p className="git-message" role="status">Turn checkpoints are not available here. They are turned on in Settings, need Git, and are not kept for a repository above the project folder.</p>}
      {view?.available && view.turns.length === 0 && <p className="git-message" role="status">No turns yet. Each prompt you send in a Copilot session of this repository is listed here with the files it changed.</p>}
      {view && view.turns.length > 0 && <ol className="git-log">
        {view.turns.map(turn => {
          const key = turnKey(turn)
          const state = stateLabel(turn)
          return <li key={key}>
            <button type="button" className="git-log-subject" aria-expanded={selected === key} title={turn.label}
              onClick={() => setSelected(selected === key ? null : key)}>{turn.label || '(no prompt text)'}</button>
            <span className="git-log-meta">{new Date(turn.startedAt).toLocaleString()}{state ? ` · ${state}` : ''}</span>
            {selected === key && <TurnDetails profileId={profileId} repoId={repoId} turn={turn} />}
          </li>
        })}
      </ol>}
      {view && <button type="button" onClick={refresh}>Refresh</button>}
    </div>
  )
}
