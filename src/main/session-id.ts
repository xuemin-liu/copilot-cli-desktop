/**
 * Grammar for a `copilot` session identifier, used to guard the boundary
 * where an id crosses from untrusted PTY output (or persisted tab state)
 * into a command-line argument. Requiring the first character to be
 * alphanumeric guarantees a validated id can never be mistaken for an
 * option flag, which always begins with '-'.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}
