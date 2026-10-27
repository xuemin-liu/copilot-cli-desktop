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

/** Names that fit in `maxChars`, whole, then how many more there are. */
export function listNames(paths: readonly string[], maxChars: number): string {
  const kept: string[] = []
  let used = 0
  for (const path of paths) {
    const next = used + path.length + 2
    if (kept.length > 0 && next > maxChars) break
    kept.push(path.length > 120 ? `…${path.slice(-119)}` : path)
    used = next
  }
  const rest = paths.length - kept.length
  return kept.join(', ') + (rest > 0 ? `, and ${rest} more` : '')
}

export interface CommitPromptInput {
  repoName: string
  branch: string | null
  /** Staged files whose diffs were read. */
  parts: readonly CommitPromptPart[]
  /** Staged files whose diffs were not read (the panel reads a bounded number). They are still named and counted. */
  omitted?: readonly string[]
  /** The status list itself was cut off, so there may be staged files the panel does not know about. */
  listTruncated?: boolean
}

/**
 * A prompt asking Copilot to draft a commit message for the staged files, sharing the budget fairly between them. Every
 * staged file the caller knows about appears either with its diff or in the closing note, with an accurate count, so a
 * message is never drafted from part of a commit without saying so.
 */
export function composeCommitMessagePrompt(input: CommitPromptInput): string {
  const intro = `Write a concise conventional-commit message (a subject under 72 characters, then a short body only if it helps) for these staged changes in \`${input.repoName}\`${input.branch ? ` on branch \`${input.branch}\`` : ''}. Reply with only the message.\n`
  const sections: string[] = []
  // Room for the closing note about files that did not fit.
  let remaining = PROMPT_BUDGET - intro.length - 900
  // Show as many files as can each get a useful share; the rest are listed by name at the end.
  const showable = Math.max(1, Math.min(input.parts.length, Math.floor(remaining / 700)))
  const notes = new Set<string>()
  for (const [index, part] of input.parts.slice(0, showable).entries()) {
    const label = part.path.length > 200 ? `…${part.path.slice(-199)}` : part.path
    const share = Math.floor(remaining / (showable - index))
    const body = bodyFor(part.path, part.diff, share - label.length - 40)
    for (const note of body.notes) notes.add(note)
    const section = `\n### ${label}\n${FENCE}diff\n${body.text}\n${FENCE}\n`
    sections.push(section)
    remaining -= section.length
  }
  const shown = Math.min(showable, input.parts.length)
  const notShown = [...input.parts.slice(shown).map(part => part.path), ...(input.omitted ?? [])]
  const tail = [
    ...notes,
    ...(notShown.length > 0 ? [`${notShown.length} more staged file${notShown.length === 1 ? '' : 's'} not shown: ${listNames(notShown, 400)}.`] : []),
    ...(input.listTruncated ? ['The status list was cut off, so there may be more staged files that are not named here.'] : []),
  ].join(' ')
  return intro + sections.join('') + (tail ? `\n${tail}\n` : '')
}

export interface DiffComment {
  /** `new` for added and context lines (numbered in the new file), `old` for deleted lines. */
  side: 'new' | 'old'
  line: number
  /** The diff line as shown, with its leading +, - or space. Masked and bounded before it is quoted. Empty when `redacted`. */
  quote: string
  /** Captured from inside a private-key block of the diff it came from: never quoted, whatever diff is current later. */
  redacted: boolean
  /** Where the line sits in the new file (`NumberedDiffLine.position`): orders the comments whatever context the diff
   * they came from carried. */
  index: number
  text: string
}

export interface ReviewCommentsPrompt {
  text: string
  /** How many of the comments fit. */
  included: number
  /** The quoted diff lines were left out to make the comments fit. */
  quotesDropped: boolean
}

/** Inclusive line-index ranges of private-key blocks in a diff as shown. A single line from inside such a block has no
 * BEGIN marker of its own, so the block redaction cannot recognise it; the ranges let a caller withhold it at capture. */
export function privateKeyLineRanges(diffText: string): Array<[number, number]> {
  const text = diffText.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const ranges: Array<[number, number]> = []
  for (const match of text.matchAll(PRIVATE_KEY_BLOCK)) {
    const start = match.index ?? 0
    const end = start + Math.max(0, match[0].length - 1)
    const lineOf = (offset: number): number => { let line = 0; for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) line += 1; return line }
    ranges.push([lineOf(start), lineOf(end)])
  }
  return ranges
}

/** A small excerpt around the pointer, with redaction applied before selecting any private-key lines. */
export function composeGitCursorContext(input: {
  folder: string; path: string; staged: boolean; diffText: string; order: number; side: 'new' | 'old'; line: number
}): string {
  const label = (text: string): string => JSON.stringify(text.replace(CONTROL_CHARS, '').slice(0, 1_000))
  const header = `Git panel cursor context (reference for the user's question):\nRepository: ${label(input.folder)}\nFile: ${label(input.path)}\nChange: ${input.staged ? 'staged' : 'working tree'}\nCursor: ${input.side === 'old' ? 'old' : 'new'} line ${input.line}\n`
  if (looksSensitivePath(input.path)) return `${header}(contents withheld: this file looks like it holds secrets)`
  const lines = input.diffText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const ranges = privateKeyLineRanges(input.diffText)
  const start = Math.max(0, input.order - 3)
  const excerpt = lines.slice(start, input.order + 4).map((line, offset) => {
    const index = start + offset
    const safe = ranges.some(([from, to]) => index >= from && index <= to)
      ? '[REDACTED PRIVATE KEY]' : maskSecrets(line.replace(CONTROL_CHARS, '')).text
    return `${index === input.order ? '> ' : '  '}${safe.length > 600 ? `${safe.slice(0, 600)}…` : safe}`
  }).join('\n')
  return `${header}The line marked > is the code at the cursor. Nearby diff lines follow:\n${FENCE}diff\n${excerpt}\n${FENCE}`
}

const MAX_QUOTE_CHARS = 200
const MAX_COMMENT_CHARS = 2_000
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function cleanComment(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim().slice(0, MAX_COMMENT_CHARS)
}

/** `text` in inline code when it has no backtick, otherwise in plain quotes; never altered to fit a fence. */
function inlineQuote(text: string): string {
  return text.includes('`') ? `"${text}"` : `\`${text}\``
}

/**
 * Comments on individual diff lines, numbered, each with the line it points at. Quoted lines get the same protection as a
 * whole diff: a secrets-looking file is never quoted, credential-looking values are masked, and the result stays inside
 * the prompt budget by dropping the quotes first, then trailing comments (saying how many were left out).
 */
export function composeReviewCommentsPrompt(input: { repoName: string; path: string; staged: boolean; comments: readonly DiffComment[] }): ReviewCommentsPrompt {
  const header = `Review comments on \`${input.path}\` (${input.staged ? 'staged' : 'unstaged'} change in \`${input.repoName}\`). Please address each one:\n`
  const withhold = looksSensitivePath(input.path)
  const build = (count: number, quotes: boolean): string => {
    const notes = new Set<string>()
    if (withhold && quotes) notes.add('The changed lines are not quoted because this file looks like it holds secrets.')
    const items = input.comments.slice(0, count).map((comment, index) => {
      const where = `${comment.side === 'old' ? 'Old line' : 'Line'} ${comment.line}`
      let quoted = ''
      if (quotes && !withhold) {
        const masked = comment.redacted ? { text: '[REDACTED PRIVATE KEY]', masked: true } : maskSecrets(comment.quote.replace(CONTROL_CHARS, ''))
        if (masked.masked) notes.add('Values that looked like credentials were replaced with [REDACTED].')
        quoted = ` (${inlineQuote(masked.text.length > MAX_QUOTE_CHARS ? `${masked.text.slice(0, MAX_QUOTE_CHARS)}…` : masked.text)})`
      }
      const body = cleanComment(comment.text) || '(empty comment)'
      return `${index + 1}. ${where}${quoted}:\n   ${body.split('\n').join('\n   ')}\n`
    })
    const dropped = input.comments.length - count
    const tail = [...notes, ...(dropped > 0 ? [`[… ${dropped} more comment${dropped === 1 ? '' : 's'} not included: the prompt box is full]`] : [])]
    return header + items.join('') + (tail.length > 0 ? `\n${tail.join(' ')}\n` : '')
  }
  let quotes = true
  let count = input.comments.length
  let text = build(count, quotes)
  if (text.length > PROMPT_BUDGET) { quotes = false; text = build(count, quotes) }
  while (text.length > PROMPT_BUDGET && count > 0) { count -= 1; text = build(count, quotes) }
  return { text, included: count, quotesDropped: !quotes && !withhold }
}

/** Why the panel's pull did not happen: the branches diverged, local changes were in the way, or a merge is already stopped on conflicts. */
export type ResolvePullSituation = 'diverged' | 'local-changes' | 'conflicts'

export interface ResolvePullPromptInput {
  repoName: string
  /** The repository's absolute folder: the main worktree or a linked one, which may not be the session's own folder. */
  folder: string
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  situation: ResolvePullSituation
  /** What Git printed for the failed pull (redacted by main); empty when there was no pull. */
  output: string
  /** Files Git said local changes would overwrite. */
  blocked: readonly string[]
  /** Files with unresolved conflicts. */
  conflicted: readonly string[]
}

const MAX_OUTPUT_CHARS = 4_000
const MAX_NAMES_CHARS = 1_500

/** A fence longer than any run of backticks in `text`, so the text cannot close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * The task the person would otherwise type in the terminal after a failed pull: pull with a merge and resolve the conflicts. It
 * names the folder, because the selected repository is often not the session's own folder (a worktree session pulling the main
 * worktree), and it rules out what would lose work or rewrite shared history.
 */
export function composeResolvePullPrompt(input: ResolvePullPromptInput): string {
  const upstream = input.upstream ? inlineQuote(input.upstream) : 'its upstream'
  const counts = input.ahead > 0 || input.behind > 0 ? ` (${input.ahead} local commit${input.ahead === 1 ? '' : 's'} not on ${upstream}, ${input.behind} new commit${input.behind === 1 ? '' : 's'} on it)` : ''
  const where = `the Git repository ${inlineQuote(input.repoName)} at ${inlineQuote(input.folder)}`
  const why = input.situation === 'conflicts'
    ? `In ${where}, a merge into ${inlineQuote(input.branch)} has stopped on conflicts.`
    : input.situation === 'local-changes'
      ? `In ${where}, pulling ${upstream} into ${inlineQuote(input.branch)} failed because uncommitted changes would be overwritten${counts}.`
      : `In ${where}, ${inlineQuote(input.branch)} could not be fast-forwarded to ${upstream} because both have new commits${counts}.`
  const steps = [
    'Work in that folder (change to it first if it is not your current folder).',
    input.situation === 'conflicts'
      ? 'Finish the merge that is in progress (`git status` shows it). Do not abort it.'
      : `Pull ${upstream} into ${inlineQuote(input.branch)} with a merge.`,
    'Do not rebase, force, `git reset --hard`, discard changes, or push.',
    'If uncommitted changes are in the way, stop and ask me before stashing, committing or discarding them.',
    'Resolve every conflict, keeping the intent of both sides, and leave no conflict markers.',
    'Run the project\'s quick checks (type check, tests) if it has them.',
    'Commit the merge with Git\'s default message.',
    'Finish with a short note for each conflicted file saying what you kept from each side.',
  ]
  const parts = [`${why}\n\nPlease:\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n`]
  if (input.blocked.length > 0) parts.push(`\nFiles in the way: ${listNames(input.blocked, MAX_NAMES_CHARS)}.\n`)
  if (input.conflicted.length > 0) parts.push(`\nConflicted files: ${listNames(input.conflicted, MAX_NAMES_CHARS)}.\n`)
  const printed = maskSecrets(input.output.replace(/\r\n/g, '\n').replace(CONTROL_CHARS, '').trim()).text
  if (printed !== '') {
    const fitted = fitLines(printed, MAX_OUTPUT_CHARS)
    const body = fitted.omittedLines > 0 ? `${fitted.text}\n[… ${fitted.omittedLines} more line${fitted.omittedLines === 1 ? '' : 's'} not shown]` : fitted.text
    const fence = fenceFor(body)
    parts.push(`\nWhat Git printed:\n${fence}text\n${body}\n${fence}\n`)
  }
  return parts.join('')
}
