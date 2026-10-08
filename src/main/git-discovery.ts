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

/** A `.git` file or `commondir` is one path. */
const GIT_POINTER_MAX_BYTES = 4_096
/** `objects/info/alternates` lists one directory per line, so it may be longer; real ones are a few hundred bytes. */
const GIT_ALTERNATES_MAX_BYTES = 64 * 1024

const sameFolder = (left: string, right: string): boolean => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()

type PointerRead = { kind: 'absent' } | { kind: 'text'; text: string } | { kind: 'unsafe' }

/**
 * Read a file that can redirect git. "No such file" is the only answer that means nothing is being redirected; a file that
 * is too large to inspect completely, or cannot be read, is `unsafe`, because git reads all of it and the part left unseen
 * could be the part that names a share.
 */
async function readPointerFile(path: string, maxBytes: number): Promise<PointerRead> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > maxBytes ? { kind: 'unsafe' } : { kind: 'text', text: buffer.subarray(0, bytesRead).toString('utf8') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unsafe' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function localAbsolute(base: string, value: string): string | null {
  const resolved = win32.resolve(base, value.trim())
  return win32.isAbsolute(resolved) && isLocalFilesystemPath(resolved) ? resolved : null
}

/**
 * Files inside a git directory that make git open another location. Any of them naming a share would let the first git
 * command touch it, and Windows would offer the user's credentials, so every one must stay on local storage. Git honors
 * them in both the `.git` directory form and the `gitdir:` file form.
 */
async function pointerIssue(gitDir: string): Promise<string | null> {
  const common = await readPointerFile(win32.join(gitDir, 'commondir'), GIT_POINTER_MAX_BYTES)
  if (common.kind === 'unsafe') return 'The repository\'s commondir could not be checked completely, so it is not opened'
  const commonDir = common.kind === 'absent' ? gitDir : localAbsolute(gitDir, common.text)
  if (!commonDir) return 'The repository points outside local storage, so it is not opened'
  for (const directory of new Set([gitDir, commonDir])) {
    const alternates = await readPointerFile(win32.join(directory, 'objects', 'info', 'alternates'), GIT_ALTERNATES_MAX_BYTES)
    if (alternates.kind === 'absent') continue
    if (alternates.kind === 'unsafe') return 'The repository\'s alternates could not be checked completely, so it is not opened'
    const objects = win32.join(directory, 'objects')
    for (const line of alternates.text.split(/\r?\n/)) {
      if (line.trim() && !line.startsWith('#') && !localAbsolute(objects, line)) return 'The repository borrows objects from outside local storage, so it is not opened'
    }
  }
  return null
}

/** What lives at `<folder>\.git`: `null` when absent, otherwise whether git may be pointed at it. */
export async function inspectGitEntry(folder: string): Promise<{ issue: string | null } | null> {
  const entry = win32.join(folder, '.git')
  let info
  try { info = await lstat(entry) } catch { return null }
  if (info.isSymbolicLink()) return { issue: 'The .git entry is a link, so it is not opened' }
  if (info.isDirectory()) return { issue: await pointerIssue(entry) }
  if (!info.isFile()) return { issue: 'The .git entry is not a folder or a file' }
  const pointer = await readPointerFile(entry, GIT_POINTER_MAX_BYTES)
  const match = pointer.kind === 'text' ? /^gitdir:\s*(.+?)\s*$/m.exec(pointer.text) : null
  if (!match?.[1]) return { issue: 'The .git file does not name a git directory' }
  const gitDir = localAbsolute(folder, match[1])
  if (!gitDir) return { issue: 'The .git file points outside local storage, so it is not opened' }
  return { issue: await pointerIssue(gitDir) }
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
