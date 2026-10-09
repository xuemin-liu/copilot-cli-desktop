import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { GitDiffView as GitDiff, GitEntryView, GitLogEntry, GitProjectView, GitRepoStatusView, GitRepoSummary } from '../../main/git-types.js'
import { composeCommitMessagePrompt, composeDiffPrompt } from '../../main/git-prompt.js'
import { errorMessage } from '../errors.js'
import { insertIntoPrompt } from '../prompt-insert.js'
import { GitDiffView } from './GitDiffView.js'

export interface GitPanelProps {
  profileId: string
  /** The session whose prompt box receives text, or null when there is none or it lives in another window. */
  promptTarget: { id: string; title: string } | null
  /** True when the panel is replacing the session area because the window is narrow. */
  takeover?: boolean
  onClose(): void
  /** How text reaches a prompt box. Defaults to the app's own prompt insertion. */
  insert?: (tabId: string, text: string) => void
}

type Tab = 'changes' | 'history'
interface Selection { path: string; staged: boolean }

const repoStorageKey = (profileId: string): string => `git-repo:${profileId}`
const MAX_DRAFT_FILES = 30
const HISTORY_PAGE = 50

function readStoredRepo(profileId: string): string | null {
  try { return localStorage.getItem(repoStorageKey(profileId)) } catch { return null }
}

/** Opens the project in the main process, follows its pushed changes, and closes it again on unmount. */
function useGitProject(profileId: string): { view: GitProjectView | null; error: string | null; busy: boolean; rescan(): void; replace(view: GitProjectView): void } {
  const [view, setView] = useState<GitProjectView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let disposed = false
    setView(null)
    setError(null)
    // The first view arrives both as the open's result and as an event; treating both as "latest" is harmless.
    const off = window.copilotDesktop.onGitChanged(payload => { if (!disposed && payload.profileId === profileId) setView(payload.view) })
    window.copilotDesktop.gitOpen(profileId).then(next => { if (!disposed) setView(next) }).catch((cause: unknown) => { if (!disposed) setError(errorMessage(cause)) })
    return () => { disposed = true; off(); void window.copilotDesktop.gitClose(profileId).catch(() => undefined) }
  }, [profileId])
  const rescan = useCallback(() => {
    setBusy(true)
    setError(null)
    window.copilotDesktop.gitRescan(profileId).then(setView).catch((cause: unknown) => setError(errorMessage(cause))).finally(() => setBusy(false))
  }, [profileId])
  return { view, error, busy, rescan, replace: setView }
}

function pickRepo(view: GitProjectView, stored: string | null): GitRepoSummary | null {
  return view.repos.find(repo => repo.relativePath === stored)
    ?? view.repos.find(repo => repo.state === 'ready' && repo.changeCount > 0)
    ?? view.repos[0] ?? null
}

const stateLabel = (repo: GitRepoSummary): string =>
  repo.state === 'needs-review' ? 'Needs review' : repo.state === 'error' ? 'Error'
    : repo.changeCount > 0 ? `${repo.changeCount} change${repo.changeCount === 1 ? '' : 's'}` : 'Clean'

function RepoRow({ repo, selected, onSelect }: { repo: GitRepoSummary; selected: boolean; onSelect(): void }): JSX.Element {
  const tone = repo.state === 'needs-review' ? 'review' : repo.state === 'error' ? 'error' : repo.changeCount > 0 ? 'dirty' : (repo.behind ?? 0) > 0 ? 'behind' : 'clean'
  return (
    <button type="button" className={`git-repo git-repo-${tone}${selected ? ' git-repo-selected' : ''}`} aria-pressed={selected} onClick={onSelect}
      title={repo.relativePath === '.' ? repo.name : repo.relativePath}>
      <span className="git-repo-dot" aria-hidden="true" />
      <span className="git-repo-name">{repo.name}{repo.kind === 'parent' && <em> (parent)</em>}</span>
      <span className="git-repo-meta">{[repo.branch ?? (repo.detached ? 'detached' : ''), stateLabel(repo), (repo.behind ?? 0) > 0 ? `↓${repo.behind}` : ''].filter(Boolean).join(' · ')}</span>
    </button>
  )
}

function fileParts(path: string): { name: string; folder: string } {
  const parts = path.replace(/\/$/, '').split('/')
  const name = parts.pop() ?? path
  return { name: path.endsWith('/') ? `${name}/` : name, folder: parts.join('/') }
}

function EntryRow({ entry, code, selected, onSelect }: { entry: GitEntryView; code: string; selected: boolean; onSelect(): void }): JSX.Element {
  const { name, folder } = fileParts(entry.path)
  return (
    <button type="button" className={`git-entry${selected ? ' git-entry-selected' : ''}`} aria-pressed={selected} onClick={onSelect}
      title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}>
      <span className={`git-code git-code-${code === '?' ? 'untracked' : code}`} aria-hidden="true">{code}</span>
      <span className="git-entry-name">{name}</span>
      {folder && <span className="git-entry-folder">{folder}</span>}
    </button>
  )
}

function EntryGroup({ title, entries, codeOf, staged, selection, onSelect }: {
  title: string; entries: GitEntryView[]; codeOf(entry: GitEntryView): string; staged: boolean; selection: Selection | null; onSelect(entry: GitEntryView, staged: boolean): void
}): JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <section className="git-group" aria-label={title}>
      <h3>{title} ({entries.length})</h3>
      {entries.map(entry => (
        <EntryRow key={`${staged ? 's' : 'u'}:${entry.path}`} entry={entry} code={codeOf(entry)}
          selected={selection?.path === entry.path && selection.staged === staged} onSelect={() => onSelect(entry, staged)} />
      ))}
    </section>
  )
}

export function GitPanel({ profileId, promptTarget, takeover = false, onClose, insert = insertIntoPrompt }: GitPanelProps): JSX.Element {
  const { view, error, busy, rescan, replace } = useGitProject(profileId)
  const [storedRepo, setStoredRepo] = useState(() => readStoredRepo(profileId))
  const [tab, setTab] = useState<Tab>('changes')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [status, setStatus] = useState<GitRepoStatusView | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ key: string; value: GitDiff } | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [log, setLog] = useState<{ repoId: string; entries: GitLogEntry[]; done: boolean } | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const repo = view ? pickRepo(view, storedRepo) : null
  const ready = repo?.state === 'ready'

  // The file list: reload when this repository's list, branch or commit changes.
  useEffect(() => {
    if (!repo || repo.state !== 'ready') { setStatus(null); return }
    let stale = false
    window.copilotDesktop.gitStatus(profileId, repo.id)
      .then(next => { if (!stale) { setStatus(next); setStatusError(null) } })
      .catch((cause: unknown) => { if (!stale) setStatusError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, repo?.id, repo?.state, repo?.generation, repo?.headOid, repo?.branch, repo?.ahead, repo?.behind]) // eslint-disable-line react-hooks/exhaustive-deps

  const currentStatus = status && repo && status.repoId === repo.id ? status : null
  const selectedEntry = ((): GitEntryView | null => {
    if (!selection || !currentStatus) return null
    const list = selection.staged ? currentStatus.staged : [...currentStatus.unstaged, ...currentStatus.untracked, ...currentStatus.conflicted]
    return list.find(entry => entry.path === selection.path) ?? null
  })()

  // The diff of the selected file: reload on selection, on a changed list, and when the window regains focus.
  const diffKey = repo && selectedEntry && selection ? `${repo.id}:${selectedEntry.id}:${selection.staged}` : null
  useEffect(() => {
    if (!repo || !selectedEntry || !selection || !diffKey) { setDiff(null); setDiffError(null); return }
    let stale = false
    window.copilotDesktop.gitDiff(profileId, repo.id, selectedEntry.id, selection.staged)
      .then(value => { if (!stale) { setDiff({ key: diffKey, value }); setDiffError(null) } })
      .catch((cause: unknown) => { if (!stale) setDiffError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, diffKey, reload]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onFocus = (): void => setReload(count => count + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  // A changed project view means files may have changed under a selection that still exists.
  useEffect(() => { setReload(count => count + 1) }, [view])

  // History.
  useEffect(() => {
    if (tab !== 'history' || !repo || repo.state !== 'ready') return
    let stale = false
    window.copilotDesktop.gitLog(profileId, repo.id, HISTORY_PAGE, 0)
      .then(entries => { if (!stale) { setLog({ repoId: repo.id, entries, done: entries.length < HISTORY_PAGE }); setLogError(null) } })
      .catch((cause: unknown) => { if (!stale) setLogError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, tab, repo?.id, repo?.state, repo?.headOid]) // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = (): void => {
    if (!repo || !log) return
    window.copilotDesktop.gitLog(profileId, repo.id, HISTORY_PAGE, log.entries.length)
      .then(more => setLog(current => current && current.repoId === repo.id ? { ...current, entries: [...current.entries, ...more], done: more.length < HISTORY_PAGE } : current))
      .catch((cause: unknown) => setLogError(errorMessage(cause)))
  }

  const chooseRepo = (next: GitRepoSummary): void => {
    setStoredRepo(next.relativePath)
    setSelection(null)
    setNotice(null)
    setActionError(null)
    try { localStorage.setItem(repoStorageKey(profileId), next.relativePath) } catch { /* Keep the in-memory choice. */ }
  }

  const trust = (): void => {
    if (!repo?.configHash) return
    setWorking(true)
    setActionError(null)
    window.copilotDesktop.gitTrust(profileId, repo.id, repo.configHash).then(replace)
      .catch((cause: unknown) => setActionError(errorMessage(cause))).finally(() => setWorking(false))
  }

  const addToPrompt = (): void => {
    if (!repo || !selection || !diff || diff.key !== diffKey || !promptTarget) return
    insert(promptTarget.id, composeDiffPrompt({ repoName: repo.name, path: selection.path, staged: selection.staged, diff: diff.value }))
    setNotice(`Added to the prompt box of “${promptTarget.title}”. Review it and press Enter to send.`)
  }

  const draftMessage = (): void => {
    if (!repo || !currentStatus || !promptTarget) return
    const staged = currentStatus.staged.slice(0, MAX_DRAFT_FILES)
    setWorking(true)
    setActionError(null)
    Promise.all(staged.map(entry => window.copilotDesktop.gitDiff(profileId, repo.id, entry.id, true).then(value => ({ path: entry.path, diff: value }))))
      .then(parts => {
        insert(promptTarget.id, composeCommitMessagePrompt({ repoName: repo.name, branch: repo.branch, parts }))
        setNotice(`Asked “${promptTarget.title}” to draft a commit message. Review the prompt and press Enter to send.`)
      })
      .catch((cause: unknown) => setActionError(errorMessage(cause))).finally(() => setWorking(false))
  }

  const pickEntry = (entry: GitEntryView, staged: boolean): void => { setSelection({ path: entry.path, staged }); setNotice(null) }
  const canInsert = promptTarget !== null

  return (
    <aside className="git-panel" aria-label="Git">
      <header className="git-panel-header">
        <h2>Git</h2>
        <span className="git-panel-sub">{view ? `${view.repos.length} repositor${view.repos.length === 1 ? 'y' : 'ies'}` : 'Loading…'}</span>
        <button type="button" className="icon-button" aria-label="Rescan repositories" title="Rescan this folder for repositories and refresh" disabled={busy} onClick={rescan}>↻</button>
        <button type="button" className="icon-button" aria-label={takeover ? 'Close Git panel and return to the session' : 'Close Git panel'}
          title={takeover ? 'Back to the session' : 'Close (Ctrl+Shift+G)'} onClick={onClose}>×</button>
      </header>

      {error && <p className="git-message git-message-error" role="alert">{error}</p>}
      {!view && !error && <p className="git-message" role="status">Looking for repositories…</p>}
      {view && !view.git.available && <p className="git-message git-message-error" role="alert">{view.git.error}</p>}
      {view && view.git.available && !view.git.supported && <p className="git-message git-message-error" role="alert">{view.git.error}</p>}
      {view && view.git.available && view.repos.length === 0 && (
        <p className="git-message" role="status">No Git repositories were found in this project folder.{view.notes.length > 0 && ` ${view.notes.join(' ')}`}</p>
      )}
      {view && view.notes.length > 0 && view.repos.length > 0 && <p className="git-note" role="status">{view.notes.join(' ')}</p>}

      {view && view.repos.length > 1 && (
        <div className="git-repos" role="group" aria-label="Repositories">
          {view.repos.map(item => <RepoRow key={item.id} repo={item} selected={item.id === repo?.id} onSelect={() => chooseRepo(item)} />)}
        </div>
      )}

      {repo && (
        <div className="git-repo-view">
          {ready && (
            <div className="git-branch" role="status">
              <span className="git-branch-name">{repo.detached ? 'Detached HEAD' : repo.branch ?? 'No commits yet'}</span>
              {repo.upstream && <span className="git-branch-upstream">{repo.upstream}</span>}
              {(repo.ahead ?? 0) > 0 && <span className="git-ahead">↑{repo.ahead}</span>}
              {(repo.behind ?? 0) > 0 && <span className="git-behind">↓{repo.behind}</span>}
              {view && view.repos.length === 1 && <span className="git-branch-state">{stateLabel(repo)}</span>}
            </div>
          )}

          {repo.state === 'needs-review' && (
            <section className="git-review" aria-label="Review repository settings">
              <h3>This repository needs your review</h3>
              <p>Its own settings can make Git run programs. Nothing in it has been read yet. Trust it only if you recognise these settings.</p>
              <ul>
                {repo.reviewItems.map(item => <li key={`${item.key}=${item.value}`}><code>{item.key}</code> = <code>{item.value.length > 200 ? `${item.value.slice(0, 200)}…` : item.value}</code></li>)}
              </ul>
              <button type="button" className="primary-button" disabled={working} onClick={trust}>Trust this repository</button>
            </section>
          )}

          {repo.state === 'error' && <p className="git-message git-message-error" role="alert">{repo.error ?? 'This repository could not be read.'}</p>}

          {ready && (
            <>
              <div className="git-tabs" role="tablist" aria-label="Repository views">
                <button type="button" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>Changes{repo.changeCount > 0 ? ` (${repo.changeCount})` : ''}</button>
                <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>History</button>
              </div>

              {statusError && <p className="git-message git-message-error" role="alert">{statusError}</p>}

              {tab === 'changes' && (
                <div className="git-changes">
                  {currentStatus && currentStatus.totalEntries === 0 && <p className="git-message" role="status">Nothing to commit. The working tree is clean.</p>}
                  {currentStatus && (
                    <div className="git-files">
                      <EntryGroup title="Conflicts" entries={currentStatus.conflicted} codeOf={() => 'U'} staged={false} selection={selection} onSelect={pickEntry} />
                      <EntryGroup title="Staged" entries={currentStatus.staged} codeOf={entry => entry.index} staged selection={selection} onSelect={pickEntry} />
                      <EntryGroup title="Changes" entries={currentStatus.unstaged} codeOf={entry => entry.worktree} staged={false} selection={selection} onSelect={pickEntry} />
                      <EntryGroup title="Untracked" entries={currentStatus.untracked} codeOf={() => '?'} staged={false} selection={selection} onSelect={pickEntry} />
                      {currentStatus.truncated && <p className="git-note" role="status">Showing the first {currentStatus.staged.length + currentStatus.unstaged.length + currentStatus.untracked.length} of {currentStatus.totalEntries.toLocaleString()} changed files.</p>}
                    </div>
                  )}

                  {currentStatus && currentStatus.staged.length > 0 && (
                    <div className="git-actions">
                      <button type="button" disabled={!canInsert || working} onClick={draftMessage}
                        title={canInsert ? 'Put a prompt in the session asking Copilot to write a commit message for the staged files' : 'Open a session in this window first'}>
                        Draft commit message with Copilot
                      </button>
                    </div>
                  )}

                  {selection && (
                    <div className="git-diff-area">
                      <div className="git-diff-head">
                        <span className="git-diff-path" title={selection.path}>{selection.path}</span>
                        <span className="git-diff-side">{selection.staged ? 'staged' : 'working tree'}</span>
                        <button type="button" disabled={!canInsert || !diff || diff.key !== diffKey} onClick={addToPrompt}
                          title={canInsert ? `Put this diff in the prompt box of “${promptTarget?.title}”` : 'Open a session in this window first'}>
                          Add to prompt
                        </button>
                      </div>
                      {diffError && <p className="git-message git-message-error" role="alert">{diffError}</p>}
                      {!diffError && selectedEntry === null && <p className="git-message" role="status">That file is no longer changed.</p>}
                      {!diffError && selectedEntry !== null && diff?.key === diffKey && <GitDiffView diff={diff.value} />}
                      {!diffError && selectedEntry !== null && diff?.key !== diffKey && <p className="git-message" role="status">Loading diff…</p>}
                    </div>
                  )}
                  {!selection && currentStatus && currentStatus.totalEntries > 0 && <p className="git-note">Select a file to see its diff.</p>}
                </div>
              )}

              {tab === 'history' && (
                <div className="git-history">
                  {logError && <p className="git-message git-message-error" role="alert">{logError}</p>}
                  {log && log.repoId === repo.id && log.entries.length === 0 && <p className="git-message" role="status">No commits yet.</p>}
                  {log && log.repoId === repo.id && (
                    <ol className="git-log">
                      {log.entries.map(entry => (
                        <li key={entry.hash}>
                          <span className="git-log-subject" title={entry.subject}>{entry.subject}</span>
                          {entry.refs.length > 0 && <span className="git-log-refs">{entry.refs.join(', ')}</span>}
                          <span className="git-log-meta"><code>{entry.hash.slice(0, 7)}</code> · {entry.author} · {new Date(entry.date).toLocaleDateString()}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {log && log.repoId === repo.id && !log.done && <button type="button" onClick={loadMore}>Load more</button>}
                </div>
              )}
            </>
          )}

          {actionError && <p className="git-message git-message-error" role="alert">{actionError}</p>}
          {notice && <p className="git-message git-message-info" role="status">{notice}</p>}
        </div>
      )}
    </aside>
  )
}
