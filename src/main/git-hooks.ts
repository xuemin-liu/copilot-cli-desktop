import { createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
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

const MAX_HOOK_BYTES = 512 * 1024

export interface HooksInventory {
  /** Folder git will look in. */
  directory: string
  /** Names of the hooks present, sorted. Empty when a commit would run no repository program. */
  hooks: string[]
  /** Changes if a hook is added, removed or edited, or the folder moves. */
  hash: string
}

/** The hook a file name stands for, or null. `pre-commit`, `pre-commit.exe` and `pre-commit.cmd` count; `pre-commit.sample` does not. */
export function hookNameOf(fileName: string): string | null {
  const parts = fileName.toLowerCase().split('.')
  const base = parts[0] ?? ''
  if (!COMMIT_HOOKS.has(base)) return null
  return parts.length > 1 && parts.at(-1) === 'sample' ? null : base
}

async function digest(path: string): Promise<string> {
  const info = await lstat(path)
  // A link can point anywhere and still be what git runs, so it is part of the inventory as what it is.
  if (info.isSymbolicLink()) return 'link'
  if (!info.isFile()) return `not-a-file`
  if (info.size > MAX_HOOK_BYTES) return `too-large:${info.size}`
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(info.size)
    await handle.read(buffer, 0, buffer.length, 0)
    return createHash('sha256').update(buffer).digest('hex')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function inspectCommitHooks(runner: GitRunner, repoRoot: string, signal?: AbortSignal): Promise<HooksInventory> {
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
  for (const name of names.sort()) {
    const hook = hookNameOf(name)
    if (hook) found.push([name, await digest(win32.join(directory, name))])
  }
  const hash = createHash('sha256').update(JSON.stringify([directory.toLowerCase(), found])).digest('hex')
  return { directory, hooks: [...new Set(found.map(([name]) => name))], hash }
}
