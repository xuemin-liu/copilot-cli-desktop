import { lstat, open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { isLocalFilesystemPath } from './external-targets.js'
import type { GitRepoKind } from './git-types.js'
import { realPathNative } from './real-path.js'

/**
 * Finds repositories for a project folder using only the filesystem. Nothing here starts git, so an
 * untrusted `.git` is inspected before any program can be asked to read it.
 */

export interface DiscoveredRepo {
  /** Canonical (`realpath.native`) root of the working tree. */
  root: string
  relativePath: string
  kind: GitRepoKind
  /** Set when the `.git` entry is unsafe to hand to git; the repo is listed but never opened. */
  issue: string | null
}

export interface DiscoveryResult {
  /** Canonical project folder. */
  project: string
  repos: DiscoveredRepo[]
  truncated: boolean
  notes: string[]
}

export interface DiscoveryOptions {
  homeDirectory?: string
  maxDepth?: number
  maxRepos?: number
  maxDirectories?: number
  budgetMs?: number
  skipNames?: ReadonlySet<string>
}

export const DEFAULT_SKIP_NAMES: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'release', '.venv', 'venv', 'target', '.next', '.git',
])

const GIT_POINTER_MAX_BYTES = 4_096

const sameFolder = (left: string, right: string): boolean => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()

async function readSmallText(path: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(GIT_POINTER_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > GIT_POINTER_MAX_BYTES ? null : buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function localAbsolute(base: string, value: string): string | null {
  const resolved = win32.resolve(base, value.trim())
  return win32.isAbsolute(resolved) && isLocalFilesystemPath(resolved) ? resolved : null
}

/** What lives at `<folder>\.git`: `null` when absent, otherwise whether git may be pointed at it. */
export async function inspectGitEntry(folder: string): Promise<{ issue: string | null } | null> {
  const entry = win32.join(folder, '.git')
  let info
  try { info = await lstat(entry) } catch { return null }
  if (info.isSymbolicLink()) return { issue: 'The .git entry is a link, so it is not opened' }
  if (info.isDirectory()) return { issue: null }
  if (!info.isFile()) return { issue: 'The .git entry is not a folder or a file' }
  const text = await readSmallText(entry)
  const match = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text)
  if (!match?.[1]) return { issue: 'The .git file does not name a git directory' }
  const gitDir = localAbsolute(folder, match[1])
  if (!gitDir) return { issue: 'The .git file points outside local storage, so it is not opened' }
  // A linked worktree's git directory names its shared directory in `commondir`.
  const common = await readSmallText(win32.join(gitDir, 'commondir'))
  if (common !== null && !localAbsolute(gitDir, common)) return { issue: 'The worktree points outside local storage, so it is not opened' }
  return { issue: null }
}

function isAncestorTooBroad(candidate: string, homeDirectory: string): boolean {
  const resolved = win32.resolve(candidate)
  return resolved === win32.parse(resolved).root || sameFolder(resolved, homeDirectory)
}

export async function discoverRepos(projectPath: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  if (!isLocalFilesystemPath(projectPath)) throw new Error('Only local project folders can be inspected for git repositories')
  const project = await realPathNative(projectPath)
  if (!isLocalFilesystemPath(project)) throw new Error('The project folder resolves outside local storage')
  // Compare against the home folder's canonical form: the project is canonical, and a home reached through an 8.3 short
  // name or a junction would otherwise never match it.
  const rawHome = options.homeDirectory ?? homedir()
  const home = await realPathNative(rawHome).catch(() => rawHome)
  const maxDepth = options.maxDepth ?? 3
  const maxRepos = options.maxRepos ?? 25
  const maxDirectories = options.maxDirectories ?? 2_000
  const deadline = Date.now() + (options.budgetMs ?? 3_000)
  const skip = options.skipNames ?? DEFAULT_SKIP_NAMES
  const notes: string[] = []
  const repos: DiscoveredRepo[] = []
  let truncated = false
  const relative = (root: string): string => win32.relative(project, root) || '.'

  const own = await inspectGitEntry(project)
  if (own) {
    repos.push({ root: project, relativePath: '.', kind: 'project', issue: own.issue })
    return { project, repos, truncated, notes }
  }

  // The project may sit inside a larger repository.
  for (let folder = win32.dirname(project), previous = project; folder !== previous; previous = folder, folder = win32.dirname(folder)) {
    const entry = await inspectGitEntry(folder)
    if (!entry) continue
    if (isAncestorTooBroad(folder, home)) {
      notes.push(`A repository at ${folder} contains this folder, but it is a drive root or home folder, so it is ignored`)
    } else {
      repos.push({ root: folder, relativePath: relative(folder), kind: 'parent', issue: entry.issue })
    }
    break
  }

  const queue: Array<{ folder: string; depth: number }> = [{ folder: project, depth: 0 }]
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) continue
    let children
    try { children = await readdir(current.folder, { withFileTypes: true }) } catch { continue }
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      // Dirent.isDirectory() is false for links and junctions, so they are never followed.
      if (!child.isDirectory() || skip.has(child.name.toLowerCase())) continue
      if (++visited > maxDirectories || Date.now() > deadline) { truncated = true; queue.length = 0; break }
      const folder = win32.join(current.folder, child.name)
      const found = await inspectGitEntry(folder)
      if (found) {
        if (repos.filter(repo => repo.kind !== 'parent').length >= maxRepos) { truncated = true; queue.length = 0; break }
        repos.push({ root: folder, relativePath: relative(folder), kind: 'nested', issue: found.issue })
      } else {
        queue.push({ folder, depth: current.depth + 1 })
      }
    }
  }
  if (truncated) notes.push(`Showing the first ${repos.length} repositories; rescan to look again`)
  repos.sort((a, b) => (a.kind === 'nested' ? 1 : 0) - (b.kind === 'nested' ? 1 : 0) || a.relativePath.localeCompare(b.relativePath))
  return { project, repos, truncated, notes }
}
