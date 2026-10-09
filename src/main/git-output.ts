/**
 * Helpers for showing what git and its hooks print. Hook output is meant for a terminal, so it can carry colour codes and
 * carriage-return progress lines; in a text panel those would show as junk.
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** CSI sequences (colours, cursor moves) and OSC sequences (window titles, links), which a text panel cannot show. */
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')

export function stripTerminalEscapes(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').split(ESC).join('')
}

/** Plain text for display: no escape sequences, and every kind of line ending becomes a newline. */
export function readableOutput(text: string): string {
  return stripTerminalEscapes(text).split(`${String.fromCharCode(13)}${String.fromCharCode(10)}`).join('\n').split(String.fromCharCode(13)).join('\n')
}

/** Add a chunk to a running transcript, keeping only the last `max` characters. */
export function appendOutput(previous: string, chunk: string, max = 6_000): string {
  const next = previous + readableOutput(chunk)
  return next.length > max ? next.slice(next.length - max) : next
}
