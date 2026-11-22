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
export interface PrLoopRequest { kind: 'review' | 'fix'
  /**
   * null: no number was given. "review my PR" means the person's own open PR in this project (several: they choose);
   * "fix my PR" / "watch this PR and fix the review feedback" means the PR of the branch this conversation is on.
   */
  number: number | null; repository: string | null }
/** "my PR", "this PR", "the current pull request": a PR named without a number. */
const UNNUMBERED = /\b(?:my|this|the\s+current)\s+(?:pr|pull\s+request)\b/i
/** "review new PRs in this repo" turns the new-PR queue on; "stop reviewing new PRs" turns it off. */
export interface PrQueueRequest { kind: 'queue-on' | 'queue-off' }

const QUEUE_ON = /^(?:review|watch(?:\s+for)?(?:\s+and\s+review)?)\s+(?:all\s+|any\s+|every\s+)?(?:new|incoming|upcoming|future)\s+(?:prs?|pull\s+requests?)\b(?:\s+(?:in|for|on)\s+(?:this|the)\s+(?:repo(?:sitory)?|project))?\s*[.!]?$/i
const QUEUE_OFF = /^(?:stop|don'?t\s+keep|no\s+longer)\s+(?:reviewing|watching(?:\s+for)?)\s+(?:all\s+|any\s+)?(?:new|incoming)\s+(?:prs?|pull\s+requests?)\b(?:\s+(?:in|for|on)\s+(?:this|the)\s+(?:repo(?:sitory)?|project))?\s*[.!]?$/i

/** The whole message, one short line, is the request: anything more is not read as consent. */
export function prQueueRequest(text: string): PrQueueRequest | null {
  if (typeof text !== 'string' || text.length > 200) return null
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length !== 1) return null
  const command = lines[0]!.replace(OPENING, '')
  if (QUEUE_OFF.test(command)) return { kind: 'queue-off' }
  if (NEGATION.test(command)) return null
  return QUEUE_ON.test(command) ? { kind: 'queue-on' } : null
}

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
  // The whole message is the person's consent, not just its first line: a "do not" anywhere withdraws it, and the
  // message must name exactly one pull request, so "watch PR 286 and fix PR 287" is not read as either.
  // A message too long to read whole is no request: a restriction past any cut could be missed.
  if (text.length > 2000) return null
  if (!line || NEGATION.test(text)) return null
  // One PR only: URLs count by repository and number; bare numbers must agree with them, and with each other.
  const urls = new Set<string>(), bare = new Set<number>()
  for (const match of text.matchAll(/https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/pull\/(\d+)/gi)) urls.add(`${match[1]!.toLowerCase()}#${Number(match[2])}`)
  for (const match of text.replace(/https:\/\/\S+/gi, ' ').matchAll(/\b(?:pr|pull\s+request)\s*#?\s*(\d{1,9})\b|#(\d{1,9})\b/gi)) bare.add(Number(match[1] ?? match[2]))
  if (urls.size > 1) return null
  const urlNumber = urls.size ? Number([...urls][0]!.split('#')[1]) : null
  const command = line.replace(OPENING, '')
  // No number anywhere, and the command names "my PR" or "this PR" instead.
  const unnumbered = urlNumber === null && bare.size === 0 && UNNUMBERED.test(command)
  // "fix my PR and PR 12" names two PRs.
  if (!unnumbered && UNNUMBERED.test(command)) return null
  if (!unnumbered && (urlNumber !== null ? [...bare].some((n) => n !== urlNumber) : bare.size !== 1)) return null
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
  if (unnumbered) {
    // A review needs the person's own PRs ("review my PR"): "review this PR" names nothing the desktop can find.
    if (kind === 'review' && !/\bmy\s+(?:pr|pull\s+request)\b/i.test(command)) return null
    return { kind, number: null, repository: null }
  }
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
