import { parseSafeHttpUrl } from './external-targets.js'

/** Accept address-bar input while keeping explicit protocols and URL safety checks. */
export function parseBrowserAddress(value: string): URL {
  const address = value.trim()
  if (!address) throw new Error('Enter a web address')
  const hasPort = /^(?:[^/?#:\s]+|\[[^\]]+\]):\d+(?=[/?#]|$)/.test(address)
  if (!hasPort && /^[a-z][a-z\d+.-]*:/i.test(address)) return parseSafeHttpUrl(address)

  const parsed = parseSafeHttpUrl(address.startsWith('//') ? `https:${address}` : `https://${address}`)
  const host = parsed.hostname
  // Local HTTP dev servers remain convenient; named domains default to HTTPS.
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)) {
    return parseSafeHttpUrl(address.startsWith('//') ? `http:${address}` : `http://${address}`)
  }
  return parsed
}
