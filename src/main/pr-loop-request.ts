import { parseGithubPullUrl } from './workflow-github.js'

/**
 * What the person asked for in their own message (docs/pr-loops-plan.md, Phase 5), read like a meeting join: a session
 * runs the helper's `pr-start`, and the desktop decides only from the prompt the person typed. A PR comment, a file or
 * the code under review cannot start a loop, because none of them is the person's prompt.
 *
 * - "review PR 287", "please review pull request #287", "review https://github.com/o/r/pull/287"
 * - "watch PR 286 and fix the review feedback", "fix PR 286", "address the comments on PR 286"
 */
export interface PrLoopRequest { kind: 'review' | 'fix'; number: number; repository: string | null }

const URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?(?=[\s.,;:!?)]|$)/i
const NUMBER = /\b(?:pr|pull\s+request)\s*#?\s*(\d{1,9})\b|#(\d{1,9})\b/i
const FIX = /\b(?:fix(?:es|ing)?|address(?:es|ing)?|watch(?:es|ing)?|handle|resolve)\b/i
const REVIEW = /\breview(?:s|ing)?\b/i

export function prLoopRequest(text: string): PrLoopRequest | null {
  if (typeof text !== 'string') return null
  // Only the first lines count, as for a meeting join: a long pasted text is not a request.
  const line = text.split(/\r?\n/).slice(0, 3).join(' ').slice(0, 400)
  const url = URL.exec(line)?.[0]
  let repository: string | null = null, number: number | null = null
  if (url) {
    try { const pull = parseGithubPullUrl(url.replace(/\/$/, '')); repository = pull.repository; number = pull.number } catch { return null }
  } else {
    const match = NUMBER.exec(line)
    number = match ? Number(match[1] ?? match[2]) : null
  }
  if (!number || !Number.isSafeInteger(number) || number < 1) return null
  // "fix" wins over "review" when both appear ("fix the review feedback on PR 286").
  const kind = FIX.test(line) ? 'fix' : REVIEW.test(line) ? 'review' : null
  return kind ? { kind, number, repository } : null
}
