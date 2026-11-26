import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  hashSeatReceiptToken,
  isItemExplicitApproval,
  resolveTrustedForgeEndpoint,
  verifySeatOutcomeFromSnapshot,
  type ForgePullEvidenceSnapshot,
} from './pr-forge-evidence.js'

const TOOLS_DIR = resolve('resources/pr-workflows')
const PR_POLL = join(TOOLS_DIR, 'pr-poll.mjs')
const PR_APPROVE = join(TOOLS_DIR, 'pr-approve.mjs')
const PR_RECEIPT = join(TOOLS_DIR, 'pr-seat-receipt.mjs')

const HEAD_1 = '1'.repeat(40)
const BASE_1 = '2'.repeat(40)
const BASE_2 = '3'.repeat(40)

function runNodeScript(
  scriptPath: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        windowsHide: true,
        timeout: 20_000,
      },
      (err, stdout, stderr) => {
        const exitCode = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? 1
            : 0
        resolveRun({ code: exitCode, stdout: String(stdout), stderr: String(stderr) })
      },
    )
    child.stdin?.end()
  })
}

function listenServer(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolvePort(addr.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

test('pr-poll.mjs + pr-approve.mjs work end-to-end on Gitea REST API, preserve approvalForHead across --mark, detect comment edits, and invalidate approval when base moves while head stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-poll-gitea-'))
  let currentHead = HEAD_1
  let currentBase = BASE_1
  let nextCommentId = 500
  const reviews: Array<Record<string, unknown>> = [
    {
      id: 10,
      state: 'COMMENT',
      user: { id: 7, login: 'alice' },
      body: 'Non-blocking: [Claude Code] check edge case',
      commit_id: HEAD_1,
      submitted_at: '2026-11-26T00:00:00Z',
      updated_at: '2026-11-26T00:00:00Z',
    },
  ]
  const issueComments: Array<Record<string, unknown>> = []

  const giteaServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    if (url.pathname === '/api/v1/user') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 7, login: 'alice' }))
      return
    }
    if (url.pathname === '/api/v1/repos/daq/service/pulls/12') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        number: 12,
        state: 'open',
        merged: false,
        user: { id: 7, login: 'alice' },
        head: { ref: 'feat/test', sha: currentHead, repo: { id: 99, full_name: 'daq/service' } },
        base: { ref: 'main', sha: currentBase, repo: { id: 99, full_name: 'daq/service' } },
      }))
      return
    }
    if (url.pathname === '/api/v1/repos/daq/service/pulls/12/files') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ filename: 'src/index.ts' }]))
      return
    }
    if (url.pathname === '/api/v1/repos/daq/service/pulls/12/reviews') {
      if (req.method === 'POST') {
        const parsed = JSON.parse(rawBody) as { body: string; commit_id: string; event?: string }
        const created = {
          id: ++nextCommentId,
          state: parsed.event === 'APPROVE' ? 'APPROVED' : 'COMMENT',
          user: { id: 7, login: 'alice' },
          body: parsed.body,
          commit_id: parsed.commit_id,
          submitted_at: '2026-11-26T00:05:00Z',
          updated_at: '2026-11-26T00:05:00Z',
          html_url: `http://127.0.0.1/daq/service/pulls/12#pullrequestreview-${nextCommentId}`,
        }
        reviews.push(created)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(created))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reviews))
      return
    }
    const giteaReviewById = /^\/api\/v1\/repos\/daq\/service\/pulls\/12\/reviews\/(\d+)$/.exec(url.pathname)
    if (giteaReviewById) {
      const found = reviews.find((r) => Number(r.id) === Number(giteaReviewById[1]))
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(found ?? { message: 'Not found' }))
      return
    }
    if (url.pathname === '/api/v1/repos/daq/service/pulls/12/comments') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([]))
      return
    }
    if (url.pathname === '/api/v1/repos/daq/service/issues/12/comments') {
      if (req.method === 'POST') {
        const parsed = JSON.parse(rawBody) as { body: string }
        const created = {
          id: ++nextCommentId,
          user: { id: 7, login: 'alice' },
          body: parsed.body,
          created_at: '2026-11-26T00:05:00Z',
          updated_at: '2026-11-26T00:05:00Z',
          html_url: `http://127.0.0.1/daq/service/pulls/12#issuecomment-${nextCommentId}`,
        }
        issueComments.push(created)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(created))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(issueComments))
      return
    }
    if (url.pathname === '/redirect-test/api/v1/repos/daq/service/pulls/12') {
      res.writeHead(302, { location: 'http://evil.example.com/steal' })
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: `Not found: ${url.pathname}` }))
  })

  const port = await listenServer(giteaServer)
  try {
    const httpOrigin = `http://127.0.0.1:${port}`
    const prUrl = `${httpOrigin}/daq/service/pulls/12`
    const gitOrigin = `${httpOrigin}/daq/service.git`
    const stateFile = join(dir, 'state.json')
    const env = { GITEA_TOKEN: 'test-gitea-token' }

    // 1. Cleartext http:// is refused when origin is https:// and --allow-http-origin is omitted:
    const httpRefused = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', `https://127.0.0.1:${port}/daq/service.git`, '--snapshot'],
      { env },
    )
    assert.notEqual(httpRefused.code, 0)
    assert.match(httpRefused.stderr, /Refusing cleartext http/i)

    // 2. Host mismatch between --pr-url and git remote origin is refused:
    const hostMismatch = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', 'http://other-host:3000/daq/service.git', '--snapshot'],
      { env },
    )
    assert.notEqual(hostMismatch.code, 0)
    assert.match(hostMismatch.stderr, /does not match Git origin host/i)

    // 3. Initial snapshot on Gitea succeeds when origin matches http://127.0.0.1:<port>:
    const snap1 = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot'],
      { env },
    )
    assert.equal(snap1.code, 0, snap1.stderr)
    const snap1Json = JSON.parse(snap1.stdout)
    assert.equal(snap1Json.forge, 'gitea')
    assert.equal(snap1Json.headSha, HEAD_1)
    assert.equal(snap1Json.baseSha, BASE_1)
    assert.equal(snap1Json.newReviews.length, 1)
    assert.equal(snap1Json.approvalForHead, false)

    // Mark review 10 as handled:
    const mark1 = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', '10,0,0', '--head', HEAD_1, '--base', BASE_1],
      { env },
    )
    assert.equal(mark1.code, 0, mark1.stderr)

    // Subsequent single poll with no changes returns NO_CHANGE, and --wait --max returns WAIT_TIMEOUT:
    const noChange = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(noChange.code, 0, noChange.stderr)
    assert.equal(noChange.stdout.trim(), 'NO_CHANGE')

    const waitTimeout = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--wait', '1', '--max', '1'],
      { env },
    )
    assert.equal(waitTimeout.code, 0, waitTimeout.stderr)
    assert.equal(waitTimeout.stdout.trim(), 'WAIT_TIMEOUT')

    // 4. Material edit to already-seen review #10 (same numeric ID, updated body & updated_at) wakes watcher with edited: true!
    reviews[0] = {
      ...reviews[0],
      body: 'Blocking: [Claude Code] upgraded severity after re-checking',
      updated_at: '2026-11-26T00:02:00Z',
    }
    const editedPoll = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--wait', '1', '--max', '1'],
      { env },
    )
    assert.equal(editedPoll.code, 0, editedPoll.stderr)
    const editedJson = JSON.parse(editedPoll.stdout)
    assert.equal(editedJson.edited, true)
    assert.equal(editedJson.newReviews.length, 1)
    assert.equal(editedJson.newReviews[0].edited, true)

    // Mark the edited version so versions map updates:
    await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', '10,0,0', '--head', HEAD_1, '--base', BASE_1],
      { env },
    )

    // 5. Post approval for Claude Code via pr-approve.mjs (and verify deduplication on repeat):
    const noteClaude = join(dir, 'claude-approve.md')
    writeFileSync(noteClaude, '[Claude Code] Verified build and unit tests pass.\n')
    const approve1 = await runNodeScript(
      PR_APPROVE,
      ['daq/service', '12', HEAD_1, BASE_1, noteClaude, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(approve1.code, 0, approve1.stderr)
    assert.equal(reviews.length, 2)
    assert.match(String(reviews[1]!.body), new RegExp(`^Approved at ${HEAD_1}\\n\\n\\[Claude Code\\][\\s\\S]*Reviewed base: ${BASE_1}$`))

    const approveDup = await runNodeScript(
      PR_APPROVE,
      ['daq/service', '12', HEAD_1, BASE_1, noteClaude, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(approveDup.code, 0, approveDup.stderr)
    assert.equal(reviews.length, 2, 'pr-approve.mjs deduplicates matching existing approval')

    // Mark watermark past review 501, then verify full-list approvalForHead STILL stays true across --mark!
    await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', `${nextCommentId},0,0`, '--head', HEAD_1, '--base', BASE_1],
      { env },
    )
    const afterMarkSnap = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Claude Code]'],
      { env },
    )
    assert.equal(afterMarkSnap.code, 0, afterMarkSnap.stderr)
    const afterMarkJson = JSON.parse(afterMarkSnap.stdout)
    assert.equal(afterMarkJson.newReviews.length, 0, 'watermark is past review 501')
    assert.equal(afterMarkJson.approvalForHead, true, 'approvalForHead uses full PR evidence, surviving --mark!')

    // Requiring TWO tags ([Claude Code] and [Codex CLI]) fails until Codex also posts its own distinct comment:
    const twoTagMissing = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Claude Code]', '--require-tag', '[Codex CLI]'],
      { env },
    )
    assert.equal(JSON.parse(twoTagMissing.stdout).approvalForHead, false)

    // A single comment spoofing BOTH tags cannot satisfy two distinct --require-tag seats!
    reviews.pop() // remove Claude review temporarily so only one combined item exists
    issueComments.push({
      id: ++nextCommentId,
      user: { id: 7, login: 'alice' },
      body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_1}\n\n[Claude Code] [Codex CLI] combined`,
      created_at: '2026-11-26T00:06:00Z',
      updated_at: '2026-11-26T00:06:00Z',
    })
    const combinedSpoof = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Claude Code]', '--require-tag', '[Codex CLI]'],
      { env },
    )
    assert.equal(JSON.parse(combinedSpoof.stdout).approvalForHead, false, 'one comment cannot satisfy two distinct reviewer tags')

    // Restore distinct comments from Claude + a third-party bystander:
    issueComments.length = 0
    issueComments.push(
      {
        id: ++nextCommentId,
        user: { id: 999, login: 'random-bystander' },
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_1}\n\n[Codex CLI] bystander`,
        created_at: '2026-11-26T00:06:10Z',
        updated_at: '2026-11-26T00:06:10Z',
      },
      {
        id: ++nextCommentId,
        user: { id: 7, login: 'alice' },
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_1}\n\n[Claude Code] ok`,
        created_at: '2026-11-26T00:06:20Z',
        updated_at: '2026-11-26T00:06:20Z',
      },
    )
    const bystanderRejected = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Claude Code]', '--require-tag', '[Codex CLI]'],
      { env },
    )
    assert.equal(JSON.parse(bystanderRejected.stdout).approvalForHead, false, 'third-party bystander comment cannot satisfy expected reviewer approval')

    // Add real Codex approval from alice -> both tags now satisfied!
    const noteCodex = join(dir, 'codex-approve.md')
    writeFileSync(noteCodex, '[Codex CLI] All checks green.\n')
    const approveCodex = await runNodeScript(
      PR_APPROVE,
      ['daq/service', '12', HEAD_1, BASE_1, noteCodex, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(approveCodex.code, 0, approveCodex.stderr)
    const bothApproved = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Claude Code]', '--require-tag', '[Codex CLI]'],
      { env },
    )
    assert.equal(JSON.parse(bothApproved.stdout).approvalForHead, true)

    // Mark watermarks at (HEAD_1, BASE_1):
    await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', `${nextCommentId},0,${nextCommentId}`, '--head', HEAD_1, '--base', BASE_1],
      { env },
    )

    // 6. Move ONLY the PR base (BASE_1 -> BASE_2) while HEAD_1 stays unchanged!
    // Watcher (--invert --watch-head) MUST wake with baseChanged: true AND approvalForHead MUST become false!
    currentBase = BASE_2
    const baseMovedWake = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--invert', '--watch-head', '--wait', '1', '--max', '1', '--require-tag', '[Claude Code]'],
      { env },
    )
    assert.equal(baseMovedWake.code, 0, baseMovedWake.stderr)
    const baseMovedJson = JSON.parse(baseMovedWake.stdout)
    assert.equal(baseMovedJson.headChanged, false)
    assert.equal(baseMovedJson.baseChanged, true, 'base-only move wakes --watch-head')
    assert.equal(baseMovedJson.approvalForHead, false, 'approval bound to BASE_1 is invalidated when base moves to BASE_2')
  } finally {
    await closeServer(giteaServer)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pr-poll.mjs + pr-approve.mjs work end-to-end on GitLab REST v4 and refuse HTTP redirects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-poll-gitlab-'))
  const notes: Array<Record<string, unknown>> = []
  let nextNoteId = 700
  let redirectMode = false

  const gitlabServer = createServer(async (req, res) => {
    if (redirectMode) {
      res.writeHead(302, { location: 'https://evil.example.com/phish' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    if (url.pathname === '/api/v4/user') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 21, username: 'bob' }))
      return
    }
    if (url.pathname === '/api/v4/projects/team%2Fsub%2Fapp/merge_requests/7') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        iid: 7,
        state: 'opened',
        author: { id: 21, username: 'bob' },
        target_project_id: 55,
        source_project_id: 55,
        source_branch: 'feat/gl',
        target_branch: 'main',
        diff_refs: { head_sha: HEAD_1, base_sha: BASE_1 },
      }))
      return
    }
    if (url.pathname === '/api/v4/projects/team%2Fsub%2Fapp/merge_requests/7/approvals') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ approved_by: [] }))
      return
    }
    if (url.pathname === '/api/v4/projects/team%2Fsub%2Fapp/merge_requests/7/notes') {
      if (req.method === 'POST') {
        const parsed = JSON.parse(rawBody) as { body: string }
        const note = {
          id: ++nextNoteId,
          system: false,
          author: { id: 21, username: 'bob' },
          body: parsed.body,
          created_at: '2026-11-26T01:00:00Z',
          updated_at: '2026-11-26T01:00:00Z',
        }
        notes.push(note)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(note))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(notes))
      return
    }
    const gitlabNoteById = /^\/api\/v4\/projects\/team%2Fsub%2Fapp\/merge_requests\/7\/notes\/(\d+)$/.exec(url.pathname)
    if (gitlabNoteById) {
      const found = notes.find((n) => Number(n.id) === Number(gitlabNoteById[1]))
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(found ?? { message: 'Not found' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: `Not found: ${url.pathname}` }))
  })

  const port = await listenServer(gitlabServer)
  try {
    const httpOrigin = `http://127.0.0.1:${port}`
    const mrUrl = `${httpOrigin}/team/sub/app/-/merge_requests/7`
    const gitOrigin = `${httpOrigin}/team/sub/app.git`
    const stateFile = join(dir, 'gl-state.json')
    const noteFile = join(dir, 'gl-note.md')
    writeFileSync(noteFile, '[Antigravity CLI] GitLab MR verified.\n')
    const env = { GITLAB_TOKEN: 'glpat-test' }

    const postRes = await runNodeScript(
      PR_APPROVE,
      ['team/sub/app', '7', HEAD_1, BASE_1, noteFile, '--pr-url', mrUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(postRes.code, 0, postRes.stderr)
    assert.equal(notes.length, 1)

    const snapRes = await runNodeScript(
      PR_POLL,
      ['7', stateFile, '--pr-url', mrUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Antigravity CLI]'],
      { env },
    )
    assert.equal(snapRes.code, 0, snapRes.stderr)
    const snapJson = JSON.parse(snapRes.stdout)
    assert.equal(snapJson.forge, 'gitlab')
    assert.equal(snapJson.approvalForHead, true)

    // Enable 302 redirect and verify pr-approve.mjs / pr-poll.mjs refuse redirects instead of following them:
    redirectMode = true
    const redirectPoll = await runNodeScript(
      PR_POLL,
      ['7', stateFile, '--pr-url', mrUrl, '--origin', gitOrigin, '--snapshot'],
      { env },
    )
    assert.notEqual(redirectPoll.code, 0)
    assert.match(redirectPoll.stderr, /Refusing HTTP 302 redirect/i)
  } finally {
    await closeServer(gitlabServer)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pr-seat-receipt.mjs posts seat-scoped token + metadata to loopback /pr-seat-receipt and rejects errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-receipt-'))
  const received: { body: Record<string, unknown> | null } = { body: null }
  const receiptServer = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    received.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, message: 'Verified approved on PR (issue:777).' }))
  })
  const port = await listenServer(receiptServer)
  try {
    const token = 'a'.repeat(64)
    const cfgPath = join(dir, 'seat-receipt.json')
    writeFileSync(cfgPath, JSON.stringify({
      port,
      seatToken: token,
      groupId: 'grp-1',
      cli: 'claude',
      generation: 'gen-1',
      round: 2,
      head: HEAD_1,
      base: BASE_1,
    }))
    const res = await runNodeScript(PR_RECEIPT, ['--kind', 'approved', '--id', '777'], {
      env: { COPILOT_DESKTOP_SEAT_RECEIPT: cfgPath },
    })
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /Verified approved on PR/)
    assert.equal(received.body?.remoteId, 777)
    assert.equal(received.body?.kind, 'approved')
    assert.equal(hashSeatReceiptToken(token).length, 64)
  } finally {
    await closeServer(receiptServer)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pr-forge-evidence verifies seat outcomes accurately, rejects mixed approval+findings, and excludes Bitbucket/ADO from Gitea adapter', () => {
  assert.equal(
    resolveTrustedForgeEndpoint({
      origin: 'https://bitbucket.org/workspace/repo.git',
      prNumber: 5,
      prUrl: 'https://bitbucket.org/workspace/repo/pull-requests/5',
    }),
    null,
  )
  assert.equal(
    resolveTrustedForgeEndpoint({
      origin: 'https://dev.azure.com/org/proj/_git/repo',
      prNumber: 5,
      prUrl: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/5',
    }),
    null,
  )
  const giteaEp = resolveTrustedForgeEndpoint({
    origin: 'http://omaha:3001/daq/daq-service.git',
    prNumber: 12,
    prUrl: 'http://omaha:3001/daq/daq-service/pulls/12',
  })
  assert.equal(giteaEp?.forge, 'gitea')
  assert.equal(giteaEp?.httpOrigin, 'http://omaha:3001')

  const roundStart = Date.parse('2026-11-26T02:00:00Z')
  const snapshot: ForgePullEvidenceSnapshot = {
    forge: 'github',
    open: true,
    merged: false,
    head: HEAD_1,
    base: BASE_2,
    sameRepo: true,
    actorId: 7,
    actorLogin: 'alice',
    items: [
      // Pre-round stale comment (ignored):
      {
        kind: 'issue',
        id: 1,
        user: 'alice',
        userId: 7,
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_2}\n\n[Claude Code] old`,
        commitId: null,
        createdAtMs: roundStart - 60_000,
      },
      // Mixed round output from Claude (both an approval AND a finding in the same round -> must count as 'findings', NEVER 'approved'!):
      {
        kind: 'issue',
        id: 2,
        user: 'alice',
        userId: 7,
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_2}\n\n[Claude Code]`,
        commitId: null,
        createdAtMs: roundStart + 1_000,
      },
      {
        kind: 'inline',
        id: 3,
        user: 'alice',
        userId: 7,
        body: 'Blocking: [Claude Code] null dereference on line 42',
        commitId: HEAD_1,
        createdAtMs: roundStart + 2_000,
      },
      // Clean base-bound approval from Codex:
      {
        kind: 'issue',
        id: 4,
        user: 'alice',
        userId: 7,
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_2}\n\n[Codex CLI] checks ran`,
        commitId: null,
        createdAtMs: roundStart + 3_000,
      },
    ],
  }

  const claimed = new Set<string>()
  const claudeOutcome = verifySeatOutcomeFromSnapshot({
    snapshot,
    cli: 'claude',
    totalRequiredSeats: 2,
    head: HEAD_1,
    base: BASE_2,
    baseMovedInGroup: true,
    roundStartedAtMs: roundStart,
    marker: '🤖 ',
    claimedEvidenceKeys: claimed,
  })
  assert.deepEqual(claudeOutcome, { verdict: 'findings', claimedKeys: ['inline:3'] })

  const codexOutcome = verifySeatOutcomeFromSnapshot({
    snapshot,
    cli: 'codex',
    totalRequiredSeats: 2,
    head: HEAD_1,
    base: BASE_2,
    baseMovedInGroup: true,
    roundStartedAtMs: roundStart,
    marker: '🤖 ',
    claimedEvidenceKeys: claimed,
  })
  assert.deepEqual(codexOutcome, { verdict: 'approved', claimedKeys: ['issue:4'] })

  // Negated or quoted approvals never match isItemExplicitApproval:
  assert.equal(
    isItemExplicitApproval(
      {
        kind: 'issue',
        id: 9,
        user: 'alice',
        userId: 7,
        body: `> Approved at ${HEAD_1}\nNot approved yet at ${HEAD_1}`,
        commitId: null,
        createdAtMs: roundStart,
      },
      HEAD_1,
      BASE_1,
      false,
    ),
    false,
  )
})
