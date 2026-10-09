import { redactDiagnosticText } from './desktop-diagnostics.js'
import type { GitDiffView } from './git-types.js'

/**
 * Text the Git panel puts in the prompt box. `promptInsertText` hard-slices at 12,000 characters, so anything longer would
 * lose its tail, including a truncation marker. The panel therefore stays under this budget itself, marker included.
 */
export const PROMPT_BUDGET = 11_000

const SENSITIVE_PATH = /(^|\/)\.env(\.|$)|\.(pem|key|pfx|p12|keystore|jks)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|(^|\/)(secrets?|credentials?)(\.|\/|$)|(^|\/)\.(npmrc|netrc|pgpass)$/i

/** Files whose contents are secrets by convention. They are named but never sent. */
export function looksSensitivePath(path: string): boolean {
  return SENSITIVE_PATH.test(path.replace(/\\/g, '/'))
}

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g

/** Replace values that look like credentials. Not a guarantee: it catches the common shapes, not every secret. */
export function maskSecrets(text: string): { text: string; masked: boolean } {
  const masked = redactDiagnosticText(text.replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]'))
  return { text: masked, masked: masked !== text }
}

/** Keep whole lines up to `maxChars`, and say how much was left out. */
export function fitLines(text: string, maxChars: number): { text: string; omittedLines: number } {
  if (text.length <= maxChars) return { text, omittedLines: 0 }
  const lines = text.split('\n')
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break
    kept.push(line)
    used += line.length + 1
  }
  return { text: kept.join('\n'), omittedLines: lines.length - kept.length }
}

const FENCE = '```'

function describe(diff: GitDiffView): string | null {
  if (diff.kind === 'binary') return '(binary file, no text diff)'
  if (diff.kind === 'directory') return '(untracked folder)'
  if (diff.kind === 'too-large') return '(file too large to show)'
  if (diff.kind === 'empty') return '(no textual change)'
  return null
}

interface Body { text: string; notes: string[] }

function bodyFor(path: string, diff: GitDiffView, budget: number): Body {
  if (looksSensitivePath(path)) return { text: '(contents withheld: this file looks like it holds secrets)', notes: [] }
  const plain = describe(diff)
  if (plain) return { text: plain, notes: [] }
  const masked = maskSecrets(diff.text)
  const notes: string[] = []
  if (masked.masked) notes.push('Values that looked like credentials were replaced with [REDACTED].')
  const marker = (omitted: number): string => `\n[… diff truncated: ${omitted} more line${omitted === 1 ? '' : 's'} not shown]`
  // Leave room for a marker whose number has up to six digits.
  const fitted = fitLines(masked.text.replace(/\r\n/g, '\n').replace(/\n$/, ''), Math.max(0, budget - marker(999_999).length))
  const truncated = fitted.omittedLines > 0 || diff.truncated
  const text = fitted.omittedLines > 0 ? fitted.text + marker(fitted.omittedLines) : truncated ? `${fitted.text}\n[… diff truncated: the file is larger than the panel reads]` : fitted.text
  return { text, notes }
}

export function composeDiffPrompt(input: { repoName: string; path: string; staged: boolean; diff: GitDiffView }): string {
  const header = `Here is the ${input.staged ? 'staged' : 'unstaged'} change to \`${input.path}\` in \`${input.repoName}\`:\n\n${FENCE}diff\n`
  const footer = (notes: string[]): string => `\n${FENCE}${notes.length ? `\n${notes.join(' ')}` : ''}\n`
  // The footer's notes are short; reserve room for them before fitting the body.
  const body = bodyFor(input.path, input.diff, PROMPT_BUDGET - header.length - 200)
  return header + body.text + footer(body.notes)
}

export interface CommitPromptPart {
  path: string
  diff: GitDiffView
}

/** A prompt asking Copilot to draft a commit message for the staged files, sharing the budget fairly between them. */
export function composeCommitMessagePrompt(input: { repoName: string; branch: string | null; parts: readonly CommitPromptPart[] }): string {
  const intro = `Write a concise conventional-commit message (a subject under 72 characters, then a short body only if it helps) for these staged changes in \`${input.repoName}\`${input.branch ? ` on branch \`${input.branch}\`` : ''}. Reply with only the message.\n`
  const sections: string[] = []
  // Room for the closing note about files that did not fit.
  let remaining = PROMPT_BUDGET - intro.length - 420
  // Show as many files as can each get a useful share; the rest are listed by name at the end.
  const showable = Math.max(1, Math.min(input.parts.length, Math.floor(remaining / 700)))
  const notes = new Set<string>()
  for (const [index, part] of input.parts.slice(0, showable).entries()) {
    const label = part.path.length > 200 ? `…${part.path.slice(-199)}` : part.path
    const share = Math.floor(remaining / (showable - index))
    const body = bodyFor(part.path, part.diff, share - label.length - 40)
    for (const note of body.notes) notes.add(note)
    const section = `
### ${label}
${FENCE}diff
${body.text}
${FENCE}
`
    sections.push(section)
    remaining -= section.length
  }
  const shown = Math.min(showable, input.parts.length)
  const left = input.parts.length - shown
  const tail = [...notes].join(' ') + (left > 0 ? `${notes.size ? ' ' : ''}${left} more staged file${left === 1 ? '' : 's'} not shown: ${input.parts.slice(shown).map(part => part.path).join(', ').slice(0, 300)}` : '')
  return intro + sections.join('') + (tail ? `\n${tail}\n` : '')
}
