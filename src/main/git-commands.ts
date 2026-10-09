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
 * from the index instead; the working-tree files stay either way.
 */
export function unstageArgs(hasHead: boolean): string[] {
  return hasHead
    ? ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul']
    : ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul']
}

/** Commit the index. The message comes from stdin, so it is never an argument and cannot be read as an option. */
export function commitArgs(): string[] {
  return ['commit', '-F', '-']
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
