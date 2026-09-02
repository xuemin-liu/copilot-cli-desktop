const MAX_CLIPBOARD_BYTES = 1_000_000
const MAX_BASE64_LENGTH = Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4
// The end-of-string branch removes an OSC 52 command whose terminator was
// lost when PtySession truncated an oversized backlog line. Leaving that
// opener in replay text would keep xterm's stateful parser inside OSC mode and
// swallow every later backlog/live byte until another BEL or ST arrived.
const OSC52_COMMAND = /\u001b\]52;[^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b)|$)/g

export class ClipboardWriteGate {
  private authorizedUntil = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly lifetimeMs = 5_000,
  ) {}

  authorize(): void {
    this.authorizedUntil = this.now() + this.lifetimeMs
  }

  consumeDecodedWrite(decoded: string | null): decoded is string {
    if (decoded === null) return false
    const allowed = this.authorizedUntil > 0 && this.now() <= this.authorizedUntil
    this.authorizedUntil = 0
    return allowed
  }

  clear(): void {
    this.authorizedUntil = 0
  }
}

/** Remove historical clipboard commands before replaying a terminal backlog. */
export function stripOsc52Commands(text: string): string {
  return text.replace(OSC52_COMMAND, '')
}

/**
 * Decode an OSC 52 system-clipboard write (`c;<base64>`). Clipboard reads
 * (`?`) and writes to other terminal selections are deliberately ignored.
 */
export function decodeOsc52ClipboardWrite(data: string): string | null {
  const separator = data.indexOf(';')
  if (separator === -1) return null

  const selection = data.slice(0, separator)
  const encoded = data.slice(separator + 1)
  if ((selection !== '' && selection !== 'c') || encoded === '' || encoded === '?') return null
  if (encoded.length > MAX_BASE64_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null

  const remainder = encoded.length % 4
  if (remainder === 1) return null
  const padded = `${encoded}${'='.repeat((4 - remainder) % 4)}`

  try {
    const binary = atob(padded)
    if (binary.length > MAX_CLIPBOARD_BYTES) return null
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
