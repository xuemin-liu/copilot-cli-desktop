import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { GitRunner, resolveGitExecutable } from './git-runner.js'
import { receiptTag, type PostReceipt } from './pr-loop-posts.js'
import { makeReviewerArea, planReviewerArea, removeReviewerArea } from './pr-review-launch.js'
import { PR_REVIEWER_TOKEN_ENV } from './pr-reviewer-mcp.js'
import {
  buildClaudeMcpConfigJson,
  buildClaudeReviewerLaunch,
  buildCodexReviewerLaunch,
  cleanupReviewerSeatCredentials,
  materialFeedbackSignature,
  prepareCodexReviewerHome,
  prFeedbackSignature,
  prReviewAndFixRequest,
  readReviewerDiffPage,
  readSeatFeedbackPage,
  TempReviewerRegistry,
  validateSeatReviewSubmission,
  type ReceiptReader,
} from './pr-temp-reviewers.js'
import type { GithubSnapshot } from './workflow-github.js'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

function makeSnapshot(overrides: Partial<GithubSnapshot> = {}): GithubSnapshot {
  return {
    repository: 'owner/repo',
    headRepository: 'owner/repo',
    baseRepository: 'owner/repo',
    branch: 'feat/test',
    head: HEAD,
    base: BASE,
    open: true,
    merged: false,
    checks: 'absent',
    author: 42,
    feedback: [],
    reviews: [],
    ...overrides,
  }
}

test('prReviewAndFixRequest accepts explicit combined requests and rejects plain review/fix or negations', () => {
  assert.deepEqual(prReviewAndFixRequest('/review-and-fix-pr'), { number: null, repository: null })
  assert.deepEqual(prReviewAndFixRequest('/review-and-fix-pr 18'), { number: 18, repository: null })
  assert.deepEqual(prReviewAndFixRequest('review and fix PR 42'), { number: 42, repository: null })
  assert.deepEqual(prReviewAndFixRequest('please review and fix my PR'), { number: null, repository: null })
  assert.deepEqual(
    prReviewAndFixRequest('start temp reviewers and fix https://github.com/octo/demo/pull/99'),
    { number: 99, repository: 'octo/demo' },
  )

  // Plain single-role commands must stay with their existing handlers
  assert.equal(prReviewAndFixRequest('review PR 42'), null)
  assert.equal(prReviewAndFixRequest('fix PR 42'), null)
  assert.equal(prReviewAndFixRequest('do not review and fix PR 42'), null)
  assert.equal(prReviewAndFixRequest('review and fix PR 42 and PR 43'), null)
})

test('CLI launch builders verify flags, isolate CODEX_HOME outside user home, and keep bearer tokens out of argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-test-'))
  try {
    const fakeUserHome = join(dir, 'user-home')
    const fakeRealCodex = join(fakeUserHome, '.codex')
    const seatHome = join(dir, 'seat-area', 'home')
    const checkoutPath = join(dir, 'seat-area', 'checkout')
    mkdirSync(fakeRealCodex, { recursive: true })
    mkdirSync(seatHome, { recursive: true })
    mkdirSync(checkoutPath, { recursive: true })

    // Populate user's real ~/.codex with auth.json PLUS dangerous MCP servers, hooks, and profiles:
    writeFileSync(join(fakeRealCodex, 'auth.json'), '{"access_token":"tok"}')
    writeFileSync(
      join(fakeRealCodex, 'config.toml'),
      '[mcp_servers.node_repl]\ncommand = "node"\n[mcp_servers.copilot-meeting]\nurl = "http://127.0.0.1:39217/mcp"\n',
    )
    writeFileSync(join(fakeRealCodex, 'hooks.json'), '{"hooks":[]}')

    const { codexHome: isolatedCodexHome, authSync } = await prepareCodexReviewerHome({
      areaHome: seatHome,
      realCodexHome: fakeRealCodex,
      checkoutPath,
    })
    assert.ok(authSync, 'authSync returned when real auth.json exists')
    assert.equal(isolatedCodexHome.startsWith(resolve(fakeUserHome)), false, 'CODEX_HOME must live outside user home')
    assert.equal(existsSync(join(isolatedCodexHome, 'auth.json')), true, 'auth.json copied to isolated CODEX_HOME')
    assert.equal(existsSync(join(isolatedCodexHome, 'hooks.json')), false, 'user hooks never copied')
    const isolatedConfig = readFileSync(join(isolatedCodexHome, 'config.toml'), 'utf8')
    assert.doesNotMatch(isolatedConfig, /node_repl|copilot-meeting/, 'user MCP servers excluded from isolated CODEX_HOME')
    assert.match(isolatedConfig, /trust_level = "trusted"/)

    const claudeHelp = '--session-id --restricted --disallowedTools --strict-mcp-config --mcp-config --allowedTools --model'
    const claude = buildClaudeReviewerLaunch({
      help: claudeHelp,
      sessionId: '11111111-1111-4111-8111-111111111111',
      mcpConfigPath: '/tmp/claude-mcp.json',
      prompt: 'Review PR',
      model: 'sonnet',
    })
    assert.ok(claude.args.includes('--restricted'))
    assert.ok(claude.args.includes('--strict-mcp-config'))
    assert.equal(claude.args.some((arg) => arg.includes('secret-token')), false)
    const json = JSON.parse(buildClaudeMcpConfigJson('http://127.0.0.1:9999/pr-reviewer-mcp', 'secret-token'))
    assert.equal(json.mcpServers['copilot-pr-reviewer'].headers.Authorization, 'Bearer secret-token')

    const codexHelp = '--no-daemon --sandbox --ask-for-approval --config --model'
    const codex = buildCodexReviewerLaunch({
      help: codexHelp,
      mcpUrl: 'http://127.0.0.1:9999/pr-reviewer-mcp',
      bearerToken: 'codex-secret-token',
      codexHome: isolatedCodexHome,
      prompt: 'Review PR',
    })
    assert.ok(codex.args.includes('--no-daemon'))
    assert.ok(codex.args.includes('read-only'))
    assert.equal(codex.args.some((arg) => arg.includes('codex-secret-token')), false, 'secret never in argv')
    assert.equal(codex.envAdditions[PR_REVIEWER_TOKEN_ENV], 'codex-secret-token')
    assert.equal(codex.envAdditions.CODEX_HOME, resolve(isolatedCodexHome))
    assert.equal(codex.envAdditions.CODEX_HOME!.startsWith(resolve(fakeUserHome)), false)

    assert.throws(() => buildClaudeReviewerLaunch({
      help: '--session-id',
      sessionId: '11111111-1111-4111-8111-111111111111',
      mcpConfigPath: '/tmp/x.json',
      prompt: 'Review',
    }), /required reviewer flags/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TempReviewerRegistry invalidates prior approvals when new actionable feedback arrives on the same head and base', () => {
  const registry = new TempReviewerRegistry()
  const snap0 = makeSnapshot()
  const initialSig = materialFeedbackSignature(snap0)
  const group = registry.createGroup({
    hostTabId: 'tab-1',
    hostSessionId: 'sess-1',
    profileId: 'prof-1',
    accountId: 42,
    repository: 'owner/repo',
    prNumber: 12,
    prUrl: 'https://github.com/owner/repo/pull/12',
    head: HEAD,
    base: BASE,
    feedbackSignature: prFeedbackSignature(snap0),
    materialFeedbackSignature: initialSig,
    authorReplySignature: 'empty',
    clis: ['copilot', 'claude'],
    origin: 'https://github.com/owner/repo.git',
  })
  group.stage = 'active'
  for (const seat of group.requiredSeats.values()) seat.lifecycle = 'running'

  const copilotSeat = group.requiredSeats.get('copilot')!
  const claudeSeat = group.requiredSeats.get('claude')!
  assert.equal(registry.authorizeBearer(claudeSeat.bearerToken)?.seat, claudeSeat)

  const storedReceipts = new Map<string, PostReceipt[]>()
  const reader: ReceiptReader = {
    list: (grantId) => storedReceipts.get(grantId) ?? [],
    settled: (grantId) => !(storedReceipts.get(grantId) ?? []).some((r) => r.state === 'intent' || r.state === 'uncertain'),
  }

  // Only Copilot approved so far -> confirmTarget is null
  const r1Id = '11111111-1111-4111-8111-111111111111'
  storedReceipts.set(copilotSeat.grantId, [{
    id: r1Id, grantId: copilotSeat.grantId, sessionId: copilotSeat.generation, repository: 'owner/repo', number: 12,
    kind: 'approval', target: null, bodyHash: 'h1', state: 'posted', githubId: 101, url: null, createdAt: 10,
    head: HEAD, base: BASE, checks: { ran: ['tsc'], missing: [] }, seatGeneration: copilotSeat.generation,
    feedbackSignature: group.materialFeedbackSignature,
  }])
  assert.equal(registry.view(group, reader).confirmTarget, null)

  // If Claude fails, frozen roster still blocks confirmTarget
  claudeSeat.lifecycle = 'failed'
  assert.equal(registry.view(group, reader).confirmTarget, null)

  // Retry Claude -> old token revoked, new generation issued; Claude posts held-approval
  const oldToken = claudeSeat.bearerToken
  const retriedClaude = registry.resetSeatGeneration(group.id, 'claude')
  retriedClaude.lifecycle = 'running'
  assert.equal(registry.authorizeBearer(oldToken), null)
  const r2Id = '22222222-2222-4222-8222-222222222222'
  storedReceipts.set(retriedClaude.grantId, [{
    id: r2Id, grantId: retriedClaude.grantId, sessionId: retriedClaude.generation, repository: 'owner/repo', number: 12,
    kind: 'review', target: null, bodyHash: 'h2', state: 'posted', githubId: 102, url: null, createdAt: 20,
    head: HEAD, base: BASE, heldApproval: true, checks: { ran: ['diff'], missing: ['npm test'] }, seatGeneration: retriedClaude.generation,
    feedbackSignature: group.materialFeedbackSignature,
  }])

  // Snapshot containing ONLY the group's own approval/held-approval comments keeps materialFeedbackSignature unchanged:
  const snapWithOwnApprovals = makeSnapshot({
    feedback: [{
      source: 'github/owner/repo/pull/12/inline/101',
      version: 'v-r1',
      actorId: 42,
      kind: 'review',
      body: `Approved at ${HEAD}\n\n${receiptTag(r1Id)}`,
      head: HEAD,
      at: 10,
    }],
    reviews: [{
      id: 102,
      actorId: 42,
      state: 'COMMENTED',
      commitId: HEAD,
      submittedAt: 20,
      body: `Not approved yet\n\n${receiptTag(r2Id)}`,
    }],
  })
  registry.applySnapshot(group.id, snapWithOwnApprovals, reader)
  const readyView = registry.view(group, reader)
  assert.ok(readyView.confirmTarget, 'own approval artifacts do not invalidate sibling approvals')
  assert.equal(readyView.confirmTarget.approveAnyway, true)
  assert.deepEqual(readyView.confirmTarget.missingChecks, [{ cli: 'claude', missing: ['npm test'] }])

  // Now a new blocking comment arrives on the SAME head and base:
  const snapWithNewFinding = makeSnapshot({
    feedback: [
      ...snapWithOwnApprovals.feedback,
      {
        source: 'github/owner/repo/pull/12/inline/55',
        version: 'new-blocking-v1',
        actorId: 99,
        kind: 'review',
        body: 'Blocking: wait, found a race condition',
        head: HEAD,
        at: 30,
      },
    ],
    reviews: snapWithOwnApprovals.reviews ?? [],
  })
  assert.throws(
    () => registry.verifyAndConfirm(group.id, readyView.confirmTarget!, snapWithNewFinding, reader),
    /wait for reviewers to assess the latest feedback/,
  )
  assert.equal(group.stage, 'active', 'group remains active after stale click rejection')

  // CRITICAL: Even after refreshing the UI, the old approval receipts DO NOT re-enable confirmation!
  const afterNewFindingView = registry.view(group, reader)
  assert.equal(afterNewFindingView.confirmTarget, null, 'stale approvals invalidated until reviewers reassess new comment')
  assert.deepEqual(afterNewFindingView.seats.map((s) => s.verdict), ['reviewing', 'reviewing'])
  assert.notEqual(group.materialFeedbackSignature, copilotSeat.lastSeenMaterialFeedback, 'pr_wait detects new material feedback')

  // Only once both reviewers assess the new feedback and post fresh approvals covering the updated signature does confirmation return:
  storedReceipts.set(copilotSeat.grantId, [
    ...storedReceipts.get(copilotSeat.grantId)!,
    {
      id: '33333333-3333-4333-8333-333333333333', grantId: copilotSeat.grantId, sessionId: copilotSeat.generation, repository: 'owner/repo', number: 12,
      kind: 'approval', target: null, bodyHash: 'h3', state: 'posted', githubId: 103, url: null, createdAt: 40,
      head: HEAD, base: BASE, checks: { ran: ['tsc'], missing: [] }, seatGeneration: copilotSeat.generation,
      feedbackSignature: group.materialFeedbackSignature,
    },
  ])
  storedReceipts.set(retriedClaude.grantId, [
    ...storedReceipts.get(retriedClaude.grantId)!,
    {
      id: '44444444-4444-4444-8444-444444444444', grantId: retriedClaude.grantId, sessionId: retriedClaude.generation, repository: 'owner/repo', number: 12,
      kind: 'review', target: null, bodyHash: 'h4', state: 'posted', githubId: 104, url: null, createdAt: 41,
      head: HEAD, base: BASE, heldApproval: true, checks: { ran: ['diff'], missing: ['npm test'] }, seatGeneration: retriedClaude.generation,
      feedbackSignature: group.materialFeedbackSignature,
    },
  ])
  const reassessedTarget = registry.view(group, reader).confirmTarget!
  assert.ok(reassessedTarget, 'fresh approvals covering the new feedback re-enable confirmation')
  const confirmed = registry.verifyAndConfirm(group.id, reassessedTarget, snapWithNewFinding, reader)
  assert.equal(confirmed.outcome, 'confirmed')
  assert.equal(group.stage, 'ended')
  assert.equal(registry.authorizeBearer(retriedClaude.bearerToken), null, 'tokens revoked on confirmation')
})

test('dismissing the last required seat ends the group as stopped, never confirmed', () => {
  const registry = new TempReviewerRegistry()
  const snap = makeSnapshot()
  const group = registry.createGroup({
    hostTabId: 'tab-2',
    hostSessionId: 'sess-2',
    profileId: 'prof-1',
    accountId: 42,
    repository: 'owner/repo',
    prNumber: 20,
    prUrl: 'https://github.com/owner/repo/pull/20',
    head: HEAD,
    base: BASE,
    feedbackSignature: prFeedbackSignature(snap),
    authorReplySignature: 'empty',
    clis: ['claude'],
    origin: 'https://github.com/owner/repo.git',
  })
  group.stage = 'active'
  const { groupEnded } = registry.dismissSeat(group.id, 'claude')
  assert.equal(groupEnded, true)
  assert.equal(group.stage, 'ended')
  assert.equal(group.outcome, 'stopped')
})

test('readReviewerDiffPage streams patches larger than 4 MiB past the buffer cap and marks end-of-diff accurately', async () => {
  const gitExe = await resolveGitExecutable()
  assert.ok(gitExe, 'git executable required')
  const dir = mkdtempSync(join(tmpdir(), 'large-pr-diff-'))
  try {
    const repo = join(dir, 'repo')
    const hooks = join(dir, 'hooks')
    mkdirSync(repo, { recursive: true })
    mkdirSync(hooks, { recursive: true })
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') }
    writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n')
    execFileSync(gitExe.path, ['init', '-q'], { cwd: repo, env: gitEnv })
    writeFileSync(join(repo, 'seed.txt'), 'base\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'base'], { cwd: repo, env: gitEnv })
    const baseSha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()

    // Add > 4.6 MiB of text across two files so total patch exceeds GitRunner's default 4 MiB stdout buffer:
    const line = `${'x'.repeat(99)}\n` // 100 bytes per line
    writeFileSync(join(repo, 'large-a.txt'), line.repeat(24_000)) // ~2.4 MB
    writeFileSync(join(repo, 'large-b.txt'), `${line.repeat(24_000)}TAIL_MARKER_END\n`) // ~2.4 MB
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'head'], { cwd: repo, env: gitEnv })
    const headSha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()
    const gitdir = execFileSync(gitExe.path, ['rev-parse', '--absolute-git-dir'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()

    const runner = new GitRunner({ gitPath: gitExe.path, hooksDirectory: hooks, baseEnvironment: gitEnv })
    const area = { root: dir, gitdir, checkout: repo }

    // First page at offset 0:
    const first = await readReviewerDiffPage(runner, area, baseSha, headSha, { offset: 0, pageChars: 20_000 })
    assert.equal(first.ok, true)
    const firstJson = JSON.parse(first.text) as { offset: number; nextOffset: number | null; complete: boolean; diff: string }
    assert.equal(firstJson.complete, false)
    assert.equal(firstJson.nextOffset, 20_000)
    assert.equal(firstJson.diff.length, 20_000)

    // Jump past 4.75 MiB right into the tail beyond the old 4 MiB cap:
    const tailStart = 4_790_000
    let cursor: number | null = tailStart
    let sawTailMarker = false
    let finalComplete = false
    while (cursor !== null) {
      const page = await readReviewerDiffPage(runner, area, baseSha, headSha, { offset: cursor, pageChars: 50_000 })
      assert.equal(page.ok, true, page.text)
      const parsed = JSON.parse(page.text) as { nextOffset: number | null; complete: boolean; diff: string }
      if (parsed.diff.includes('TAIL_MARKER_END')) sawTailMarker = true
      finalComplete = parsed.complete
      cursor = parsed.nextOffset
    }
    assert.equal(sawTailMarker, true, 'must read TAIL_MARKER_END well past 4 MiB')
    assert.equal(finalComplete, true, 'final page reports complete: true')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateSeatReviewSubmission rejects approval and held-approval when a blocking comment arrives between pr_read and submission', async () => {
  const registry = new TempReviewerRegistry()
  let currentSnapshot = makeSnapshot()
  const group = registry.createGroup({
    hostTabId: 'tab-race',
    hostSessionId: 'sess-race',
    profileId: 'prof-1',
    accountId: 42,
    repository: 'owner/repo',
    prNumber: 33,
    prUrl: 'https://github.com/owner/repo/pull/33',
    head: HEAD,
    base: BASE,
    feedbackSignature: prFeedbackSignature(currentSnapshot),
    materialFeedbackSignature: materialFeedbackSignature(currentSnapshot),
    authorReplySignature: 'empty',
    clis: ['claude'],
    origin: 'https://github.com/owner/repo.git',
  })
  group.stage = 'active'
  const seat = group.requiredSeats.get('claude')!
  seat.lifecycle = 'running'

  // Cannot approve before reading PR feedback at all:
  const beforeAnyRead = validateSeatReviewSubmission(group, seat, true)
  assert.equal(beforeAnyRead.ok, false)

  // Multi-page read: stopping after page 1 (nextPage: '2') does NOT allow approval:
  await readSeatFeedbackPage(group, seat, '1', {
    refreshSnapshot: async () => { registry.applySnapshot(group.id, currentSnapshot) },
    readPage: async () => JSON.stringify({ head: HEAD, base: BASE, reviews: [], inline: [], conversation: [], nextPage: 2 }),
  })
  const halfRead = validateSeatReviewSubmission(group, seat, true)
  assert.equal(halfRead.ok, false)

  // Completing page 2 (nextPage: null) records the delivered feedback signature on the seat:
  await readSeatFeedbackPage(group, seat, '2', {
    refreshSnapshot: async () => { registry.applySnapshot(group.id, currentSnapshot) },
    readPage: async () => JSON.stringify({ head: HEAD, base: BASE, reviews: [], inline: [], conversation: [], nextPage: null }),
  })
  const deliveredSignature = seat.assessedFeedback?.materialSignature
  assert.equal(deliveredSignature, group.materialFeedbackSignature)

  // RACE: A blocking comment arrives AFTER the seat read the PR and BEFORE it submits its first approval / held approval!
  currentSnapshot = makeSnapshot({
    feedback: [{
      source: 'github/owner/repo/pull/33/inline/777',
      version: 'race-comment-v1',
      actorId: 99,
      kind: 'review',
      body: 'Blocking: security bug introduced here',
      head: HEAD,
      at: 50,
    }],
  })
  // Submission refreshes the group snapshot from GitHub:
  registry.applySnapshot(group.id, currentSnapshot)
  assert.notEqual(group.materialFeedbackSignature, deliveredSignature)

  // Both direct approval and held-approval (wantsApprove = true) are REJECTED because delivered != fresh:
  const rejectedApproval = validateSeatReviewSubmission(group, seat, true)
  assert.equal(rejectedApproval.ok, false)
  if (!rejectedApproval.ok) {
    assert.match(rejectedApproval.error, /New feedback arrived/)
  }
  // And `lastSeenMaterialFeedback` was NOT advanced, so `pr_wait` still detects and wakes on the unread comment:
  assert.notEqual(seat.lastSeenMaterialFeedback, group.materialFeedbackSignature, 'pr_wait still sees unread feedback')

  // Once the seat re-reads from page 1 and sees the new comment, approval covers the new signature:
  await readSeatFeedbackPage(group, seat, '1', {
    refreshSnapshot: async () => { registry.applySnapshot(group.id, currentSnapshot) },
    readPage: async () => JSON.stringify({
      head: HEAD,
      base: BASE,
      reviews: [],
      inline: [{ id: 777, body: 'Blocking: security bug introduced here' }],
      conversation: [],
      nextPage: null,
    }),
  })
  const acceptedAfterReread = validateSeatReviewSubmission(group, seat, true)
  assert.equal(acceptedAfterReread.ok, true)
  if (acceptedAfterReread.ok) {
    assert.equal(acceptedAfterReread.feedbackSignature, group.materialFeedbackSignature)
  }
})

test('cleanupReviewerSeatCredentials syncs rotated Codex auth atomically when unchanged and deletes seat credentials even when worktree is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-cred-cleanup-'))
  try {
    const fakeRealCodex = join(dir, 'real-codex')
    mkdirSync(fakeRealCodex, { recursive: true })
    const initialAuth = JSON.stringify({ tokens: { refresh_token: 'rt_initial', access_token: 'at_initial' } })
    writeFileSync(join(fakeRealCodex, 'auth.json'), initialAuth)

    // Case 1: Seat rotates refresh token AND `removeReviewerArea` returns `'kept'` (e.g. unavailable Git runner / local edits)
    const area1 = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    area1.project = join(dir, 'some-project')
    mkdirSync(area1.checkout, { recursive: true })
    writeFileSync(join(area1.checkout, 'local-edit.txt'), 'keep me')

    const { codexHome: codexHome1, authSync: authSync1 } = await prepareCodexReviewerHome({
      areaHome: area1.home,
      realCodexHome: fakeRealCodex,
      checkoutPath: area1.checkout,
    })
    writeFileSync(join(area1.helper, 'claude-reviewer-mcp.json'), '{"secret":"tok"}')
    assert.equal(existsSync(join(codexHome1, 'auth.json')), true)

    // Simulate Codex single-use refresh-token rotation inside the seat's isolated CODEX_HOME:
    const rotatedAuth = JSON.stringify({ tokens: { refresh_token: 'rt_rotated', access_token: 'at_rotated' } })
    writeFileSync(join(codexHome1, 'auth.json'), rotatedAuth)

    await cleanupReviewerSeatCredentials(area1, authSync1)
    const outcome1 = await removeReviewerArea(area1, null)
    assert.equal(outcome1, 'kept', 'worktree area is kept when runner is unavailable or checkout has local changes')
    assert.equal(existsSync(join(area1.checkout, 'local-edit.txt')), true, 'user checkout preserved')
    assert.equal(existsSync(join(codexHome1, 'auth.json')), false, 'copied auth.json removed even when area is kept')
    assert.equal(existsSync(area1.home), false, 'seat home removed even when area is kept')
    assert.equal(existsSync(area1.helper), false, 'seat helper removed even when area is kept')
    assert.equal(readFileSync(join(fakeRealCodex, 'auth.json'), 'utf8'), rotatedAuth, 'rotated token synced back to real CODEX_HOME')

    // Case 2: Real ~/.codex/auth.json ALSO changed independently while seat ran -> do NOT overwrite real auth, still delete copy
    const area2 = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    mkdirSync(area2.checkout, { recursive: true })
    const { codexHome: codexHome2, authSync: authSync2 } = await prepareCodexReviewerHome({
      areaHome: area2.home,
      realCodexHome: fakeRealCodex,
      checkoutPath: area2.checkout,
    })
    const concurrentRealAuth = JSON.stringify({ tokens: { refresh_token: 'rt_user_relogin', access_token: 'at_user_relogin' } })
    writeFileSync(join(fakeRealCodex, 'auth.json'), concurrentRealAuth)
    writeFileSync(join(codexHome2, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'rt_seat2' } }))

    await cleanupReviewerSeatCredentials(area2, authSync2)
    assert.equal(existsSync(join(codexHome2, 'auth.json')), false, 'seat copy deleted')
    assert.equal(readFileSync(join(fakeRealCodex, 'auth.json'), 'utf8'), concurrentRealAuth, 'diverged real auth.json never overwritten')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
