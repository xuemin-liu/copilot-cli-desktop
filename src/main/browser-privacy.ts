import { parseSafeHttpUrl } from './external-targets.js'
import { MAX_TELEMETRY_TEXT, SENSITIVE_QUERY, sanitizedUrl } from './browser-url-sanitize.js'

export { MAX_TELEMETRY_TEXT, sanitizedUrl }

const SENSITIVE_NAME = /auth|token|secret|api[-_]?key|cookie|csrf|xsrf|session|credential|password/i
/** Best-effort filtering of recognizable credentials; arbitrary prose is not safe. */
export function sanitizedText(value: string): string {
  const truncated = value.length > MAX_TELEMETRY_TEXT
  const bounded = value.slice(0, MAX_TELEMETRY_TEXT)
  const text = bounded.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, (url: string, offset: number) =>
    truncated && offset + url.length === bounded.length ? '[redacted truncated URL]' : sanitizedUrl(url))
    .replace(/\bBearer\s+[\w.+\/~=-]+/gi, 'Bearer [redacted]')
  // Start only at a token boundary, consume the key once, then test its name.
  // Matching a keyword inside an unanchored greedy key retries every suffix.
  const fields = /(?<![\w-])(["']?)([\w-]+)["']?\s*[:=]\s*/g
  const chunks: string[] = []
  let copied = 0
  let match: RegExpExecArray | null
  while ((match = fields.exec(text))) {
    if (!SENSITIVE_NAME.test(match[2]!)) continue
    const start = fields.lastIndex
    let end = start
    const quote = text[start]
    if (quote === '"' || quote === "'") {
      end++
      // Escapes and an unfinished quoted value consume through the bounded end.
      while (end < text.length) {
        const character = text[end++]
        if (character === '\\') end = Math.min(text.length, end + 1)
        else if (character === quote) break
      }
    } else {
      while (end < text.length && !/[\s,;&}]/.test(text[end]!)) end++
    }
    chunks.push(text.slice(copied, start), '[redacted]')
    copied = end
    fields.lastIndex = end
  }
  chunks.push(text.slice(copied))
  return chunks.join('').slice(0, MAX_TELEMETRY_TEXT)
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
    // URL-bearing header syntax must remain complete for safe parsing.
    if (value.length > MAX_TELEMETRY_TEXT && /^(location|content-location|referer|link|refresh)$/i.test(name)) return '[redacted oversized URL header]'
    if (/^(location|content-location|referer)$/i.test(name)) return urlValue(value)
    if (/^link$/i.test(name)) return value.replace(/<([^<>]+)>/g, (_match, url: string) => `<${urlValue(url)}>`)
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
