// Post a file-level inline approval of the exact head and base the reviewer assessed.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [repo, number, head, base, noteFile] = process.argv.slice(2)
const sha = /^[0-9a-f]{40,64}$/
if (process.argv.length !== 7 || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number)
  || !sha.test(head) || !sha.test(base)) {
  throw new Error('Usage: pr-approve.mjs OWNER/REPO PR REVIEWED_HEAD REVIEWED_BASE VALIDATION_FILE')
}
const note = readFileSync(noteFile, 'utf8').replace(/^\uFEFF/, '').trim()
if (!note || note.length > 16000) throw new Error('Supply a concise validation note and any limits')
const api = (args, input) => execFileSync('gh', ['api', ...args], { encoding: 'utf8', input, timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
const root = 'repos/' + repo + '/pulls/' + number
const body = 'Approved at ' + head + '\n\n' + note + '\n\nReviewed base: ' + base
const actor = Number(api(['user', '--jq', '.id']))
const existing = api([root + '/comments', '--paginate', '--jq', '.[] | {id, body, original_commit_id, user: .user.id}'])
  .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  .find(comment => comment.user === actor && comment.original_commit_id === head && comment.body === body)
const path = api([root + '/files?per_page=1', '--jq', '.[0].filename // empty']).trim()
if (!path) throw new Error('The PR has no changed file for an inline approval')
const pull = JSON.parse(api([root, '--jq', '{state, head: .head.sha, base: .base.sha}']))
if (pull.state !== 'open' || pull.head !== head || pull.base !== base) throw new Error('PR closed or changed. Reassess before approving.')
const posted = existing ?? JSON.parse(api([root + '/comments', '--method', 'POST', '--input', '-'],
  JSON.stringify({ body, commit_id: head, subject_type: 'file', path })))
const confirmed = JSON.parse(api(['repos/' + repo + '/pulls/comments/' + posted.id]))
if (confirmed.original_commit_id !== head || confirmed.body !== body || confirmed.user?.id !== actor) {
  throw new Error('Inline approval could not be verified. Reconcile on GitHub before retrying.')
}
console.log(JSON.stringify({ id: confirmed.id, url: confirmed.html_url, head, base }))
