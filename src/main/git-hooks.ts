import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { win32 } from 'node:path'
import { gitPathArgs } from './git-commands.js'
import { isLocalFilesystemPath } from './external-targets.js'
import { gitSucceeded } from './git-runner.js'
import type { GitRunner } from './git-runner.js'

/**
 * Hooks are programs in the repository's `.git/hooks` folder that git runs around a commit. A repository can arrive with
 * them (an unpacked archive, a copied folder), and the trust check on the repository's config does not see them, so a
 * commit must not run them until the user has seen their names and approved their exact contents.
 */

/** Hooks a commit can run: the commit sequence itself, the index and reference updates it makes, and nothing else. */
export const COMMIT_HOOKS: ReadonlySet<string> = new Set([
  'pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction',
])

/** Hooks a push can run. The panel does not run these (see `inspectHooks`): a repository that has one is pushed from a terminal. */
export const PUSH_HOOKS: ReadonlySet<string> = new Set(['pre-push'])

/** The largest hook that is hashed. Real hooks are a few kilobytes; anything bigger cannot be approved, only run by hand. */
export const MAX_HOOK_BYTES = 64 * 1024 * 1024

export interface HooksInventory {
  /** Folder git will look in. */
  directory: string
  /** Names of the hooks present, sorted. Empty when a commit would run no repository program. */
  hooks: string[]
  /**
   * Hooks whose contents cannot be fully verified: a link (its target can change without the link changing), a file that is
   * not a regular file, or one too large to hash. Approval is of exact contents, so these can never be approved.
   */
  unverifiable: Array<{ name: string; reason: string }>
  /** Changes if a hook is added, removed or edited in any byte, or the folder moves. */
  hash: string
}

/** The hook a file name stands for, or null. `pre-commit`, `pre-commit.exe` and `pre-commit.cmd` count; `pre-commit.sample` does not. */
export function hookNameOf(fileName: string, names: ReadonlySet<string> = COMMIT_HOOKS): string | null {
  const parts = fileName.toLowerCase().split('.')
  const base = parts[0] ?? ''
  if (!names.has(base)) return null
  return parts.length > 1 && parts.at(-1) === 'sample' ? null : base
}

type Digest = { digest: string } | { unverifiable: string }

/** SHA-256 of the whole file, read as a stream so size is no reason to look at less than all of it. */
async function digest(path: string, maxBytes: number): Promise<Digest> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return { unverifiable: 'it is a link, and a link\'s target can change without the link changing' }
  if (!info.isFile()) return { unverifiable: 'it is not a regular file' }
  if (info.size > maxBytes) return { unverifiable: `it is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, too large to check` }
  const hash = createHash('sha256')
  let read = 0
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => { read += chunk.length; hash.update(chunk) })
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  // A file that grew past the limit while it was being read was not fully checked either.
  if (read > maxBytes) return { unverifiable: 'it changed while it was being read' }
  return { digest: hash.digest('hex') }
}

export function inspectCommitHooks(runner: GitRunner, repoRoot: string, signal?: AbortSignal, maxBytes = MAX_HOOK_BYTES): Promise<HooksInventory> {
  return inspectHooks(runner, repoRoot, COMMIT_HOOKS, signal, maxBytes)
}

/** The repository's hooks among `names`, with a digest of each one's complete contents. */
export async function inspectHooks(runner: GitRunner, repoRoot: string, hookNames: ReadonlySet<string>, signal?: AbortSignal, maxBytes = MAX_HOOK_BYTES): Promise<HooksInventory> {
  // Not a read: reads point `core.hooksPath` at an empty folder, which would make git report that folder instead of the
  // repository's real one. `rev-parse` runs no hook, so asking without the override is safe.
  const located = await runner.run({ cwd: repoRoot, args: gitPathArgs('hooks'), kind: 'write', timeoutMs: 15_000, signal })
  if (!gitSucceeded(located)) throw new Error('Could not find the repository\'s hooks folder')
  const printed = located.stdout.toString('utf8').split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (!printed) throw new Error('Could not find the repository\'s hooks folder')
  const directory = win32.resolve(repoRoot, printed)
  if (!isLocalFilesystemPath(directory)) throw new Error('The repository\'s hooks folder is not on local storage')
  let names: string[] = []
  try { names = await readdir(directory) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  const found: Array<[string, string]> = []
  const unverifiable: Array<{ name: string; reason: string }> = []
  for (const name of names.sort()) {
    if (!hookNameOf(name, hookNames)) continue
    const result = await digest(win32.join(directory, name), maxBytes)
    if ('unverifiable' in result) {
      unverifiable.push({ name, reason: result.unverifiable })
      found.push([name, `unverifiable: ${result.unverifiable}`])
    } else {
      found.push([name, result.digest])
    }
  }
  const hash = createHash('sha256').update(JSON.stringify([directory.toLowerCase(), found])).digest('hex')
  return { directory, hooks: [...new Set(found.map(([name]) => name))], unverifiable, hash }
}
