import { copyFile, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { win32 } from 'node:path'
import { isPathWithinRoot } from './external-targets.js'
import { safeRepoSegments } from './git-untracked.js'
import { realPathNative } from './real-path.js'

/**
 * Discarding changes destroys work, so it is built around two promises: whatever is thrown away from a tracked file is first
 * copied to a folder the app owns, and whatever is thrown away from the untracked files goes to the Recycle Bin. This module is
 * the file-system half: the copies, their retention, and the checks that decide whether an untracked item may be deleted at all.
 */

/** A copy larger than this is not made, and then the file is not discarded from the panel. */
export const MAX_SNAPSHOT_FILE_BYTES = 25 * 1024 * 1024
export const MAX_SNAPSHOT_TOTAL_BYTES = 200 * 1024 * 1024
/** How many saved copies are kept, newest first. */
export const KEEP_SNAPSHOTS = 30
/** A folder with more entries than this is not walked, so it is not trashed from the panel. */
export const MAX_TRASH_ENTRIES = 20_000

export class DiscardRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscardRefused'
  }
}

export interface SnapshotLimits {
  maxFileBytes?: number
  maxTotalBytes?: number
  /** For tests: runs right after a file has been copied, before it is measured again. */
  afterCopy?: (relativePath: string) => void | Promise<void>
}

export interface Snapshot {
  directory: string
  files: number
  bytes: number
  /** How each file looked (size and modification time) when it was copied, so a later attempt can tell whether the copy is still current. */
  stamps: Record<string, string>
}

const stamp = (date: Date): string => date.toISOString().replace(/[:.]/g, '-')

/** How a file looks right now: `<size>:<mtime>`, or `missing`. Two equal stamps mean the copy made at the first is still of the file. */
export async function stampFiles(repoRoot: string, relativePaths: readonly string[]): Promise<Record<string, string>> {
  const stamps: Record<string, string> = {}
  for (const relativePath of relativePaths) {
    const file = repoFile(repoRoot, relativePath)
    const info = file.ok ? await lstat(file.absolute).catch(() => null) : null
    stamps[relativePath] = info === null ? 'missing' : `${info.size}:${info.mtimeMs}`
  }
  return stamps
}

/**
 * Whether the folders above a path are plain folders inside the repository. A junction or link in the middle of a path sends a
 * read or a write somewhere else (Git itself does not notice a Windows junction), so it is refused wherever it is, and the nearest
 * existing folder must resolve inside the repository. A missing folder is fine: a restore creates it.
 */
async function ancestorProblem(repoRoot: string, relativePath: string): Promise<string | null> {
  const segments = safeRepoSegments(relativePath)
  if (!segments) return `"${relativePath}" has a name that is not safe to touch`
  let current = repoRoot
  for (const segment of segments.slice(0, -1)) {
    current = win32.join(current, segment)
    const info = await lstat(current).catch(() => null)
    if (info === null) return null
    if (info.isSymbolicLink()) return `"${relativePath}" is inside a folder that is a link, so it could reach outside the repository`
    if (!info.isDirectory()) return `"${relativePath}" is inside something that is not a folder`
  }
  try {
    const [root, resolved] = await Promise.all([realPathNative(repoRoot), realPathNative(current)])
    if (!isPathWithinRoot(root, resolved)) return `"${relativePath}" resolves outside the repository`
  } catch {
    return `"${relativePath}" could not be resolved`
  }
  return null
}

/** The path of a repository file, resolved inside the repository, or the reason it cannot be used. */
function repoFile(repoRoot: string, relativePath: string): { ok: true; absolute: string } | { ok: false; reason: string } {
  const segments = safeRepoSegments(relativePath)
  if (!segments) return { ok: false, reason: `"${relativePath}" has a name that is not safe to touch` }
  const absolute = win32.join(repoRoot, ...segments)
  if (!isPathWithinRoot(repoRoot, absolute)) return { ok: false, reason: `"${relativePath}" is outside the repository` }
  return { ok: true, absolute }
}

/**
 * What a copy of these tracked files would need, checked before the person is asked: each file that still exists is a regular file
 * (not a link) and within the size limits. A file that no longer exists (deleted in the working tree) needs no copy.
 */
export async function checkSnapshotable(repoRoot: string, relativePaths: readonly string[], limits: SnapshotLimits = {}): Promise<string[]> {
  const maxFile = limits.maxFileBytes ?? MAX_SNAPSHOT_FILE_BYTES
  const maxTotal = limits.maxTotalBytes ?? MAX_SNAPSHOT_TOTAL_BYTES
  const problems: string[] = []
  let total = 0
  for (const relativePath of relativePaths) {
    const file = repoFile(repoRoot, relativePath)
    if (!file.ok) { problems.push(file.reason); continue }
    const above = await ancestorProblem(repoRoot, relativePath)
    if (above) { problems.push(above); continue }
    const info = await lstat(file.absolute).catch(() => null)
    if (info === null) continue
    if (info.isSymbolicLink() || !info.isFile()) { problems.push(`"${relativePath}" is not a regular file, so a copy cannot be saved`); continue }
    if (info.size > maxFile) { problems.push(`"${relativePath}" is larger than ${Math.round(maxFile / (1024 * 1024))} MB, too large to save a copy of`); continue }
    total += info.size
  }
  if (problems.length === 0 && total > maxTotal) problems.push(`these files together are larger than ${Math.round(maxTotal / (1024 * 1024))} MB, too much to save copies of`)
  return problems
}

/**
 * Copy the tracked files to a new folder under `snapshotRoot` before they are restored, with a manifest saying where they came from.
 * What is copied is what is on disk now: each file is measured before and after its copy, and one that changed while it was being
 * copied stops the discard (a half-written copy is not a copy).
 */
export async function saveSnapshot(snapshotRoot: string, repoRoot: string, relativePaths: readonly string[], now: Date, limits: SnapshotLimits = {}): Promise<Snapshot> {
  const problems = await checkSnapshotable(repoRoot, relativePaths, limits)
  if (problems.length > 0) throw new DiscardRefused(problems[0] ?? 'A copy cannot be saved')
  const repoName = repoRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? 'repository'
  const directory = win32.join(snapshotRoot, `${stamp(now)}-${repoName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}`)
  if (!isPathWithinRoot(snapshotRoot, directory)) throw new DiscardRefused('The place for saved copies is not usable')
  await mkdir(directory, { recursive: true })
  const saved: Array<{ path: string; bytes: number }> = []
  const stamps: Record<string, string> = {}
  let bytes = 0
  for (const relativePath of relativePaths) {
    const file = repoFile(repoRoot, relativePath)
    if (!file.ok) throw new DiscardRefused(file.reason)
    const before = await lstat(file.absolute).catch(() => null)
    stamps[relativePath] = before === null ? 'missing' : `${before.size}:${before.mtimeMs}`
    if (before === null) continue
    const target = win32.join(directory, 'files', ...(safeRepoSegments(relativePath) ?? []))
    if (!isPathWithinRoot(directory, target)) throw new DiscardRefused(`"${relativePath}" cannot be saved safely`)
    await mkdir(win32.dirname(target), { recursive: true })
    await copyFile(file.absolute, target)
    await limits.afterCopy?.(relativePath)
    const after = await lstat(file.absolute).catch(() => null)
    if (after === null || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new DiscardRefused(`"${relativePath}" changed while its copy was being saved. Nothing was discarded; try again.`)
    saved.push({ path: relativePath, bytes: before.size })
    bytes += before.size
  }
  await writeFile(win32.join(directory, 'manifest.json'), JSON.stringify({ repository: repoRoot, savedAt: now.toISOString(), files: saved }, null, 2), 'utf8')
  return { directory, files: saved.length, bytes, stamps }
}

/** Remove the oldest saved copies beyond `keep`. Only folders this module created (by name) inside `snapshotRoot` are ever touched. */
export async function pruneSnapshots(snapshotRoot: string, keep = KEEP_SNAPSHOTS): Promise<number> {
  const names = (await readdir(snapshotRoot).catch(() => [] as string[])).filter(name => /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[A-Za-z0-9._-]+$/.test(name)).sort()
  const old = names.slice(0, Math.max(0, names.length - keep))
  for (const name of old) {
    const target = win32.join(snapshotRoot, name)
    if (isPathWithinRoot(snapshotRoot, target)) await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
  }
  return old.length
}

export type Trashable = { ok: true; absolute: string } | { ok: false; reason: string }

/**
 * Whether an untracked file or folder may go to the Recycle Bin. It came from a repository, so: a safe name, not a link or junction,
 * contained in the repository after resolving, and for a folder, nothing inside it is a git repository (that would delete someone's
 * whole history) and it is small enough to inspect.
 */
export async function checkTrashable(repoRoot: string, relativePath: string): Promise<Trashable> {
  const file = repoFile(repoRoot, relativePath)
  if (!file.ok) return file
  const segments = safeRepoSegments(relativePath) ?? []
  if (segments.some(segment => segment.toLowerCase() === '.git')) return { ok: false, reason: `"${relativePath}" is inside a git folder` }
  const above = await ancestorProblem(repoRoot, relativePath)
  if (above) return { ok: false, reason: above }
  const info = await lstat(file.absolute).catch(() => null)
  if (info === null) return { ok: false, reason: `"${relativePath}" no longer exists` }
  if (info.isSymbolicLink()) return { ok: false, reason: `"${relativePath}" is a link, so it is not deleted from the panel` }
  try {
    const [root, resolved] = await Promise.all([realPathNative(repoRoot), realPathNative(file.absolute)])
    if (!isPathWithinRoot(root, resolved)) return { ok: false, reason: `"${relativePath}" resolves outside the repository` }
  } catch {
    return { ok: false, reason: `"${relativePath}" could not be resolved` }
  }
  if (info.isFile()) return { ok: true, absolute: file.absolute }
  if (!info.isDirectory()) return { ok: false, reason: `"${relativePath}" is not a regular file or folder` }
  // A folder: walk it without following links, refusing a nested repository and anything too big to inspect.
  let seen = 0
  const stack = [file.absolute]
  while (stack.length > 0) {
    const directory = stack.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (++seen > MAX_TRASH_ENTRIES) return { ok: false, reason: `"${relativePath}" has more than ${MAX_TRASH_ENTRIES.toLocaleString()} items, too many to check. Delete it in File Explorer.` }
      if (entry.name.toLowerCase() === '.git') return { ok: false, reason: `"${relativePath}" contains a git repository, so it is not deleted from the panel` }
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(win32.join(directory, entry.name))
    }
  }
  return { ok: true, absolute: file.absolute }
}
