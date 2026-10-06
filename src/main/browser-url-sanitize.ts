// No imports: the renderer bundles this file (through the console formatter), so it must not reach Node modules.
export const SENSITIVE_QUERY = /auth|token|secret|api[-_]?key|csrf|xsrf|session|credential|password|signature|^sig$|^key$|^code$|^state$/i
export const MAX_TELEMETRY_TEXT = 8192

/** Telemetry only: never use the redacted URL to navigate or match overrides. */
export function sanitizedUrl(value: string): string {
  // Reject oversized URLs intact: slicing through userinfo or a query field
  // could turn a credential into an ordinary-looking, unredacted URL prefix.
  if (value.length > MAX_TELEMETRY_TEXT) return '[redacted oversized URL]'
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
