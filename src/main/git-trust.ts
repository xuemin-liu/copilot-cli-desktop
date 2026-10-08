import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { win32 } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import type { GitRunner } from './git-runner.js'
import { splitNul } from './git-parse.js'
import type { GitReviewItem } from './git-types.js'

/**
 * The repo trust gate. Read-only git commands cannot be made fully safe against a hostile repository:
 * clean filters run on `status`, and writes run hooks, credential helpers and `core.sshCommand`. So a repository
 * whose own config names a program is held at "needs review" until the user accepts that exact config.
 */

/** POSIX ERE over lower-cased config keys. Only settings that can start a program or redirect git. */
export const REVIEW_KEY_PATTERN = '^(core\\.(fsmonitor|sshcommand|hookspath|worktree|askpass|gitproxy)|filter\\..+|diff\\.external|diff\\..+\\.(command|textconv)|merge\\..+\\.driver|credential\\..+|gpg\\..+|include\\..+|includeif\\..+|url\\..+|remote\\..+\\.(vcs|proxy|receivepack|uploadpack|uploadarchive)|protocol\\..+)$'

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
}

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
  const lines = items.map(item => `${item.key}=${item.value}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** Read only the repository's own config (local and worktree scope), never global or system. */
export async function scanRepoConfig(runner: GitRunner, repoRoot: string, signal?: AbortSignal): Promise<RepoConfigScan> {
  const found: GitReviewItem[] = []
  for (const scope of ['--local', '--worktree']) {
    const result = await runner.run({
      cwd: repoRoot, signal,
      args: ['config', scope, '--show-origin', '-z', '--get-regexp', REVIEW_KEY_PATTERN],
    })
    // Exit 1 means no match. A failure in `--worktree` is expected when worktree config is not in use.
    if (result.exitCode === 0) found.push(...parseConfigScan(result.stdout.toString('utf8')))
    else if (scope === '--local' && result.exitCode !== 1) throw new Error(result.cancelled ? 'cancelled' : result.stderr.trim().split(/\r?\n/, 1)[0] || 'Could not read the repository config')
  }
  const seen = new Set<string>()
  const items = found.filter(item => {
    const id = `${item.key}\0${item.value}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }).filter(item => !isBenignConfigItem(item.key, item.value))
  return { items, hash: configItemsHash(items) }
}

/** Canonical map key for a repository root. */
export function repoTrustKey(root: string): string {
  return win32.resolve(root).toLowerCase()
}

interface TrustFile {
  version: 1
  repos: Record<string, string>
}

const MAX_TRUSTED_REPOS = 500

/** Persists "the user accepted this repository's config" by canonical path and config hash. */
export class GitTrustStore {
  private repos = new Map<string, string>()
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  private load(): Promise<void> {
    this.loaded ??= readFile(this.file, 'utf8').then(text => {
      const parsed = JSON.parse(text) as Partial<TrustFile>
      if (parsed.version !== 1 || !parsed.repos || typeof parsed.repos !== 'object') return
      for (const [key, hash] of Object.entries(parsed.repos)) {
        if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) this.repos.set(key, hash)
      }
    }).catch(() => undefined)
    return this.loaded
  }

  async isTrusted(root: string, hash: string): Promise<boolean> {
    await this.load()
    return this.repos.get(repoTrustKey(root)) === hash
  }

  async trust(root: string, hash: string): Promise<void> {
    await this.load()
    const key = repoTrustKey(root)
    this.repos.delete(key)
    this.repos.set(key, hash)
    while (this.repos.size > MAX_TRUSTED_REPOS) this.repos.delete(this.repos.keys().next().value as string)
    const body: TrustFile = { version: 1, repos: Object.fromEntries(this.repos) }
    this.writes = this.writes.then(() => writeFileAtomic(this.file, JSON.stringify(body, null, 2)))
    await this.writes
  }
}
