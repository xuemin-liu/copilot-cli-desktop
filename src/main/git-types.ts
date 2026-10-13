import type { GitStatusCode, GitEntryKind, GitLogEntry } from './git-parse.js'

/** Serializable shapes shared by the main process and the renderer. */

/** `worktree`: a linked worktree of one of the project's repositories, in which a Copilot session runs. */
export type GitRepoKind = 'project' | 'nested' | 'parent' | 'worktree'

/**
 * - `ready`: status is available.
 * - `needs-review`: the repository's own config names programs; nothing but a config read has touched it.
 * - `error`: git failed or the repository is unsafe to open; see `error`.
 */
export type GitRepoState = 'ready' | 'needs-review' | 'error'

export interface GitReviewItem {
  /** Config key, lowercased by git, for example `core.sshcommand`. */
  key: string
  value: string
}

export interface GitRepoSummary {
  /** Opaque, monotonic, never reused: `repo-<n>`. */
  id: string
  name: string
  /** Relative to the project folder; `.` for the project itself; the absolute folder for a worktree (which lives outside). */
  relativePath: string
  kind: GitRepoKind
  /** For a worktree: the id of the repository it belongs to, when that repository is listed. */
  worktreeOf: string | null
  state: GitRepoState
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
  /** Changed, staged, untracked and conflicted files (ignored files excluded). */
  changeCount: number
  /** Changes whenever the file list changes, so a view that shows the list knows to reload it. */
  generation: number
  /** Current commit id (null before the first commit); changes with every commit, so history views know to reload. */
  headOid: string | null
  error: string | null
  reviewItems: GitReviewItem[]
  /** Pass back to `trust` so the user trusts exactly the config they were shown. */
  configHash: string | null
}

export interface GitEntryView {
  /** `e<generation>-<index>`; valid only for the generation it was issued in. */
  id: string
  path: string
  originalPath: string | null
  kind: GitEntryKind
  index: GitStatusCode
  worktree: GitStatusCode
  isDirectory: boolean
  submodule: boolean
}

export interface GitRepoStatusView {
  repoId: string
  /** Changes whenever the entry list changes; mutations and diffs must quote it. */
  generation: number
  summary: GitRepoSummary
  staged: GitEntryView[]
  unstaged: GitEntryView[]
  untracked: GitEntryView[]
  conflicted: GitEntryView[]
  totalEntries: number
  truncated: boolean
}

export type GitDiffKind = 'text' | 'binary' | 'directory' | 'too-large' | 'empty'

export interface GitDiffView {
  entryId: string
  path: string
  kind: GitDiffKind
  text: string
  truncated: boolean
  added: number | null
  deleted: number | null
}

export interface GitAvailability {
  available: boolean
  version: string | null
  supported: boolean
  error: string | null
}

export interface GitProjectView {
  git: GitAvailability
  repos: GitRepoSummary[]
  /** Discovery stopped at a limit; offer Rescan. */
  truncated: boolean
  notes: string[]
}

/** Why a write did not happen. Expected failures come back as a result; programming errors and stale ids are thrown. */
export type GitOperationFailure =
  | 'busy'                 // another git process holds the repository's index lock
  | 'identity-missing'     // git has no user.name / user.email
  | 'hooks-need-approval'  // the repository has hooks a commit would run
  | 'hooks-unverifiable'   // a hook cannot be fully checked (a link, too large), so it can never be approved
  | 'conflicts'            // unresolved conflicts are present
  | 'nothing-staged'
  | 'hidden-staged'        // the index holds staged entries the panel does not list (a submodule update), so a commit would include unseen changes
  | 'cancelled'
  | 'auth-required'       // the remote wants credentials the panel does not collect
  | 'no-remote'           // the repository has no remote to contact, or the one it has is not safe to contact
  | 'detached'            // there is no current branch to pull or push
  | 'needs-upstream'      // the branch has no upstream yet; `remotes` lists where it could be published
  | 'diverged'            // a pull cannot fast-forward
  | 'rejected'            // the remote refused a push because it has changes the branch lacks
  | 'published'           // the last commit is already on a remote branch, so amending it would rewrite shared history
  | 'agent-working'       // a Copilot session is working in the project, and a branch switch would rewrite files under it
  | 'local-changes'       // uncommitted changes would be overwritten by the switch; git refused and changed nothing
  | 'hooks-unsupported'   // a hook that would run on push (pre-push) is present, and the panel does not run hooks for push
  | 'failed'               // git exited non-zero; `output` has what it said

export interface GitOperationResult {
  ok: boolean
  reason: GitOperationFailure | null
  /** One plain sentence for the person. */
  message: string
  /** What git (and any hook) printed, redacted and trimmed. Empty when there is nothing useful. */
  output: string
  /** For `hooks-need-approval`: the hooks a commit would run, and the hash to send back to approve exactly these. */
  hooks: string[]
  hooksHash: string | null
  /** For `needs-upstream`: the remotes the branch could be published to. */
  remotes: string[]
  /** For a successful commit. */
  commit: { hash: string; subject: string } | null
  /** The repository's status after the operation, so the panel updates in one step. */
  status: GitRepoStatusView | null
}

/** Output from a running write (for example a commit hook), forwarded as it arrives. */
/** One local branch, as the Branches tab shows it. */
export interface GitBranchView {
  name: string
  current: boolean
  oid: string
  upstream: string | null
  ahead: number | null
  behind: number | null
  upstreamGone: boolean
  subject: string
  committedAt: number | null
}

/** One entry of `git worktree list`, as the Branches tab shows it. Paths use the platform's separators. */
export interface GitWorktreeView {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  /** The lock reason, or `locked` when none was given; null when not locked. */
  locked: string | null
  /** Why git would prune it, or `prunable`; null when it is fine. */
  prunable: string | null
  /** The main worktree (the repository itself). */
  main: boolean
  /** The repository the list was read from. */
  current: boolean
}

/** What the person is asked before something that rewrites files; shown by the main process in a native window. */
/** What the Amend control needs to know about the last commit. */
export interface GitHeadCommitView {
  oid: string
  /** The full message (a longer one than the 100,000 characters an amend accepts is an error, not a shortened copy). */
  message: string
  /** A merge commit is not amended from the panel. */
  isMerge: boolean
  /** Remote-tracking branches that already contain it. Amending is refused when this is not empty. */
  publishedTo: string[]
}

export interface GitConfirmRequest {
  title: string
  detail: string
  confirmLabel: string
  /** Something that destroys work: the window says so and makes Cancel the default. */
  danger?: boolean
}

export interface GitProgressEvent {
  repoId: string
  operation: 'stage' | 'unstage' | 'commit' | 'fetch' | 'pull' | 'push' | 'switch' | 'discard'
  stream: 'stdout' | 'stderr'
  text: string
}

export type { GitLogEntry }
