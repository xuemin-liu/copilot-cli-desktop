const MAX_CLIPBOARD_BYTES = 1_000_000
const MAX_BASE64_LENGTH = Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4
const OSC52_PREFIX = '\u001b]52;'
const OSC_BEL = '\u0007'
const OSC_ST = '\u001b\\'
const MAX_OSC52_SEQUENCE_LENGTH = OSC52_PREFIX.length + MAX_BASE64_LENGTH + 4
export const SYNCHRONIZED_OUTPUT_START = '\u001b[?2026h'
// The end-of-string branch removes an OSC 52 command whose terminator was
// lost when PtySession truncated an oversized backlog line. Leaving that
// opener in replay text would keep xterm's stateful parser inside OSC mode and
// swallow every later backlog/live byte until another BEL or ST arrived.
const OSC52_COMMAND = /\u001b\]52;[^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b)|$)/g

/** Remove historical clipboard commands before replaying a terminal backlog. */
export function stripOsc52Commands(text: string): string {
  return text.replace(OSC52_COMMAND, '')
}

function partialPrefixLength(text: string): number {
  for (let length = Math.min(OSC52_PREFIX.length - 1, text.length); length > 0; length -= 1) {
    if (OSC52_PREFIX.startsWith(text.slice(-length))) return length
  }
  return 0
}

/**
 * Places synchronized-output mode in the same xterm write as a live OSC 52
 * clipboard command. Calling terminal.write() from inside xterm's OSC handler
 * queues the mode change behind the rest of the current PTY chunk, which can
 * expose Copilot's temporary first-copy frame at xterm's render-yield boundary.
 */
export class Osc52ClipboardSynchronizer {
  private pending = ''

  constructor(private readonly prepareClipboardCopy: () => boolean) {}

  push(data: string): string {
    const input = this.pending + data
    this.pending = ''
    let output = ''
    let cursor = 0

    while (cursor < input.length) {
      const opener = input.indexOf(OSC52_PREFIX, cursor)
      if (opener === -1) {
        const partialLength = partialPrefixLength(input.slice(cursor))
        const emitEnd = input.length - partialLength
        output += input.slice(cursor, emitEnd)
        this.pending = input.slice(emitEnd)
        break
      }

      output += input.slice(cursor, opener)
      let terminatorStart = -1
      let terminatorEnd = -1
      let scan = opener + OSC52_PREFIX.length
      for (; scan < input.length; scan += 1) {
        if (input[scan] === OSC_BEL) {
          terminatorStart = scan
          terminatorEnd = scan + 1
          break
        }
        if (input[scan] !== '\u001b') continue
        if (scan + 1 >= input.length) break
        if (input.slice(scan, scan + OSC_ST.length) === OSC_ST) {
          terminatorStart = scan
          terminatorEnd = scan + OSC_ST.length
          break
        }

        // A different escape aborts this malformed OSC sequence. Preserve it
        // and scan again from the escape in case it starts another OSC 52.
        output += input.slice(opener, scan)
        cursor = scan
        break
      }

      if (terminatorStart !== -1) {
        const payload = input.slice(opener + OSC52_PREFIX.length, terminatorStart)
        if (decodeOsc52ClipboardWrite(payload) !== null && this.prepareClipboardCopy()) {
          output += SYNCHRONIZED_OUTPUT_START
        }
        output += input.slice(opener, terminatorEnd)
        cursor = terminatorEnd
        continue
      }

      if (cursor === scan && scan < input.length) continue

      const incomplete = input.slice(opener)
      if (incomplete.length > MAX_OSC52_SEQUENCE_LENGTH) {
        // Do not retain unbounded malformed terminal output. xterm will handle
        // the oversized OSC sequence normally, without the copy workaround.
        output += incomplete
      } else {
        this.pending = incomplete
      }
      break
    }

    return output
  }
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
