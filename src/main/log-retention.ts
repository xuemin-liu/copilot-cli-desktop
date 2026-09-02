import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_LOG_LIMIT_BYTES = 5 * 1024 * 1024
export const DEFAULT_SESSION_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const DEFAULT_SESSION_LOG_DIRECTORY_LIMIT = 20

export async function appendBoundedLog(filename: string, text: string, maxBytes = DEFAULT_LOG_LIMIT_BYTES): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const currentSize = await stat(filename).then((value) => value.size, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return 0
    throw error
  })
  const incoming = Buffer.from(text, 'utf8')
  if (currentSize + incoming.length > maxBytes && currentSize > 0) {
    const previous = `${filename}.1`
    await rm(previous, { force: true })
    await rename(filename, previous).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  const bounded = incoming.length <= maxBytes ? incoming : incoming.subarray(incoming.length - maxBytes)
  await appendFile(filename, bounded, { mode: 0o600 })
}

export async function pruneSessionLogDirectories(
  root: string,
  options: { now?: number; maxAgeMs?: number; maxDirectories?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_SESSION_LOG_MAX_AGE_MS
  const maxDirectories = options.maxDirectories ?? DEFAULT_SESSION_LOG_DIRECTORY_LIMIT
  const absoluteRoot = resolve(root)
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 })
  const candidates = [] as Array<{ path: string; mtimeMs: number }>
  for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const path = resolve(absoluteRoot, entry.name)
    if (dirname(path) !== absoluteRoot) continue
    const info = await stat(path)
    candidates.push({ path, mtimeMs: info.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const expired = candidates.filter((candidate, index) => index >= maxDirectories || now - candidate.mtimeMs > maxAgeMs)
  for (const candidate of expired) await rm(candidate.path, { recursive: true, force: true })
  return expired.length
}
