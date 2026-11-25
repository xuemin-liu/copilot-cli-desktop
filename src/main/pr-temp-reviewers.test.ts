import assert from 'node:assert/strict'
import test from 'node:test'
import type { PostReceipt } from './pr-loop-posts.js'
import { PR_REVIEWER_TOKEN_ENV } from './pr-reviewer-mcp.js'
import {
  buildClaudeMcpConfigJson,
  buildClaudeReviewerLaunch,
  buildCodexReviewerLaunch,
  prFeedbackSignature,
  prReviewAndFixRequest,
  TempReviewerRegistry,
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

test('CLI launch builders verify flags and keep bearer tokens out of process argv', () => {
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
    prompt: 'Review PR',
  })
  assert.ok(codex.args.includes('--no-daemon'))
  assert.ok(codex.args.includes('read-only'))
  assert.equal(codex.args.some((arg) => arg.includes('codex-secret-token')), false, 'secret never in argv')
  assert.equal(codex.envAdditions[PR_REVIEWER_TOKEN_ENV], 'codex-secret-token')

  assert.throws(() => buildClaudeReviewerLaunch({
    help: '--session-id',
    sessionId: '11111111-1111-4111-8111-111111111111',
    mcpConfigPath: '/tmp/x.json',
    prompt: 'Review',
  }), /required reviewer flags/)
})

test('TempReviewerRegistry enforces idempotent start, frozen roster, receipt-derived verdicts, and click-time validation', () => {
  const registry = new TempReviewerRegistry()
  const snap0 = makeSnapshot()
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
    authorReplySignature: 'empty',
    clis: ['copilot', 'claude'],
    origin: 'https://github.com/owner/repo.git',
  })
  group.stage = 'active'
  for (const seat of group.requiredSeats.values()) seat.lifecycle = 'running'

  // Idempotent on same host + PR; rejected on different PR for same host
  assert.equal(registry.createGroup({
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
    authorReplySignature: 'empty',
    clis: ['copilot', 'claude'],
    origin: 'https://github.com/owner/repo.git',
  }), group)
  assert.throws(() => registry.createGroup({
    hostTabId: 'tab-1',
    hostSessionId: 'sess-1',
    profileId: 'prof-1',
    accountId: 42,
    repository: 'owner/repo',
    prNumber: 13,
    prUrl: 'https://github.com/owner/repo/pull/13',
    head: HEAD,
    base: BASE,
    feedbackSignature: prFeedbackSignature(snap0),
    authorReplySignature: 'empty',
    clis: ['copilot'],
    origin: 'https://github.com/owner/repo.git',
  }), /Stop them first/)

  const copilotSeat = group.requiredSeats.get('copilot')!
  const claudeSeat = group.requiredSeats.get('claude')!
  assert.equal(registry.authorizeBearer(claudeSeat.bearerToken)?.seat, claudeSeat)

  const storedReceipts = new Map<string, PostReceipt[]>()
  const reader: ReceiptReader = {
    list: (grantId) => storedReceipts.get(grantId) ?? [],
    settled: (grantId) => !(storedReceipts.get(grantId) ?? []).some((r) => r.state === 'intent' || r.state === 'uncertain'),
  }

  // Only Copilot approved so far -> confirmTarget is null
  storedReceipts.set(copilotSeat.grantId, [{
    id: 'r-1', grantId: copilotSeat.grantId, sessionId: copilotSeat.generation, repository: 'owner/repo', number: 12,
    kind: 'approval', target: null, bodyHash: 'h1', state: 'posted', githubId: 101, url: null, createdAt: 10,
    head: HEAD, base: BASE, checks: { ran: ['tsc'], missing: [] }, seatGeneration: copilotSeat.generation,
  }])
  assert.equal(registry.view(group, reader).confirmTarget, null)

  // If Claude fails, frozen roster still blocks confirmTarget (never silently skipped!)
  claudeSeat.lifecycle = 'failed'
  assert.equal(registry.view(group, reader).confirmTarget, null)

  // Retry Claude -> old token revoked, new generation issued; Claude posts held-approval
  const oldToken = claudeSeat.bearerToken
  const retriedClaude = registry.resetSeatGeneration(group.id, 'claude')
  retriedClaude.lifecycle = 'running'
  assert.equal(registry.authorizeBearer(oldToken), null)
  storedReceipts.set(retriedClaude.grantId, [{
    id: 'r-2', grantId: retriedClaude.grantId, sessionId: retriedClaude.generation, repository: 'owner/repo', number: 12,
    kind: 'review', target: null, bodyHash: 'h2', state: 'posted', githubId: 102, url: null, createdAt: 20,
    head: HEAD, base: BASE, heldApproval: true, checks: { ran: ['diff'], missing: ['npm test'] }, seatGeneration: retriedClaude.generation,
  }])

  const readyView = registry.view(group, reader)
  assert.ok(readyView.confirmTarget)
  assert.equal(readyView.confirmTarget.approveAnyway, true)
  assert.deepEqual(readyView.confirmTarget.missingChecks, [{ cli: 'claude', missing: ['npm test'] }])

  // Edited comment changes (source, version) feedbackSignature -> click-time verifyAndConfirm rejects stale target!
  const editedSnap = makeSnapshot({
    feedback: [{
      source: 'github/owner/repo/pull/12/inline/55',
      version: 'edited-hash-v2',
      actorId: 99,
      kind: 'review',
      body: 'Blocking: wait, found a race condition',
      head: HEAD,
      at: 30,
    }],
  })
  assert.throws(
    () => registry.verifyAndConfirm(group.id, readyView.confirmTarget!, editedSnap, reader),
    /changed since this confirmation was shown/,
  )
  assert.equal(group.stage, 'active', 'group remains active after stale click rejection')

  // Fresh target with matching snapshot succeeds and ends the group as confirmed
  const refreshedTarget = registry.view(group, reader).confirmTarget!
  const confirmed = registry.verifyAndConfirm(group.id, refreshedTarget, editedSnap, reader)
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
