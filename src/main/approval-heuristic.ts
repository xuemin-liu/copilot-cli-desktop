import { isValidSessionId } from './session-id.js'

/**
 * HEURISTIC, NOT A PROTOCOL. GitHub Copilot CLI does not publish a structured
 * event stream for approval prompts (unlike, say, a JSON event line a desktop
 * app could parse reliably). This module does a best-effort regex scan of raw
 * pty output chunks for text patterns that resemble an approval prompt, so the
 * desktop app can badge a session tab as "needs approval" and raise a
 * notification. It WILL both miss real prompts (false negative) and misfire on
 * unrelated output that merely resembles a prompt (false positive). Treat the
 * resulting badge as a hint, not a guarantee — verify by re-checking `copilot
 * --help` / the CLI's actual prompt copy against these patterns if this stops
 * matching in practice.
 */
const APPROVAL_PATTERNS: readonly RegExp[] = [
  /\ballow\b[^\n]{0,80}\?\s*$/im,
  /\bapprove\b[^\n]{0,80}\?\s*$/im,
  /\bdo you want to (proceed|continue|allow)\b/i,
  /\[y\/n\]\s*$/im,
  /\(y\/n\)\s*$/im,
  /press\s+enter\s+to\s+(approve|allow|continue)/i,
  /requesting permission/i,
  /needs your approval/i,
  /waiting for approval/i,
]

export function detectApprovalPrompt(chunk: string): boolean {
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(chunk))
}

const SESSION_ID_PATTERNS: readonly RegExp[] = [
  /\bsession[\s_-]?id\b\s*[:=]\s*([A-Za-z0-9._-]{4,64})(?=\s|\u001b)/i,
  /\bresume(?:\s+this\s+session)?\s+with\b[^\n]*--resume[= ]([A-Za-z0-9._-]{4,64})(?=\s|\u001b)/i,
]

/** Best-effort fallback for CLI versions that cannot accept --session-id. */
export function extractSessionId(chunk: string): string | null {
  for (const pattern of SESSION_ID_PATTERNS) {
    const candidate = pattern.exec(chunk)?.[1]
    if (candidate && isValidSessionId(candidate)) return candidate
  }
  return null
}
