import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { GitDiffView as GitDiff, GitEntryView, GitLogEntry, GitOperationResult, GitProjectView, GitRepoStatusView, GitRepoSummary } from '../../main/git-types.js'
import { composeCommitMessagePrompt, composeDiffPrompt } from '../../main/git-prompt.js'
import { appendOutput, readableOutput } from '../../main/git-output.js'
import { errorMessage } from '../errors.js'
import { insertIntoPrompt } from '../prompt-insert.js'
import { GitCommitBox } from './GitCommitBox.js'
import { GitDiffView } from './GitDiffView.js'
import { GitReviewCard } from './GitReviewCard.js'

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

interface RowAction {
  /** The button's visible symbol and its accessible verb, for example "+" and "Stage". */
  symbol: string
  verb: string
  disabled: boolean
  run(entry: GitEntryView): void
}

function EntryRow({ entry, code, selected, onSelect, action }: { entry: GitEntryView; code: string; selected: boolean; onSelect(): void; action?: RowAction | undefined }): JSX.Element {
  const { name, folder } = fileParts(entry.path)
  return (
    <div className="git-entry-row">
      <button type="button" className={`git-entry${selected ? ' git-entry-selected' : ''}`} aria-pressed={selected} onClick={onSelect}
        title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}>
        <span className={`git-code git-code-${code === '?' ? 'untracked' : code}`} aria-hidden="true">{code}</span>
        <span className="git-entry-name">{name}</span>
        {folder && <span className="git-entry-folder">{folder}</span>}
      </button>
      {action && (
        <button type="button" className="git-entry-action" disabled={action.disabled} aria-label={`${action.verb} ${entry.path}`} title={`${action.verb} ${entry.path}`}
          onClick={() => action.run(entry)}>{action.symbol}</button>
      )}
    </div>
  )
}

interface GroupAction {
  label: string
  title: string
  disabled: boolean
  run(): void
}

function EntryGroup({ title, entries, codeOf, staged, selection, onSelect, rowAction, groupAction }: {
  title: string; entries: GitEntryView[]; codeOf(entry: GitEntryView): string; staged: boolean; selection: Selection | null; onSelect(entry: GitEntryView, staged: boolean): void
  rowAction?: RowAction; groupAction?: GroupAction
}): JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <section className="git-group" aria-label={title}>
      <div className="git-group-head">
        <h3>{title} ({entries.length})</h3>
        {groupAction && <button type="button" className="git-group-action" disabled={groupAction.disabled} title={groupAction.title} onClick={groupAction.run}>{groupAction.label}</button>}
      </div>
      {entries.map(entry => (
        <EntryRow key={`${staged ? 's' : 'u'}:${entry.path}`} entry={entry} code={codeOf(entry)} action={rowAction}
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
  const [log, setLog] = useState<{ repoId: string; headOid: string | null; entries: GitLogEntry[]; done: boolean } | null>(null)
  // The "Load more" request in flight, if any. Only one at a time, and a response only extends the list it was asked for.
  const moreRequest = useRef<number | null>(null)
  const moreCounter = useRef(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  // Writes: one at a time. `messages` keeps a draft per repository; `hooks` is set when a commit needs hook approval.
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [operation, setOperation] = useState<'stage' | 'unstage' | 'commit' | null>(null)
  const [progress, setProgress] = useState('')
  const [output, setOutput] = useState('')
  const [hooks, setHooks] = useState<{ names: string[]; hash: string } | null>(null)

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
    // A new first page replaces the list, so any page still loading for the old one no longer applies.
    moreRequest.current = null
    setLoadingMore(false)
    window.copilotDesktop.gitLog(profileId, repo.id, HISTORY_PAGE, 0)
      .then(entries => { if (!stale) { setLog({ repoId: repo.id, headOid: repo.headOid, entries, done: entries.length < HISTORY_PAGE }); setLogError(null) } })
      .catch((cause: unknown) => { if (!stale) setLogError(errorMessage(cause)) })
    return () => { stale = true }
  }, [profileId, tab, repo?.id, repo?.state, repo?.headOid]) // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = (): void => {
    if (!repo || !log || moreRequest.current !== null) return
    const { repoId, headOid } = log
    const skip = log.entries.length
    const id = ++moreCounter.current
    moreRequest.current = id
    setLoadingMore(true)
    window.copilotDesktop.gitLog(profileId, repo.id, HISTORY_PAGE, skip)
      .then(more => setLog(current => {
        // Extend only the very list this page continues: same repository, same commit, and nothing added since.
        if (!current || current.repoId !== repoId || current.headOid !== headOid || current.entries.length !== skip) return current
        const known = new Set(current.entries.map(entry => entry.hash))
        return { ...current, entries: [...current.entries, ...more.filter(entry => !known.has(entry.hash))], done: more.length < HISTORY_PAGE }
      }))
      .catch((cause: unknown) => setLogError(errorMessage(cause)))
      .finally(() => { if (moreRequest.current === id) { moreRequest.current = null; setLoadingMore(false) } })
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
    // Read a bounded number of diffs, but hand the composer the whole staged inventory so it can name and count the rest.
    const read = currentStatus.staged.slice(0, MAX_DRAFT_FILES)
    const omitted = currentStatus.staged.slice(MAX_DRAFT_FILES).map(entry => entry.path)
    setWorking(true)
    setActionError(null)
    Promise.all(read.map(entry => window.copilotDesktop.gitDiff(profileId, repo.id, entry.id, true).then(value => ({ path: entry.path, diff: value }))))
      .then(parts => {
        insert(promptTarget.id, composeCommitMessagePrompt({ repoName: repo.name, branch: repo.branch, parts, omitted, listTruncated: currentStatus.truncated }))
        setNotice(`Asked “${promptTarget.title}” to draft a commit message. Review the prompt and press Enter to send.`)
      })
      .catch((cause: unknown) => setActionError(errorMessage(cause))).finally(() => setWorking(false))
  }

  // What a running write prints (a commit hook's messages, say) appears as it arrives.
  useEffect(() => window.copilotDesktop.onGitProgress(payload => {
    if (payload.profileId === profileId && payload.event.repoId === repo?.id) setProgress(previous => appendOutput(previous, payload.event.text))
  }), [profileId, repo?.id])

  const messageKey = repo?.relativePath ?? ''
  const message = messages[messageKey] ?? ''
  const setMessage = (value: string): void => setMessages(current => ({ ...current, [messageKey]: value }))

  /** Run one write, show its outcome, and take the fresh status it returns. */
  const runWrite = (kind: 'stage' | 'unstage' | 'commit', task: () => Promise<GitOperationResult>): void => {
    setOperation(kind)
    setProgress('')
    setOutput('')
    setActionError(null)
    setNotice(null)
    setHooks(null)
    task().then((result: GitOperationResult) => {
      if (result.status) setStatus(result.status)
      if (result.ok) {
        setNotice(result.message)
        if (kind === 'commit') setMessage('')
      } else if (result.reason === 'hooks-need-approval' && result.hooksHash) {
        setHooks({ names: result.hooks, hash: result.hooksHash })
      } else {
        setActionError(result.message)
      }
      setOutput(result.ok ? '' : readableOutput(result.output))
    }).catch((cause: unknown) => setActionError(errorMessage(cause))).finally(() => setOperation(null))
  }

  const changeIndex = (kind: 'stage' | 'unstage', entries: readonly GitEntryView[]): void => {
    if (!repo || !currentStatus || entries.length === 0) return
    const generation = currentStatus.generation
    const ids = entries.map(entry => entry.id)
    runWrite(kind, () => kind === 'stage' ? window.copilotDesktop.gitStage(profileId, repo.id, ids, generation) : window.copilotDesktop.gitUnstage(profileId, repo.id, ids, generation))
  }

  const commit = (approvedHooksHash: string | null): void => {
    if (!repo || !currentStatus) return
    const generation = currentStatus.generation
    runWrite('commit', () => window.copilotDesktop.gitCommit(profileId, repo.id, message, generation, approvedHooksHash))
  }

  const cancelWrite = (): void => { if (repo) void window.copilotDesktop.gitCancel(profileId, repo.id).catch(() => undefined) }

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

          {repo.state === 'needs-review' && <GitReviewCard items={repo.reviewItems} working={working} onTrust={trust} />}

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
                      <EntryGroup title="Conflicts" entries={currentStatus.conflicted} codeOf={() => 'U'} staged={false} selection={selection} onSelect={pickEntry}
                        rowAction={{ symbol: '✓', verb: 'Mark resolved:', disabled: operation !== null, run: entry => changeIndex('stage', [entry]) }} />
                      <EntryGroup title="Staged" entries={currentStatus.staged} codeOf={entry => entry.index} staged selection={selection} onSelect={pickEntry}
                        rowAction={{ symbol: '−', verb: 'Unstage', disabled: operation !== null, run: entry => changeIndex('unstage', [entry]) }}
                        groupAction={{ label: 'Unstage all', title: currentStatus.truncated ? 'The file list is cut off, so this would only unstage the files shown' : 'Unstage every staged file', disabled: operation !== null || currentStatus.truncated, run: () => changeIndex('unstage', currentStatus.staged) }} />
                      <EntryGroup title="Changes" entries={currentStatus.unstaged} codeOf={entry => entry.worktree} staged={false} selection={selection} onSelect={pickEntry}
                        rowAction={{ symbol: '+', verb: 'Stage', disabled: operation !== null, run: entry => changeIndex('stage', [entry]) }}
                        groupAction={{ label: 'Stage all', title: currentStatus.truncated ? 'The file list is cut off, so this would only stage the files shown' : 'Stage every changed file (not untracked ones)', disabled: operation !== null || currentStatus.truncated, run: () => changeIndex('stage', currentStatus.unstaged) }} />
                      <EntryGroup title="Untracked" entries={currentStatus.untracked} codeOf={() => '?'} staged={false} selection={selection} onSelect={pickEntry}
                        rowAction={{ symbol: '+', verb: 'Stage', disabled: operation !== null, run: entry => changeIndex('stage', [entry]) }}
                        groupAction={{ label: 'Stage all', title: currentStatus.truncated ? 'The file list is cut off, so this would only stage the files shown' : 'Stage every untracked file', disabled: operation !== null || currentStatus.truncated, run: () => changeIndex('stage', currentStatus.untracked) }} />
                      {currentStatus.truncated && <p className="git-note" role="status">Showing the first {currentStatus.staged.length + currentStatus.unstaged.length + currentStatus.untracked.length} of {currentStatus.totalEntries.toLocaleString()} changed files.</p>}
                    </div>
                  )}

                  {currentStatus && (currentStatus.staged.length > 0 || message !== '' || operation !== null || hooks !== null) && (
                    <GitCommitBox stagedCount={currentStatus.staged.length} conflictCount={currentStatus.conflicted.length}
                      message={message} onMessageChange={setMessage} busy={operation} progress={progress}
                      canDraft={canInsert && currentStatus.staged.length > 0 && !working}
                      draftTitle={canInsert ? 'Put a prompt in the session asking Copilot to write a commit message for the staged files' : 'Open a session in this window first'}
                      onDraft={draftMessage} onCommit={() => commit(null)} onCancel={cancelWrite}
                      hooks={hooks?.names ?? null} onApproveHooks={() => { if (hooks) commit(hooks.hash) }} onDismissHooks={() => setHooks(null)} />
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
                  {log && log.repoId === repo.id && !log.done && <button type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
                </div>
              )}
            </>
          )}

          {actionError && <p className="git-message git-message-error" role="alert">{actionError}</p>}
          {output && <pre className="git-output" aria-label="What Git printed">{output}</pre>}
          {notice && <p className="git-message git-message-info" role="status">{notice}</p>}
        </div>
      )}
    </aside>
  )
}
