#!/usr/bin/env node
// Cheap, model-free check for new review feedback on a pull request. Used by the /fix-pr command.
//
//   node pr-poll.mjs <pr> <state-file> [--repo OWNER/REPO] [--marker "<prefix>"] [--invert] [--watch-head]   print NO_CHANGE or JSON with the news (--snapshot always includes the observed boundary)
//   node pr-poll.mjs <pr> <state-file> --init                                       record everything now on the PR as already handled
//   node pr-poll.mjs <pr> <state-file> --mark --through <reviewId>,<inlineId>,<issueId> --head <sha>   record what the last poll showed as handled
//
// Waiting (the watcher):
//   node pr-poll.mjs <pr> <state-file> ... --wait [seconds] [--max <seconds>]
//   Polls every `seconds` (default 60) and EXITS only when there is news (the same output as a normal poll), or after --max seconds
//   with `WAIT_TIMEOUT` so the caller can start it again. Run it as a background command: the caller is woken when it exits, and a
//   quiet minute costs no model turn at all. A failed poll is retried; five failures in a row end it with `ERROR: ...`. Every `gh`
//   call times out after 2 minutes and every poll after 10, so a hung call is a failed poll and --max stays roughly the deadline.
//
// Two modes, for the two sides of a review:
//   author (default)   report feedback from others; the author's own replies start with the marker and are skipped  (/fix-pr)
//   reviewer (--invert) report only comments that start with the marker, i.e. the author's replies; the reviewer's own comments
//                       are skipped. Add --watch-head so a new commit counts as news even with no new comment            (/review-pr)
//
// Needs only Node 18+ and an authenticated `gh`. Reads from GitHub; the only thing it ever writes is the state file, and only
// with --init or --mark. The state file is JSON with maxReviewId, maxInlineId, maxIssueId and headSha (other keys are kept).
// Comments whose body starts with the marker (default "🤖 ") are the author's own replies and are never reported.
//
// What it does NOT see: it reports comments with an id above the handled watermark, and a changed head. Edits to a comment it
// already handled, review-thread resolution and a changed base are not news. Bodies over 8000 characters are cut, and such an
// item has `truncated: true` and `length`. So before deciding anything, read the full current comments with `gh`.
//
// Approvals (author mode): `approvedReview` and `approvalHint` say an approval arrived, for ANY commit. `approvalForHead` is true
// only when one names the current head: a formal APPROVED review whose commit is the head, or an approving comment whose text
// contains the head sha (7+ hex characters of it). Each review and comment carries `commitId` (inline: the commit it was posted on).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined }
const positional = argv.filter((value, index) => !value.startsWith('--') && !['--repo', '--marker', '--through', '--head', '--max', '--wait'].includes(argv[index - 1]))
const [pr, stateFile] = positional
if (!/^\d+$/.test(pr ?? '') || !stateFile) {
  console.error('usage: node pr-poll.mjs <pr> <state-file> [--repo OWNER/REPO] [--marker "<prefix>"] [--init | --mark]')
  process.exit(2)
}
if (flag('--wait')) {
  // The watcher: run this same script (without --wait) every `seconds` until it has something to say, then print that and exit.
  const numberAfter = name => { const value = argv[argv.indexOf(name) + 1] ?? ''; return /^\d+$/.test(value) ? Number(value) : null }
  const seconds = numberAfter('--wait') ?? 60
  const maxSeconds = numberAfter('--max') ?? 0
  const once = argv.filter((value, index) => value !== '--wait' && value !== '--max' && !(['--wait', '--max'].includes(argv[index - 1] ?? '') && /^\d+$/.test(value)))
  const started = Date.now()
  let failures = 0
  for (;;) {
    let output = ''
    try {
      output = execFileSync(process.execPath, [process.argv[1], ...once], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 }).trim()
      failures = 0
    } catch (error) {
      // A network blip or a rate limit is not news; five in a row is.
      if (++failures >= 5) {
        const line = String(error?.stderr || error?.message || error).trim().split(String.fromCharCode(10))[0].trim()
        console.error(line.startsWith('ERROR: ') ? line : `ERROR: ${line}`)
        process.exit(1)
      }
    }
    if (output !== '' && output !== 'NO_CHANGE') { console.log(output); process.exit(0) }
    if (maxSeconds > 0 && Date.now() - started + seconds * 1000 > maxSeconds * 1000) { console.log('WAIT_TIMEOUT'); process.exit(0) }
    await new Promise(resolve => setTimeout(resolve, seconds * 1000))
  }
}

const marker = option('--marker') ?? '\u{1F916} '
const gh = process.env.PR_POLL_GH ?? 'gh'

// A failure is one line, not a stack trace: the caller reads this output, and a missing repo or a gh login problem is the usual cause.
const fail = error => { console.error(`ERROR: ${String(error?.stderr || error?.message || error).trim().split(String.fromCharCode(10))[0].trim()}`); process.exit(1) }
process.on('uncaughtException', fail)

const run = (...args) => execFileSync(gh, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 2 * 60_000 })
/** Every item of a paginated list endpoint, one compact JSON object per line so concatenated pages parse. */
const list = (path, projection) => run('api', '--paginate', path, '--jq', `.[] | ${projection}`)
  .split(/\r?\n/).filter(line => line.trim() !== '').map(line => JSON.parse(line))

const repo = option('--repo') ?? run('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner').trim()
const meta = JSON.parse(run('pr', 'view', pr, '--repo', repo, '--json', 'state,headRefOid,baseRefName,baseRefOid'))
const reviews = list(`repos/${repo}/pulls/${pr}/reviews`, '{id, state, user: .user.login, body, commitId: .commit_id, url: .html_url}')
// An inline comment's commit_id moves with the PR head; original_commit_id is the commit it was posted on.
const inline = list(`repos/${repo}/pulls/${pr}/comments`, '{id, path, line, user: .user.login, body, commitId: .original_commit_id, inReplyTo: .in_reply_to_id, url: .html_url}')
const issue = list(`repos/${repo}/issues/${pr}/comments`, '{id, user: .user.login, body, url: .html_url}')

const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')) : {}
const top = items => items.reduce((highest, item) => Math.max(highest, item.id), 0)
const now = { maxReviewId: top(reviews), maxInlineId: top(inline), maxIssueId: top(issue), headSha: meta.headRefOid }

if (flag('--init') || flag('--mark')) {
  // --mark never lowers a recorded id, so it is safe to run twice. `--through` records what the last poll showed ("highest" in its
  // output), so feedback that arrived while it was being handled is still reported by the next poll.
  const keys = ['maxReviewId', 'maxInlineId', 'maxIssueId']
  const through = option('--through')?.split(',').map(Number)
  if (flag('--mark') && (!through || through.length !== 3 || through.some(value => !Number.isSafeInteger(value) || value < 0))) {
    console.error('--through takes <reviewId>,<inlineId>,<issueId>')
    process.exit(2)
  }
  if (flag('--mark') && !/^[a-f0-9]{40,64}$/i.test(option('--head') ?? '')) {
    console.error('--mark requires the full assessed commit SHA in --head')
    process.exit(2)
  }
  const target = Object.fromEntries(keys.map((key, index) => [key, through?.[index] ?? now[key]]))
  const next = { ...state }
  for (const key of keys) next[key] = flag('--mark') ? Math.max(state[key] ?? 0, target[key]) : now[key]
  // The head recorded is the one the caller names (the commit it actually handled), not whatever the PR points at by now.
  next.headSha = option('--head') ?? now.headSha
  const temporary = stateFile + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, stateFile)
  } finally { rmSync(temporary, { force: true }) }
  console.log(JSON.stringify({ recorded: { maxReviewId: next.maxReviewId, maxInlineId: next.maxInlineId, maxIssueId: next.maxIssueId, headSha: next.headSha } }))
  process.exit(0)
}

const marked = item => (item.body ?? '').startsWith(marker)
// Author mode skips the marked comments (the author's own replies); reviewer mode keeps only them.
const own = flag('--invert') ? item => !marked(item) : marked
const CLIP = 8000
const fresh = (items, key) => items.filter(item => item.id > (state[key] ?? 0) && !own(item))
// An empty COMMENTED review is the wrapper GitHub creates around inline comments and replies; the comments themselves are reported.
const newReviews = fresh(reviews, 'maxReviewId').filter(item => !(item.state === 'COMMENTED' && (item.body ?? '').trim() === ''))
const newInline = fresh(inline, 'maxInlineId')
const newIssue = fresh(issue, 'maxIssueId')

const headChanged = state.headSha !== undefined && state.headSha !== meta.headRefOid
const open = meta.state === 'OPEN'
if (!flag('--snapshot') && open && newReviews.length === 0 && newInline.length === 0 && newIssue.length === 0 && !(flag('--watch-head') && headChanged)) {
  console.log('NO_CHANGE')
  process.exit(0)
}

// Only a hint: the model reads the comment and decides. A formal APPROVED review is certain.
const wording = /\b(approved?|lgtm|looks good to me)\b/i
// In reviewer mode an approval is not something the author gives, so the hint is only about author mode.
const approving = item => item.state === 'APPROVED'
  || (wording.test(item.body ?? '') && !/\b(not|n't|cannot|can't|no longer)\s+(yet\s+)?approv/i.test(item.body ?? ''))
const author = !flag('--invert')
const approvalHint = author && [...newReviews, ...newInline, ...newIssue].some(approving)
// The approval must name this head: a formal review on it, or the sha (7+ hex characters of it) in the approving text.
const namesHead = item => (item.body?.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).some(token => meta.headRefOid.startsWith(token.toLowerCase()))
const approvalForHead = author && [...newReviews, ...newInline, ...newIssue].some(item => approving(item)
  && ((item.state === 'APPROVED' && item.commitId === meta.headRefOid) || namesHead(item)))
const shape = item => (item.body ?? '').length > CLIP
  ? { ...item, body: `${item.body.slice(0, CLIP)}\n[cut at ${CLIP} characters: read the full text before deciding]`, truncated: true, length: item.body.length }
  : { ...item, body: item.body ?? '' }
console.log(JSON.stringify({
  prState: meta.state, headSha: meta.headRefOid, previousHead: state.headSha ?? null, headChanged, baseRef: meta.baseRefName, baseSha: meta.baseRefOid,
  approvedReview: newReviews.some(item => item.state === 'APPROVED'), approvalHint, approvalForHead,
  newReviews: newReviews.map(shape), newInline: newInline.map(shape), newIssue: newIssue.map(shape), highest: now,
}, null, 2))
