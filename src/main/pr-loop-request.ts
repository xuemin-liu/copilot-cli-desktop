import { parseGithubPullUrl } from './workflow-github.js'

/**
 * What the person asked for in their own message (docs/pr-loops-plan.md), read like a meeting join: a session runs the
 * helper's `pr-start`, and the desktop decides only from the prompt the person typed. A PR comment, a file or the code
 * under review cannot start a loop, because none of them is the person's prompt.
 *
 * Only an explicit command at the start of the message counts, because a fix loop then edits and pushes with the
 * session's permissions and a review loop posts on the PR:
 * - "review PR 287", "please review pull request #287", "can you review https://github.com/o/r/pull/287?"
 * - "fix PR 286", "address the comments on PR 286", "watch PR 286 and fix the review feedback"
 * Not a start: "watch PR 286" (watching alone is not a request to change anything), "please do not review PR 287",
 * "is the review of PR 287 done?", or a request below the first lines of a longer message.
 */
export interface PrLoopRequest { kind: 'review' | 'fix'; number: number; repository: string | null }

const URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?(?=[\s.,;:!?)]|$)/i
const NUMBER = /\b(?:pr|pull\s+request)\s*#?\s*(\d{1,9})\b|#(\d{1,9})\b/i
/** Polite openings that keep the command a command. */
const OPENING = /^(?:(?:hey|hi|ok(?:ay)?|so|now)\b[\s,]*)?(?:(?:please|pls|kindly)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?)?/i
const NEGATION = /\b(?:don'?t|do\s+not|doesn'?t|not|never|no\s+need|stop|cancel|without)\b/i
const FIX_VERB = /\b(?:fix|address|handle|resolve)\b/i

export function prLoopRequest(text: string): PrLoopRequest | null {
  if (typeof text !== 'string') return null
  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? ''
  const line = first.trim().slice(0, 300)
  if (!line || NEGATION.test(line)) return null
  const command = line.replace(OPENING, '')
  const verb = /^(review|fix|address|handle|resolve|watch)\b/i.exec(command)?.[1]?.toLowerCase()
  if (!verb) return null
  let kind: PrLoopRequest['kind']
  if (verb === 'review') kind = 'review'
  else if (verb === 'watch') {
    // Watching becomes a fix loop only when the same command also asks to fix: "watch PR 286 and fix the feedback".
    if (!/\band\s+(?:then\s+)?(?:fix|address|handle|resolve)\b/i.test(command)) return null
    kind = 'fix'
  } else kind = 'fix'
  // A review command that also says fix ("review and fix PR 286") is ambiguous: the person decides by asking again.
  if (kind === 'review' && FIX_VERB.test(command)) return null
  const url = URL.exec(command)?.[0]
  let repository: string | null = null, number: number | null = null
  if (url) {
    try { const pull = parseGithubPullUrl(url.replace(/\/$/, '')); repository = pull.repository; number = pull.number } catch { return null }
  } else {
    const match = NUMBER.exec(command)
    number = match ? Number(match[1] ?? match[2]) : null
  }
  if (!number || !Number.isSafeInteger(number) || number < 1) return null
  return { kind, number, repository }
}
