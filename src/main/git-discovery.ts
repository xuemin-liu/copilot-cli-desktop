import { lstat, open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { hostPath, samePath } from './host-path.js'
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
  /** For a `worktree`: the canonical root of the repository it belongs to. */
  worktreeOf?: string
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

export const sameFolder = samePath

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

const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 }

/**
 * Decode a line in git's C-style quoted form (`"..."` with `\\`, `\"`, `\a \b \f \n \r \t \v` and three-digit octal escapes),
 * which `objects/info/alternates` accepts. Returns null for anything that is not exactly one well-formed quoted string, so the
 * caller can refuse it: a validator that guesses at quoting can be talked into calling a share a local path.
 */
export function decodeGitQuoted(line: string): string | null {
  if (!line.startsWith('"')) return null
  const bytes: number[] = []
  let index = 1
  for (;;) {
    const char = line[index]
    if (char === undefined) return null
    if (char === '"') return line.slice(index + 1) === '' ? Buffer.from(bytes).toString('utf8') : null
    if (char !== '\\') { bytes.push(...Buffer.from(char, 'utf8')); index++; continue }
    const next = line[index + 1]
    if (next !== undefined && next in C_ESCAPES) { bytes.push(C_ESCAPES[next]!); index += 2; continue }
    const octal = /^[0-3][0-7]{2}/.exec(line.slice(index + 1))
    if (!octal) return null
    bytes.push(parseInt(octal[0], 8))
    index += 4
  }
}

function localAbsolute(base: string, value: string): string | null {
  const resolved = hostPath.resolve(base, value.trim())
  return hostPath.isAbsolute(resolved) && isLocalFilesystemPath(resolved) ? resolved : null
}

/**
 * Files inside a git directory that make git open another location. Any of them naming a share would let the first git
 * command touch it, and Windows would offer the user's credentials, so every one must stay on local storage. Git honors
 * them in both the `.git` directory form and the `gitdir:` file form.
 */
async function pointerIssue(gitDir: string): Promise<string | null> {
  const common = await readPointerFile(hostPath.join(gitDir, 'commondir'), GIT_POINTER_MAX_BYTES)
  if (common.kind === 'unsafe') return 'The repository\'s commondir could not be checked completely, so it is not opened'
  const commonDir = common.kind === 'absent' ? gitDir : localAbsolute(gitDir, common.text)
  if (!commonDir) return 'The repository points outside local storage, so it is not opened'
  return alternatesIssue([...new Set([gitDir, commonDir])].map(directory => hostPath.join(directory, 'objects')))
}

/** Git ignores alternates nested deeper than this; a longer chain is refused rather than trusted to be ignored. */
const ALTERNATES_MAX_DEPTH = 5
/** Distinct object directories examined per repository. Real repositories have zero to a handful. */
const ALTERNATES_MAX_DIRECTORIES = 64
const ALTERNATES_INCOMPLETE = 'The repository\'s alternates could not be checked completely, so it is not opened'

/**
 * Follow the whole chain of `objects/info/alternates`, because git does: an alternate's own alternates file is read too, so
 * a local first hop can lead to a share on the second. Every hop is decoded, resolved against the directory that names it,
 * and followed through links to where it really lives. Depth, count and file size are capped, and anything that cannot be
 * examined completely is refused.
 */
async function alternatesIssue(roots: readonly string[]): Promise<string | null> {
  const seen = new Set<string>()
  const queue = roots.map(directory => ({ directory, depth: 0 }))
  while (queue.length > 0) {
    const { directory, depth } = queue.shift()!
    const key = directory.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (seen.size > ALTERNATES_MAX_DIRECTORIES) return ALTERNATES_INCOMPLETE
    const alternates = await readPointerFile(hostPath.join(directory, 'info', 'alternates'), GIT_ALTERNATES_MAX_BYTES)
    if (alternates.kind === 'absent') continue
    if (alternates.kind === 'unsafe') return ALTERNATES_INCOMPLETE
    for (const raw of alternates.text.split(/\r?\n/)) {
      if (!raw.trim() || raw.startsWith('#')) continue
      // Git reads a quoted line as the decoded path. Anything it could not decode is refused, not guessed at.
      const entry = raw.startsWith('"') ? decodeGitQuoted(raw) : raw
      if (entry === null) return ALTERNATES_INCOMPLETE
      const target = localAbsolute(directory, entry)
      if (!target) return 'The repository borrows objects from outside local storage, so it is not opened'
      // A link inside local storage can still lead to a share; follow it to where the directory really is.
      const real = await realPathNative(target).catch(() => null)
      if (real !== null && !isLocalFilesystemPath(real)) return 'The repository borrows objects from outside local storage, so it is not opened'
      if (depth + 1 > ALTERNATES_MAX_DEPTH) return ALTERNATES_INCOMPLETE
      queue.push({ directory: real ?? target, depth: depth + 1 })
    }
  }
  return null
}

/** What lives at `<folder>\.git`: `null` when absent, otherwise whether git may be pointed at it. */
export async function inspectGitEntry(folder: string): Promise<{ issue: string | null } | null> {
  const entry = hostPath.join(folder, '.git')
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
  const resolved = hostPath.resolve(candidate)
  return resolved === hostPath.parse(resolved).root || sameFolder(resolved, homeDirectory)
}

export type EnclosingRepository =
  | { kind: 'found'; root: string; issue: string | null; folder: string }
  | { kind: 'too-broad'; root: string }
  | { kind: 'none' }

/**
 * The repository a local folder is, or sits in, found as `discoverRepos` finds a project or parent repository: on the
 * canonical folder, using only the filesystem (nothing here starts Git), and never one that encloses the home folder or a
 * drive root, whose changes would be everything under it. Throws for a folder that is not local or cannot be read.
 */
export async function enclosingRepository(folderPath: string, homeDirectory?: string): Promise<EnclosingRepository> {
  if (!isLocalFilesystemPath(folderPath)) throw new Error('Only local folders can be inspected for git repositories')
  const folder = await realPathNative(folderPath)
  if (!isLocalFilesystemPath(folder)) throw new Error('The folder resolves outside local storage')
  const rawHome = homeDirectory ?? homedir()
  const home = await realPathNative(rawHome).catch(() => rawHome)
  for (let current = folder, previous = ''; current !== previous; previous = current, current = hostPath.dirname(current)) {
    const entry = await inspectGitEntry(current)
    if (!entry) continue
    if (current !== folder && isAncestorTooBroad(current, home)) return { kind: 'too-broad', root: current }
    return { kind: 'found', root: current, issue: entry.issue, folder }
  }
  return { kind: 'none' }
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
  const relative = (root: string): string => hostPath.relative(project, root) || '.'

  const own = await inspectGitEntry(project)
  if (own) {
    repos.push({ root: project, relativePath: '.', kind: 'project', issue: own.issue })
    return { project, repos, truncated, notes }
  }

  // The project may sit inside a larger repository.
  for (let folder = hostPath.dirname(project), previous = project; folder !== previous; previous = folder, folder = hostPath.dirname(folder)) {
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
      const folder = hostPath.join(current.folder, child.name)
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

export interface SessionWorktree {
  /** Canonical root of the worktree. */
  root: string
  /** Canonical root of the repository it belongs to. */
  mainRoot: string
  /** The worktree's folder name (`git worktree add` names it after the branch by default). */
  name: string
  /** The checked-out branch, or null when detached. Read from the worktree's HEAD file, without running git. */
  branch: string | null
  /** Set when the worktree's git directory is unsafe to hand to git; it is listed but never opened. */
  issue: string | null
  /** Canonical `<repo>\\.git\\worktrees\\<name>`, for reading the branch again later. */
  gitDir: string
}

const WORKTREE_GIT_DIR = /^(.+)[\\/]\.git[\\/]worktrees[\\/]([^\\/]+)$/

/**
 * Whether a folder a Copilot session reports as its cwd is a linked worktree of a repository this app already knows, using
 * only the filesystem. The cwd is data the CLI wrote: it must be a local path; its `.git` must be a file (not a link or a
 * folder) naming a git directory under `<repo>\.git\worktrees\<name>`, after links are followed; and `accept` must agree
 * that `<repo>` is one of ours. Anything else is not a worktree the app will show.
 */
export async function inspectSessionWorktree(cwd: string, accept: (mainRoot: string) => boolean): Promise<SessionWorktree | null> {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4_096 || !isLocalFilesystemPath(cwd)) return null
  let root: string
  try { root = await realPathNative(cwd) } catch { return null }
  if (!isLocalFilesystemPath(root)) return null
  const entry = hostPath.join(root, '.git')
  let info
  try { info = await lstat(entry) } catch { return null }
  if (!info.isFile()) return null
  const pointer = await readPointerFile(entry, GIT_POINTER_MAX_BYTES)
  const match = pointer.kind === 'text' ? /^gitdir:\s*(.+?)\s*$/m.exec(pointer.text) : null
  if (!match?.[1]) return null
  const named = localAbsolute(root, match[1])
  if (!named) return null
  let gitDir: string
  try { gitDir = await realPathNative(named) } catch { return null }
  if (!isLocalFilesystemPath(gitDir)) return null
  const place = WORKTREE_GIT_DIR.exec(gitDir)
  if (!place?.[1] || !place[2]) return null
  let mainRoot: string
  try { mainRoot = await realPathNative(place[1]) } catch { return null }
  if (!isLocalFilesystemPath(mainRoot) || !accept(mainRoot)) return null
  // Where the git directory sits says nothing about which repository git will read: `commondir` does. It must be the
  // accepted repository's own .git, and the backpointer must name this folder's .git file, or the folder is not a
  // worktree of that repository and is not shown at all.
  const common = await readPointerFile(hostPath.join(gitDir, 'commondir'), GIT_POINTER_MAX_BYTES)
  if (common.kind !== 'text') return null
  const commonNamed = localAbsolute(gitDir, common.text)
  if (!commonNamed) return null
  let commonDir: string
  try { commonDir = await realPathNative(commonNamed) } catch { return null }
  if (!sameFolder(commonDir, hostPath.join(mainRoot, '.git'))) return null
  const back = await readPointerFile(hostPath.join(gitDir, 'gitdir'), GIT_POINTER_MAX_BYTES)
  if (back.kind !== 'text') return null
  const backNamed = localAbsolute(gitDir, back.text)
  if (!backNamed) return null
  let backTarget: string
  try { backTarget = await realPathNative(backNamed) } catch { return null }
  if (!sameFolder(backTarget, entry)) return null
  return { root, mainRoot, name: place[2], branch: await readWorktreeBranch(gitDir), issue: await pointerIssue(gitDir), gitDir }
}

/** More linked worktrees than the start-in list shows; the rest are not offered there (a saved choice is still honored). */
const MAX_LISTED_WORKTREES = 50

/**
 * The canonical project folder and the main checkout of the repository it is (or sits in), found the way `discoverRepos`
 * finds a project or parent repository; when the project is itself a linked worktree, its main repository. Null when there
 * is none, it is unsafe to open, or the only one encloses the home folder or a drive root.
 */
async function projectRepository(projectPath: string, homeDirectory?: string): Promise<{ project: string; mainRoot: string } | null> {
  if (!isLocalFilesystemPath(projectPath)) return null
  let project: string
  try { project = await realPathNative(projectPath) } catch { return null }
  const rawHome = homeDirectory ?? homedir()
  const home = await realPathNative(rawHome).catch(() => rawHome)
  for (let folder = project, previous = ''; folder !== previous; previous = folder, folder = hostPath.dirname(folder)) {
    let info
    try { info = await lstat(hostPath.join(folder, '.git')) } catch { continue }
    if (folder !== project && isAncestorTooBroad(folder, home)) return null
    if (info.isDirectory()) return (await inspectGitEntry(folder))?.issue === null ? { project, mainRoot: folder } : null
    const mainRoot = (await inspectSessionWorktree(folder, () => true))?.mainRoot
    return mainRoot ? { project, mainRoot } : null
  }
  return null
}

/** A folder is offered as a linked worktree of `mainRoot` when `inspectSessionWorktree` accepts it for that repository, it
 * is safe to open, and it is not the project folder itself. */
async function linkedWorktreeOf(folder: string, mainRoot: string, project: string): Promise<SessionWorktree | null> {
  const worktree = await inspectSessionWorktree(folder, (candidate) => sameFolder(candidate, mainRoot))
  return worktree && worktree.issue === null && !sameFolder(worktree.root, project) ? worktree : null
}

/**
 * The linked worktrees of the repository a project folder is (or sits in), using only the filesystem, so a session can be
 * started in one: each entry under `<repo>\.git\worktrees` whose folder passes `linkedWorktreeOf`. At most `max` are
 * listed. Sorted by folder.
 */
export async function listLinkedWorktrees(projectPath: string, options: { homeDirectory?: string; max?: number } = {}): Promise<SessionWorktree[]> {
  const repository = await projectRepository(projectPath, options.homeDirectory)
  if (!repository) return []
  const { project, mainRoot } = repository
  const max = options.max ?? MAX_LISTED_WORKTREES
  let entries
  try { entries = await readdir(hostPath.join(mainRoot, '.git', 'worktrees'), { withFileTypes: true }) } catch { return [] }
  const found: SessionWorktree[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (found.length >= max) break
    const gitDir = hostPath.join(mainRoot, '.git', 'worktrees', entry.name)
    const back = await readPointerFile(hostPath.join(gitDir, 'gitdir'), GIT_POINTER_MAX_BYTES)
    const dotGit = back.kind === 'text' ? localAbsolute(gitDir, back.text) : null
    if (!dotGit) continue
    const worktree = await linkedWorktreeOf(hostPath.dirname(dotGit), mainRoot, project)
    // The folder must lead back to this very entry; one whose backpointer names another entry's worktree is not listed twice.
    if (worktree && sameFolder(worktree.gitDir, gitDir)) found.push(worktree)
  }
  return found.sort((a, b) => a.root.localeCompare(b.root))
}

/**
 * `path` as a linked worktree of the project's repository, else null. The path comes from the renderer or a saved tab, so
 * the folder itself is checked against the repository (its `.git` file, commondir and backpointer), the same check the
 * list makes for each entry, but without the list's cap: a choice stays valid however many worktrees are added later.
 */
export async function resolveLinkedWorktree(projectPath: string, path: string): Promise<SessionWorktree | null> {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096 || !isLocalFilesystemPath(path)) return null
  const repository = await projectRepository(projectPath)
  return repository ? linkedWorktreeOf(path, repository.mainRoot, repository.project) : null
}

/** The branch a worktree has checked out, from its HEAD file (no git): null when detached, missing or unreadable. */
export async function readWorktreeBranch(gitDir: string): Promise<string | null> {
  const head = await readPointerFile(hostPath.join(gitDir, 'HEAD'), GIT_POINTER_MAX_BYTES)
  const ref = head.kind === 'text' ? /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head.text) : null
  return ref?.[1] ?? null
}
