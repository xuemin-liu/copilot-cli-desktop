import { parseSafeHttpUrl } from './external-targets.js'

const SENSITIVE_NAME = /auth|token|secret|api[-_]?key|cookie|csrf|xsrf|session|credential|password/i
const SENSITIVE_QUERY = /auth|token|secret|api[-_]?key|csrf|xsrf|session|credential|password|signature|^sig$|^key$|^code$|^state$/i

/** Telemetry only: never use the redacted URL to navigate or match overrides. */
export function sanitizedUrl(value: string): string {
  let url: URL
  const relative = /^[/?#]/.test(value) && !value.startsWith('//')
  try { url = relative ? new URL(value, 'https://redaction.invalid') : new URL(value) } catch { return value }
  url.username = ''; url.password = ''
  for (const name of new Set(url.searchParams.keys())) {
    if (SENSITIVE_QUERY.test(name)) url.searchParams.set(name, '[redacted]')
  }
  if (url.hash) url.hash = '[redacted]'
  return relative ? `${url.pathname}${url.search}${url.hash}` : url.href
}

/** Best-effort filtering of recognizable credentials; arbitrary prose is not safe. */
export function sanitizedText(value: string): string {
  return value.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, sanitizedUrl)
    .replace(/\bBearer\s+[\w.+\/~=-]+/gi, 'Bearer [redacted]')
    .replace(/(["']?[\w-]*(?:auth|token|secret|api[-_]?key|cookie|csrf|xsrf|session|credential|password)[\w-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      '$1[redacted]')
}

export function sanitizedHeaders<T extends string | string[]>(headers: Record<string, T>): Record<string, T> {
  const urlValue = (value: string): string => {
    try {
      // Header URLs can use every relative-reference form, including ../ and //.
      const absolute = new URL(value, 'https://redaction.invalid').href
      const redacted = sanitizedUrl(absolute)
      return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')
        ? redacted : redacted.replace('https://redaction.invalid', '')
    } catch { return '[redacted URL]' }
  }
  const sanitize = (name: string, value: string): string => {
    if (/^(location|content-location|referer)$/i.test(name)) return urlValue(value)
    if (/^link$/i.test(name)) return value.replace(/<([^>]+)>/g, (_match, url: string) => `<${urlValue(url)}>`)
    if (/^refresh$/i.test(name)) return value.replace(/(url\s*=\s*)(["']?)(.+?)\2$/i,
      (_match, prefix: string, quote: string, url: string) => `${prefix}${quote}${urlValue(url)}${quote}`)
    return sanitizedText(value)
  }
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name,
    SENSITIVE_NAME.test(name) ? (Array.isArray(value) ? ['[redacted]'] : '[redacted]')
      : Array.isArray(value) ? value.map(item => sanitize(name, item)) : sanitize(name, value),
  ])) as Record<string, T>
}

/** Only successful top-level ordinary pages are candidates for next-launch restore. */
export function restorableUrl(value: string): string | null {
  const url = parseSafeHttpUrl(value)
  if (url.hash || [...url.searchParams.keys()].some(name => SENSITIVE_QUERY.test(name))) return null
  url.search = ''
  return url.href
}
