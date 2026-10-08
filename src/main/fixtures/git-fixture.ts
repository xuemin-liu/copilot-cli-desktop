import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitRunner, resolveGitExecutable } from '../git-runner.js'
import type { GitExecutable } from '../git-runner.js'

/** Isolated git environment and throwaway repositories for tests. Never reads the developer's own git config. */
export interface GitFixture {
  git: GitExecutable
  root: string
  /** Base environment for a `GitRunner`; points git at a private global config. */
  env: NodeJS.ProcessEnv
  runner: GitRunner
  /** Run git directly, unhardened, to build fixtures. Returns stdout. */
  plain(cwd: string, ...args: string[]): string
  /** Create a repository with one committed `a.txt`. */
  repo(name: string, configure?: (directory: string) => void): string
  cleanup(): void
}

let cachedGit: Promise<GitExecutable | null> | undefined

export function findGitForTests(): Promise<GitExecutable | null> {
  cachedGit ??= resolveGitExecutable()
  return cachedGit
}

export async function createGitFixture(): Promise<GitFixture | null> {
  const git = await findGitForTests()
  if (!git) return null
  const root = mkdtempSync(join(tmpdir(), 'git-fixture-'))
  const globalConfig = join(root, 'gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[protocol "file"]\n\tallow = always\n')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  const plain = (cwd: string, ...args: string[]): string =>
    execFileSync(git.path, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const runner = new GitRunner({ gitPath: git.path, hooksDirectory: join(root, 'no-hooks'), baseEnvironment: env, trackProcess: null })
  return {
    git, root, env, runner, plain,
    repo(name, configure) {
      const directory = join(root, name)
      mkdirSync(directory, { recursive: true })
      plain(directory, 'init', '-q')
      writeFileSync(join(directory, 'a.txt'), 'one\n')
      plain(directory, 'add', '.')
      plain(directory, 'commit', '-q', '-m', 'init')
      configure?.(directory)
      return directory
    },
    // Windows keeps a folder busy for a moment after its last process dies.
    cleanup() { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) },
  }
}

/** Forward slashes, for embedding a path in a shell command that git runs through sh. */
export function shellPath(path: string): string {
  return path.replace(/\\/g, '/')
}
