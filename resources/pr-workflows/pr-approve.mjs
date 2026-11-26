#!/usr/bin/env node
// Post an explicit, verified approval of the exact (head, base) revision assessed on GitHub, Gitea/Forgejo, or GitLab.
//
//   node pr-approve.mjs <OWNER/REPO-or-PR-URL> <PR> <REVIEWED_HEAD> <REVIEWED_BASE> <VALIDATION_FILE> [--pr-url URL] [--origin URL] [--forge github|gitea|gitlab]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  forgeFetchJson,
  readForgeCredentials,
  resolveForgeEndpoint,
  SHA_RE,
} from './pr-forge.mjs'

async function main() {
  const argv = process.argv.slice(2)
  const VALUE_OPTS = new Set(['--origin', '--forge', '--pr-url', '--allow-http-origin'])
  const option = (name) => {
    const idx = argv.indexOf(name)
    return idx >= 0 ? argv[idx + 1] : undefined
  }
  const positional = argv.filter((val, idx) => !val.startsWith('--') && !VALUE_OPTS.has(argv[idx - 1]))
  const [target, number, rawHead, rawBase, noteFile] = positional

  if (positional.length !== 5 || !/^[1-9]\d*$/.test(number ?? '') || !SHA_RE.test(rawHead ?? '') || !SHA_RE.test(rawBase ?? '')) {
    throw new Error('Usage: pr-approve.mjs <OWNER/REPO-or-PR-URL> <PR> <REVIEWED_HEAD> <REVIEWED_BASE> <VALIDATION_FILE>')
  }
  const head = rawHead.toLowerCase()
  const base = rawBase.toLowerCase()
  const note = readFileSync(noteFile, 'utf8').replace(/^\uFEFF/, '').trim()
  if (!note || note.length > 16000) throw new Error('Supply a concise validation note and any limits')

  const isUrlTarget = /^https?:\/\//i.test(target)
  const explicitPrUrl = option('--pr-url')
  const endpoint = resolveForgeEndpoint({
    prInput: isUrlTarget ? target : number,
    repoOption: isUrlTarget ? undefined : target,
    prUrlOption: explicitPrUrl || (isUrlTarget ? target : undefined),
    originOption: option('--origin'),
    forgeOption: option('--forge'),
    allowHttpOriginOption: option('--allow-http-origin'),
  })
  if (endpoint.prNumber !== Number(number)) {
    throw new Error(`Conflicting PR numbers: ${endpoint.prNumber} vs ${number}`)
  }

  const body = `Approved at ${head}\n\n${note}\n\nReviewed base: ${base}`

  if (endpoint.forge === 'github') {
    const gh = process.env.PR_POLL_GH || 'gh'
    const hostArgs = endpoint.hostname && endpoint.hostname !== 'github.com' && !process.env.PR_POLL_GH
      ? ['--hostname', endpoint.hostname]
      : []
    const api = (args, input) =>
      execFileSync(gh, ['api', ...hostArgs, ...args], { encoding: 'utf8', input, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
    const root = `repos/${endpoint.repoPath}/pulls/${endpoint.prNumber}`
    const actor = Number(api(['user', '--jq', '.id']))
    const existing = api([`${root}/comments`, '--paginate', '--jq', '.[] | {id, body, original_commit_id, user: .user.id}'])
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((comment) => comment.user === actor && String(comment.original_commit_id).toLowerCase() === head && comment.body === body)
    const path = api([`${root}/files?per_page=1`, '--jq', '.[0].filename // empty']).trim()
    if (!path) throw new Error('The PR has no changed file for an inline approval')
    const pull = JSON.parse(api([root, '--jq', '{state, head: .head.sha, base: .base.sha}']))
    if (pull.state !== 'open' || String(pull.head).toLowerCase() !== head || String(pull.base).toLowerCase() !== base) {
      throw new Error('PR closed or changed. Reassess before approving.')
    }
    const posted = existing ?? JSON.parse(
      api([`${root}/comments`, '--method', 'POST', '--input', '-'], JSON.stringify({ body, commit_id: head, subject_type: 'file', path })),
    )
    const confirmed = JSON.parse(api([`repos/${endpoint.repoPath}/pulls/comments/${posted.id}`]))
    if (String(confirmed.original_commit_id).toLowerCase() !== head || confirmed.body !== body || confirmed.user?.id !== actor) {
      throw new Error('Inline approval could not be verified. Reconcile on GitHub before retrying.')
    }
    console.log(JSON.stringify({ id: confirmed.id, kind: 'inline', url: confirmed.html_url, head, base }))
    return
  }

  const cred = readForgeCredentials(endpoint)
  if (!cred) {
    throw new Error(`No credentials available for ${endpoint.httpOrigin} (configure Git credentials or forge token).`)
  }

  if (endpoint.forge === 'gitea') {
    const repoApi = `/api/v1/repos/${endpoint.repoPath}`
    const [{ data: actor }, { data: pull }] = await Promise.all([
      forgeFetchJson(endpoint, '/api/v1/user', { cred }),
      forgeFetchJson(endpoint, `${repoApi}/pulls/${endpoint.prNumber}`, { cred }),
    ])
    if (pull.merged || String(pull.state).toLowerCase() !== 'open' || String(pull.head?.sha).toLowerCase() !== head || String(pull.base?.sha).toLowerCase() !== base) {
      throw new Error('PR closed or changed on Gitea/Forgejo. Reassess before approving.')
    }
    const { data: reviews } = await forgeFetchJson(endpoint, `${repoApi}/pulls/${endpoint.prNumber}/reviews?limit=50`, { cred })
    const existing = Array.isArray(reviews)
      ? reviews.find((r) => r.user?.id === actor.id && String(r.commit_id ?? '').toLowerCase() === head && r.body === body)
      : null
    const created = existing ?? (await forgeFetchJson(endpoint, `${repoApi}/pulls/${endpoint.prNumber}/reviews`, {
      method: 'POST',
      cred,
      body: { commit_id: head, event: 'COMMENT', body },
    })).data
    const { data: confirmed } = await forgeFetchJson(endpoint, `${repoApi}/pulls/${endpoint.prNumber}/reviews/${created.id}`, { cred })
    if (String(confirmed.commit_id ?? '').toLowerCase() !== head || confirmed.body !== body || confirmed.user?.id !== actor.id) {
      throw new Error('Gitea review approval could not be verified after posting.')
    }
    console.log(
      JSON.stringify({
        id: confirmed.id,
        kind: 'review',
        url: confirmed.html_url ?? `${endpoint.httpOrigin}/${endpoint.repoPath}/pulls/${endpoint.prNumber}`,
        head,
        base,
      }),
    )
    return
  }

  // GitLab REST v4
  const encodedProject = encodeURIComponent(endpoint.repoPath)
  const mrApi = `/api/v4/projects/${encodedProject}/merge_requests/${endpoint.prNumber}`
  const [{ data: actor }, { data: mr }] = await Promise.all([
    forgeFetchJson(endpoint, '/api/v4/user', { cred }),
    forgeFetchJson(endpoint, mrApi, { cred }),
  ])
  const mrHead = String(mr.diff_refs?.head_sha ?? mr.sha ?? '').toLowerCase()
  const mrBase = String(mr.diff_refs?.base_sha ?? '').toLowerCase()
  if (String(mr.state).toLowerCase() !== 'opened' || mrHead !== head || mrBase !== base) {
    throw new Error('Merge request closed or changed on GitLab. Reassess before approving.')
  }
  const { data: notes } = await forgeFetchJson(endpoint, `${mrApi}/notes?per_page=100`, { cred })
  const existing = Array.isArray(notes) ? notes.find((n) => n.author?.id === actor.id && n.body === body) : null
  const created = existing ?? (await forgeFetchJson(endpoint, `${mrApi}/notes`, {
    method: 'POST',
    cred,
    body: { body },
  })).data
  const { data: confirmed } = await forgeFetchJson(endpoint, `${mrApi}/notes/${created.id}`, { cred })
  if (confirmed.body !== body || confirmed.author?.id !== actor.id) {
    throw new Error('GitLab approval note could not be verified after posting.')
  }
  console.log(
    JSON.stringify({
      id: confirmed.id,
      kind: 'issue',
      url: `${mr.web_url ?? `${endpoint.httpOrigin}/${endpoint.repoPath}/-/merge_requests/${endpoint.prNumber}`}#note_${confirmed.id}`,
      head,
      base,
    }),
  )
}

main().catch((error) => {
  console.error(error?.message || String(error))
  process.exitCode = 1
})
