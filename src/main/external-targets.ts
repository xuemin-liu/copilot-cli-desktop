import { win32 } from 'node:path'

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

/** Reject UNC and Windows device namespaces before any filesystem operation. */
export function isLocalFilesystemPath(candidate: string): boolean {
  if (!candidate || candidate.includes('\0')) return false
  const normalizedSeparators = candidate.replaceAll('/', '\\')
  if (normalizedSeparators.startsWith('\\\\') || normalizedSeparators.startsWith('\\??\\')) return false
  const root = win32.parse(normalizedSeparators).root
  return !root.startsWith('\\\\')
}

export function isSessionTabId(value: unknown): value is string {
  return typeof value === 'string' && /^tab-[1-9]\d*$/.test(value)
}
