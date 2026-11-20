import { GitHistory } from './GitHistory.js'
import { GitOutput } from './GitOutput.js'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import type { GitBranchView, GitDiffView as GitDiff, GitHeadCommitView, GitEntryView, GitOperationResult, GitProjectView, GitRepoStatusView, GitRepoSummary, GitWorktreeView } from '../../main/git-types.js'
import { composeCommitMessagePrompt, composeDiffPrompt, composeGitCursorContext, composeResolvePullPrompt, composeReviewCommentsPrompt } from '../../main/git-prompt.js'
import type { ResolvePullSituation } from '../../main/git-prompt.js'
import { filesInTheWay } from '../../main/git-sync.js'
import { appendOutput, readableOutput } from '../../main/git-output.js'
import { GitResolveBar, folderWithin, resolveBlocker } from './GitResolveBar.js'
import type { ResolveTarget } from './GitResolveBar.js'
import { errorMessage } from '../errors.js'
import { insertIntoPrompt } from '../prompt-insert.js'
import { GitCommitBox } from './GitCommitBox.js'
import type { AmendState } from './GitCommitBox.js'
import { GitSyncBar } from './GitSyncBar.js'
import { GitBranchList } from './GitBranchList.js'
import type { GitSyncKind } from './GitSyncBar.js'
import { GitDiffView, diffChangeSignature } from './GitDiffView.js'
import { GitWorktreeList } from './GitWorktreeList.js'
import type { WorktreeSession } from './GitWorktreeList.js'
import type { DiffCommentAnchor } from './GitDiffView.js'
import { anchorMovedComments, bucketKey, moveCommentBucket, orderedComments, pruneCommentBuckets, removeCommentBucket, updateCommentBucket } from '../diff-comments.js'
import type { DiffCommentBuckets } from '../diff-comments.js'
import { GitReviewCard } from './GitReviewCard.js'
import { Splitter } from './Splitter.js'
import { TRASH_LABEL, isMac, isShortcutModifier } from '../platform.js'
import { markedEntries, nextMarks } from '../git-marks.js'
import type { MarkMode, MarkSide, Marks } from '../git-marks.js'
import { GIT_CURSOR_CONTEXT_EVENT } from '../git-cursor-context.js'
import type { GitCursorContextRequest } from '../git-cursor-context.js'

export interface GitPanelProps {
  profileId: string
  selectionKey?: string | undefined
  /** The session whose prompt box receives text, or null when there is none or it lives in another window. `cwd` is the folder it
   * works in; `taskBlocker` says why it cannot take a task that edits files and runs Git. */
  promptTarget: ({ id: string; cwd?: string | null } & ResolveTarget) | null
  /** The active session's worktree folder, when it runs in one: the panel shows that worktree's repository entry. */
  sessionWorktreePath?: string | null | undefined
  /** Every session that runs in a worktree, so the worktree list can say who uses which. */
  worktreeSessions?: readonly WorktreeSession[]
  /** True when the panel is replacing the session area because the window is narrow. */
  takeover?: boolean
  /** A retained hidden panel cannot supply a cursor selection to the CLI. */
  active?: boolean
  /** The shared dock owns close/back navigation. */
  embedded?: boolean
  onClose(): void
  /** How text reaches a prompt box. Defaults to the app's own prompt insertion. */
  insert?: (tabId: string, text: string) => void
  /** How a resolve task reaches a session and claims the repository: sent when it is safe to, otherwise pasted. Defaults to
   * main's `gitResolve`, then `insert`. */
  sendTask?: (repoId: string, tabId: string, text: string) => Promise<TaskDelivery>
}

/** What became of a task for a session. */
export type TaskDelivery = { result: 'sent' } | { result: 'pasted'; message: string } | { result: 'refused'; message: string }

/** Main claims the repository, then types the task and presses Enter only at a safe moment; otherwise it is pasted for the person to send. */
async function sendOrPaste(profileId: string, repoId: string, tabId: string, text: string, insert: (tabId: string, text: string) => void, currentTarget: () => string | undefined): Promise<TaskDelivery> {
  const outcome = await window.copilotDesktop.gitResolve(profileId, repoId, tabId, text)
  if (outcome.result !== 'busy') return outcome
  if (currentTarget() !== tabId) return { result: 'refused', message: 'The current session changed. Try the task again in the current session.' }
  insert(tabId, text)
  return { result: 'pasted', message: outcome.message }
}

/** A pull that failed in a way Copilot can finish, for the repository, branch and commit it was asked for. */
interface PullFailure { repoId: string; branch: string; headOid: string; reason: 'diverged' | 'local-changes'; output: string }

type Tab = 'changes' | 'history' | 'branches'
interface Selection { repoId: string; path: string; staged: boolean }
interface RepoError { repoId: string; message: string }
type FeedbackArea = 'sync' | 'files' | 'commit' | 'branch' | 'worktree' | 'diff' | 'trust'
interface RepoFeedback { area: FeedbackArea; notice?: string; error?: string; output?: string }
type WriteKind = 'stage' | 'unstage' | 'commit' | 'branch' | 'discard' | 'worktree' | GitSyncKind
interface CommitAttempt {
  repoId: string
  generation: number
  message: string
  branch: string | null
  headOid: string | null
  amend: boolean
}
interface HookApproval { attempt: CommitAttempt; names: string[]; hash: string }

const writeArea: Record<WriteKind, FeedbackArea> = {
  fetch: 'sync', pull: 'sync', push: 'sync', stage: 'files', unstage: 'files', discard: 'files',
  commit: 'commit', branch: 'branch', worktree: 'worktree',
}

function GitFeedback({ feedback }: { feedback: RepoFeedback }): JSX.Element {
  return <div className="git-feedback" data-area={feedback.area}>
    {feedback.error && <p className="git-message git-message-error" role="alert">{feedback.error}</p>}
    {feedback.notice && <p className="git-message git-message-info" role="status">{feedback.notice}</p>}
    {feedback.output && <GitOutput text={feedback.output} />}
  </div>
}

function groupsOnSide(status: GitRepoStatusView, staged: boolean): readonly GitEntryView[][] {
  return staged ? [status.staged] : [status.unstaged, status.untracked, status.conflicted]
}

function entryOnSide(status: GitRepoStatusView, path: string, staged: boolean): GitEntryView | undefined {
  return groupsOnSide(status, staged).flat().find(entry => entry.path === path)
}

function reconcileSelection(selection: Selection | null, status: GitRepoStatusView, previous: GitRepoStatusView | null): Selection | null {
  if (!selection || selection.repoId !== status.repoId || entryOnSide(status, selection.path, selection.staged)) return selection
  if (status.truncated) return selection
  if (entryOnSide(status, selection.path, !selection.staged)) return { ...selection, staged: !selection.staged }
  if (previous?.repoId !== status.repoId) return null
  const before = groupsOnSide(previous, selection.staged)
  const groupIndex = before.findIndex(entries => entries.some(entry => entry.path === selection.path))
  const group = before[groupIndex]
  if (!group) return null
  const index = group.findIndex(entry => entry.path === selection.path)
  const remaining = new Set(groupsOnSide(status, selection.staged)[groupIndex]?.map(entry => entry.path))
  const ordered = [...group.slice(index + 1), ...group.slice(0, index).reverse()]
  const neighbor = ordered.find(entry => remaining.has(entry.path))
  return neighbor ? { ...selection, path: neighbor.path } : null
}

const repoStorageKey = (profileId: string): string => `git-repo:${profileId}`
const MAX_DRAFT_FILES = 30

function readStoredRepo(profileId: string): string | null {
  try { return localStorage.getItem(repoStorageKey(profileId)) } catch { return null }
}

/** Whether the diff shows the whole file rather than the changes with a few lines around them: one choice for every repository. */
const WHOLE_FILE_KEY = 'git-diff-whole-file'
function readWholeFile(): boolean {
  try { return localStorage.getItem(WHOLE_FILE_KEY) === '1' } catch { return false }
}

/** How much of the Changes tab's height (in percent) the file list takes while a diff is shown below it: one choice for every repository. */
const LIST_SHARE_KEY = 'git-changes-list-share'
const LIST_SHARE_MIN = 15
const LIST_SHARE_MAX = 80
function readListShare(): number {
  try {
    const stored = Number(localStorage.getItem(LIST_SHARE_KEY))
    if (stored >= LIST_SHARE_MIN && stored <= LIST_SHARE_MAX) return stored
  } catch { /* Use the default. */ }
  return 40
}

const gitViews = new Map<string, { count: number; latest: Promise<GitProjectView> }>()

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
    let subscription = gitViews.get(profileId)
    if (!subscription) {
      subscription = { count: 0, latest: window.copilotDesktop.gitOpen(profileId) }
      gitViews.set(profileId, subscription)
    }
    const shared = subscription
    shared.count++
    const off = window.copilotDesktop.onGitChanged(payload => {
      if (!disposed && payload.profileId === profileId) {
        shared.latest = Promise.resolve(payload.view)
        setView(payload.view)
      }
    })
    const initial = shared.latest
    initial.then(next => { if (!disposed && shared.latest === initial) setView(next) })
      .catch((cause: unknown) => { if (!disposed) setError(errorMessage(cause)) })
    return () => {
      disposed = true; off()
      if (--shared.count === 0) {
        gitViews.delete(profileId)
        void window.copilotDesktop.gitClose(profileId).catch(() => undefined)
      }
    }
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

export function RepoRow({ repo, selected, onSelect, disabled = false }: { repo: GitRepoSummary; selected: boolean; onSelect(): void; disabled?: boolean }): JSX.Element {
  const tone = repo.state === 'needs-review' ? 'review' : repo.state === 'error' ? 'error' : repo.changeCount > 0 ? 'dirty' : (repo.behind ?? 0) > 0 ? 'behind' : 'clean'
  return (
    <button type="button" className={`git-repo git-repo-${tone}${selected ? ' git-repo-selected' : ''}`} aria-pressed={selected} onClick={onSelect} disabled={disabled}
      title={disabled ? 'Wait for the running Git operation to finish, or cancel it, before switching repositories' : repo.relativePath === '.' ? repo.name : repo.relativePath}>
      <span className="git-repo-dot" aria-hidden="true" />
      <span className="git-repo-name">{repo.name}{repo.kind === 'parent' && <em> (parent)</em>}{repo.kind === 'worktree' && <em> (worktree)</em>}</span>
      <span className="git-repo-meta">{[repo.branch ?? (repo.detached ? 'detached' : ''), stateLabel(repo), (repo.behind ?? 0) > 0 ? `↓${repo.behind}` : ''].filter(Boolean).join(' · ')}</span>
      {(repo.kind === 'worktree' || (repo.relativePath !== '.' && repo.relativePath !== repo.name)) &&
        <span className="git-repo-path">{repo.relativePath}</span>}
    </button>
  )
}

function RepoSwitcher({ repos, repo, locked, active, onSelect }: {
  repos: readonly GitRepoSummary[]; repo: GitRepoSummary; locked: boolean; active: boolean; onSelect(repo: GitRepoSummary): void
}): JSX.Element {
  const id = useId()
  const picker = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (!active) picker.current?.hidePopover() }, [active])
  return <>
    <button type="button" className="git-repo-switch" popoverTarget={id} aria-label={`Switch repository, current repository ${repo.name}, ${repos.length} repositories`}
      title={`${repo.folder} · ${repos.length} repositories`}>
      <span>{repo.name}</span><span aria-hidden="true">▾</span>
    </button>
    <div id={id} ref={picker} popover="auto" className="git-repos" role="group" aria-label="Repositories">
      {repos.map(item => <RepoRow key={item.id} repo={item} selected={item.id === repo.id} disabled={locked && item.id !== repo.id}
        onSelect={() => { onSelect(item); picker.current?.hidePopover() }} />)}
    </div>
  </>
}

function fileParts(path: string): { name: string; folder: string } {
  const parts = path.replace(/\/$/, '').split('/')
  const name = parts.pop() ?? path
  return { name: path.endsWith('/') ? `${name}/` : name, folder: parts.join('/') }
}

/** Whether Discard applies to an entry: an untracked file or folder, or a tracked file with a working-tree change (not a conflict, a submodule or an added-but-empty file). */
/** The draft commit message kept for a repository. Folder names are arbitrary text, so `__proto__` or `constructor` must not read the object's own prototype. */
export function draftOf(drafts: Readonly<Record<string, string>>, key: string): string {
  return Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] ?? '' : ''
}

export function canDiscard(entry: Pick<GitEntryView, 'kind' | 'worktree' | 'submodule'>): boolean {
  if (entry.kind === 'untracked') return true
  if (entry.submodule) return false
  return (entry.kind === 'changed' && ['M', 'T', 'D'].includes(entry.worktree)) || (entry.kind === 'renamed' && ['M', 'T'].includes(entry.worktree))
}

interface RowAction {
  /** The button's visible symbol and its accessible verb, for example "+" and "Stage". */
  symbol: string
  verb: string
  disabled: boolean
  run(entry: GitEntryView): void
  /** What the button says for this row when it acts on more than the row (the selected files); `verb` and the path otherwise. */
  labelOf?(entry: GitEntryView): string | null
}

const MULTI_SELECT_HINT = `${isMac ? 'Cmd' : 'Ctrl'}+click or Shift+click to select several`

/** How a click on a file row picks it: Shift for a range, Ctrl (Cmd on macOS) to add or remove one, otherwise only this one. */
const markMode = (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): MarkMode =>
  event.shiftKey ? 'range' : isShortcutModifier(event) ? 'toggle' : 'only'

function navigateFiles(event: KeyboardEvent<HTMLDivElement>): void {
  if (!(event.target instanceof HTMLButtonElement) || !event.target.matches('.git-entry')) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.git-entry'))
  const index = rows.indexOf(event.target)
  let next: number
  switch (event.key) {
    case 'ArrowDown': next = Math.min(index + 1, rows.length - 1); break
    case 'ArrowUp': next = Math.max(index - 1, 0); break
    case 'Home': next = 0; break
    case 'End': next = rows.length - 1; break
    default: return
  }
  event.preventDefault()
  const row = rows[next]
  row?.focus()
  if (row && !isShortcutModifier(event)) row.click()
}

function EntryRow({ entry, code, selected, marked, multiple, onSelect, action, extra }: {
  entry: GitEntryView; code: string; selected: boolean; marked: boolean; multiple: boolean; onSelect(mode: MarkMode): void; action?: RowAction | undefined; extra?: RowAction | undefined
}): JSX.Element {
  const { name, folder } = fileParts(entry.path)
  const path = entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path
  const actionLabel = (row: RowAction): string => row.labelOf?.(entry) ?? `${row.verb} ${entry.path}`
  return (
    <div className="git-entry-row">
      <button type="button" className={`git-entry${selected ? ' git-entry-selected' : ''}${marked ? ' git-entry-marked' : ''}`} aria-current={selected ? 'true' : undefined} aria-pressed={multiple ? marked : undefined}
        // Shift+click would otherwise select the text of every row in between.
        onMouseDown={event => { if (multiple && event.shiftKey) event.preventDefault() }}
        onKeyDown={event => {
          if (multiple && event.key === ' ' && !event.altKey) {
            event.preventDefault()
            if (!event.repeat) onSelect(event.shiftKey ? 'range' : 'toggle')
          }
        }}
        onClick={event => onSelect(multiple ? markMode(event) : 'only')}
        title={multiple ? `${path}\n${MULTI_SELECT_HINT}` : path}>
        <span className={`git-code git-code-${code === '?' ? 'untracked' : code}`} aria-hidden="true">{code}</span>
        <span className="git-entry-name">{name}</span>
        {folder && <span className="git-entry-folder">{folder}</span>}
      </button>
      {action && (
        <button type="button" className="git-entry-action" disabled={action.disabled} aria-label={actionLabel(action)} title={actionLabel(action)}
          onClick={() => action.run(entry)}>{action.symbol}</button>
      )}
      {extra && (
        <button type="button" className="git-entry-action git-entry-danger" disabled={extra.disabled} aria-label={actionLabel(extra)} title={actionLabel(extra)}
          onClick={() => extra.run(entry)}>{extra.symbol}</button>
      )}
    </div>
  )
}

export interface GitMarkedBarProps {
  count: number
  side: MarkSide
  /** How many of the selected files Discard applies to (none on the staged side). */
  discardable: number
  disabled: boolean
  onChangeIndex(): void
  onDiscard(): void
  onClear(): void
}

/** What can be done with the selected files at once; shown while two or more are selected. */
export function GitMarkedBar({ count, side, discardable, disabled, onChangeIndex, onDiscard, onClear }: GitMarkedBarProps): JSX.Element {
  const verb = side === 'staged' ? 'Unstage' : 'Stage'
  return (
    <div className="git-marked" role="toolbar" aria-label="Selected files">
      <span className="git-marked-count">{count} selected</span>
      <button type="button" className="git-group-action" disabled={disabled} onClick={onChangeIndex} title={`${verb} the ${count} selected files`}>{verb}</button>
      {side === 'working' && discardable > 0 && (
        <button type="button" className="git-group-action git-entry-danger" disabled={disabled} onClick={onDiscard}
          title={`Discard ${discardable === count ? 'the selected files' : `the ${discardable} selected files that can be discarded`}. You will be asked first; a copy of each changed file is saved, and untracked files go to the ${TRASH_LABEL}.`}>
          {discardable === count ? 'Discard' : `Discard ${discardable}`}
        </button>
      )}
      <button type="button" className="git-group-action" onClick={onClear} title="Select only the file shown">Clear</button>
    </div>
  )
}

interface GroupAction {
  label: string
  title: string
  disabled: boolean
  run(): void
}

function EntryGroup({ title, entries, codeOf, staged, selection, marked, multiple = true, onSelect, rowAction, groupAction, extraRowAction, extraGroupAction }: {
  title: string; entries: GitEntryView[]; codeOf(entry: GitEntryView): string; staged: boolean; selection: Selection | null
  /** Marked paths on this group's side, independent of the open preview. */
  marked: ReadonlySet<string> | null
  /** Whether several of these files can be selected at once (not conflicts, which are marked resolved one at a time). */
  multiple?: boolean
  onSelect(entry: GitEntryView, staged: boolean, mode: MarkMode, list: readonly string[]): void
  rowAction?: RowAction; groupAction?: GroupAction
  /** A second, destructive action (Discard): on the rows that can be discarded, and on the group. */
  extraRowAction?: RowAction & { applies(entry: GitEntryView): boolean }; extraGroupAction?: GroupAction
}): JSX.Element | null {
  if (entries.length === 0) return null
  const paths = entries.map(entry => entry.path)
  return (
    <section className="git-group" aria-label={title}>
      <div className="git-group-head">
        <h3>{title} ({entries.length})</h3>
        {groupAction && <button type="button" className="git-group-action" disabled={groupAction.disabled} title={groupAction.title} onClick={groupAction.run}>{groupAction.label}</button>}
        {extraGroupAction && <button type="button" className="git-group-action git-entry-danger" disabled={extraGroupAction.disabled} title={extraGroupAction.title} onClick={extraGroupAction.run}>{extraGroupAction.label}</button>}
      </div>
      {entries.map(entry => (
        <EntryRow key={`${staged ? 's' : 'u'}:${entry.path}`} entry={entry} code={codeOf(entry)} action={rowAction} extra={extraRowAction?.applies(entry) ? extraRowAction : undefined}
          selected={selection?.path === entry.path && selection.staged === staged} marked={marked?.has(entry.path) ?? false} multiple={multiple}
          onSelect={mode => onSelect(entry, staged, mode, paths)} />
      ))}
    </section>
  )
}

export function GitPanel({ profileId, selectionKey = profileId, promptTarget, takeover = false, active = true, embedded = false, onClose, insert = insertIntoPrompt, sendTask, sessionWorktreePath = null, worktreeSessions = [] }: GitPanelProps): JSX.Element {
  const currentPromptTarget = useRef(promptTarget)
  useLayoutEffect(() => {
    currentPromptTarget.current = promptTarget
    return () => { currentPromptTarget.current = null }
  }, [promptTarget])
  const { view, error, busy, rescan, replace } = useGitProject(profileId)
  const [storedRepo, setStoredRepo] = useState(() => readStoredRepo(selectionKey))
  const previousSelectionKey = useRef(selectionKey)
  useLayoutEffect(() => {
    if (selectionKey === previousSelectionKey.current) return
    // Reopening Git reuses its mounted view but gives the new tab its own saved selection.
    const choice = readStoredRepo(previousSelectionKey.current)
    if (choice !== null) {
      try { localStorage.setItem(repoStorageKey(selectionKey), choice) } catch { /* Keep the in-memory choice. */ }
    }
    previousSelectionKey.current = selectionKey
  }, [selectionKey])
  const [tab, setTab] = useState<Tab>('changes')
  const [picked, setSelection] = useState<Selection | null>(null)
  const [filter, setFilter] = useState<{ repoId: string; value: string } | null>(null)
  const [marks, setMarks] = useState<Marks | null>(null)
  const [status, setStatus] = useState<GitRepoStatusView | null>(null)
  const [statusError, setStatusError] = useState<RepoError | null>(null)
  const previousStatus = useRef<GitRepoStatusView | null>(null)
  const [diff, setDiff] = useState<{ key: string; value: GitDiff } | null>(null)
  const [diffFailure, setDiffFailure] = useState<{ key: string; message: string } | null>(null)
  const [wholeFile, setWholeFile] = useState(readWholeFile)
  const [listShare, setListShare] = useState(readListShare)
  const changesRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<{ scope: string; diffText: string; anchor: DiffCommentAnchor; id: number; declined: boolean } | null>(null)
  const cursorSequence = useRef(0)
  // Comments on diff lines: one bucket per file and side (entry ids change with every status generation, so they are not
  // part of the key), each remembering the diff it was written against so the panel can warn when that has changed.
  const [comments, setComments] = useState<DiffCommentBuckets>(() => new Map())
  const [reload, setReload] = useState(0)
  const [feedbackByRepo, setFeedbackByRepo] = useState<ReadonlyMap<string, RepoFeedback>>(() => new Map())
  const updateFeedback = useCallback((repoId: string, feedback: RepoFeedback): void => {
    setFeedbackByRepo(current => new Map(current).set(repoId, feedback))
  }, [])
  const [working, setWorking] = useState(false)
  // Writes: one at a time. `messages` keeps a draft per repository; `hooks` is set when a commit needs hook approval.
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [operation, setOperation] = useState<{ kind: WriteKind; repoId: string } | null>(null)
  // Set the moment a write starts, so output and Cancel belong to the repository that owns the write even if the view changes.
  const operationRepo = useRef<string | null>(null)
  const [progress, setProgress] = useState('')
  const [hookApproval, setHooks] = useState<HookApproval | null>(null)
  // Branches: the list for the selected repository, a draft per repository, and a counter that reloads the list after a change.
  const [branches, setBranches] = useState<{
    repoId: string; headOid: string | null; branch: string | null; reload: number; items: GitBranchView[] | null; error: string | null
  } | null>(null)
  const [branchDrafts, setBranchDrafts] = useState<Record<string, string>>({})
  const [branchReload, setBranchReload] = useState(0)
  // Worktrees of the selected repository (read-only), shown under the branches.
  const [worktrees, setWorktrees] = useState<{ repoId: string; items: GitWorktreeView[] } | null>(null)
  const [worktreeError, setWorktreeError] = useState<RepoError | null>(null)
  // The session worktree the panel last followed, so a manual choice afterwards is kept until the session changes.
  const followedWorktree = useRef<string | null>(null)
  // Amend: whether the box is amending the last commit, and what is known about that commit.
  const [amendRepoId, setAmendRepoId] = useState<string | null>(null)
  const [headCommit, setHeadCommit] = useState<{ repoId: string; headOid: string; info: GitHeadCommitView } | null>(null)
  const amendPrefill = useRef(false)
  // Repository selection can leave the prefilled message behind after it exits amend mode.
  const untouchedAmendDrafts = useRef(new Map<string, string>())
  // Set when a push finds the branch has no upstream: the person picks the remote and confirms before anything is sent.
  const [publish, setPublish] = useState<{ repoId: string; branch: string; headOid: string; remotes: string[]; remote: string } | null>(null)
  const [pullFailure, setPullFailure] = useState<PullFailure | null>(null)
  // The resolver last seen working, per repository, so the panel can say when it has finished.
  const lastResolver = useRef<Map<string, string>>(new Map())
  const resolveInFlight = useRef(false)
  const [resolveSending, setResolveSending] = useState(false)

  const repo = view ? pickRepo(view, storedRepo) : null
  const repoId = repo?.id ?? null
  const pathFilter = filter && filter.repoId === repoId ? filter.value : ''
  const visibleRepo = useRef(repoId)
  useLayoutEffect(() => { visibleRepo.current = repoId }, [repoId])
  const selection = picked?.repoId === repoId ? picked : null
  const amending = repoId !== null && amendRepoId === repoId
  const visibleOperation = operation?.repoId === repoId ? operation : null
  const feedback = repoId ? feedbackByRepo.get(repoId) : undefined

  const switchRepo = useCallback((next: GitRepoSummary, persist: boolean): boolean => {
    if (operationRepo.current !== null) return false
    if (next.id !== repoId) {
      setHooks(null)
      setPublish(null)
      setAmendRepoId(null)
      setSelection(null)
      setMarks(null)
      setFilter(null)
    }
    setStoredRepo(next.relativePath)
    if (persist) {
      try { localStorage.setItem(repoStorageKey(selectionKey), next.relativePath) } catch { /* Keep the in-memory choice. */ }
    }
    return true
  }, [selectionKey, repoId])

  // When the active session runs in a worktree that is listed, show that worktree's repository (once per session worktree).
  useEffect(() => {
    if (selectionKey !== profileId && readStoredRepo(selectionKey) !== null) return
    if (!sessionWorktreePath) { followedWorktree.current = null; return }
    if (!view || followedWorktree.current === sessionWorktreePath) return
    const match = view.repos.find(candidate => candidate.kind === 'worktree' && candidate.relativePath.toLowerCase() === sessionWorktreePath.toLowerCase())
    if (match && switchRepo(match, false)) followedWorktree.current = sessionWorktreePath
  }, [view, sessionWorktreePath, switchRepo, operation, selectionKey, profileId])
  const ready = repo?.state === 'ready'
  const currentBranches = branches && branches.repoId === repo?.id && branches.headOid === repo.headOid
    && branches.branch === repo.branch && branches.reload === branchReload ? branches : null

  const acceptStatus = useCallback((next: GitRepoStatusView): void => {
    setStatus(current => visibleRepo.current !== next.repoId || (current?.repoId === next.repoId && current.generation > next.generation) ? current : next)
  }, [])

  // The file list: reload when this repository's list, branch or commit changes.
  useEffect(() => {
    if (!repo || repo.state !== 'ready') { setStatus(null); return }
    let stale = false
    window.copilotDesktop.gitStatus(profileId, repo.id)
      .then(next => { if (!stale) { acceptStatus(next); setStatusError(null) } })
      .catch((cause: unknown) => { if (!stale) setStatusError({ repoId: repo.id, message: errorMessage(cause) }) })
    return () => { stale = true }
  }, [profileId, repo?.id, repo?.state, repo?.generation, repo?.headOid, repo?.branch, repo?.ahead, repo?.behind]) // eslint-disable-line react-hooks/exhaustive-deps

  const currentStatus = status && repo && status.repoId === repo.id ? status : null
  const selectedEntry = selection && currentStatus ? entryOnSide(currentStatus, selection.path, selection.staged) ?? null : null
  const currentStatusError = statusError?.repoId === repoId ? statusError.message : null

  // Reconcile selection and comments before showing a fresh status, including changes from a terminal or Copilot.
  useLayoutEffect(() => {
    if (!currentStatus) return
    const previous = previousStatus.current
    previousStatus.current = currentStatus
    setSelection(current => reconcileSelection(current, currentStatus, previous))
    if (currentStatus.truncated) return
    const staged = new Set(currentStatus.staged.map(entry => entry.path))
    const working = new Set(groupsOnSide(currentStatus, false).flat().map(entry => entry.path))
    setComments(current => pruneCommentBuckets(current, currentStatus.repoId, (path, isStaged) => (isStaged ? staged : working).has(path)))
  }, [currentStatus])

  // The diff of the selected file: reload on selection, on a changed list, and when the window regains focus.
  const diffKey = repo && selectedEntry && selection ? `${repo.id}:${selectedEntry.id}:${selection.staged}:${wholeFile ? 'whole' : 'hunks'}` : null
  const diffError = diffFailure && diffFailure.key === diffKey ? diffFailure.message : null
  useEffect(() => {
    if (!repo || !selectedEntry || !selection || !diffKey) { setDiff(null); setDiffFailure(null); return }
    let stale = false
    window.copilotDesktop.gitDiff(profileId, repo.id, selectedEntry.id, selection.staged, wholeFile)
      .then(value => { if (!stale) { setDiff({ key: diffKey, value }); setDiffFailure(null) } })
      .catch((cause: unknown) => { if (!stale) setDiffFailure({ key: diffKey, message: errorMessage(cause) }) })
    return () => { stale = true }
  }, [profileId, diffKey, reload]) // eslint-disable-line react-hooks/exhaustive-deps
  const cursorScope = JSON.stringify([repo?.id, repo?.branch, repo?.headOid, selection, wholeFile, tab, promptTarget?.id])
  const activeCursor = cursor?.scope === cursorScope && diff?.key === diffKey && !diffError && tab === 'changes'
    && cursor.diffText === diff.value.text ? cursor.anchor : null
  useLayoutEffect(() => { setCursor(null) }, [cursorScope])
  useLayoutEffect(() => {
    setCursor(current => current && diff && current.diffText !== diff.value.text ? null : current)
  }, [diff?.value.text])
  // Answer synchronously at submission time. Unmounting/closing the panel removes the provider.
  useLayoutEffect(() => {
    if (!active || !activeCursor || !repo || !selection || !diff || !promptTarget || !ready || currentStatusError) return
    const text = composeGitCursorContext({ folder: repo.folder, path: selection.path, staged: selection.staged,
      diffText: diff.value.text, ...activeCursor })
    const id = cursor!.id
    const provide = (event: Event): void => {
      const request = (event as CustomEvent<GitCursorContextRequest>).detail
      if (request.tabId !== promptTarget.id) return
      request.text = text
      // An acknowledgement for an older submission must not clear a line selected in the meantime.
      request.complete = attached => setCursor(current => current?.id === id
        ? attached ? null : { ...current, declined: true }
        : current)
    }
    window.addEventListener(GIT_CURSOR_CONTEXT_EVENT, provide)
    return () => window.removeEventListener(GIT_CURSOR_CONTEXT_EVENT, provide)
  }, [active, activeCursor, cursor?.id, repo, selection, diff, promptTarget?.id, ready, currentStatusError])
  const commentTarget = selection
  const commentKey = commentTarget ? bucketKey(commentTarget) : null
  const activeComments = commentKey ? comments.get(commentKey) ?? null : null
  const pendingComments = activeComments?.pending.length ?? 0
  const commentCount = activeComments ? activeComments.items.size + activeComments.unanchored.length + pendingComments : 0
  useLayoutEffect(() => {
    if (!pendingComments || !commentKey || !diff || diff.key !== diffKey || diffError) return
    setComments(current => anchorMovedComments(current, commentKey, diff.value))
  }, [pendingComments, commentKey, diff, diffKey, diffError])
  // Compared by the changed lines alone, so comments written in the other view (more or less context) are not stale.
  const diffSignature = useMemo(() => diff ? diffChangeSignature(diff.value.text) : null, [diff])
  const baseline = activeComments?.diffText ?? null
  const baselineSignature = useMemo(() => baseline === null ? null : diffChangeSignature(baseline), [baseline])
  const commentsStale = baselineSignature !== null && diff?.key === diffKey && diffSignature !== baselineSignature
  const openSelectedFile = (): void => {
    if (!repo || !selection) return
    const repoId = repo.id
    void window.copilotDesktop.openFile({ profileId, folder: repo.folder }, selection.path).then(result => {
      if (!result.ok) updateFeedback(repoId, { area: 'diff', error: result.reason === 'missing' ? 'This file is not on disk. It may have been deleted.'
        : result.reason === 'limit' ? result.message ?? 'Too many files are open. Close a file tab first.' : 'Only files in the workspace can be opened.' })
    }, (cause: unknown) => updateFeedback(repoId, { area: 'diff', error: errorMessage(cause) }))
  }
  const toggleWholeFile = (): void => {
    const next = !wholeFile
    setWholeFile(next)
    try { localStorage.setItem(WHOLE_FILE_KEY, next ? '1' : '0') } catch { /* Keep the in-memory choice. */ }
  }
  const changeListShare = (next: number): void => {
    setListShare(next)
    try { localStorage.setItem(LIST_SHARE_KEY, String(Math.round(next))) } catch { /* Keep the in-memory choice. */ }
  }
  const changeComment = (key: string, anchor: DiffCommentAnchor, text: string | null): void => {
    if (!commentKey || !diff || diff.key !== diffKey) return
    const diffText = diff.value.text
    setComments(current => updateCommentBucket(current, commentTarget!, diffText, key, anchor, text))
  }
  const clearComments = (): void => { if (commentKey) setComments(current => removeCommentBucket(current, commentKey)) }

  useEffect(() => {
    const onFocus = (): void => setReload(count => count + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  // A changed project view means files may have changed under a selection that still exists.
  useEffect(() => { setReload(count => count + 1) }, [view])

  // Amend: the last commit's message and where it is published, whenever amending is on and the commit changes.
  useEffect(() => {
    if (!amending || !repo || repo.state !== 'ready' || repo.headOid === null) return
    let stale = false
    window.copilotDesktop.gitHeadCommit(profileId, repo.id)
      .then(info => { if (!stale) setHeadCommit({ repoId: repo.id, headOid: info.oid, info }) })
      .catch((cause: unknown) => { if (!stale) { updateFeedback(repo.id, { area: 'commit', error: errorMessage(cause) }); setAmendRepoId(null) } })
    return () => { stale = true }
  }, [amending, profileId, repo?.id, repo?.state, repo?.headOid]) // eslint-disable-line react-hooks/exhaustive-deps

  // Branches.
  useEffect(() => {
    if (tab !== 'branches' || !repo || repo.state !== 'ready') return
    let stale = false
    const scope = { repoId: repo.id, headOid: repo.headOid, branch: repo.branch, reload: branchReload }
    setBranches(null)
    window.copilotDesktop.gitBranches(profileId, repo.id)
      .then(items => { if (!stale) setBranches({ ...scope, items, error: null }) })
      .catch((cause: unknown) => { if (!stale) setBranches({ ...scope, items: null, error: errorMessage(cause) }) })
    return () => { stale = true }
  }, [profileId, tab, repo?.id, repo?.state, repo?.headOid, repo?.branch, branchReload]) // eslint-disable-line react-hooks/exhaustive-deps
  // Worktrees: reloaded with the branches, and whenever the project view changes (a session's worktree may have appeared).
  useEffect(() => {
    if (tab !== 'branches' || !repo || repo.state !== 'ready') return
    let stale = false
    window.copilotDesktop.gitWorktrees(profileId, repo.id)
      .then(items => { if (!stale) { setWorktrees({ repoId: repo.id, items }); setWorktreeError(null) } })
      .catch((cause: unknown) => { if (!stale) setWorktreeError({ repoId: repo.id, message: errorMessage(cause) }) })
    return () => { stale = true }
  }, [profileId, tab, repo?.id, repo?.state, repo?.headOid, repo?.branch, branchReload, view]) // eslint-disable-line react-hooks/exhaustive-deps
  const trust = (): void => {
    if (!repo?.configHash) return
    setWorking(true)
    updateFeedback(repo.id, { area: 'trust' })
    window.copilotDesktop.gitTrust(profileId, repo.id, repo.configHash).then(replace)
      .catch((cause: unknown) => updateFeedback(repo.id, { area: 'trust', error: errorMessage(cause) })).finally(() => setWorking(false))
  }

  const addToPrompt = (): void => {
    if (!repo || !selection || !selectedEntry || !diff || diff.key !== diffKey || !promptTarget) return
    const send = (value: GitDiff): void => {
      const target = currentPromptTarget.current
      if (!target) { updateFeedback(repo.id, { area: 'diff', error: 'Open or resume a session in this project to add Git context.' }); return }
      insert(target.id, composeDiffPrompt({ repoName: repo.name, path: selection.path, staged: selection.staged, diff: value }))
      updateFeedback(repo.id, { area: 'diff', notice: `Added to the prompt box of “${target.title}”. Review it and press Enter to send.` })
    }
    if (!wholeFile) { send(diff.value); return }
    // The whole file would crowd the change out of the prompt: send the change with its usual context instead.
    updateFeedback(repo.id, { area: 'diff' })
    window.copilotDesktop.gitDiff(profileId, repo.id, selectedEntry.id, selection.staged)
      .then(send).catch((cause: unknown) => updateFeedback(repo.id, { area: 'diff', error: errorMessage(cause) }))
  }

  const addCommentsToPrompt = (): void => {
    if (!repo || !selection || !activeComments || activeComments.pending.length || !promptTarget) return
    const ordered = orderedComments(activeComments)
    const result = composeReviewCommentsPrompt({ repoName: repo.name, path: selection.path, staged: selection.staged, comments: ordered })
    insert(promptTarget.id, result.text)
    const left = ordered.length - result.included
    updateFeedback(repo.id, { area: 'diff', notice: `Added ${result.included} comment${result.included === 1 ? '' : 's'} to the prompt box of “${promptTarget.title}”.`
      + (left > 0 ? ` ${left} did not fit.` : '') + (result.quotesDropped ? ' The quoted lines were left out to fit.' : '') + ' Review it and press Enter to send.' })
  }

  const draftMessage = (): void => {
    if (!repo || !currentStatus || !promptTarget) return
    // Read a bounded number of diffs, but hand the composer the whole staged inventory so it can name and count the rest.
    const read = currentStatus.staged.slice(0, MAX_DRAFT_FILES)
    const omitted = currentStatus.staged.slice(MAX_DRAFT_FILES).map(entry => entry.path)
    setWorking(true)
    updateFeedback(repo.id, { area: 'commit' })
    Promise.all(read.map(entry => window.copilotDesktop.gitDiff(profileId, repo.id, entry.id, true).then(value => ({ path: entry.path, diff: value }))))
      .then(parts => {
        const target = currentPromptTarget.current
        if (!target) { updateFeedback(repo.id, { area: 'commit', error: 'Open or resume a session in this project to add Git context.' }); return }
        insert(target.id, composeCommitMessagePrompt({ repoName: repo.name, branch: repo.branch, parts, omitted, listTruncated: currentStatus.truncated }))
        updateFeedback(repo.id, { area: 'commit', notice: `Asked “${target.title}” to draft a commit message. Review the prompt and press Enter to send.` })
      })
      .catch((cause: unknown) => updateFeedback(repo.id, { area: 'commit', error: errorMessage(cause) })).finally(() => setWorking(false))
  }

  // What a running write prints (a commit hook's messages, say) appears as it arrives.
  useEffect(() => window.copilotDesktop.onGitProgress(payload => {
    if (payload.profileId === profileId && payload.event.repoId === operationRepo.current) setProgress(previous => appendOutput(previous, payload.event.text))
  }), [profileId])

  const messageKey = repo?.relativePath ?? ''
  const message = draftOf(messages, messageKey)
  const commitAttempt: CommitAttempt | null = repo && currentStatus ? {
    repoId: repo.id, generation: currentStatus.generation, message,
    branch: repo.detached ? null : repo.branch, headOid: repo.headOid, amend: amending,
  } : null
  const requestedCommit = hookApproval?.attempt
  const hooks = requestedCommit && commitAttempt
    && requestedCommit.repoId === commitAttempt.repoId
    && requestedCommit.generation === commitAttempt.generation && requestedCommit.generation === repo?.generation
    && requestedCommit.message === commitAttempt.message && requestedCommit.amend === commitAttempt.amend
    && requestedCommit.branch === commitAttempt.branch && requestedCommit.headOid === commitAttempt.headOid ? hookApproval : null
  const setMessage = (value: string): void => {
    if (value !== message) setHooks(null)
    if (value.trim() !== untouchedAmendDrafts.current.get(messageKey)?.trim()) untouchedAmendDrafts.current.delete(messageKey)
    setMessages(current => ({ ...current, [messageKey]: value }))
  }
  const suggestionDraft = amending || untouchedAmendDrafts.current.get(messageKey)?.trim() === message.trim() ? '' : message
  const branchDraftKey = repo?.folder ?? ''
  const newBranch = draftOf(branchDrafts, branchDraftKey)

  /** Run one write, show its outcome, and take the fresh status it returns. */
  const runWrite = (kind: WriteKind, owner: { id: string; key: string }, task: () => Promise<GitOperationResult>, options: {
    seen?: { branch: string; headOid: string } | null
    attempt?: CommitAttempt
    indexMove?: { paths: readonly string[]; staged: boolean }
  } = {}): void => {
    if (operationRepo.current !== null || visibleRepo.current !== owner.id) return
    operationRepo.current = owner.id
    setOperation({ kind, repoId: owner.id })
    setProgress('')
    const area = writeArea[kind]
    updateFeedback(owner.id, { area })
    setHooks(null)
    setPublish(null)
    setPullFailure(null)
    const seenBranch = options.seen
    task().then((result: GitOperationResult) => {
      const next = result.status
      if (next?.repoId === owner.id) {
        const latest = previousStatus.current
        if (result.ok && options.indexMove && !(latest?.repoId === owner.id && latest.generation > next.generation)) {
          const { paths, staged } = options.indexMove
          const destination = new Set(groupsOnSide(next, staged).flat().map(entry => entry.path))
          const moved = new Set(paths.filter(path => destination.has(path)))
          setSelection(current => current?.repoId === owner.id && current.staged !== staged && moved.has(current.path)
            ? { ...current, staged } : current)
          setComments(current => {
            let updated = current
            for (const path of moved) {
              const source = updated.get(bucketKey({ repoId: owner.id, path, staged: !staged }))
              if (source) updated = moveCommentBucket(updated, source)
            }
            return updated
          })
        }
        acceptStatus(next)
      }
      if (kind === 'pull' && seenBranch && (result.reason === 'diverged' || result.reason === 'local-changes')) {
        setPullFailure({ repoId: owner.id, branch: seenBranch.branch, headOid: seenBranch.headOid, reason: result.reason, output: result.output })
      }
      const output = readableOutput(result.output).trimEnd()
      if (result.ok) {
        updateFeedback(owner.id, { area, notice: result.message, output })
        // The draft that was committed belongs to the repository that committed it, whichever one is on screen now.
        if (kind === 'commit') {
          untouchedAmendDrafts.current.delete(owner.key)
          setMessages(current => ({ ...current, [owner.key]: '' }))
          setAmendRepoId(current => current === owner.id ? null : current)
        }
        if (kind === 'worktree') setBranchReload(count => count + 1)
      } else if (result.reason === 'cancelled' && (kind === 'discard' || kind === 'branch' || kind === 'worktree')) {
        updateFeedback(owner.id, { area, notice: result.message, output })
      } else if (result.reason === 'hooks-need-approval' && result.hooksHash && options.attempt) {
        updateFeedback(owner.id, { area, output })
        setHooks({ attempt: options.attempt, names: result.hooks, hash: result.hooksHash })
      } else if (result.reason === 'needs-upstream' && result.remotes.length > 0 && seenBranch) {
        updateFeedback(owner.id, { area, output })
        setPublish({ repoId: owner.id, ...seenBranch, remotes: result.remotes, remote: result.remotes.includes('origin') ? 'origin' : result.remotes[0] ?? '' })
      } else {
        updateFeedback(owner.id, { area, error: result.message, output })
      }
    }).catch((cause: unknown) => updateFeedback(owner.id, { area, error: errorMessage(cause) })).finally(() => {
      operationRepo.current = null
      setOperation(null)
      if (kind === 'branch') setBranchReload(count => count + 1)
    })
  }

  const changeIndex = (kind: 'stage' | 'unstage', entries: readonly GitEntryView[]): void => {
    if (!repo || !currentStatus || entries.length === 0) return
    const generation = currentStatus.generation
    const ids = entries.map(entry => entry.id)
    setMarks(null)
    runWrite(kind, { id: repo.id, key: repo.relativePath }, () => kind === 'stage' ? window.copilotDesktop.gitStage(profileId, repo.id, ids, generation) : window.copilotDesktop.gitUnstage(profileId, repo.id, ids, generation),
      { indexMove: { paths: entries.map(entry => entry.path), staged: kind === 'stage' } })
  }

  // A pull or push is for the branch, at the commit, that was on screen when the person clicked; if it has changed since, main refuses.
  const sync = (kind: GitSyncKind, publishTo: string | null = null, seen?: { branch: string; headOid: string }): void => {
    if (!repo) return
    const expected = kind === 'fetch' ? null : seen ?? (repo.branch !== null && repo.headOid !== null ? { branch: repo.branch, headOid: repo.headOid } : null)
    if (kind !== 'fetch' && expected === null) return
    runWrite(kind, { id: repo.id, key: repo.relativePath }, () => window.copilotDesktop.gitSync(profileId, repo.id, kind, publishTo, expected), { seen: expected })
  }

  // A branch change is for the branch, at the commit, that was on screen when the person clicked; main refuses if that has moved.
  const changeBranch = (action: 'create' | 'switch', name: string): void => {
    if (!repo || repo.headOid === null) return
    const expected = { branch: repo.detached ? null : repo.branch, headOid: repo.headOid }
    runWrite('branch', { id: repo.id, key: repo.relativePath }, async () => {
      const result = await window.copilotDesktop.gitBranch(profileId, repo.id, action, name, expected)
      if (result.ok && action === 'create') setBranchDrafts(current => ({ ...current, [repo.folder]: '' }))
      return result
    })
  }

  // The service checks that the worktree is merged, unused and unlocked, then asks in a native window; nothing here decides.
  const removeWorktree = (path: string): void => {
    if (!repo) return
    runWrite('worktree', { id: repo.id, key: repo.relativePath }, () => window.copilotDesktop.gitWorktreeRemove(profileId, repo.id, path))
  }

  // The native window in main lists the files and asks; nothing here decides for the person.
  const discard = (entries: readonly GitEntryView[]): void => {
    if (!repo || !currentStatus || entries.length === 0) return
    const generation = currentStatus.generation
    const ids = entries.map(entry => entry.id)
    setMarks(null)
    runWrite('discard', { id: repo.id, key: repo.relativePath }, () => window.copilotDesktop.gitDiscard(profileId, repo.id, ids, generation))
  }

  const commit = (approval: HookApproval | null): void => {
    const attempt = approval?.attempt ?? commitAttempt
    if (!repo || !attempt || attempt.repoId !== repo.id || (approval && approval !== hooks)) return
    const { repoId, generation, branch, headOid, message } = attempt
    const hash = approval?.hash ?? null
    const owner = { id: repoId, key: repo.relativePath }
    if (attempt.amend) {
      if (headOid === null) return
      runWrite('commit', owner, () => window.copilotDesktop.gitAmend(profileId, repoId, message, generation, hash, { branch, headOid }), { attempt })
      return
    }
    const expected = approval ? { branch, headOid } : undefined
    runWrite('commit', owner, () => window.copilotDesktop.gitCommit(profileId, repoId, message, generation, hash, expected), { attempt })
  }

  // Turning Amend on puts the last message in an empty box (so it can be edited); turning it off removes it again if it is untouched.
  const toggleAmend = (on: boolean): void => {
    setAmendRepoId(on ? repoId : null)
    setHooks(null)
    if (on) amendPrefill.current = message.trim() === ''
    else if (headCommit && headCommit.info.message.trim() === message.trim()) setMessage('')
  }
  useEffect(() => {
    // Only the last commit's own message: the info cached from an earlier commit (before this amend or commit) must never be used.
    if (!amending || !headCommit || !repo || headCommit.repoId !== repo.id || headCommit.headOid !== repo.headOid || !amendPrefill.current) return
    amendPrefill.current = false
    untouchedAmendDrafts.current.set(repo.relativePath, headCommit.info.message)
    setMessages(current => ({ ...current, [repo.relativePath]: headCommit.info.message }))
  }, [amending, headCommit, repo?.headOid]) // eslint-disable-line react-hooks/exhaustive-deps
  const amendInfo = headCommit && headCommit.repoId === repoId && headCommit.headOid === repo?.headOid ? headCommit.info : null
  const amendState: AmendState | null = repo && repo.headOid !== null ? {
    on: amending,
    loading: amending && amendInfo === null,
    lastMessage: amendInfo?.message ?? null,
    publishedTo: amendInfo?.publishedTo ?? [],
    isMerge: amendInfo?.isMerge ?? false,
  } : null

  // Cancel the repository that owns the running write, not whichever one is selected.
  const cancelWrite = (): void => { if (operation) void window.copilotDesktop.gitCancel(profileId, operation.repoId).catch(() => undefined) }

  const feedbackAt = (area: FeedbackArea): JSX.Element | null => {
    if (visibleOperation && writeArea[visibleOperation.kind] === area && (area === 'files' || area === 'branch' || area === 'worktree')) {
      return <div className="git-feedback" data-area={area}>
        <button type="button" onClick={cancelWrite}>Cancel</button>
        <GitOutput text={progress} live />
      </div>
    }
    return feedback?.area === area && (feedback.notice || feedback.error || feedback.output)
      ? <GitFeedback key={repoId} feedback={feedback} /> : null
  }

  const pickEntry = (entry: GitEntryView, staged: boolean, mode: MarkMode, list: readonly string[]): void => {
    if (!repoId) return
    setSelection({ repoId, path: entry.path, staged })
    setMarks(current => nextMarks(current, staged ? 'staged' : 'working', entry.path, list, mode))
    if (feedback?.area === 'diff') updateFeedback(repoId, { area: 'diff' })
  }
  // Two or more selected files on one side: the bar acts on them, and so does a row's own button when that row is one of them.
  const query = pathFilter.trim().toLowerCase()
  const matching = (entries: GitEntryView[]): GitEntryView[] => query
    ? entries.filter(entry => entry.path.toLowerCase().includes(query) || entry.originalPath?.toLowerCase().includes(query)) : entries
  const stagedFiles = matching(currentStatus?.staged ?? [])
  const changedFiles = matching(currentStatus?.unstaged ?? [])
  const newFiles = matching(currentStatus?.untracked ?? [])
  const conflictFiles = matching(currentStatus?.conflicted ?? [])
  const sideEntries = (side: MarkSide): GitEntryView[] => side === 'staged' ? stagedFiles : [...changedFiles, ...newFiles]
  const filterFiles = (value: string): void => {
    setFilter(repoId && value ? { repoId, value } : null)
    setMarks(null)
  }
  const markedNow = marks ? markedEntries(marks, marks.side, sideEntries(marks.side)) : []
  const several = markedNow.length > 1 ? markedNow : []
  const markedPaths = new Set(markedNow.map(entry => entry.path))
  const groupMarks = (side: MarkSide): ReadonlySet<string> | null => marks?.side === side ? markedPaths : null
  const forRow = (entry: GitEntryView, side: MarkSide): GitEntryView[] => several.length > 0 && groupMarks(side)?.has(entry.path) ? several : [entry]
  const discardableOf = (entries: readonly GitEntryView[]): GitEntryView[] => entries.filter(canDiscard)
  const rowLabel = (verb: string, side: MarkSide, pick: (entries: GitEntryView[]) => GitEntryView[] = entries => entries) => (entry: GitEntryView): string | null => {
    const entries = forRow(entry, side)
    return entries.length > 1 ? `${verb} the ${pick(entries).length} selected files` : null
  }
  const canInsert = promptTarget !== null

  // Resolve with Copilot: after a pull Copilot can finish, or while a merge is stopped on conflicts.
  const failure = pullFailure && repo && pullFailure.repoId === repo.id && pullFailure.branch === repo.branch && pullFailure.headOid === repo.headOid ? pullFailure : null
  // Conflicts from a cherry-pick, revert or rebase are not a merge: the task's "finish and commit the merge" would leave that
  // operation half done, so nothing is offered for them.
  const conflicted = (currentStatus?.conflicted.length ?? 0) > 0
  const situation: ResolvePullSituation | null = !repo || repo.detached || repo.branch === null ? null
    : conflicted ? (repo.merging ? 'conflicts' : null) : failure?.reason ?? null
  // The claim lives in main: closing and reopening the panel does not forget it, and main refuses the writes it covers.
  const resolver = repo?.resolver ?? null
  const publishOffer = publish && publish.repoId === repoId && publish.branch === repo?.branch && publish.headOid === repo.headOid ? publish : null
  const copilotWriting = resolver?.working === true
  const writesLocked = operation !== null || copilotWriting
  const lockedReason = copilotWriting ? `Copilot is working on this repository in “${resolver.title}”. Wait for it to finish.`
    : operation && !visibleOperation ? 'Wait for Git to finish in the other repository.' : null
  useEffect(() => {
    if (!view) return
    for (const item of view.repos) {
      const title = lastResolver.current.get(item.id)
      if (item.resolver?.working) lastResolver.current.set(item.id, item.resolver.title)
      else if (title !== undefined) {
        lastResolver.current.delete(item.id)
        if (!item.resolver) updateFeedback(item.id, { area: 'sync', notice: `“${title}” has finished. Check the Changes list and History, and what Copilot reported, before you push.` })
      }
    }
  }, [view, updateFeedback])

  const resolveWithCopilot = (): void => {
    if (!repo || !repo.branch || !situation || !promptTarget || !currentStatus) return
    const target = promptTarget
    const text = composeResolvePullPrompt({
      repoName: repo.name, folder: repo.folder, branch: repo.branch, upstream: repo.upstream, ahead: repo.ahead ?? 0, behind: repo.behind ?? 0, situation,
      output: failure?.output ?? '', blocked: failure?.reason === 'local-changes' ? filesInTheWay(failure.output) : [], conflicted: currentStatus.conflicted.map(entry => entry.path),
    })
    const owner = repo.id
    const deliver = sendTask ?? ((repoId: string, tabId: string, task: string) => sendOrPaste(profileId, repoId, tabId, task, insert, () => currentPromptTarget.current?.id))
    // One request at a time, until main's answer (and its claim) is in: a second click must not hand the task over twice.
    if (resolveInFlight.current) return
    resolveInFlight.current = true
    setResolveSending(true)
    updateFeedback(owner, { area: 'sync' })
    deliver(owner, target.id, text).finally(() => { resolveInFlight.current = false; setResolveSending(false) }).then(outcome => {
      if (outcome.result === 'refused') { updateFeedback(owner, { area: 'sync', error: outcome.message }); return }
      setPullFailure(current => current?.repoId === owner ? null : current)
      updateFeedback(owner, { area: 'sync', notice: outcome.result === 'sent'
        ? `Asked “${target.title}” to pull and resolve the conflicts. Follow it in the session, and answer if it asks you something.`
        : `${outcome.message} The task is in the prompt box of “${target.title}”; press Enter there when it is ready.` })
    }).catch((cause: unknown) => updateFeedback(owner, { area: 'sync', error: errorMessage(cause) }))
  }

  return (
    <aside className="git-panel" aria-label="Git">
      <header className="git-panel-header">
        <h2>Git</h2>
        {repo && view && view.repos.length > 1
          ? <RepoSwitcher active={active} repos={view.repos} repo={repo} locked={operation !== null} onSelect={item => switchRepo(item, true)} />
          : <span className="git-panel-sub">{repo?.name ?? (view ? '0 repositories' : 'Loading…')}</span>}
        <button type="button" className="icon-button" aria-label="Rescan repositories" title="Rescan this folder for repositories and refresh" disabled={busy}
          onClick={() => { setBranchReload(count => count + 1); rescan() }}>↻</button>
        {!embedded && <button type="button" className="icon-button" aria-label={takeover ? 'Close Git panel and return to the session' : 'Close Git panel'}
          title={takeover ? 'Back to the session' : 'Close (Ctrl+Shift+G)'} onClick={onClose}>×</button>}
      </header>

      {error && <p className="git-message git-message-error" role="alert">{error}</p>}
      {!view && !error && <p className="git-message" role="status">Looking for repositories…</p>}
      {view && !view.git.available && <p className="git-message git-message-error" role="alert">{view.git.error}</p>}
      {view && view.git.available && !view.git.supported && <p className="git-message git-message-error" role="alert">{view.git.error}</p>}
      {view && view.git.available && view.repos.length === 0 && (
        <p className="git-message" role="status">No Git repositories were found in this project folder.{view.notes.length > 0 && ` ${view.notes.join(' ')}`}</p>
      )}
      {view && view.notes.length > 0 && view.repos.length > 0 && <p className="git-note" role="status">{view.notes.join(' ')}</p>}

      {repo && (
        <div className="git-repo-view">
          {ready && (
            <div className="git-branch" role="status">
              <span className="git-branch-name">{repo.detached ? 'Detached HEAD' : repo.branch ?? 'No commits yet'}</span>
              {repo.upstream && <span className="git-branch-upstream">{repo.upstream}</span>}
              {(repo.ahead ?? 0) > 0 && <span className="git-ahead">↑{repo.ahead}</span>}
              {(repo.behind ?? 0) > 0 && <span className="git-behind">↓{repo.behind}</span>}
              <span className="git-branch-state">{stateLabel(repo)}</span>
            </div>
          )}

          {ready && (
            <GitSyncBar upstream={repo.upstream} ahead={repo.ahead ?? 0} behind={repo.behind ?? 0}
              noBranch={repo.detached || repo.branch === null || repo.headOid === null}
              locked={writesLocked} running={visibleOperation && (visibleOperation.kind === 'fetch' || visibleOperation.kind === 'pull' || visibleOperation.kind === 'push') ? visibleOperation.kind : null}
              progress={visibleOperation ? progress : ''}
              publish={publishOffer}
              onSync={kind => sync(kind)} onChooseRemote={remote => setPublish(current => current && current === publishOffer ? { ...current, remote } : current)}
              onPublish={() => { if (publishOffer) sync('push', publishOffer.remote, publishOffer) }} onDismissPublish={() => setPublish(null)} onCancel={cancelWrite} />
          )}

          {feedbackAt('sync')}
          {ready && situation && repo.branch && !copilotWriting && (
            <GitResolveBar situation={situation} branch={repo.branch} upstream={repo.upstream} folder={repo.folder} target={promptTarget}
              outside={promptTarget?.cwd ? !folderWithin(repo.folder, promptTarget.cwd) : false}
              blocker={resolveBlocker(promptTarget, operation !== null, resolveSending)} onResolve={resolveWithCopilot} />
          )}
          {copilotWriting && <p className="git-message git-message-info" role="status">{lockedReason}</p>}
          {repo.state === 'needs-review' && <GitReviewCard items={repo.reviewItems} working={working} onTrust={trust} />}

          {feedbackAt('trust')}
          {repo.state === 'error' && <p className="git-message git-message-error" role="alert">{repo.error ?? 'This repository could not be read.'}</p>}

          {ready && (
            <>
              <div className="git-tabs" role="tablist" aria-label="Repository views">
                {(['changes', 'history', 'branches'] as const).map((viewTab, index, tabs) => (
                  <button key={viewTab} type="button" role="tab" aria-selected={tab === viewTab} tabIndex={tab === viewTab ? 0 : -1}
                    onClick={() => setTab(viewTab)} onKeyDown={event => {
                      let next: number
                      switch (event.key) {
                        case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break
                        case 'ArrowRight': next = (index + 1) % tabs.length; break
                        case 'Home': next = 0; break
                        case 'End': next = tabs.length - 1; break
                        default: return
                      }
                      event.preventDefault()
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
                      setTab(tabs[next]!)
                    }}>{viewTab === 'changes' ? 'Changes' + (repo.changeCount ? ' (' + repo.changeCount + ')' : '') : viewTab === 'history' ? 'History' : 'Branches'}</button>
                ))}
              </div>

              {currentStatusError && <p className="git-message git-message-error" role="alert">{currentStatusError}</p>}

              {tab === 'changes' && (
                // While a diff is shown, the list and the commit box scroll on their own above it, and the divider sets how
                // much of the height each gets: a long list must not push the diff out of sight.
                <div className={`git-changes${selection ? ' git-changes-split' : ''}`} ref={changesRef}>
                  <div className="git-changes-list" style={selection ? { flexBasis: `${listShare}%` } : undefined}>
                  {feedbackAt('files')}
                  {currentStatus && currentStatus.totalEntries === 0 && <p className="git-message" role="status">Nothing to commit. The working tree is clean.</p>}
                  {currentStatus && (
                    <div className="git-files" onKeyDown={event => {
                      if (event.key === 'Escape' && pathFilter) {
                        event.preventDefault()
                        event.stopPropagation()
                        filterFiles('')
                        event.currentTarget.querySelector<HTMLInputElement>('.git-path-filter')?.focus()
                      } else {
                        navigateFiles(event)
                      }
                    }}>
                      {(currentStatus.totalEntries > 0 || pathFilter) && <input type="search" className="git-path-filter"
                        aria-label="Filter changed files by path" placeholder="Filter by path" value={pathFilter}
                        onChange={event => filterFiles(event.target.value)} onKeyDown={event => {
                          if (event.key === 'ArrowDown') {
                            event.preventDefault()
                            const first = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.git-entry')
                            first?.focus()
                            first?.click()
                          }
                        }} />}
                      {query && currentStatus.totalEntries > 0 && ![stagedFiles, changedFiles, newFiles, conflictFiles].some(files => files.length) &&
                        <p className="git-note" role="status">No matching files.</p>}
                      {several.length > 0 && marks && (
                        <GitMarkedBar count={several.length} side={marks.side} discardable={marks.side === 'working' ? discardableOf(several).length : 0} disabled={writesLocked}
                          onChangeIndex={() => changeIndex(marks.side === 'staged' ? 'unstage' : 'stage', several)} onDiscard={() => discard(discardableOf(several))}
                          onClear={() => setMarks(selection ? { side: selection.staged ? 'staged' : 'working', paths: [selection.path], anchor: selection.path } : null)} />
                      )}
                      <EntryGroup title="Conflicts" entries={conflictFiles} codeOf={() => 'U'} staged={false} selection={selection} marked={null} multiple={false} onSelect={pickEntry}
                        rowAction={{ symbol: '✓', verb: 'Mark resolved:', disabled: writesLocked, run: entry => changeIndex('stage', [entry]) }} />
                      <EntryGroup title="Staged" entries={stagedFiles} codeOf={entry => entry.index} staged selection={selection} marked={groupMarks('staged')} onSelect={pickEntry}
                        rowAction={{ symbol: '−', verb: 'Unstage', disabled: writesLocked, run: entry => changeIndex('unstage', forRow(entry, 'staged')), labelOf: rowLabel('Unstage', 'staged') }}
                        groupAction={{ label: query ? 'Unstage shown' : 'Unstage all', title: query ? 'Unstage matching files in this group' : currentStatus.truncated ? 'The file list is cut off, so this would only unstage the files shown' : 'Unstage every staged file', disabled: writesLocked || currentStatus.truncated, run: () => changeIndex('unstage', stagedFiles) }} />
                      <EntryGroup title="Changes" entries={changedFiles} codeOf={entry => entry.worktree} staged={false} selection={selection} marked={groupMarks('working')} onSelect={pickEntry}
                        rowAction={{ symbol: '+', verb: 'Stage', disabled: writesLocked, run: entry => changeIndex('stage', forRow(entry, 'working')), labelOf: rowLabel('Stage', 'working') }}
                        extraRowAction={{ symbol: '↶', verb: 'Discard', disabled: writesLocked, applies: canDiscard, run: entry => discard(discardableOf(forRow(entry, 'working'))), labelOf: rowLabel('Discard', 'working', discardableOf) }}
                        extraGroupAction={{ label: query ? 'Discard shown' : 'Discard all', title: query ? 'Discard matching files in this group' : currentStatus.truncated ? 'The file list is cut off, so this would only discard the files shown' : 'Discard every changed file. You will be asked first, and a copy of each is saved.', disabled: writesLocked || currentStatus.truncated, run: () => discard(changedFiles.filter(canDiscard)) }}
                        groupAction={{ label: query ? 'Stage shown' : 'Stage all', title: query ? 'Stage matching files in this group' : currentStatus.truncated ? 'The file list is cut off, so this would only stage the files shown' : 'Stage every changed file (not untracked ones)', disabled: writesLocked || currentStatus.truncated, run: () => changeIndex('stage', changedFiles) }} />
                      <EntryGroup title="Untracked" entries={newFiles} codeOf={() => '?'} staged={false} selection={selection} marked={groupMarks('working')} onSelect={pickEntry}
                        rowAction={{ symbol: '+', verb: 'Stage', disabled: writesLocked, run: entry => changeIndex('stage', forRow(entry, 'working')), labelOf: rowLabel('Stage', 'working') }}
                        extraRowAction={{ symbol: '↶', verb: 'Discard', disabled: writesLocked, applies: canDiscard, run: entry => discard(discardableOf(forRow(entry, 'working'))), labelOf: rowLabel('Discard', 'working', discardableOf) }}
                        extraGroupAction={{ label: query ? 'Discard shown' : 'Discard all', title: query ? 'Discard matching files in this group' : currentStatus.truncated ? 'The file list is cut off, so this would only discard the files shown' : `Move every untracked file to the ${TRASH_LABEL}. You will be asked first.`, disabled: writesLocked || currentStatus.truncated, run: () => discard(newFiles) }}
                        groupAction={{ label: query ? 'Stage shown' : 'Stage all', title: query ? 'Stage matching files in this group' : currentStatus.truncated ? 'The file list is cut off, so this would only stage the files shown' : 'Stage every untracked file', disabled: writesLocked || currentStatus.truncated, run: () => changeIndex('stage', newFiles) }} />
                      {currentStatus.truncated && <p className="git-note" role="status">Showing the first {currentStatus.staged.length + currentStatus.unstaged.length + currentStatus.untracked.length} of {currentStatus.totalEntries.toLocaleString()} changed files.</p>}
                    </div>
                  )}

                  {currentStatus && !(currentStatus.staged.length > 0 || message !== '' || visibleOperation?.kind === 'commit' || hooks !== null || amending) && amendState && (
                    <button type="button" className="git-amend-open" disabled={writesLocked} onClick={() => toggleAmend(true)} title="Fix the last commit: add staged files to it or change its message. Only for a commit that has not been pushed.">Amend last commit…</button>
                  )}
                  {currentStatus && (currentStatus.staged.length > 0 || message !== '' || visibleOperation?.kind === 'commit' || hooks !== null || amending) && (
                    <GitCommitBox stagedCount={currentStatus.staged.length} conflictCount={currentStatus.conflicted.length}
                      message={message} onMessageChange={setMessage} busy={visibleOperation?.kind ?? null} progress={visibleOperation ? progress : ''}
                      canDraft={canInsert && currentStatus.staged.length > 0 && !working}
                      draftTitle={canInsert ? 'Put a prompt in the session asking Copilot to write a commit message for the staged files' : 'Open a session in this window first'}
                      onDraft={draftMessage} onCommit={() => commit(null)} onCancel={cancelWrite}
                      hooks={hooks?.names ?? null} onApproveHooks={() => { if (hooks) commit(hooks) }} onDismissHooks={() => setHooks(null)}
                      amend={amendState} onToggleAmend={toggleAmend} lockedReason={lockedReason} />
                  )}
                  {feedbackAt('commit')}
                  {!selection && currentStatus && currentStatus.totalEntries > 0 && <p className="git-note">Select a file to see its diff.</p>}
                  </div>

                  {selection && (
                    <Splitter label="Resize file list and diff" orientation="horizontal" value={listShare} min={LIST_SHARE_MIN} max={LIST_SHARE_MAX} step={5}
                      containerRef={changesRef} fromPointer={(clientY, bounds) => (clientY - bounds.top) / bounds.height * 100} onChange={changeListShare} />
                  )}
                  {selection && (
                    <div className="git-diff-area">
                      <div className="git-diff-head">
                        <span className="git-diff-path" title={selection.path}>{selection.path}</span>
                        <span className="git-diff-side">{selection.staged ? 'staged' : 'working tree'}</span>
                        <button type="button" className="git-diff-whole-file" aria-pressed={wholeFile} onClick={toggleWholeFile}
                          title={wholeFile ? 'Show only the changes and the lines around them' : 'Show the whole file with the changes in place'}>
                          Whole file
                        </button>
                        <button type="button" className="git-diff-open-file" onClick={openSelectedFile} title="Open this file in a File tab">Open file</button>
                        <button type="button" className="git-diff-add-prompt" disabled={!canInsert || !diff || diff.key !== diffKey} onClick={addToPrompt}
                          title={canInsert ? `Put this diff in the prompt box of “${promptTarget?.title}”` : 'Open a session in this window first'}>
                          Add to prompt
                        </button>
                      </div>
                      {feedbackAt('diff')}
                      {diffError && <p className="git-message git-message-error" role="alert">{diffError}</p>}
                      {!diffError && selectedEntry === null && currentStatus?.truncated && <p className="git-message" role="status">This file is outside the displayed changes.</p>}
                      {!diffError && selectedEntry !== null && diff?.key === diffKey && (
                        <GitDiffView diff={diff.value} cursorKey={activeCursor ? `${activeCursor.side}:${activeCursor.line}` : null}
                          onCursor={anchor => setCursor({ scope: cursorScope, diffText: diff.value.text, anchor, id: ++cursorSequence.current, declined: false })}
                          comments={{ items: new Map([...(activeComments?.items ?? [])].map(([key, item]) => [key, item.text])), onChange: changeComment }} />
                      )}
                      {activeCursor && <p className="git-cursor-status" role="status">
                        CLI context: {activeCursor.side === 'old' ? 'old line' : 'line'} {activeCursor.line}. {cursor?.declined
                          ? 'Not added to the last prompt. The reference is still selected.'
                          : 'Added to your next question in the CLI.'}
                        <button type="button" onClick={() => setCursor(null)} aria-label="Clear cursor context">Clear</button>
                      </p>}
                      {!diffError && selectedEntry !== null && activeComments && (
                        <div className="git-diff-comments-bar">
                          <span className="git-diff-comments-count">{commentCount} comment{commentCount === 1 ? '' : 's'}</span>
                          {commentsStale && <span className="git-diff-comments-stale" role="status">The diff changed since these were written; check they still apply.</span>}
                          {pendingComments > 0 && <span role="status">Checking comment locations…</span>}
                          {activeComments.unanchored.length > 0 && <div className="git-diff-unanchored">
                            <span className="git-diff-comments-stale" role="status">Review comments without a matching line.</span>
                            <ul>{activeComments.unanchored.map((comment, index) => <li key={index}>{comment.text}</li>)}</ul>
                          </div>}
                          <button type="button" disabled={!canInsert || pendingComments > 0} onClick={addCommentsToPrompt}
                            title={canInsert ? `Put these comments in the prompt box of “${promptTarget?.title}”` : 'Open a session in this window first'}>
                            Add comments to prompt
                          </button>
                          <button type="button" onClick={clearComments} title="Remove every comment on this file">Clear</button>
                        </div>
                      )}
                      {!diffError && selectedEntry !== null && diff?.key !== diffKey && <p className="git-message" role="status">Loading diff…</p>}
                    </div>
                  )}
                </div>
              )}

              {tab === 'branches' && (
                <>
                  <GitBranchList key={repo.id} feedback={feedbackAt('branch')} branches={currentBranches?.items ?? null} error={currentBranches?.error ?? null}
                    locked={writesLocked || repo.headOid === null}
                    lockedReason={repo.headOid === null ? 'There are no commits yet. Make the first commit before creating or switching branches.' : null}
                    newName={newBranch} commitDraft={suggestionDraft}
                    onNewNameChange={value => setBranchDrafts(current => ({ ...current, [branchDraftKey]: value }))}
                    onCreate={() => changeBranch('create', newBranch.trim())} onSwitch={name => changeBranch('switch', name)} />
                  <GitWorktreeList feedback={feedbackAt('worktree')} worktrees={worktrees && worktrees.repoId === repo.id ? worktrees.items : null} error={worktreeError?.repoId === repoId ? worktreeError.message : null} sessions={worktreeSessions}
                    locked={writesLocked} onRemove={removeWorktree} />
                </>
              )}

              {tab === 'history' && <GitHistory key={JSON.stringify([profileId, repo.id, repo.headOid])}
                profileId={profileId} repoId={repo.id} headOid={repo.headOid} />}
            </>
          )}
        </div>
      )}
    </aside>
  )
}
