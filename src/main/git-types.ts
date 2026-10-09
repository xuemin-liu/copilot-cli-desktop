import type { GitStatusCode, GitEntryKind, GitLogEntry } from './git-parse.js'

/** Serializable shapes shared by the main process and the renderer. */

export type GitRepoKind = 'project' | 'nested' | 'parent'

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
  /** Relative to the project folder; `.` for the project itself. */
  relativePath: string
  kind: GitRepoKind
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
  | 'cancelled'
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
  /** For a successful commit. */
  commit: { hash: string; subject: string } | null
  /** The repository's status after the operation, so the panel updates in one step. */
  status: GitRepoStatusView | null
}

/** Output from a running write (for example a commit hook), forwarded as it arrives. */
export interface GitProgressEvent {
  repoId: string
  operation: 'stage' | 'unstage' | 'commit'
  stream: 'stdout' | 'stderr'
  text: string
}

export type { GitLogEntry }
