import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  clearForgeProbeCacheForTests,
  fetchForgePullEvidence,
  ghPagedItems,
  ghConfigMayKnowHost,
  ghEnterpriseChildEnv,
  hashSeatReceiptToken,
  isItemExplicitApproval,
  resolveTrustedForgeEndpoint,
  resolveVerifiedForgeKind,
  verifySeatOutcomeFromSnapshot,
  type ForgePullEvidenceSnapshot,
} from './pr-forge-evidence.js'
import type { GitRunner } from './git-runner.js'

interface PrForgeModule {
  evaluateRevisionApprovals: (opts: Record<string, unknown>) => { approvalForHead: boolean }
  forgePaginateArray: (
    endpoint: { forge: string; httpOrigin: string },
    basePath: string,
    cred: { kind: string; token: string } | null,
    maxPages?: number,
  ) => Promise<unknown[]>
  resolveForgeEndpoint: (opts: Record<string, unknown>) => {
    forge: string
    httpOrigin: string
    hostname: string
    host: string
    repoPath: string
    prNumber: number
  }
}

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
  server.closeAllConnections?.()
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

test('pr-poll.mjs + pr-approve.mjs work end-to-end on Gitea REST API, preserve approvalForHead across --mark, detect comment edits, and invalidate approval when base moves while head stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-poll-gitea-'))
  let currentHead = HEAD_1
  let currentBase = BASE_1
  let nextCommentId = 500
  const reviewInlineByReviewId = new Map<number, Array<Record<string, unknown>>>([
    [
      11,
      [
        {
          id: 21,
          path: 'src/index.ts',
          position: 4,
          user: { id: 7, login: 'alice' },
          body: '[Codex CLI]\nNon-blocking: inline review comment on Gitea review #11',
          original_commit_id: HEAD_1,
          created_at: '2026-11-26T00:00:30Z',
          updated_at: '2026-11-26T00:00:30Z',
        },
      ],
    ],
  ])
  const reviews: Array<Record<string, unknown>> = [
    {
      id: 10,
      state: 'COMMENT',
      user: { id: 7, login: 'alice' },
      body: 'Non-blocking: [Claude Code] check edge case',
      commit_id: HEAD_1,
      comments_count: 0,
      submitted_at: '2026-11-26T00:00:00Z',
      updated_at: '2026-11-26T00:00:00Z',
    },
    {
      id: 11,
      state: 'COMMENT',
      user: { id: 7, login: 'alice' },
      body: '',
      commit_id: HEAD_1,
      comments_count: 1,
      submitted_at: '2026-11-26T00:00:30Z',
      updated_at: '2026-11-26T00:00:30Z',
    },
  ]
  const issueComments: Array<Record<string, unknown>> = []

  const giteaServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    if (url.pathname === '/api/v1/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '1.22.0' }))
      return
    }
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
    const giteaReviewComments = /^\/api\/v1\/repos\/daq\/service\/pulls\/12\/reviews\/(\d+)\/comments$/.exec(url.pathname)
    if (giteaReviewComments) {
      const page = Number(url.searchParams.get('page') ?? '1')
      const list = page === 1 ? (reviewInlineByReviewId.get(Number(giteaReviewComments[1])) ?? []) : []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
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
    const env = { GITEA_TOKEN: 'test-gitea-token', GITEA_URL: httpOrigin }

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

    // 3. Initial snapshot on Gitea succeeds when origin matches http://127.0.0.1:<port>, including per-review inline comments:
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
    assert.equal(snap1Json.newReviews.length, 1, 'empty-body grouped inline review #11 is suppressed from newReviews')
    assert.equal(snap1Json.newInline.length, 1, 'inline comment #21 fetched from /pulls/12/reviews/11/comments')
    assert.equal(snap1Json.newInline[0].id, 21)
    assert.equal(snap1Json.approvalForHead, false)

    // Verify Desktop resolveVerifiedForgeKind (/api/v1/version probe) + fetchForgePullEvidence + parentReviewId receipt matching on Gitea:
    clearForgeProbeCacheForTests()
    const prevGiteaTok = process.env.GITEA_TOKEN
    const prevGiteaUrlTest = process.env.GITEA_URL
    process.env.GITEA_TOKEN = 'test-gitea-token'
    process.env.GITEA_URL = httpOrigin
    try {
      const trustedEp = resolveTrustedForgeEndpoint({ origin: gitOrigin, prNumber: 12, prUrl })
      assert.equal(trustedEp?.forge, 'probe')
      const verifiedEp = await resolveVerifiedForgeKind({ endpoint: trustedEp!, projectCwd: dir, runner: null })
      assert.equal(verifiedEp?.forge, 'gitea')
      const liveEv = await fetchForgePullEvidence({ endpoint: verifiedEp!, userDataDir: dir, projectCwd: dir, runner: null })
      const inlineEv = liveEv.items.find((i) => i.kind === 'inline' && i.id === 21)
      assert.ok(inlineEv, 'Desktop fetchForgePullEvidence reads Gitea /reviews/11/comments')
      assert.equal(inlineEv.parentReviewId, 11)
      const parentReceiptMatch = verifySeatOutcomeFromSnapshot({
        snapshot: liveEv,
        tag: '[Codex CLI]',
        requireExactReviewerTags: true,
        head: HEAD_1,
        base: BASE_1,
        baseMovedInGroup: false,
        roundStartedAtMs: Date.parse('2026-11-26T00:00:00Z'),
        marker: '🤖 ',
        claimedEvidenceKeys: new Set(),
        receipt: { kind: 'findings', remoteId: 11, itemType: 'review' },
      })
      assert.deepEqual(parentReceiptMatch, { verdict: 'findings', claimedKeys: ['inline:21'] })
    } finally {
      if (prevGiteaTok === undefined) delete process.env.GITEA_TOKEN
      else process.env.GITEA_TOKEN = prevGiteaTok
      if (prevGiteaUrlTest === undefined) delete process.env.GITEA_URL
      else process.env.GITEA_URL = prevGiteaUrlTest
    }

    // Mark review 11 and inline 21 as handled:
    const mark1 = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', '11,21,0', '--head', HEAD_1, '--base', BASE_1],
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
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', '11,21,0', '--head', HEAD_1, '--base', BASE_1],
      { env },
    )

    // 4b. Overlapping snapshots with identical numeric watermarks MUST NOT swallow edits made between Snapshot 1 and Snapshot 2!
    const snapBeforeRace = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot'],
      { env },
    )
    assert.equal(snapBeforeRace.code, 0, snapBeforeRace.stderr)
    const snap1Id = JSON.parse(snapBeforeRace.stdout).snapshotId as string
    assert.ok(snap1Id, 'snapshot includes a unique snapshotId')
    reviews[0] = {
      ...reviews[0],
      body: 'Blocking: [Claude Code] edited between snapshot and mark',
      updated_at: '2026-11-26T00:02:30Z',
    }
    // Fetch a SECOND overlapping status snapshot BEFORE marking the first boundary!
    const overlappingStatusSnap = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot'],
      { env },
    )
    assert.equal(overlappingStatusSnap.code, 0, overlappingStatusSnap.stderr)
    const snap2Id = JSON.parse(overlappingStatusSnap.stdout).snapshotId as string
    assert.notEqual(snap2Id, snap1Id)

    // Marking the first boundary (with --snapshot-id snap1Id) records snap1's versions, NOT snap2's!
    const markSnap1 = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', '11,21,0', '--head', HEAD_1, '--base', BASE_1, '--snapshot-id', snap1Id],
      { env },
    )
    assert.equal(markSnap1.code, 0, markSnap1.stderr)
    const afterRacePoll = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(afterRacePoll.code, 0, afterRacePoll.stderr)
    assert.notEqual(afterRacePoll.stdout.trim(), 'NO_CHANGE', 'edit made between overlapping snapshots must still wake next poll')
    const afterRaceJson = JSON.parse(afterRacePoll.stdout)
    assert.equal(afterRaceJson.edited, true)
    assert.match(afterRaceJson.newReviews[0].body, /edited between snapshot and mark/)
    // Now mark the delivered edited observation by its snapshotId and verify subsequent poll returns NO_CHANGE:
    await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', '11,21,0', '--head', HEAD_1, '--base', BASE_1, '--snapshot-id', String(afterRaceJson.snapshotId)],
      { env },
    )
    const postRaceClean = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(postRaceClean.stdout.trim(), 'NO_CHANGE')

    // 4c. Marking WITHOUT --snapshot-id when a newly posted comment arrived after the oldest pending snapshot and was edited before --mark
    // MUST NOT stamp the live edited version for an ID absent from the acknowledged snapshot!
    const snapOldest = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot'],
      { env },
    )
    assert.equal(snapOldest.code, 0, snapOldest.stderr)
    reviews.push({
      id: 12,
      state: 'COMMENT',
      user: { id: 7, login: 'alice' },
      body: 'Non-blocking: [Codex CLI] brand new review v1',
      commit_id: HEAD_1,
      comments_count: 0,
      submitted_at: '2026-11-26T00:03:00Z',
      updated_at: '2026-11-26T00:03:00Z',
    })
    const snapLaterWith12 = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot'],
      { env },
    )
    assert.equal(snapLaterWith12.code, 0, snapLaterWith12.stderr)
    reviews[reviews.length - 1] = {
      ...reviews[reviews.length - 1],
      body: 'Blocking: [Codex CLI] edited review 12 before mark',
      updated_at: '2026-11-26T00:03:30Z',
    }
    // Omitting --snapshot-id selects snapOldest (which did not contain #12); #12 must remain unseen/edited on the next poll!
    await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', '12,21,0', '--head', HEAD_1, '--base', BASE_1],
      { env },
    )
    const wakeFor12 = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.notEqual(wakeFor12.stdout.trim(), 'NO_CHANGE', 'missing ID from oldest snapshot must not be stamped with live edit')
    const wake12Json = JSON.parse(wakeFor12.stdout)
    assert.equal(wake12Json.edited, true)
    assert.equal(wake12Json.newReviews[0].id, 12)
    assert.match(wake12Json.newReviews[0].body, /edited review 12 before mark/)
    await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', '12,21,0', '--head', HEAD_1, '--base', BASE_1, '--snapshot-id', String(wake12Json.snapshotId)],
      { env },
    )
    const cleanAfter12 = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(cleanAfter12.stdout.trim(), 'NO_CHANGE')
    reviews.pop()

    // 5. Post approval for Claude Code via pr-approve.mjs using full PR URL as first arg (and verify refusal of finding-labeled notes + deduplication on repeat):
    for (const badNoteBody of [
      '[Claude Code] The three **Blocking** findings from the earlier round are verified fixed; typecheck and tests pass.\n',
      '[Claude Code] Open findings:\n- Blocking: none\n- Non-blocking: none\n',
    ]) {
      const badNotePath = join(dir, 'bad-approve-note.md')
      writeFileSync(badNotePath, badNoteBody)
      const refusedApprove = await runNodeScript(
        PR_APPROVE,
        [prUrl, '12', HEAD_1, BASE_1, badNotePath, '--origin', gitOrigin],
        { env },
      )
      assert.notEqual(refusedApprove.code, 0, 'pr-approve.mjs refuses validation notes containing finding severity labels')
      assert.match(refusedApprove.stderr, /Reword the note without finding labels/i)
      assert.equal(reviews.length, 2, 'refused note posts nothing to the PR host')
    }
    const noteClaude = join(dir, 'claude-approve.md')
    writeFileSync(noteClaude, '[Claude Code]\nVerified build and unit tests pass.\n')
    const approve1 = await runNodeScript(
      PR_APPROVE,
      [prUrl, '12', HEAD_1, BASE_1, noteClaude, '--origin', gitOrigin],
      { env },
    )
    assert.equal(approve1.code, 0, approve1.stderr)
    assert.equal(reviews.length, 3)
    assert.match(String(reviews[2]!.body), new RegExp(`^Approved at ${HEAD_1}\\n\\n\\[Claude Code\\][\\s\\S]*Reviewed base: ${BASE_1}$`))

    const approveDup = await runNodeScript(
      PR_APPROVE,
      ['omaha-ignored/daq/service'.replace('omaha-ignored', `127.0.0.1:${port}`), '12', HEAD_1, BASE_1, noteClaude, '--pr-url', prUrl, '--origin', gitOrigin],
      { env },
    )
    assert.equal(approveDup.code, 0, approveDup.stderr)
    assert.equal(reviews.length, 3, 'pr-approve.mjs deduplicates matching existing approval even with host-prefixed repo arg')

    // Mark watermark past review 501, then verify full-list approvalForHead STILL stays true across --mark!
    await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', `${nextCommentId},21,0`, '--head', HEAD_1, '--base', BASE_1],
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
      body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_1}\n\n[Claude Code]\n[Codex CLI]\ncombined`,
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
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_1}\n\n[Codex CLI]\nbystander`,
        created_at: '2026-11-26T00:06:10Z',
        updated_at: '2026-11-26T00:06:10Z',
      },
      {
        id: ++nextCommentId,
        user: { id: 7, login: 'alice' },
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_1}\n\n[Claude Code]\nok`,
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
    writeFileSync(noteCodex, '[Codex CLI]\nAll checks green.\n')
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
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', `${nextCommentId},21,${nextCommentId}`, '--head', HEAD_1, '--base', BASE_1],
      { env },
    )

    // Also add a legacy unbound "Approved at <head>" comment (WITHOUT "Reviewed base:") before moving base:
    issueComments.push({
      id: ++nextCommentId,
      user: { id: 7, login: 'alice' },
      body: `Approved at ${HEAD_1}\n\n[Claude Code] legacy unbound approval without Reviewed base`,
      created_at: '2026-11-26T00:06:30Z',
      updated_at: '2026-11-26T00:06:30Z',
    })

    // 6. Move ONLY the PR base (BASE_1 -> BASE_2) while HEAD_1 stays unchanged!
    // Watcher (--invert --watch-head) MUST wake with baseChanged: true AND approvalForHead MUST become false (even with legacy unbound "Approved at <head>")!
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

    const authorBaseMovedSnap = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Claude Code]'],
      { env },
    )
    assert.equal(JSON.parse(authorBaseMovedSnap.stdout).approvalForHead, false, 'legacy unbound and BASE_1 approvals invalidated when base moves to BASE_2')

    // Even AFTER --mark records BASE_2 for the same HEAD_1, baseMovedForHead persists so unbound approvals stay invalid until a BASE_2 approval is posted!
    await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--mark', '--through', `${nextCommentId},21,${nextCommentId}`, '--head', HEAD_1, '--base', BASE_2],
      { env },
    )
    const postMarkAfterBaseMove = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Claude Code]'],
      { env },
    )
    assert.equal(JSON.parse(postMarkAfterBaseMove.stdout).approvalForHead, false, 'baseMovedForHead persists across --mark for unchanged head')

    const approveBase2 = await runNodeScript(
      PR_APPROVE,
      [prUrl, '12', HEAD_1, BASE_2, noteClaude, '--origin', gitOrigin],
      { env },
    )
    assert.equal(approveBase2.code, 0, approveBase2.stderr)
    const reapprovedBase2 = await runNodeScript(
      PR_POLL,
      ['12', stateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Claude Code]'],
      { env },
    )
    assert.equal(JSON.parse(reapprovedBase2.stdout).approvalForHead, true, 'new approval bound to Reviewed base: BASE_2 restores approvalForHead')

    // 7. Fresh state file (never observed a base move!) MUST reject a formal APPROVED review whose body names an older `Reviewed base: BASE_1` when live base is BASE_2!
    reviews.length = 0
    issueComments.length = 0
    reviews.push({
      id: ++nextCommentId,
      state: 'APPROVED',
      user: { id: 7, login: 'alice' },
      body: `Approved at ${HEAD_1}\n\n[Claude Code] approved earlier base\n\nReviewed base: ${BASE_1}`,
      commit_id: HEAD_1,
      comments_count: 0,
      submitted_at: '2026-11-26T00:08:00Z',
      updated_at: '2026-11-26T00:08:00Z',
    })
    const freshStateFile = join(dir, 'fresh-state.json')
    const freshMismatchSnap = await runNodeScript(
      PR_POLL,
      ['12', freshStateFile, '--pr-url', prUrl, '--origin', gitOrigin, '--snapshot'],
      { env },
    )
    assert.equal(freshMismatchSnap.code, 0, freshMismatchSnap.stderr)
    const freshMismatchJson = JSON.parse(freshMismatchSnap.stdout)
    assert.equal(freshMismatchJson.approvalForHead, false, 'fresh poll rejects formal APPROVED review bound to older Reviewed base')
    assert.equal(freshMismatchJson.approvedReview, false, 'approvedReview also rejects formal APPROVED review bound to older Reviewed base')
  } finally {
    await closeServer(giteaServer)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pr-poll.mjs + pr-approve.mjs + Desktop evidence work end-to-end on GitLab REST v4, bind target-branch tip moves with unchanged merge-base, and refuse HTTP redirects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-poll-gitlab-'))
  const notes: Array<Record<string, unknown>> = []
  let nextNoteId = 700
  let redirectMode = false
  let targetBranchTipSha = BASE_1

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
    if (url.pathname === '/api/v4/projects/team%2Fsub%2Fapp/repository/branches/main') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'main', commit: { id: targetBranchTipSha } }))
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
        // Merge-base (`diff_refs.base_sha`) stays at BASE_1 even when target branch `main` advances to BASE_2!
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
    const env = { GITLAB_TOKEN: 'glpat-test', GITLAB_URL: httpOrigin }

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
    assert.equal(snapJson.baseSha, BASE_1)
    assert.equal(snapJson.mergeBaseSha, BASE_1)
    assert.equal(snapJson.approvalForHead, true)

    await runNodeScript(
      PR_POLL,
      ['7', stateFile, '--pr-url', mrUrl, '--origin', gitOrigin, '--mark', '--through', `0,0,${nextNoteId}`, '--head', HEAD_1, '--base', BASE_1],
      { env },
    )

    // Target-only branch advance on GitLab (`main` tip moves BASE_1 -> BASE_2 while `diff_refs.head_sha` and `diff_refs.base_sha` stay unchanged!):
    targetBranchTipSha = BASE_2
    const targetAdvanceSnap = await runNodeScript(
      PR_POLL,
      ['7', stateFile, '--pr-url', mrUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Antigravity CLI]'],
      { env },
    )
    assert.equal(targetAdvanceSnap.code, 0, targetAdvanceSnap.stderr)
    const targetAdvanceJson = JSON.parse(targetAdvanceSnap.stdout)
    assert.equal(targetAdvanceJson.baseSha, BASE_2, 'GitLab baseSha tracks live target branch tip')
    assert.equal(targetAdvanceJson.mergeBaseSha, BASE_1, 'GitLab mergeBaseSha retains diff_refs.base_sha for diffing')
    assert.equal(targetAdvanceJson.baseChanged, true)
    assert.equal(targetAdvanceJson.approvalForHead, false, 'BASE_1 approval is invalidated when GitLab target branch tip advances to BASE_2')

    // Desktop fetchForgePullEvidence also reports live target branch tip BASE_2 and rejects stale BASE_1 approval:
    const prevGlTok = process.env.GITLAB_TOKEN
    const prevGlUrl = process.env.GITLAB_URL
    process.env.GITLAB_TOKEN = 'glpat-test'
    process.env.GITLAB_URL = httpOrigin
    try {
      const glEp = resolveTrustedForgeEndpoint({ origin: gitOrigin, prNumber: 7, prUrl: mrUrl })
      assert.equal(glEp?.forge, 'gitlab')
      const glSnapshot = await fetchForgePullEvidence({ endpoint: glEp! as Parameters<typeof fetchForgePullEvidence>[0]['endpoint'], userDataDir: dir, projectCwd: dir, runner: null })
      assert.equal(glSnapshot.base, BASE_2)
      const staleVerify = verifySeatOutcomeFromSnapshot({
        snapshot: glSnapshot,
        tag: '[Antigravity CLI]',
        requireExactReviewerTags: false,
        head: HEAD_1,
        base: BASE_2,
        baseMovedInGroup: true,
        roundStartedAtMs: Date.parse('2026-11-26T00:59:00Z'),
        marker: '🤖 ',
        claimedEvidenceKeys: new Set(),
      })
      assert.equal(staleVerify, null, 'Desktop GitLab verification rejects approval bound to BASE_1 after target branch tip moves to BASE_2')
    } finally {
      if (prevGlTok === undefined) delete process.env.GITLAB_TOKEN
      else process.env.GITLAB_TOKEN = prevGlTok
      if (prevGlUrl === undefined) delete process.env.GITLAB_URL
      else process.env.GITLAB_URL = prevGlUrl
    }

    // pr-approve.mjs rejects stale BASE_1 and succeeds with live target branch tip BASE_2:
    const staleGlApprove = await runNodeScript(
      PR_APPROVE,
      [mrUrl, '7', HEAD_1, BASE_1, noteFile, '--origin', gitOrigin],
      { env },
    )
    assert.notEqual(staleGlApprove.code, 0)
    const freshGlApprove = await runNodeScript(
      PR_APPROVE,
      [mrUrl, '7', HEAD_1, BASE_2, noteFile, '--origin', gitOrigin],
      { env },
    )
    assert.equal(freshGlApprove.code, 0, freshGlApprove.stderr)
    const reapprovedGlSnap = await runNodeScript(
      PR_POLL,
      ['7', stateFile, '--pr-url', mrUrl, '--origin', gitOrigin, '--snapshot', '--require-tag', '[Antigravity CLI]'],
      { env },
    )
    assert.equal(JSON.parse(reapprovedGlSnap.stdout).approvalForHead, true)

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
      seatId: 'seat-1',
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
    assert.equal(received.body?.seatId, 'seat-1')
    assert.equal(received.body?.kind, 'approved')
    assert.equal(hashSeatReceiptToken(token).length, 64)
  } finally {
    await closeServer(receiptServer)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pr-seat-receipt.mjs stops at its deadline when the desktop never answers, and says to send the receipt again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-receipt-stall-'))
  const stalled = new Set<import('node:http').ServerResponse>()
  const receiptServer = createServer((req, res) => { req.resume(); stalled.add(res) })
  const port = await listenServer(receiptServer)
  try {
    const cfgPath = join(dir, 'seat-receipt.json')
    writeFileSync(cfgPath, JSON.stringify({ port, seatToken: 'b'.repeat(64), groupId: 'grp-1', seatId: 'seat-1', cli: 'codex', generation: 'gen-1', round: 1, head: HEAD_1, base: BASE_1 }))
    const started = Date.now()
    const res = await runNodeScript(PR_RECEIPT, ['--kind', 'findings', '--id', '42', '--kind-type', 'review'], {
      env: { COPILOT_DESKTOP_SEAT_RECEIPT: cfgPath, COPILOT_DESKTOP_SEAT_RECEIPT_TIMEOUT_MS: '1500' },
    })
    assert.equal(res.code, 1, res.stdout)
    assert.match(res.stderr, /did not answer within 2 seconds\. It may still be checking the receipt: run the same command again/)
    assert.ok(Date.now() - started < 10_000, 'the helper exits at its deadline instead of waiting forever')
  } finally {
    for (const res of stalled) res.destroy()
    await closeServer(receiptServer)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pr-forge-evidence + pr-forge.mjs handle strict approval matching, untagged chatter, round acknowledgements, SSH custom ports, and unknown-host probing', async () => {
  const { evaluateRevisionApprovals, forgePaginateArray, resolveForgeEndpoint } = (await import(
    pathToFileURL(join(TOOLS_DIR, 'pr-forge.mjs')).href
  )) as PrForgeModule
  clearForgeProbeCacheForTests()

  // Transient probe failure (503 / 401) MUST throw (never cache 'unsupported') AND recover cleanly on the next call without restarting Desktop!
  let flakyProbeAttempt = 0
  const flakyGiteaServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/v1/version') {
      flakyProbeAttempt += 1
      if (flakyProbeAttempt === 1) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Service temporarily unavailable' }))
        return
      }
      if (flakyProbeAttempt === 2) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '1.22.1' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  const flakyPort = await listenServer(flakyGiteaServer)
  try {
    const flakyOrigin = `http://127.0.0.1:${flakyPort}`
    const flakyEp = resolveTrustedForgeEndpoint({
      origin: `${flakyOrigin}/daq/service.git`,
      prNumber: 12,
      prUrl: `${flakyOrigin}/daq/service/pulls/12`,
    })
    assert.equal(flakyEp?.forge, 'probe')
    await assert.rejects(
      resolveVerifiedForgeKind({ endpoint: flakyEp!, projectCwd: tmpdir(), runner: null }),
      /HTTP 503 on \/api\/v1\/version/,
      'transient 503 throws instead of caching unsupported',
    )
    await assert.rejects(
      resolveVerifiedForgeKind({ endpoint: flakyEp!, projectCwd: tmpdir(), runner: null }),
      /HTTP 401 on \/api\/v1\/version/,
      'auth error 401 throws instead of caching unsupported',
    )
    const recoveredForge = await resolveVerifiedForgeKind({ endpoint: flakyEp!, projectCwd: tmpdir(), runner: null })
    assert.equal(recoveredForge?.forge, 'gitea', 'recovers to gitea on next attempt without restarting Desktop')
  } finally {
    await closeServer(flakyGiteaServer)
  }

  // Gitea pagination with MAX_RESPONSE_ITEMS < 50 (e.g. 1 item per page + Link rel="next") loads all pages AND throws if safety cap is exceeded!
  let shortPageServerPort = 0
  const shortPageServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const origin = `http://127.0.0.1:${shortPageServerPort}`
    if (url.pathname === '/api/v1/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '1.22.0' }))
      return
    }
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
        head: { ref: 'feat/p', sha: HEAD_1, repo: { id: 1, full_name: 'daq/service' } },
        base: { ref: 'main', sha: BASE_1, repo: { id: 1, full_name: 'daq/service' } },
      }))
      return
    }
    if (url.pathname === '/api/v1/repos/daq/service/pulls/12/reviews') {
      const page = Number(url.searchParams.get('page') ?? '1')
      if (page === 1) {
        res.writeHead(200, {
          'content-type': 'application/json',
          link: `<${origin}/api/v1/repos/daq/service/pulls/12/reviews?limit=1&page=2>; rel="next", <${origin}/api/v1/repos/daq/service/pulls/12/reviews?limit=1&page=2>; rel="last"`,
        })
        res.end(JSON.stringify([
          { id: 101, state: 'COMMENT', user: { id: 7, login: 'alice' }, body: 'Non-blocking: [Claude Code] page 1 item', commit_id: HEAD_1, comments_count: 0, submitted_at: '2026-11-26T00:00:00Z' },
        ]))
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        link: `<${origin}/api/v1/repos/daq/service/pulls/12/reviews?limit=1&page=1>; rel="prev"`,
      })
      res.end(JSON.stringify([
        { id: 102, state: 'COMMENT', user: { id: 7, login: 'alice' }, body: 'Blocking: [Claude Code] page 2 item despite page 1 length < 50', commit_id: HEAD_1, comments_count: 0, submitted_at: '2026-11-26T00:01:00Z' },
      ]))
      return
    }
    if (url.pathname === '/api/v1/repos/daq/service/issues/12/comments') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([]))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  shortPageServerPort = await listenServer(shortPageServer)
  const shortDir = mkdtempSync(join(tmpdir(), 'gitea-short-page-'))
  const prevGiteaTokShort = process.env.GITEA_TOKEN
  const prevGiteaUrlShort = process.env.GITEA_URL
  const shortOrigin = `http://127.0.0.1:${shortPageServerPort}`
  process.env.GITEA_TOKEN = 'tok-short'
  process.env.GITEA_URL = shortOrigin
  try {
    const shortPrUrl = `${shortOrigin}/daq/service/pulls/12`
    const shortGitOrigin = `${shortOrigin}/daq/service.git`
    const shortSnap = await runNodeScript(
      PR_POLL,
      ['12', join(shortDir, 'state.json'), '--pr-url', shortPrUrl, '--origin', shortGitOrigin, '--snapshot'],
      { env: { GITEA_TOKEN: 'tok-short', GITEA_URL: shortOrigin } },
    )
    assert.equal(shortSnap.code, 0, shortSnap.stderr)
    const shortJson = JSON.parse(shortSnap.stdout)
    assert.deepEqual(
      shortJson.newReviews.map((r: { id: number }) => r.id),
      [101, 102],
      'pr-poll.mjs follows Gitea Link rel="next" even when page 1 returns < 50 items',
    )

    const shortEp = await resolveVerifiedForgeKind({
      endpoint: resolveTrustedForgeEndpoint({ origin: shortGitOrigin, prNumber: 12, prUrl: shortPrUrl })!,
      projectCwd: shortDir,
      runner: null,
    })
    const desktopShortSnap = await fetchForgePullEvidence({ endpoint: shortEp!, userDataDir: shortDir, projectCwd: shortDir, runner: null })
    assert.deepEqual(
      desktopShortSnap.items.filter((i) => i.kind === 'review').map((i) => i.id),
      [101, 102],
      'Desktop fetchForgePullEvidence follows Gitea Link rel="next" even when page 1 returns < 50 items',
    )

    // Exhausted safety cap when Link rel="next" still advertises more pages throws instead of returning incomplete evidence:
    await assert.rejects(
      forgePaginateArray(
        { forge: 'gitea', httpOrigin: shortOrigin },
        '/api/v1/repos/daq/service/pulls/12/reviews',
        { kind: 'token', token: 'tok-short' },
        1,
      ),
      /exceeded safety cap/,
    )
  } finally {
    if (prevGiteaTokShort === undefined) delete process.env.GITEA_TOKEN
    else process.env.GITEA_TOKEN = prevGiteaTokShort
    if (prevGiteaUrlShort === undefined) delete process.env.GITEA_URL
    else process.env.GITEA_URL = prevGiteaUrlShort
    await closeServer(shortPageServer)
    rmSync(shortDir, { recursive: true, force: true })
  }
  // Bitbucket (Cloud & Server) and Azure DevOps (Cloud & Server) return null in Desktop so seat receipts apply, and throw clearly in CLI helpers:
  for (const [origin, prUrl] of [
    ['https://bitbucket.org/workspace/repo.git', 'https://bitbucket.org/workspace/repo/pull-requests/5'],
    ['https://bitbucket.corp.example/scm/proj/repo.git', 'https://bitbucket.corp.example/scm/proj/repo/pull-requests/5'],
    ['https://dev.azure.com/org/proj/_git/repo', 'https://dev.azure.com/org/proj/_git/repo/pullrequest/5'],
    ['https://ado.corp.example/tfs/DefaultCollection/proj/_git/repo', 'https://ado.corp.example/tfs/DefaultCollection/proj/_git/repo/pullrequest/5'],
  ] as const) {
    assert.equal(resolveTrustedForgeEndpoint({ origin, prNumber: 5, prUrl }), null)
    assert.throws(() => resolveForgeEndpoint({ prInput: prUrl, originOption: origin }), /Unsupported forge/)
  }

  // Self-hosted Gitea URLs start as 'probe' until /api/v1/version confirms Gitea; unknown 404 hosts resolve to null (not Gitea!):
  const giteaEp = resolveTrustedForgeEndpoint({
    origin: 'http://omaha:3001/daq/daq-service.git',
    prNumber: 12,
    prUrl: 'http://omaha:3001/daq/daq-service/pulls/12',
  })
  assert.equal(giteaEp?.forge, 'probe')
  assert.equal(giteaEp?.httpOrigin, 'http://omaha:3001')

  const unknownServer = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  const unknownPort = await listenServer(unknownServer)
  try {
    const unknownOrigin = `http://127.0.0.1:${unknownPort}`
    const unknownEp = resolveTrustedForgeEndpoint({
      origin: `${unknownOrigin}/org/repo.git`,
      prNumber: 9,
      prUrl: `${unknownOrigin}/org/repo/pulls/9`,
    })
    assert.equal(unknownEp?.forge, 'probe')
    const verifiedUnknown = await resolveVerifiedForgeKind({ endpoint: unknownEp!, projectCwd: tmpdir(), runner: null })
    assert.equal(verifiedUnknown, null, 'unknown non-Gitea/non-GitLab server returns null instead of 404ing on Gitea API')
  } finally {
    await closeServer(unknownServer)
  }

  // SSH non-default port (ssh://git@gitea.example.com:2222/...) NEVER leaks :2222 into HTTPS origin/host:
  const sshDesktopEp = resolveTrustedForgeEndpoint({
    origin: 'ssh://git@gitea.example.com:2222/daq/daq-service.git',
    prNumber: 12,
    prUrl: null,
  })
  assert.equal(sshDesktopEp?.httpOrigin, 'https://gitea.example.com')
  assert.equal(sshDesktopEp?.host, 'gitea.example.com')

  const sshCliEp = resolveForgeEndpoint({
    prInput: '12',
    originOption: 'ssh://git@gitea.example.com:2222/daq/daq-service.git',
  })
  assert.equal(sshCliEp.httpOrigin, 'https://gitea.example.com')
  assert.equal(sshCliEp.host, 'gitea.example.com')

  // Host-prefixed repoOption ('omaha:3001/daq/daq-service') is normalized cleanly, and GitHub Enterprise '/pull/<n>' URLs infer forge 'github':
  const hostPrefixedEp = resolveForgeEndpoint({
    prInput: '12',
    repoOption: 'omaha:3001/daq/daq-service',
    prUrlOption: 'http://omaha:3001/daq/daq-service/pulls/12',
    originOption: 'http://omaha:3001/daq/daq-service.git',
  })
  assert.equal(hostPrefixedEp.repoPath, 'daq/daq-service')
  const gheEp = resolveForgeEndpoint({
    prInput: 'https://github.corp.example/org/repo/pull/42',
    originOption: 'git@github.corp.example:org/repo.git',
  })
  assert.equal(gheEp.forge, 'github')
  assert.equal(gheEp.hostname, 'github.corp.example')
  assert.equal(gheEp.repoPath, 'org/repo')

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
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_2}\n\n[Claude Code]\nold`,
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
        body: '[Claude Code]\nBlocking: null dereference on line 42',
        commitId: HEAD_1,
        createdAtMs: roundStart + 2_000,
      },
      // Clean base-bound approval from Codex PLUS a polite tagged round acknowledgement note in the same round (must stay 'approved'!):
      {
        kind: 'issue',
        id: 4,
        user: 'alice',
        userId: 7,
        body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_2}\n\n[Codex CLI]\nchecks ran`,
        commitId: null,
        createdAtMs: roundStart + 3_000,
      },
      {
        kind: 'issue',
        id: 5,
        user: 'alice',
        userId: 7,
        body: '[Codex CLI]\nRound 2: both earlier findings are verified fixed, thanks.',
        commitId: null,
        createdAtMs: roundStart + 3_500,
      },
    ],
  }

  const claimed = new Set<string>()
  const claudeOutcome = verifySeatOutcomeFromSnapshot({
    snapshot,
    tag: '[Claude Code]',
    requireExactReviewerTags: true,
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
    tag: '[Codex CLI]',
    requireExactReviewerTags: true,
    head: HEAD_1,
    base: BASE_2,
    baseMovedInGroup: true,
    roundStartedAtMs: roundStart,
    marker: '🤖 ',
    claimedEvidenceKeys: claimed,
  })
  assert.deepEqual(codexOutcome, { verdict: 'approved', claimedKeys: ['issue:4'] }, 'tagged non-finding acknowledgement note does not downgrade approval')

  // Findings review naming head SHA + the word "approved" MUST NEVER match approval in either Desktop or pr-forge.mjs!
  for (const nonApprovalBody of [
    `[Claude Code]\nReview of ${HEAD_1}.\n\n**Blocking**: the approved-seat gate is wrong`,
    `this cannot be approved at ${HEAD_1} until fixed`,
    `Approved at ${HEAD_1}\nReviewed base: ${BASE_1}\n\nNon-blocking: [Claude Code] still needs a null check`,
    `> Approved at ${HEAD_1}\nNot approved yet at ${HEAD_1}`,
  ]) {
    assert.equal(
      isItemExplicitApproval(
        { kind: 'issue', id: 9, user: 'alice', userId: 7, body: nonApprovalBody, commitId: null, createdAtMs: roundStart },
        HEAD_1,
        BASE_1,
        false,
      ),
      false,
      `Desktop rejected non-approval: ${nonApprovalBody.slice(0, 48)}`,
    )
    const cliEval = evaluateRevisionApprovals({
      reviews: [],
      inline: [],
      issue: [{ id: 9, user: 'alice', userId: 7, body: nonApprovalBody }],
      headSha: HEAD_1,
      baseSha: BASE_1,
      actorId: 7,
      actorLogin: 'alice',
    })
    assert.equal(cliEval.approvalForHead, false, `pr-forge.mjs rejected non-approval: ${nonApprovalBody.slice(0, 48)}`)
  }

  // Findings review naming head SHA + "approved" settles as 'findings' (never 'approved'):
  const findingsWithApprovedWord = verifySeatOutcomeFromSnapshot({
    snapshot: {
      ...snapshot,
      items: [
        {
          kind: 'review',
          id: 55,
          state: 'COMMENTED',
          user: 'alice',
          userId: 7,
          body: `[Claude Code]\nReview of ${HEAD_1}.\n\n**Blocking**: the approved-seat gate is wrong`,
          commitId: HEAD_1,
          createdAtMs: roundStart + 1_000,
        },
      ],
    },
    tag: '[Claude Code]',
    requireExactReviewerTags: true,
    head: HEAD_1,
    base: BASE_2,
    baseMovedInGroup: false,
    roundStartedAtMs: roundStart,
    marker: '🤖 ',
    claimedEvidenceKeys: new Set(),
  })
  assert.deepEqual(findingsWithApprovedWord, { verdict: 'findings', claimedKeys: ['review:55'] })

  // With 1 required seat, untagged author conversation chatter ("Testing this on macOS now") neither turns a silent exit into 'findings' nor overrides a valid approval!
  const singleSeatSilentWithChatter = verifySeatOutcomeFromSnapshot({
    snapshot: {
      ...snapshot,
      items: [
        {
          kind: 'issue',
          id: 70,
          user: 'alice',
          userId: 7,
          body: 'Testing this on macOS now',
          commitId: null,
          createdAtMs: roundStart + 1_000,
        },
      ],
    },
    tag: '[Claude Code]',
    requireExactReviewerTags: false,
    head: HEAD_1,
    base: BASE_2,
    baseMovedInGroup: false,
    roundStartedAtMs: roundStart,
    marker: '🤖 ',
    claimedEvidenceKeys: new Set(),
  })
  assert.equal(singleSeatSilentWithChatter, null, 'untagged conversation chatter does not turn silent single seat into findings')

  const singleSeatApprovedWithChatter = verifySeatOutcomeFromSnapshot({
    snapshot: {
      ...snapshot,
      items: [
        {
          kind: 'issue',
          id: 70,
          user: 'alice',
          userId: 7,
          body: 'Testing this on macOS now',
          commitId: null,
          createdAtMs: roundStart + 1_000,
        },
        {
          kind: 'issue',
          id: 71,
          user: 'alice',
          userId: 7,
          body: `Approved at ${HEAD_1}\nReviewed base: ${BASE_2}\n\n[Claude Code] all green`,
          commitId: null,
          createdAtMs: roundStart + 2_000,
        },
      ],
    },
    tag: '[Claude Code]',
    requireExactReviewerTags: false,
    head: HEAD_1,
    base: BASE_2,
    baseMovedInGroup: true,
    roundStartedAtMs: roundStart,
    marker: '🤖 ',
    claimedEvidenceKeys: new Set(),
  })
  assert.deepEqual(singleSeatApprovedWithChatter, { verdict: 'approved', claimedKeys: ['issue:71'] })

  // Grouped review with tagged parent summary and untagged labeled inline finding settles automatically with NO receipt!
  const groupedNoReceipt = verifySeatOutcomeFromSnapshot({
    snapshot: {
      ...snapshot,
      items: [
        {
          kind: 'review',
          id: 80,
          state: 'COMMENTED',
          user: 'alice',
          userId: 7,
          body: '[Codex CLI]\nReview summary for this round.',
          commitId: HEAD_1,
          createdAtMs: roundStart + 1_000,
        },
        {
          kind: 'inline',
          id: 81,
          parentReviewId: 80,
          user: 'alice',
          userId: 7,
          body: '**Blocking**: missing null guard on response payload',
          commitId: HEAD_1,
          createdAtMs: roundStart + 1_000,
        },
      ],
    },
    tag: '[Codex CLI]',
    requireExactReviewerTags: true,
    head: HEAD_1,
    base: BASE_2,
    baseMovedInGroup: false,
    roundStartedAtMs: roundStart,
    marker: '🤖 ',
    claimedEvidenceKeys: new Set(),
    receipt: null,
  })
  assert.deepEqual(groupedNoReceipt, { verdict: 'findings', claimedKeys: ['inline:81'] }, 'inherits reviewer tag attribution from eligible parentReviewId without requiring a receipt')

  // Forge discovery MUST send ZERO Authorization headers (never leaking GH_ENTERPRISE_TOKEN / GITEA_TOKEN / GITLAB_TOKEN to unverified hosts),
  // AND host-bound ghConfigMayKnowHost MUST NOT admit unrelated hosts solely because a global Enterprise token is present!
  const probeAuthHeadersSeen: Array<{ path: string; authorization: string | undefined; privateToken: string | undefined }> = []
  const gheServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    probeAuthHeadersSeen.push({
      path: url.pathname,
      authorization: req.headers.authorization,
      privateToken: typeof req.headers['private-token'] === 'string' ? req.headers['private-token'] : undefined,
    })
    if (url.pathname === '/api/v3/meta') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-github-enterprise-version': '3.14.0',
      })
      res.end(JSON.stringify({ verifiable_password_authentication: true, installed_version: '3.14.0' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  const ghePort = await listenServer(gheServer)
  const savedEnv = {
    GH_HOST: process.env.GH_HOST,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
    GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN,
    GITEA_TOKEN: process.env.GITEA_TOKEN,
    GITLAB_TOKEN: process.env.GITLAB_TOKEN,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  const emptyGhCfg = mkdtempSync(join(tmpdir(), 'empty-gh-cfg-'))
  try {
    delete process.env.GH_HOST
    process.env.GH_ENTERPRISE_TOKEN = 'ghp_enterprise_secret_never_leak'
    process.env.GITHUB_ENTERPRISE_TOKEN = 'ghp_enterprise_alt_never_leak'
    process.env.GITEA_TOKEN = 'gitea_secret_never_leak'
    process.env.GITLAB_TOKEN = 'gitlab_secret_never_leak'
    process.env.GH_CONFIG_DIR = emptyGhCfg
    process.env.APPDATA = emptyGhCfg
    process.env.XDG_CONFIG_HOME = emptyGhCfg

    // Presence of global GH_ENTERPRISE_TOKEN MUST NOT admit arbitrary hosts in ghConfigMayKnowHost without GH_HOST or hosts.yml!
    assert.equal(ghConfigMayKnowHost('unrelated.corp.example'), false, 'global Enterprise token does not admit unrelated host')
    process.env.GH_HOST = 'ghe.corp.example'
    assert.equal(ghConfigMayKnowHost('ghe.corp.example'), true, 'explicit GH_HOST admits only the matching host')
    assert.equal(ghConfigMayKnowHost('unrelated.corp.example'), false)
    delete process.env.GH_HOST

    // ghEnterpriseChildEnv binds ambient Enterprise tokens ONLY to an explicitly matching GH_HOST and strips them for any other/unbound host!
    const matchingEnv = ghEnterpriseChildEnv('ghe1.corp.example', {
      GH_HOST: 'ghe1.corp.example',
      GH_ENTERPRISE_TOKEN: 'ent-tok-1',
      GITHUB_ENTERPRISE_TOKEN: 'ent-tok-2',
    })
    assert.equal(matchingEnv.GH_ENTERPRISE_TOKEN, 'ent-tok-1')
    assert.equal(matchingEnv.GITHUB_ENTERPRISE_TOKEN, 'ent-tok-2')

    const mismatchedEnv = ghEnterpriseChildEnv('ghe2.corp.example', {
      GH_HOST: 'ghe1.corp.example',
      GH_ENTERPRISE_TOKEN: 'ent-tok-1',
      GITHUB_ENTERPRISE_TOKEN: 'ent-tok-2',
    })
    assert.equal(mismatchedEnv.GH_ENTERPRISE_TOKEN, undefined, 'strips GH_ENTERPRISE_TOKEN for non-matching Enterprise host')
    assert.equal(mismatchedEnv.GITHUB_ENTERPRISE_TOKEN, undefined, 'strips GITHUB_ENTERPRISE_TOKEN for non-matching Enterprise host')

    const unboundEnv = ghEnterpriseChildEnv('ghe1.corp.example', {
      GH_ENTERPRISE_TOKEN: 'ent-tok-1',
      GITHUB_ENTERPRISE_TOKEN: 'ent-tok-2',
    })
    assert.equal(unboundEnv.GH_ENTERPRISE_TOKEN, undefined, 'strips unbound global GH_ENTERPRISE_TOKEN when GH_HOST is unset')
    assert.equal(unboundEnv.GITHUB_ENTERPRISE_TOKEN, undefined, 'strips unbound global GITHUB_ENTERPRISE_TOKEN when GH_HOST is unset')

    // Unauthenticated host-pinned /api/v3/meta probe identifies GitHub Enterprise WITHOUT sending any Authorization / Private-Token header!
    const gheOrigin = `http://127.0.0.1:${ghePort}`
    const gheProbeEp = resolveTrustedForgeEndpoint({
      origin: `${gheOrigin}/org/repo.git`,
      prNumber: 42,
      prUrl: `${gheOrigin}/org/repo/pull/42`,
    })
    assert.equal(gheProbeEp?.forge, 'probe')
    const verifiedGhe = await resolveVerifiedForgeKind({ endpoint: gheProbeEp!, projectCwd: tmpdir(), runner: null })
    assert.equal(verifiedGhe?.forge, 'github', 'host-pinned unauthenticated /api/v3/meta probe identifies GitHub Enterprise')
    assert.ok(probeAuthHeadersSeen.length >= 2, 'probed /api/v1/version and /api/v3/meta')
    for (const seen of probeAuthHeadersSeen) {
      assert.equal(seen.authorization, undefined, `discovery probe ${seen.path} sent no Authorization header`)
      assert.equal(seen.privateToken, undefined, `discovery probe ${seen.path} sent no Private-Token header`)
    }

    // Gitea REQUIRE_SIGNIN_VIEW=true: first /api/v1/version probe is unauthenticated (gets 403), then retries ONLY with host-bound
    // `git credential fill` credential (NEVER process-wide GITEA_TOKEN!), AND subsequent evidence reads (`fetchForgePullEvidence` + `pr-poll.mjs`)
    // ALSO use the host-scoped Git credential instead of leaking ambient `GITEA_TOKEN`!
    const signinVersionAuthSeen: Array<string | undefined> = []
    const signinEvidenceAuthSeen: Array<{ path: string; authorization: string | undefined }> = []
    const expectedBasic = `Basic ${Buffer.from('alice:host-bound-secret', 'utf8').toString('base64')}`
    const signinGiteaServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/v1/version') {
        signinVersionAuthSeen.push(req.headers.authorization)
        if (req.headers.authorization === expectedBasic) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ version: '1.22.0' }))
          return
        }
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Only signed in user is allowed to call APIs.' }))
        return
      }
      signinEvidenceAuthSeen.push({ path: url.pathname, authorization: req.headers.authorization })
      if (req.headers.authorization !== expectedBasic) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Host-bound credential required; ambient token rejected.' }))
        return
      }
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
          head: { ref: 'feat/p', sha: HEAD_1, repo: { id: 1, full_name: 'daq/service' } },
          base: { ref: 'main', sha: BASE_1, repo: { id: 1, full_name: 'daq/service' } },
        }))
        return
      }
      if (url.pathname === '/api/v1/repos/daq/service/pulls/12/reviews' || url.pathname === '/api/v1/repos/daq/service/issues/12/comments') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([]))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'Not Found' }))
    })
    const signinPort = await listenServer(signinGiteaServer)
    const prevGitCfgGlobal = process.env.GIT_CONFIG_GLOBAL
    const prevGitCfgNoSys = process.env.GIT_CONFIG_NOSYSTEM
    const prevGiteaUrl = process.env.GITEA_URL
    try {
      const credsFile = join(emptyGhCfg, 'git-creds').replace(/\\/g, '/')
      const gitCfgFile = join(emptyGhCfg, 'gitconfig')
      writeFileSync(credsFile, `http://alice:host-bound-secret@127.0.0.1:${signinPort}\n`)
      writeFileSync(gitCfgFile, `[credential]\n\thelper = store --file=${credsFile}\n`)
      process.env.GIT_CONFIG_GLOBAL = gitCfgFile
      process.env.GIT_CONFIG_NOSYSTEM = '1'
      const signinOrigin = `http://127.0.0.1:${signinPort}`
      const signinPrUrl = `${signinOrigin}/daq/service/pulls/12`
      const signinGitOrigin = `${signinOrigin}/daq/service.git`
      const signinEp = resolveTrustedForgeEndpoint({
        origin: signinGitOrigin,
        prNumber: 12,
        prUrl: signinPrUrl,
      })
      assert.equal(signinEp?.forge, 'probe')
      const verifiedSignin = await resolveVerifiedForgeKind({
        endpoint: signinEp!,
        projectCwd: emptyGhCfg,
        runner: {} as GitRunner,
      })
      assert.equal(verifiedSignin?.forge, 'gitea', 'REQUIRE_SIGNIN_VIEW Gitea recovers via host-bound git credential after 403')
      assert.deepEqual(signinVersionAuthSeen, [undefined, expectedBasic], 'first probe unauthenticated, retry uses host-bound git credential only (never GITEA_TOKEN)')

      // Desktop evidence read ALSO sends host-bound git credential (NEVER ambient GITEA_TOKEN):
      const privateSnap = await fetchForgePullEvidence({
        endpoint: verifiedSignin!,
        userDataDir: emptyGhCfg,
        projectCwd: emptyGhCfg,
        runner: {} as GitRunner,
      })
      assert.equal(privateSnap.head, HEAD_1)
      assert.ok(signinEvidenceAuthSeen.length >= 3)
      for (const reqSeen of signinEvidenceAuthSeen) {
        assert.equal(reqSeen.authorization, expectedBasic, `Desktop evidence GET ${reqSeen.path} used host-bound git credential, never ambient GITEA_TOKEN`)
      }

      // Standalone pr-poll.mjs ALSO prefers host-bound git credential over ambient GITEA_TOKEN:
      const beforePollCount = signinEvidenceAuthSeen.length
      const privatePollRes = await runNodeScript(
        PR_POLL,
        ['12', join(emptyGhCfg, 'private-gitea-state.json'), '--pr-url', signinPrUrl, '--origin', signinGitOrigin, '--snapshot'],
        {
          env: {
            GIT_CONFIG_GLOBAL: gitCfgFile,
            GIT_CONFIG_NOSYSTEM: '1',
            GITEA_TOKEN: 'gitea_secret_never_leak',
          },
        },
      )
      assert.equal(privatePollRes.code, 0, privatePollRes.stderr)
      assert.ok(signinEvidenceAuthSeen.length > beforePollCount)
      for (const reqSeen of signinEvidenceAuthSeen.slice(beforePollCount)) {
        assert.equal(reqSeen.authorization, expectedBasic, `pr-poll.mjs GET ${reqSeen.path} used host-bound git credential, never ambient GITEA_TOKEN`)
      }

      // 1) Destination with NO stored Git credential and an UNBOUND ambient GITEA_TOKEN (no GITEA_URL/GITEA_HOST):
      // BOTH Desktop fetchForgePullEvidence AND standalone pr-poll.mjs MUST make unauthenticated requests (NEVER send unbound ambient GITEA_TOKEN!),
      // and pr-approve.mjs MUST fail fast without leaking the unbound token!
      writeFileSync(credsFile, '')
      delete process.env.GITEA_URL
      delete process.env.GITEA_HOST
      delete process.env.FORGEJO_URL
      delete process.env.FORGEJO_HOST
      delete process.env.FORGEJO_TOKEN
      const beforeUnboundDesktop = signinEvidenceAuthSeen.length
      await assert.rejects(
        fetchForgePullEvidence({
          endpoint: verifiedSignin!,
          userDataDir: emptyGhCfg,
          projectCwd: emptyGhCfg,
          runner: {} as GitRunner,
        }),
        /failed \(401\)/,
      )
      assert.ok(signinEvidenceAuthSeen.length > beforeUnboundDesktop)
      for (const reqSeen of signinEvidenceAuthSeen.slice(beforeUnboundDesktop)) {
        assert.equal(reqSeen.authorization, undefined, `Desktop did NOT send unbound ambient GITEA_TOKEN to ${reqSeen.path}`)
      }

      const beforeUnboundPoll = signinEvidenceAuthSeen.length
      const unboundPollRes = await runNodeScript(
        PR_POLL,
        ['12', join(emptyGhCfg, 'unbound-gitea-state.json'), '--pr-url', signinPrUrl, '--origin', signinGitOrigin, '--snapshot'],
        {
          env: {
            GIT_CONFIG_GLOBAL: gitCfgFile,
            GIT_CONFIG_NOSYSTEM: '1',
            GITEA_TOKEN: 'gitea_secret_never_leak',
            GITEA_URL: '',
            GITEA_HOST: '',
            FORGEJO_TOKEN: 'forgejo_secret_never_leak',
            FORGEJO_URL: '',
            FORGEJO_HOST: '',
          },
        },
      )
      assert.notEqual(unboundPollRes.code, 0)
      assert.ok(signinEvidenceAuthSeen.length > beforeUnboundPoll)
      for (const reqSeen of signinEvidenceAuthSeen.slice(beforeUnboundPoll)) {
        assert.equal(reqSeen.authorization, undefined, `pr-poll.mjs did NOT send unbound ambient GITEA_TOKEN/FORGEJO_TOKEN to ${reqSeen.path}`)
      }

      const approveNoteFile = join(emptyGhCfg, 'unbound-approve-note.md')
      writeFileSync(approveNoteFile, '[Codex CLI] Verified.\n')
      const beforeUnboundApprove = signinEvidenceAuthSeen.length
      const unboundApproveRes = await runNodeScript(
        PR_APPROVE,
        [signinPrUrl, '12', HEAD_1, BASE_1, approveNoteFile, '--origin', signinGitOrigin],
        {
          env: {
            GIT_CONFIG_GLOBAL: gitCfgFile,
            GIT_CONFIG_NOSYSTEM: '1',
            GITEA_TOKEN: 'gitea_secret_never_leak',
            GITEA_URL: '',
            GITEA_HOST: '',
          },
        },
      )
      assert.notEqual(unboundApproveRes.code, 0)
      assert.match(unboundApproveRes.stderr, /No credentials available/)
      assert.equal(signinEvidenceAuthSeen.length, beforeUnboundApprove, 'pr-approve.mjs sends zero requests when only an unbound ambient token exists')

      // 2) Distinct configured Gitea AND Forgejo instances simultaneously in the same environment:
      // Each instance MUST receive ONLY its own product's token (never GITEA_TOKEN sent to Forgejo or FORGEJO_TOKEN sent to Gitea)!
      const forgejoAuthSeen: Array<{ path: string; authorization: string | undefined }> = []
      const giteaAuthSeen: Array<{ path: string; authorization: string | undefined }> = []
      const makeTokenCheckedServer = (
        expectedTok: string,
        log: Array<{ path: string; authorization: string | undefined }>,
      ) => createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        log.push({ path: url.pathname, authorization: req.headers.authorization })
        if (req.headers.authorization !== `token ${expectedTok}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ message: `Expected token ${expectedTok}` }))
          return
        }
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
            head: { ref: 'feat/p', sha: HEAD_1, repo: { id: 1, full_name: 'daq/service' } },
            base: { ref: 'main', sha: BASE_1, repo: { id: 1, full_name: 'daq/service' } },
          }))
          return
        }
        if (url.pathname === '/api/v1/repos/daq/service/pulls/12/reviews' || url.pathname === '/api/v1/repos/daq/service/issues/12/comments') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify([]))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Not Found' }))
      })
      const giteaBoundServer = makeTokenCheckedServer('gitea-only-tok', giteaAuthSeen)
      const forgejoBoundServer = makeTokenCheckedServer('forgejo-only-tok', forgejoAuthSeen)
      const giteaBoundPort = await listenServer(giteaBoundServer)
      const forgejoBoundPort = await listenServer(forgejoBoundServer)
      const prevGiteaHost = process.env.GITEA_HOST
      const prevForgejoTok = process.env.FORGEJO_TOKEN
      const prevForgejoUrl = process.env.FORGEJO_URL
      const prevForgejoHost = process.env.FORGEJO_HOST
      try {
        const giteaBoundOrigin = `http://127.0.0.1:${giteaBoundPort}`
        const forgejoBoundOrigin = `http://127.0.0.1:${forgejoBoundPort}`
        process.env.GITEA_TOKEN = 'gitea-only-tok'
        process.env.GITEA_URL = giteaBoundOrigin
        process.env.FORGEJO_TOKEN = 'forgejo-only-tok'
        process.env.FORGEJO_URL = forgejoBoundOrigin

        const giteaBoundEp = {
          ...resolveTrustedForgeEndpoint({
            origin: `${giteaBoundOrigin}/daq/service.git`,
            prNumber: 12,
            prUrl: `${giteaBoundOrigin}/daq/service/pulls/12`,
          })!,
          forge: 'gitea' as const,
        }
        const forgejoBoundEp = {
          ...resolveTrustedForgeEndpoint({
            origin: `${forgejoBoundOrigin}/daq/service.git`,
            prNumber: 12,
            prUrl: `${forgejoBoundOrigin}/daq/service/pulls/12`,
          })!,
          forge: 'gitea' as const,
        }

        // Desktop: Gitea gets gitea-only-tok, Forgejo gets forgejo-only-tok (NEVER GITEA_TOKEN!), unconfigured 3rd host gets NO auth header!
        const desktopGitea = await fetchForgePullEvidence({ endpoint: giteaBoundEp, userDataDir: emptyGhCfg, projectCwd: emptyGhCfg, runner: {} as GitRunner })
        assert.equal(desktopGitea.head, HEAD_1)
        const desktopForgejo = await fetchForgePullEvidence({ endpoint: forgejoBoundEp, userDataDir: emptyGhCfg, projectCwd: emptyGhCfg, runner: {} as GitRunner })
        assert.equal(desktopForgejo.head, HEAD_1)
        assert.ok(giteaAuthSeen.length >= 3)
        assert.ok(forgejoAuthSeen.length >= 3)
        for (const r of giteaAuthSeen) assert.equal(r.authorization, 'token gitea-only-tok')
        for (const r of forgejoAuthSeen) assert.equal(r.authorization, 'token forgejo-only-tok')

        // Standalone pr-poll.mjs: same strict per-token origin isolation!
        const dualEnv = {
          GIT_CONFIG_GLOBAL: gitCfgFile,
          GIT_CONFIG_NOSYSTEM: '1',
          GITEA_TOKEN: 'gitea-only-tok',
          GITEA_URL: giteaBoundOrigin,
          FORGEJO_TOKEN: 'forgejo-only-tok',
          FORGEJO_URL: forgejoBoundOrigin,
        }
        const giteaBeforePoll = giteaAuthSeen.length
        const pollGitea = await runNodeScript(
          PR_POLL,
          ['12', join(emptyGhCfg, 'dual-gitea-state.json'), '--pr-url', `${giteaBoundOrigin}/daq/service/pulls/12`, '--origin', `${giteaBoundOrigin}/daq/service.git`, '--snapshot'],
          { env: dualEnv },
        )
        assert.equal(pollGitea.code, 0, pollGitea.stderr)
        for (const r of giteaAuthSeen.slice(giteaBeforePoll)) assert.equal(r.authorization, 'token gitea-only-tok')

        const forgejoBeforePoll = forgejoAuthSeen.length
        const pollForgejo = await runNodeScript(
          PR_POLL,
          ['12', join(emptyGhCfg, 'dual-forgejo-state.json'), '--pr-url', `${forgejoBoundOrigin}/daq/service/pulls/12`, '--origin', `${forgejoBoundOrigin}/daq/service.git`, '--snapshot'],
          { env: dualEnv },
        )
        assert.equal(pollForgejo.code, 0, pollForgejo.stderr)
        for (const r of forgejoAuthSeen.slice(forgejoBeforePoll)) assert.equal(r.authorization, 'token forgejo-only-tok')

        // Third unrelated server on another port of 127.0.0.1 receives NEITHER GITEA_TOKEN NOR FORGEJO_TOKEN!
        const beforeThirdHost = signinEvidenceAuthSeen.length
        await assert.rejects(
          fetchForgePullEvidence({
            endpoint: verifiedSignin!,
            userDataDir: emptyGhCfg,
            projectCwd: emptyGhCfg,
            runner: {} as GitRunner,
          }),
          /failed \(401\)/,
        )
        for (const reqSeen of signinEvidenceAuthSeen.slice(beforeThirdHost)) {
          assert.equal(reqSeen.authorization, undefined, `third host received neither GITEA_TOKEN nor FORGEJO_TOKEN on ${reqSeen.path}`)
        }
      } finally {
        if (prevGiteaHost === undefined) delete process.env.GITEA_HOST
        else process.env.GITEA_HOST = prevGiteaHost
        if (prevForgejoTok === undefined) delete process.env.FORGEJO_TOKEN
        else process.env.FORGEJO_TOKEN = prevForgejoTok
        if (prevForgejoUrl === undefined) delete process.env.FORGEJO_URL
        else process.env.FORGEJO_URL = prevForgejoUrl
        if (prevForgejoHost === undefined) delete process.env.FORGEJO_HOST
        else process.env.FORGEJO_HOST = prevForgejoHost
        await closeServer(giteaBoundServer)
        await closeServer(forgejoBoundServer)
      }
    } finally {
      if (prevGiteaUrl === undefined) delete process.env.GITEA_URL
      else process.env.GITEA_URL = prevGiteaUrl
      if (prevGitCfgGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = prevGitCfgGlobal
      if (prevGitCfgNoSys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
      else process.env.GIT_CONFIG_NOSYSTEM = prevGitCfgNoSys
      await closeServer(signinGiteaServer)
    }
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await closeServer(gheServer)
    rmSync(emptyGhCfg, { recursive: true, force: true })
  }
})

test('ghPagedItems reads the items out of a gh api --paginate --slurp result, which is an array of pages', () => {
  // The real shape: one array per request, here two pages of reviews.
  const slurped = [[{ id: 6079401408, body: 'Approved at abc [Claude Code]' }, { id: 6079408851, body: '[Codex CLI] **Blocking**' }], [{ id: 6079513017, body: 'third' }]]
  assert.deepEqual(ghPagedItems(slurped).map((item) => (item as { id: number }).id), [6079401408, 6079408851, 6079513017])
  // One page, and no items at all.
  assert.deepEqual(ghPagedItems([[{ id: 1 }]]), [{ id: 1 }])
  assert.deepEqual(ghPagedItems([[]]), [])
  assert.deepEqual(ghPagedItems([]), [])
  // A list that is already the items stays as it is; anything else is no items.
  assert.deepEqual(ghPagedItems([{ id: 1 }, { id: 2 }]), [{ id: 1 }, { id: 2 }])
  assert.deepEqual(ghPagedItems(null), [])
  assert.deepEqual(ghPagedItems({ message: 'Not Found' }), [])
})

test('a remaining seat in a multi-seat run needs its own unquoted tag and exact receipt', async () => {
  const first = '[Codex CLI 1 r1234]'
  const second = '[Codex CLI 2 r1234]'
  const stamp = Date.now()
  const ownApproval = { kind: 'review' as const, id: 1, state: 'APPROVED', user: 'alice', userId: 7, body: first, commitId: HEAD_1, createdAtMs: stamp }
  const wrongApproval = { ...ownApproval, id: 2, body: second }
  const quotedApproval = { ...ownApproval, id: 3, body: '> ' + first }
  const mentionedApproval = { ...wrongApproval, id: 5, body: second + '\nDiscussed with ' + first + ' in the previous round.' }
  const wrongFinding = { ...wrongApproval, id: 4, state: 'CHANGES_REQUESTED', body: second + '\nBlocking: wrong seat' }
  const snapshot: ForgePullEvidenceSnapshot = {
    forge: 'github', open: true, merged: false, sameRepo: true, head: HEAD_1, base: BASE_1, actorId: 7, actorLogin: 'alice',
    items: [wrongApproval, quotedApproval, mentionedApproval, wrongFinding, ownApproval],
  }
  const options = {
    snapshot, tag: first, requireExactReviewerTags: true, head: HEAD_1, base: BASE_1, baseMovedInGroup: false,
    roundStartedAtMs: stamp, marker: '🤖 ', claimedEvidenceKeys: new Set<string>(),
  }
  assert.deepEqual(verifySeatOutcomeFromSnapshot(options), { verdict: 'approved', claimedKeys: ['review:1'] })
  assert.equal(verifySeatOutcomeFromSnapshot({ ...options, receipt: { kind: 'approved', remoteId: 2, itemType: 'review' } }), null)
  assert.equal(verifySeatOutcomeFromSnapshot({ ...options, receipt: { kind: 'findings', remoteId: 4, itemType: 'review' } }), null)
  assert.equal(verifySeatOutcomeFromSnapshot({ ...options, claimedEvidenceKeys: new Set(['review:1']) }), null)

  const forge = await import(pathToFileURL(join(TOOLS_DIR, 'pr-forge.mjs')).href) as PrForgeModule
  const poll = {
    inline: [], issue: [], reviews: [{ ...wrongApproval, body: quotedApproval.body }, mentionedApproval],
    headSha: HEAD_1, baseSha: BASE_1, actorId: 7, requiredTags: [first],
  }
  assert.equal(forge.evaluateRevisionApprovals(poll).approvalForHead, true, 'legacy formal approval is allowed for an original singleton')
  assert.equal(forge.evaluateRevisionApprovals({ ...poll, requireExactReviewerTags: true }).approvalForHead, false)
})
