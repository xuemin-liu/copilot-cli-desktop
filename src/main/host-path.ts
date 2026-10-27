import { posix, win32 } from 'node:path'

/**
 * The path rules of the machine the app runs on. Projects, repositories, worktrees and session folders are all local paths,
 * so they follow these rules; only code that parses a Windows path on purpose uses `win32` directly.
 */
export const hostPath: typeof win32 = process.platform === 'win32' ? win32 : posix

/** Whether file names differ only by case refer to the same file: on Windows, and on macOS's default file system. */
export const caseInsensitivePaths = process.platform === 'win32' || process.platform === 'darwin'

/** One spelling of a path for comparing and for map keys: resolved, and in lower case where the platform ignores case. */
export function pathKey(path: string): string {
  const resolved = hostPath.resolve(path)
  return caseInsensitivePaths ? resolved.toLowerCase() : resolved
}

/** What the platform calls the place deleted files go, for messages. */
export const TRASH_NAME = process.platform === 'win32' ? 'Recycle Bin' : 'Trash'

export const samePath =(left: string, right: string): boolean => pathKey(left) === pathKey(right)

/** Whether `path` is `folder` or inside it, compared the way this platform compares names. */
export function isSameOrInside(path: string, folder: string): boolean {
  const target = pathKey(path)
  const base = pathKey(folder)
  return target === base || target.startsWith(base.endsWith(hostPath.sep) ? base : `${base}${hostPath.sep}`)
}
