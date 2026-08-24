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

/**
 * Best-effort extraction of a `copilot` session id from pty output, so a tab
 * can auto-resume with `--resume=<id>` next time it opens. UNVERIFIED against
 * the real CLI's actual banner/log text — adjust these patterns once the
 * `copilot` binary is available to observe real output.
 *
 * The capture groups below intentionally allow a leading '-' (matching
 * whatever id-shaped text appears in the output) so `isValidSessionId` can
 * reject it explicitly rather than by accident of the regex. An id captured
 * from untrusted terminal output must never be trusted to be safe for a
 * command line without that separate check — see resume-args.ts.
 */
const SESSION_ID_PATTERNS: readonly RegExp[] = [
  /\bsession[\s_-]?id\b\s*[:=]\s*([A-Za-z0-9._-]{4,64})/i,
  /\bresume(?:\s+this\s+session)?\s+with\b[^\n]*--resume[= ]([A-Za-z0-9._-]{4,64})/i,
]

export function extractSessionId(chunk: string): string | null {
  for (const pattern of SESSION_ID_PATTERNS) {
    const match = pattern.exec(chunk)
    if (match?.[1] && isValidSessionId(match[1])) return match[1]
  }
  return null
}
