const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
export const OSC52_MAX_BYTES = 1024 * 1024

function utf8ByteLength(value) {
  let bytes = 0
  for (const char of value) {
    const codePoint = char.codePointAt(0)
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

function decodeBase64Utf8(value) {
  const normalized = value.replace(/\s/g, '')
  if (!normalized || !BASE64_RE.test(normalized) || normalized.length % 4 === 1) return null

  try {
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch (_) {
    return null
  }
}

export function decodeOsc52Payload(data) {
  if (typeof data !== 'string') return null

  const separator = data.indexOf(';')
  if (separator < 0) return null

  const target = data.slice(0, separator)
  const payload = data.slice(separator + 1)
  if (!payload || payload === '?') return null

  // OSC 52's Pc field names the selection target. Claude Code and Windows
  // Terminal use "c" for the clipboard; an empty field is accepted by several
  // terminals as the default clipboard target.
  if (target && !target.includes('c')) return null

  return decodeBase64Utf8(payload)
}

export function registerOsc52ClipboardHandler(term, writeText, options = {}) {
  if (!term?.parser?.registerOscHandler || typeof writeText !== 'function') return null
  const enabled = options.enabled === true
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : OSC52_MAX_BYTES

  return term.parser.registerOscHandler(52, (data) => {
    if (!enabled) return true
    const text = decodeOsc52Payload(data)
    if (text == null) return false
    if (utf8ByteLength(text) > maxBytes) return true

    Promise.resolve(writeText(text)).catch(() => {})
    return true
  })
}

export function updateOscSequenceState(isInsideOsc, chunk) {
  let inside = !!isInsideOsc

  for (let i = 0; i < chunk.length; i++) {
    const char = chunk[i]
    const next = chunk[i + 1]

    if (inside) {
      if (char === '\x07') inside = false
      else if (char === '\x1b' && next === '\\') {
        inside = false
        i++
      }
      continue
    }

    if (char === '\x1b' && next === ']') {
      inside = true
      i++
    }
  }

  return inside
}
