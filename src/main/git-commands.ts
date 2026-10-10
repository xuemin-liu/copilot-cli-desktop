import { GIT_LOG_FORMAT } from './git-parse.js'
import { assertGitArgument } from './git-env.js'

/**
 * Subcommand argument lists. Each one carries the flags that keep a read from running a program
 * the repository names (`--no-ext-diff`, `--no-textconv`) or from recursing into submodules.
 * Paths always follow `--` and are literal, because the runner adds `--literal-pathspecs`.
 */

function boundedInteger(value: number, label: string, max: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${label} is out of range`)
  return String(value)
}

/** Stage the paths read from stdin (NUL-separated). Deletions and new files are included for those paths. */
export function stageArgs(): string[] {
  return ['add', '--pathspec-from-file=-', '--pathspec-file-nul']
}

/**
 * Unstage the paths read from stdin. Before the first commit there is no HEAD to restore from, so the entries are removed
 * from the index instead; the working-tree files stay either way. `-f` is needed there: a file staged and then edited again
 * differs from both the file and the absent HEAD, which plain `git rm --cached` refuses, and `--cached` keeps the file.
 */
export function unstageArgs(hasHead: boolean): string[] {
  return hasHead
    ? ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul']
    : ['rm', '--cached', '-f', '-r', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul']
}

/** Commit the index. The message comes from stdin, so it is never an argument and cannot be read as an option. */
export function commitArgs(amend = false, allowEmpty = false): string[] {
  // `--allow-empty` only for an amend of a commit that is already empty: Git's own refusal to make a commit empty stays otherwise.
  return amend ? ['commit', '--amend', ...(allowEmpty ? ['--allow-empty'] : []), '-F', '-'] : ['commit', '-F', '-']
}

/** The tree of HEAD, then the tree of its first parent: equal when the last commit changes nothing. */
export function headTreesArgs(): string[] {
  return ['rev-parse', 'HEAD^{tree}', 'HEAD~1^{tree}']
}

/** The last commit's full message, then the ids of its parents (one line, space separated) on the next record. */
export function headMessageArgs(): string[] {
  return ['show', '-s', '--format=%B', 'HEAD']
}

export function headParentsArgs(): string[] {
  return ['rev-list', '--parents', '-n', '1', 'HEAD']
}

/** Remote-tracking branches that already contain HEAD: if there are any, the commit has been published. */
export function publishedRefsArgs(): string[] {
  return ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes']
}

/**
 * The staged changes as raw records (modes, object ids, paths). Two reads that return the same text saw the same index, which is
 * how a commit checks that nothing was staged or restaged between the moment it looked and the moment it ran.
 */
export function stagedRawArgs(): string[] {
  return ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv']
}

export function gitPathArgs(name: string): string[] {
  assertGitArgument(name, 'path name')
  return ['rev-parse', '--git-path', name]
}

export function configGetArgs(key: string): string[] {
  assertGitArgument(key, 'config key')
  return ['config', '--get', key]
}

export function topLevelArgs(): string[] {
  return ['rev-parse', '--show-toplevel']
}

export function statusArgs(untracked: 'normal' | 'no' = 'normal'): string[] {
  return ['status', '--porcelain=v2', '-z', '--branch', `--untracked-files=${untracked}`, '--ignore-submodules=all']
}

export function diffArgs(options: { staged: boolean; path?: string; alsoPath?: string | null; numstat?: boolean }): string[] {
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--submodule=short']
  if (options.numstat) args.push('--numstat', '-z')
  if (options.staged) args.push('--cached')
  if (options.path !== undefined) {
    assertGitArgument(options.path, 'path')
    args.push('--', options.path)
    // A staged rename shows as a delete plus an add; include the old path so both halves appear.
    if (options.alsoPath) { assertGitArgument(options.alsoPath, 'path'); args.push(options.alsoPath) }
  }
  return args
}

export function logArgs(options: { limit: number; skip?: number }): string[] {
  return [
    'log', '-z', '--no-show-signature', '--no-ext-diff', '--no-textconv', '--no-color',
    `--max-count=${boundedInteger(options.limit, 'limit', 500)}`,
    `--skip=${boundedInteger(options.skip ?? 0, 'skip', 1_000_000)}`,
    `--format=${GIT_LOG_FORMAT}`,
  ]
}

// ---- network ------------------------------------------------------------------------------------------------------------

/** The configured remote names, one per line. */
export function remoteListArgs(): string[] {
  return ['remote']
}

/** Every address a remote uses, after `url.<base>.insteadOf` rewriting: the push addresses when `forPush`, otherwise the fetch ones. */
export function remoteUrlArgs(remote: string, forPush: boolean): string[] {
  assertGitArgument(remote, 'remote name')
  return ['remote', 'get-url', ...(forPush ? ['--push'] : []), '--all', '--', remote]
}

/** The fetch refspecs the repository configures for a remote, one per line. They decide where a fetch writes. */
export function fetchRefspecsArgs(remote: string): string[] {
  assertGitArgument(remote, 'remote name')
  return ['config', '--get-all', `remote.${remote}.fetch`]
}

/**
 * Update the remote-tracking branches from one remote. Submodules are never fetched (that would run git in other repositories),
 * nothing is pruned (whatever `fetch.prune` or `remote.<name>.prune` say) and no tag is written. Where the fetch writes is
 * decided by the remote's configured refspecs, which the caller has checked stay inside `refs/remotes/<remote>/`.
 */
export function fetchArgs(remote: string): string[] {
  assertGitArgument(remote, 'remote name')
  return ['fetch', '--no-recurse-submodules', '--no-prune', '--no-prune-tags', '--no-tags', '--', remote]
}

/** The remote-tracking branch a local branch follows, as a full ref name. */
export function upstreamRefArgs(branch: string): string[] {
  assertGitArgument(branch, 'branch name')
  return ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]
}

/** The ref `HEAD` points at (fails when it is detached). */
export function headRefArgs(): string[] {
  return ['symbolic-ref', '--quiet', 'HEAD']
}

/**
 * Move the current branch to the given remote-tracking branch only when that is a fast-forward; anything else is refused and
 * changes nothing. The ref is named in full, never `@{upstream}`, so it is the upstream of the branch that was confirmed rather
 * than of whichever branch is current when the command runs.
 */
export function fastForwardArgs(upstreamRef: string): string[] {
  assertGitArgument(upstreamRef, 'upstream')
  if (!upstreamRef.startsWith('refs/remotes/')) throw new Error('A pull can only follow a remote-tracking branch')
  return ['merge', '--ff-only', '--no-edit', '--no-autostash', '--no-verify', upstreamRef]
}

/**
 * Push one commit to one named branch with an explicit refspec, which also overrides any `remote.<name>.push` the repository
 * configures. The source is the commit id the person confirmed, not the branch name, so a commit added to the branch after
 * the confirmation is not sent. There is no `+` in it and no `--force`, so a push the remote would have to overwrite is refused.
 */
export function pushArgs(remote: string, commit: string, remoteBranch: string): string[] {
  assertGitArgument(remote, 'remote name')
  assertGitArgument(remoteBranch, 'branch name')
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error('A push needs the full id of the commit to send')
  return ['push', '--no-recurse-submodules', '--no-follow-tags', '--signed=no', '--', remote, `${commit}:refs/heads/${remoteBranch}`]
}

/** The two settings `git push --set-upstream` would write: where a branch pulls from. Written by name after a successful publish. */
export function upstreamConfigArgs(branch: string, remote: string, remoteBranch: string): string[][] {
  assertGitArgument(branch, 'branch name')
  assertGitArgument(remote, 'remote name')
  assertGitArgument(remoteBranch, 'branch name')
  return [['config', `branch.${branch}.remote`, remote], ['config', `branch.${branch}.merge`, `refs/heads/${remoteBranch}`]]
}

// ---- branches -----------------------------------------------------------------------------------------------------------

/**
 * The local branches, newest commit first, one per line with fields separated by code 31 (see `parseBranches`). The name is the
 * full ref: `%(refname:short)` turns a branch that shares its name with a tag into `heads/<name>`, which no command accepts.
 */
export function branchListArgs(): string[] {
  return [
    'for-each-ref', '--count=500', '--sort=-committerdate',
    '--format=%(HEAD)%1f%(refname)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(subject)',
    'refs/heads',
  ]
}

/** Git's own verdict on a branch name, as the full ref (so `@{-1}` and other shorthand are never expanded). */
export function refFormatArgs(name: string): string[] {
  assertGitArgument(name, 'branch name')
  return ['check-ref-format', `refs/heads/${name}`]
}

/** Never `--force`, `--merge` or `--discard-changes`: git refuses, and changes nothing, when local changes would be overwritten. */
export function switchArgs(branch: string): string[] {
  assertGitArgument(branch, 'branch name')
  if (branch.startsWith('-')) throw new Error('A branch name cannot start with "-"')
  return ['switch', '--no-guess', '--no-recurse-submodules', branch]
}

/** A new branch at the current commit, without tracking anything, then switch to it. */
export function createBranchArgs(name: string): string[] {
  assertGitArgument(name, 'branch name')
  if (name.startsWith('-')) throw new Error('A branch name cannot start with "-"')
  return ['switch', '--no-guess', '--no-recurse-submodules', '--no-track', '--create', name]
}

/** Put tracked files' working-tree content back to the staged (or committed) version. Never touches the index and never recurses. */
export function restoreArgs(): string[] {
  return ['restore', '--worktree', '--no-recurse-submodules', '--pathspec-from-file=-', '--pathspec-file-nul']
}
