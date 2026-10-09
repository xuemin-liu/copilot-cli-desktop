import { lstat, open } from 'node:fs/promises'
import { win32 } from 'node:path'
import { isPathWithinRoot } from './external-targets.js'
import { realPathNative } from './real-path.js'

/**
 * Reads an untracked file for the diff view. git has no diff for these, and the path came from a repository, so it is
 * treated as hostile: no links or junctions, contained in the repository after resolving, not a device name or a
 * stream, and size-capped.
 */

export type UntrackedRead =
  | { kind: 'text'; text: string; truncated: boolean; totalBytes: number }
  | { kind: 'binary' }
  | { kind: 'too-large'; totalBytes: number }
  | { kind: 'directory' }
  | { kind: 'unsafe'; reason: string }

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const BINARY_SNIFF_BYTES = 8_000

/** Split a git-style path into segments, or null when any segment could escape or alias another file on Windows. */
export function safeRepoSegments(relativePath: string): string[] | null {
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\')) return null
  const segments = relativePath.replace(/\/$/, '').split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null
    if (segment.includes(':') || RESERVED_NAME.test(segment) || /[. ]$/.test(segment)) return null
  }
  return segments
}

export async function readUntrackedFile(repoRoot: string, relativePath: string, maxBytes = 512 * 1024): Promise<UntrackedRead> {
  if (relativePath.endsWith('/')) return { kind: 'directory' }
  const segments = safeRepoSegments(relativePath)
  if (!segments) return { kind: 'unsafe', reason: 'The file name is not safe to open' }
  const target = win32.join(repoRoot, ...segments)
  let info
  try { info = await lstat(target) } catch { return { kind: 'unsafe', reason: 'The file no longer exists' } }
  if (info.isSymbolicLink()) return { kind: 'unsafe', reason: 'The file is a link, so it is not opened' }
  if (info.isDirectory()) return { kind: 'directory' }
  if (!info.isFile()) return { kind: 'unsafe', reason: 'Not a regular file' }
  try {
    const [resolvedRoot, resolvedTarget] = await Promise.all([realPathNative(repoRoot), realPathNative(target)])
    if (!isPathWithinRoot(resolvedRoot, resolvedTarget)) return { kind: 'unsafe', reason: 'The file resolves outside the repository' }
  } catch {
    return { kind: 'unsafe', reason: 'The file could not be resolved' }
  }
  if (info.size > maxBytes * 8) return { kind: 'too-large', totalBytes: info.size }
  const handle = await open(target, 'r').catch(() => null)
  if (!handle) return { kind: 'unsafe', reason: 'The file could not be opened' }
  try {
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, bytesRead)
    if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: 'binary' }
    const truncated = info.size > maxBytes
    return { kind: 'text', text: data.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'), truncated, totalBytes: info.size }
  } finally {
    await handle.close().catch(() => undefined)
  }
}
