import { win32 } from 'node:path'
import { hostPath } from './host-path.js'

export function parseSafeHttpUrl(value: string, label = 'URL'): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`)
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain embedded credentials`)
  return parsed
}

/**
 * Reject UNC and Windows device namespaces before any filesystem operation. Elsewhere a network mount looks like any other
 * folder, so only an empty path or one with a NUL is refused.
 */
export function isLocalFilesystemPath(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!candidate || candidate.includes('\0')) return false
  if (platform !== 'win32') return true
  const normalizedSeparators = candidate.replaceAll('/', '\\')
  if (normalizedSeparators.startsWith('\\\\') || normalizedSeparators.startsWith('\\??\\')) return false
  const root = win32.parse(normalizedSeparators).root
  return !root.startsWith('\\\\')
}

/** Lexically contain a resolved path to its owning workspace. */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = hostPath.relative(hostPath.resolve(root), hostPath.resolve(candidate))
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${hostPath.sep}`)
    && !hostPath.isAbsolute(relative)
  )
}

export function isSessionTabId(value: unknown): value is string {
  return typeof value === 'string' && /^tab-[1-9]\d*$/.test(value)
}
