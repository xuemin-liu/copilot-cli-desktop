import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathKey } from './host-path.js'
import { writeFileAtomic } from './atomic-file.js'
import type { GitRunOptions, GitRunResult, GitRunner } from './git-runner.js'
import { repoConfigFiles } from './git-discovery.js'
import { splitNul } from './git-parse.js'
import type { GitReviewItem } from './git-types.js'

/**
 * The repo trust gate. Read-only git commands cannot be made fully safe against a hostile repository:
 * clean filters run on `status`, and writes run hooks, credential helpers and `core.sshCommand`. So a repository
 * whose own config names a program is held at "needs review" until the user accepts that exact config.
 */

/**
 * POSIX ERE over lower-cased config keys. Only settings that can start a program or redirect git: `http.*` is here
 * because a repository's own proxy, certificate or header settings decide where the user's credentials are sent.
 */
export const REVIEW_KEY_PATTERN = '^(core\\.(fsmonitor|sshcommand|hookspath|worktree|askpass|gitproxy|excludesfile|attributesfile|alternaterefscommand)|filter\\..+|diff\\.external|diff\\..+\\.(command|textconv)|merge\\..+\\.driver|credential\\..+|gpg\\..+|include\\..+|includeif\\..+|url\\..+|remote\\..+\\.(vcs|proxy|receivepack|uploadpack|uploadarchive)|protocol\\..+|http\\..+)$'

/** The three values Git LFS writes for `git lfs install`; a repository cannot make them run anything else. */
const LFS_STANDARD: Readonly<Record<string, string>> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process',
  'filter.lfs.required': 'true',
}

export function isBenignConfigItem(key: string, value: string): boolean {
  if (key === 'core.fsmonitor') return /^(true|false|yes|no|on|off|0|1)$/i.test(value.trim())
  return LFS_STANDARD[key] === value.trim()
}

export interface RepoConfigScan {
  /** Settings that need the user's review; empty means nothing in this repository's own config runs a program. */
  items: GitReviewItem[]
  /** Stable over order; changes when any reviewed setting changes. */
  hash: string
  /**
   * What was done about `include` and `includeIf`: `none` when the config has neither; `held` when it has them and
   * the user has not accepted these exact lines, so the files they name were not read; `followed` when the settings
   * those files bring in are part of `items`.
   */
  includes: 'none' | 'held' | 'followed'
  /** The hash of the config's own settings, includes not followed: what accepting the include lines is recorded under. */
  ownHash: string
}

/** Tells the scan whether the user accepted a repository's include lines; without it, includes are never followed. */
export interface IncludeApprovals {
  areIncludesApproved(root: string, ownHash: string): Promise<boolean>
}

const isInclude = (item: GitReviewItem): boolean => item.key.startsWith('include.') || item.key.startsWith('includeif.')

/** Parse `git config --show-origin -z --get-regexp`: records of `origin NUL key NL value NUL`. */
export function parseConfigScan(output: string): GitReviewItem[] {
  const records = splitNul(output)
  const items: GitReviewItem[] = []
  for (let index = 0; index + 1 < records.length; index += 2) {
    const pair = records[index + 1] ?? ''
    const newline = pair.indexOf('\n')
    const key = (newline < 0 ? pair : pair.slice(0, newline)).toLowerCase()
    const value = newline < 0 ? '' : pair.slice(newline + 1)
    if (key) items.push({ key, value })
  }
  return items
}

export function configItemsHash(items: readonly GitReviewItem[]): string {
  // JSON keeps every key and value distinct. A value may itself contain newlines or text that looks like `key=value`,
  // so joining plain lines would let two different configurations hash the same.
  const tuples = items.map(item => [item.key, item.value] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
  return createHash('sha256').update(JSON.stringify(tuples)).digest('hex')
}

/** The first line of what Git said, for an error a person will read. */
function scanFailure(result: GitRunResult, what: string): Error {
  if (result.cancelled) return new Error('cancelled')
  if (result.timedOut) return new Error(`Reading ${what} took too long`)
  if (result.stdoutTruncated) return new Error(`${what} is too large to review`)
  return new Error(result.stderr.trim().split(/\r?\n/, 1)[0] || `Could not read ${what}`)
}

/**
 * The output of one `git config` query, or null when it matched nothing (exit 1). Anything else is an error: a scan
 * that was cut short, timed out or failed has not shown that the config is harmless, so it must not count as "nothing
 * to review".
 */
async function query(runner: GitRunner, options: GitRunOptions, what: string): Promise<string | null> {
  const result = await runner.run(options)
  if (result.cancelled || result.timedOut || result.stdoutTruncated) throw scanFailure(result, what)
  if (result.exitCode === 0) return result.stdout.toString('utf8')
  if (result.exitCode === 1) return null
  throw scanFailure(result, what)
}

function reviewable(found: GitReviewItem[]): GitReviewItem[] {
  const seen = new Set<string>()
  return found.filter(item => {
    const id = `${item.key}\0${item.value}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }).filter(item => !isBenignConfigItem(item.key, item.value))
}

/**
 * What in a repository's config needs the user's review. Only the repository's own config (local and worktree scope) is
 * read, never global or system.
 *
 * `git config --local` does not print what the files named by `include.path` hold, but every other git command uses
 * them. So the settings those files bring in are part of what is reviewed and hashed: a change to an included file is
 * a new question.
 *
 * An include can also name a file on another computer, and opening it is itself a network request. Any git command
 * started inside the repository opens the included files while it starts up, whatever its options say. So the first
 * pass does not run Git in the repository at all: it reads the two config files by path (`--file`, `--no-includes`),
 * from a folder that is not a repository. Only when that pass shows no include lines, or the user has accepted those
 * exact lines, is Git run in the repository. Until then the scan is `held`, and its hash matches nothing that was
 * trusted before.
 */
export async function scanRepoConfig(runner: GitRunner, repoRoot: string, signal?: AbortSignal, approvals?: IncludeApprovals): Promise<RepoConfigScan> {
  const files = await repoConfigFiles(repoRoot)
  if (!files) throw new Error('Could not find the repository config')
  const outside = tmpdir()
  const fromFile = (file: string, args: readonly string[], what: string): Promise<string | null> => query(runner, {
    cwd: outside, signal, args: ['config', '--file', file, '--no-includes', ...args],
    // Keeps Git from finding a repository above the folder it runs in.
    environment: { extra: { GIT_CEILING_DIRECTORIES: outside } },
  }, what)
  const review = ['--show-origin', '-z', '--get-regexp', REVIEW_KEY_PATTERN]

  const found = parseConfigScan(await fromFile(files.local, review, 'the repository config') ?? '')
  // Git reads `config.worktree` only with this extension on; it is set in the shared config.
  const worktreeConfig = (await fromFile(files.local, ['--type=bool', '--get', 'extensions.worktreeConfig'], 'the repository config'))?.trim() === 'true'
    && await stat(files.worktree).then(info => info.isFile(), () => false)
  if (worktreeConfig) found.push(...parseConfigScan(await fromFile(files.worktree, review, 'the worktree config') ?? ''))
  const own = reviewable(found)
  const ownHash = configItemsHash(own)
  if (!own.some(isInclude)) return { items: own, hash: ownHash, includes: 'none', ownHash }
  if (!approvals || !(await approvals.areIncludesApproved(repoRoot, ownHash))) {
    return { items: own, hash: createHash('sha256').update(`includes-held\0${ownHash}`).digest('hex'), includes: 'held', ownHash }
  }
  // The include lines are accepted, so Git may open what they name. Run in the repository, so that conditions such as
  // `includeIf "gitdir:..."` are decided as they are for every other command there.
  const followed: GitReviewItem[] = []
  for (const scope of worktreeConfig ? ['--local', '--worktree'] : ['--local']) {
    followed.push(...parseConfigScan(await query(runner, { cwd: repoRoot, signal, args: ['config', scope, '--includes', ...review] }, 'the repository config and the files it includes') ?? ''))
  }
  const items = reviewable(followed)
  return { items, hash: configItemsHash(items), includes: 'followed', ownHash }
}

/** Canonical map key for a repository root. */
export function repoTrustKey(root: string): string {
  return pathKey(root)
}

interface TrustFile {
  version: 1
  repos: Record<string, string>
  /** Repository hooks the user has approved, by canonical path and the hash of their names and contents. */
  hooks?: Record<string, string>
  /** Include lines the user has accepted, by canonical path and the hash of the config's own settings. */
  includes?: Record<string, string>
}

const MAX_TRUSTED_REPOS = 500
const HASH = /^[0-9a-f]{64}$/

/**
 * Persists what the user has accepted, by canonical repository path and hash: the repository's own config (so Git may
 * read it) and the hooks a commit would run (so Git may commit in it). A changed config or hook is a new question.
 */
export class GitTrustStore {
  private repos = new Map<string, string>()
  private hooks = new Map<string, string>()
  private includes = new Map<string, string>()
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  private load(): Promise<void> {
    this.loaded ??= readFile(this.file, 'utf8').then(text => {
      const parsed = JSON.parse(text) as Partial<TrustFile>
      if (parsed.version !== 1) return
      for (const [target, source] of [[this.repos, parsed.repos], [this.hooks, parsed.hooks], [this.includes, parsed.includes]] as const) {
        if (!source || typeof source !== 'object') continue
        for (const [key, hash] of Object.entries(source)) if (typeof hash === 'string' && HASH.test(hash)) target.set(key, hash)
      }
    }).catch(() => undefined)
    return this.loaded
  }

  private save(): Promise<void> {
    const body: TrustFile = { version: 1, repos: Object.fromEntries(this.repos), hooks: Object.fromEntries(this.hooks), includes: Object.fromEntries(this.includes) }
    this.writes = this.writes.then(() => writeFileAtomic(this.file, JSON.stringify(body, null, 2)))
    return this.writes
  }

  private remember(map: Map<string, string>, root: string, hash: string): void {
    const key = repoTrustKey(root)
    map.delete(key)
    map.set(key, hash)
    while (map.size > MAX_TRUSTED_REPOS) map.delete(map.keys().next().value as string)
  }

  async isTrusted(root: string, hash: string): Promise<boolean> {
    await this.load()
    return this.repos.get(repoTrustKey(root)) === hash
  }

  async trust(root: string, hash: string): Promise<void> {
    await this.load()
    this.remember(this.repos, root, hash)
    await this.save()
  }

  async areIncludesApproved(root: string, ownHash: string): Promise<boolean> {
    await this.load()
    return this.includes.get(repoTrustKey(root)) === ownHash
  }

  async approveIncludes(root: string, ownHash: string): Promise<void> {
    await this.load()
    this.remember(this.includes, root, ownHash)
    await this.save()
  }

  async areHooksApproved(root: string, hash: string): Promise<boolean> {
    await this.load()
    return this.hooks.get(repoTrustKey(root)) === hash
  }

  async approveHooks(root: string, hash: string): Promise<void> {
    await this.load()
    this.remember(this.hooks, root, hash)
    await this.save()
  }
}
