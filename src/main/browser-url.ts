import { parseSafeHttpUrl } from './external-targets.js'

/** Accept address-bar input while keeping explicit protocols and URL safety checks. */
export function parseBrowserAddress(value: string): URL {
  const address = value.trim()
  if (!address) throw new Error('Enter a web address')
  const hasPort = /^(?:[^/?#:\s]+|\[[^\]]+\]):\d+(?=[/?#]|$)/.test(address)
  if (!hasPort && /^[a-z][a-z\d+.-]*:/i.test(address)) return parseSafeHttpUrl(address)

  const parsed = parseSafeHttpUrl(address.startsWith('//') ? `https:${address}` : `https://${address}`)
  const host = parsed.hostname
  // Common LAN/dev hosts use HTTP unless an HTTPS port was explicitly supplied.
  const local = (!host.includes('.') && !host.includes(':')) || host === '[::1]'
    || /\.(?:localhost|local|test|internal)$/.test(host)
    || /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
    || /^\[(?:f[cd][a-f\d]{2}:|fe[89ab][a-f\d]:)/i.test(host)
  if (local) {
    const http = parseSafeHttpUrl(address.startsWith('//') ? `http:${address}` : `http://${address}`)
    if (http.port !== '443' && http.port !== '8443') return http
  }
  return parsed
}
