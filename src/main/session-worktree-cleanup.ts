import { hostPath, TRASH_NAME } from './host-path.js'
import { realPathNative } from './real-path.js'
import { gitSucceeded } from './git-runner.js'
import type { GitRunOptions, GitRunResult } from './git-runner.js'
import { parseWorktrees } from './git-parse.js'
import { sameFolder } from './git-discovery.js'

type RunGit = (options: GitRunOptions) => Promise<GitRunResult>

/** What happens to the worktree the desktop made for a session when that session's tab is closed. */
export const WORKTREE_CLEANUP_MODES = ['safe', 'ask', 'keep'] as const
export type WorktreeCleanupMode = (typeof WORKTREE_CLEANUP_MODES)[number]
export const DEFAULT_WORKTREE_CLEANUP: WorktreeCleanupMode = 'safe'

export function isWorktreeCleanupMode(value: unknown): value is WorktreeCleanupMode {
  return WORKTREE_CLEANUP_MODES.includes(value as WorktreeCleanupMode)
}

/** The worktree and branch name the desktop gives a new session's worktree (`worktreeNameFor`). */
export const DESKTOP_WORKTREE_NAME = /^desktop-[a-z0-9-]+-[0-9a-f]{6}$/

/** Whether a folder is where the desktop creates a session worktree: `<main checkout>.worktrees\desktop-<title>-<6 hex>`. */
export function isDesktopWorktreeFolder(path: string): boolean {
  const trimmed = hostPath.resolve(path)
  return DESKTOP_WORKTREE_NAME.test(hostPath.basename(trimmed)) && hostPath.basename(hostPath.dirname(trimmed)).toLowerCase().endsWith('.worktrees')
}

export interface DesktopWorktreeState {
  /** The worktree folder, as git lists it. */
  path: string
  /** Its folder name, which is also the name of the branch the desktop created with it. */
  name: string
  /** The main checkout; git runs there, never inside the folder being removed. */
  mainPath: string
  /** The checked-out branch, or null when HEAD is detached. */
  branch: string | null
  head: string
  locked: boolean
  /** Changed, staged and untracked files. Files Git ignores do not count. */
  changes: number
  /** Commits on HEAD that no other local or remote-tracking branch has. */
  uniqueCommits: number
}

/**
 * Read the state of a worktree the desktop created for a session. Null when the folder is not one (by its name and place,
 * and by git listing it as a linked worktree of its repository), or git cannot tell.
 */
export async function inspectDesktopWorktree(path: string, runGit: RunGit, signal?: AbortSignal): Promise<DesktopWorktreeState | null> {
  if (!isDesktopWorktreeFolder(path)) return null
  const run = async (request: GitRunOptions): Promise<GitRunResult | null> => {
    const result = await runGit({ ...request, signal })
    return gitSucceeded(result) ? result : null
  }
  const listed = await run({ cwd: path, args: ['worktree', 'list', '--porcelain'] })
  if (!listed) return null
  const entries = parseWorktrees(listed.stdout.toString('utf8'))
  const main = entries[0]
  // Git lists real paths; the folder may be spelled another way (a Windows short name, macOS's /var for /private/var).
  const real = await realPathNative(path).catch(() => path)
  const index = entries.findIndex(entry => sameFolder(entry.path, path) || sameFolder(entry.path, real))
  const entry = entries[index]
  // The main checkout is never a session worktree; a prunable entry has already lost its folder.
  if (!main || index < 1 || !entry || entry.bare || entry.prunable !== null || !entry.head) return null
  const status = await run({ cwd: entry.path, args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'] })
  if (!status) return null
  const changes = status.stdout.toString('utf8').split('\0').filter(record => record !== '').length
  // Commits only this worktree's branch (or detached HEAD) has. Its own branch is left out of the comparison, and so is
  // every ref that is not a branch: a commit reachable from a tag alone still counts as unique.
  const exclude = entry.branch === null ? [] : [`--exclude=${entry.branch}`]
  const unique = await run({ cwd: main.path, args: ['rev-list', '--count', entry.head, '--not', ...exclude, '--branches', '--remotes'] })
  if (!unique) return null
  const uniqueCommits = Number.parseInt(unique.stdout.toString('utf8').trim(), 10)
  if (!Number.isInteger(uniqueCommits) || uniqueCommits < 0) return null
  return {
    path: entry.path, name: hostPath.basename(hostPath.resolve(entry.path)), mainPath: main.path, branch: entry.branch, head: entry.head,
    locked: entry.locked !== null, changes, uniqueCommits,
  }
}

/** The branch the desktop created with the worktree, while the worktree still has it checked out. Other branches are kept. */
function ownBranch(state: DesktopWorktreeState): string | null {
  return state.branch === state.name && DESKTOP_WORKTREE_NAME.test(state.branch) ? state.branch : null
}

/** Removing the worktree loses nothing: it has no changes, and any commit only it has stays on a branch that is kept. */
export function removalIsSafe(state: DesktopWorktreeState): boolean {
  return !state.locked && state.changes === 0 && (state.branch !== null || state.uniqueCommits === 0)
}

/** Whether removal also deletes the worktree's branch: only the desktop's own branch, and only when no commit is only there. */
export function removalDeletesBranch(state: DesktopWorktreeState): boolean {
  return ownBranch(state) !== null && state.uniqueCommits === 0
}

export type WorktreeCleanupDecision = 'remove' | 'ask' | 'keep'

export function worktreeCleanupDecision(mode: WorktreeCleanupMode, state: DesktopWorktreeState): WorktreeCleanupDecision {
  if (mode === 'keep' || state.locked) return 'keep'
  if (mode === 'ask') return 'ask'
  return removalIsSafe(state) ? 'remove' : 'ask'
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** The confirmation shown before a worktree is removed: what goes, and what is kept. */
export function worktreeCleanupPrompt(state: DesktopWorktreeState): { title: string; detail: string } {
  const lines = [`${state.path} will be deleted, including files Git ignores there (build output, node_modules, local .env files).`]
  if (state.changes > 0) lines.push(`It has ${plural(state.changes, 'uncommitted change')}. The folder goes to the ${TRASH_NAME}, so they can be restored from there.`)
  const branch = ownBranch(state)
  if (state.branch === null) {
    if (state.uniqueCommits > 0) lines.push(`Its detached HEAD has ${plural(state.uniqueCommits, 'commit')} that no branch has. They will be hard to find once the worktree is gone.`)
  } else if (branch && state.uniqueCommits === 0) {
    lines.push(`Its branch "${branch}" has no commits that another branch does not have, so it is deleted too.`)
  } else {
    lines.push(`Its branch "${state.branch}" is kept${state.uniqueCommits > 0 ? `, with ${plural(state.uniqueCommits, 'commit')} no other branch has` : ''}.`)
  }
  return { title: `Remove worktree "${state.name}"?`, detail: lines.join('\n\n') }
}

export interface RemoveWorktreeOptions {
  /** Moves a folder to the Recycle Bin. Used when the worktree has changes, so nothing is deleted outright. */
  trash: (path: string) => Promise<void>
  signal?: AbortSignal
}

export interface RemoveWorktreeResult {
  branchDeleted: boolean
}

/**
 * Remove a session worktree that `inspectDesktopWorktree` described. A clean one is removed by git, which refuses if it has
 * changed since; one with changes goes to the Recycle Bin and git forgets it. Its branch is deleted only when
 * `removalDeletesBranch` says so, and only if it still points at the commit that was checked.
 */
export async function removeDesktopWorktree(state: DesktopWorktreeState, runGit: RunGit, options: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
  // Trashing a folder bypasses git's own refusal to remove a locked worktree, so a lock is refused here for both paths.
  if (state.locked) throw new Error(`Worktree ${state.name} is locked`)
  const run = async (args: string[]): Promise<GitRunResult> => {
    const result = await runGit({ cwd: state.mainPath, args, kind: 'write', disableHooks: true, signal: options.signal, timeoutMs: 120_000 })
    if (!gitSucceeded(result)) {
      const reason = result.cancelled ? 'cancelled' : result.timedOut ? 'timed out' : result.stderr.trim().slice(-2000) || 'Git failed'
      throw new Error(`Could not remove worktree ${state.name}: ${reason}`)
    }
    return result
  }
  if (state.changes === 0) {
    await run(['worktree', 'remove', '--', state.path])
  } else {
    await options.trash(state.path)
    await run(['worktree', 'prune'])
  }
  const branch = ownBranch(state)
  if (!branch || !removalDeletesBranch(state)) return { branchDeleted: false }
  // Compare-and-delete: a branch moved since it was checked is left alone.
  const deleted = await runGit({ cwd: state.mainPath, args: ['update-ref', '-d', `refs/heads/${branch}`, state.head],
    kind: 'write', disableHooks: true, signal: options.signal })
  if (!gitSucceeded(deleted)) return { branchDeleted: false }
  // The branch's upstream and other settings went with it in `git branch -d`; do the same here, and ignore their absence.
  await runGit({ cwd: state.mainPath, args: ['config', '--remove-section', `branch.${branch}`], kind: 'write', disableHooks: true, signal: options.signal })
  return { branchDeleted: true }
}
