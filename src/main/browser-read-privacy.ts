import { sanitizedText, sanitizedUrl } from './browser-privacy.js'
import { CREDENTIAL_PATTERN_SOURCE } from './browser-read-credentials.js'

export const MAX_RESPONSE_BYTES = 256 * 1024
export const MAX_READ_TEXT = 64 * 1024
// Preserve Jira's author objects; authorization and authentication are secrets.
const SECRET_FIELD = /authori[sz]ation|auth(?!or)|token|secret|password|passwd|credential|cookie|csrf|xsrf|api[-_]?key|private[-_]?key|signature|session/i
const JSON_MIME = /^(application\/(?:[\w.-]+\+)?json|text\/json)(?:;|$)/i
// Some APIs label replies as script or text (JSONP). Only XHR/fetch replies qualify, so page scripts stay withheld.
const API_TEXT_MIME = /^(application\/(?:x-)?javascript|text\/javascript|text\/plain)(?:;|$)/i
const JSONP = /^(?:\/\*\*\/)?\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(([\s\S]*)\)\s*;?$/

/** Whether a response's body is worth retrieving: JSON, or a small API reply sent as script or text. */
export function capturableBody(mimeType: string, resourceType = ''): boolean {
  return JSON_MIME.test(mimeType) || (/^(?:XHR|Fetch)$/.test(resourceType) && API_TEXT_MIME.test(mimeType))
}

/** A script or text API reply counts only when it is JSON, or a JSONP callback wrapping JSON. */
function parseApiText(body: string): unknown {
  const text = body.trim()
  try { return JSON.parse(text) as unknown } catch { /* try JSONP */ }
  const wrapped = JSONP.exec(text)
  if (!wrapped) throw new Error('not JSON')
  return JSON.parse(wrapped[1] ?? '') as unknown
}

/** Only structured JSON is exported (JSONP is unwrapped first). HTML/scripts, raw text and binary
 * bodies may contain credentials outside recognizable fields and are intentionally unavailable. */
export function redactBrowserValue(value: unknown): { value: unknown; redacted: boolean; truncated: boolean } {
  let remaining = MAX_READ_TEXT
  let redacted = false
  let truncated = false
  let count = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > 8000 || depth > 32 || remaining <= 0) { truncated = true; return '[truncated]' }
    if (typeof item === 'string') {
      // Filter before truncating. Cutting a credential field in half first can leak it.
      const recognizable = item.length > 8192 ? '' : item.replace(new RegExp(CREDENTIAL_PATTERN_SOURCE, 'gi'), '[redacted]')
        .replace(/\b(api|access|refresh|client|session)\s+(key|token|secret|cookie)(?=\s*[:=])/gi, '$1-$2')
      let clean = item.length > 8192 ? '[unavailable oversized text]' : sanitizedText(recognizable)
      if (clean !== item) redacted = true
      if (item.length > 8192) truncated = true
      if (clean.length > remaining) { clean = clean.slice(0, remaining); truncated = true }
      remaining -= clean.length
      return clean
    }
    if (Array.isArray(item)) {
      if (item.length > 4000) truncated = true
      return item.slice(0, 4000).map(child => visit(child, depth + 1))
    }
    if (item && typeof item === 'object') {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      const entries = Object.entries(item)
      if (entries.length > 4000) truncated = true
      for (const [name, child] of entries.slice(0, 4000)) {
        if (remaining <= 0 || count > 8000) { truncated = true; break }
        const key = String(visit(name, depth + 1))
        if (SECRET_FIELD.test(name)) { result[key] = '[redacted]'; redacted = true }
        else result[key] = visit(child, depth + 1)
      }
      return result
    }
    return typeof item === 'number' || typeof item === 'boolean' || item === null ? item : null
  }
  return { value: visit(value, 0), redacted, truncated }
}

export function readableResponse(body: string, mimeType: string, resourceType = ''): { state: string; data?: unknown; redacted: boolean; truncated: boolean; reason?: string } {
  if (!capturableBody(mimeType, resourceType)) {
    return { state: 'unavailable', reason: 'Only structured JSON is exported (including JSON or JSONP API replies sent as script or text); HTML, page scripts and binary bodies are withheld.', redacted: false, truncated: false }
  }
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    return { state: 'unavailable', reason: 'Response exceeds the 256 KiB capture limit. Partial JSON is not exported.', redacted: false, truncated: true }
  }
  try {
    const parsed = JSON_MIME.test(mimeType) ? JSON.parse(body) as unknown : parseApiText(body)
    if (!parsed || typeof parsed !== 'object') return { state: 'unavailable', reason: 'Raw scalar JSON values are withheld; only structured ticket data is exported.', redacted: false, truncated: false }
    const result = redactBrowserValue(parsed)
    return { state: 'available', data: result.value, redacted: result.redacted, truncated: result.truncated }
  } catch {
    return { state: 'unavailable', reason: JSON_MIME.test(mimeType) ? 'Response is not valid JSON. Raw bodies are not exported.'
      : 'Response is neither JSON nor a JSONP callback wrapping JSON. Raw script and text bodies are not exported.', redacted: false, truncated: false }
  }
}

export function readableUrl(url: string): string { return sanitizedUrl(url) }
