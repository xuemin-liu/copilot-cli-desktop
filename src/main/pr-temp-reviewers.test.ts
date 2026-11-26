import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { GitRunner, resolveGitExecutable } from './git-runner.js'
import {
  makeReviewerArea,
  planReviewerArea,
  prepareAgnosticReviewWorktree,
  refreshAgnosticReviewWorktree,
  removeReviewerArea,
  reviewCheckoutState,
} from './pr-review-launch.js'
import { ReviewReservations } from './pr-review-reservations.js'
import { PR_REVIEWER_TOKEN_ENV } from './pr-reviewer-mcp.js'
import {
  buildClaudeMcpConfigJson,
  buildClaudeReviewerLaunch,
  buildCodexReviewerLaunch,
  cleanupReviewerSeatCredentials,
  parseAnyPullRequestInput,
  prepareCodexReviewerHome,
  prReviewAndFixRequest,
  readGroupStateForSeat,
  readReviewerDiffPage,
  recoverSweptReviewerCredentials,
  repositoryLabelFromOrigin,
  shutdownActiveReviewerSeats,
  TempReviewerRegistry,
  validateSeatReviewSubmission,
} from './pr-temp-reviewers.js'

const HEAD = 'a'.repeat(40)
const HEAD2 = 'c'.repeat(40)
const BASE = 'b'.repeat(40)

test('parseAnyPullRequestInput, repositoryLabelFromOrigin, and prReviewAndFixRequest work across Gitea, GitLab, GitHub, and plain numbers', () => {
  assert.deepEqual(
    parseAnyPullRequestInput('http://omaha:3001/daq/daq-service/pulls/12'),
    {
      number: 12,
      prLabel: 'PR #12',
      prUrl: 'http://omaha:3001/daq/daq-service/pulls/12',
      repository: 'omaha:3001/daq/daq-service',
    },
  )
  assert.deepEqual(
    parseAnyPullRequestInput('https://gitlab.example.com/team/sub/project/-/merge_requests/7'),
    {
      number: 7,
      prLabel: 'MR !7',
      prUrl: 'https://gitlab.example.com/team/sub/project/-/merge_requests/7',
      repository: 'gitlab.example.com/team/sub/project',
    },
  )
  assert.deepEqual(
    parseAnyPullRequestInput('https://github.com/octo/demo/pull/99'),
    {
      number: 99,
      prLabel: 'PR #99',
      prUrl: 'https://github.com/octo/demo/pull/99',
      repository: 'octo/demo',
    },
  )
  assert.deepEqual(parseAnyPullRequestInput('!14'), { number: 14, prLabel: 'MR !14', prUrl: null, repository: null })
  assert.deepEqual(parseAnyPullRequestInput('42'), { number: 42, prLabel: 'PR #42', prUrl: null, repository: null })
  assert.throws(() => parseAnyPullRequestInput('http://user:secret@omaha:3001/org/repo/pulls/12'), /embedded credentials/)

  assert.equal(repositoryLabelFromOrigin('http://omaha:3001/daq/daq-service.git', 'fallback'), 'omaha:3001/daq/daq-service')
  assert.equal(repositoryLabelFromOrigin('git@omaha.local:daq/daq-service.git', 'fallback'), 'omaha.local/daq/daq-service')
  assert.equal(repositoryLabelFromOrigin('https://github.com/octo/demo.git', 'fallback'), 'octo/demo')
  assert.equal(repositoryLabelFromOrigin('', 'local-repo'), 'local-repo')

  assert.deepEqual(prReviewAndFixRequest('/review-and-fix-pr'), { number: null, repository: null })
  assert.deepEqual(prReviewAndFixRequest('/review-and-fix-pr 18'), { number: 18, repository: null })
  assert.deepEqual(prReviewAndFixRequest('review and fix PR 42'), { number: 42, repository: null })
  assert.deepEqual(prReviewAndFixRequest('review and fix MR !7'), { number: 7, repository: null })
  assert.deepEqual(prReviewAndFixRequest('please review and fix my PR'), { number: null, repository: null })
  assert.deepEqual(
    prReviewAndFixRequest('start temp reviewers and fix https://github.com/octo/demo/pull/99'),
    { number: 99, repository: 'octo/demo' },
  )
  assert.deepEqual(
    prReviewAndFixRequest('review and fix http://omaha:3001/daq/daq-service/pulls/12'),
    { number: 12, repository: 'omaha:3001/daq/daq-service', prUrl: 'http://omaha:3001/daq/daq-service/pulls/12' },
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

test('TempReviewerRegistry coordinates forge-agnostic multi-round Gitea reviews, invalidates stale approvals, and finishes cleanly', () => {
  const registry = new TempReviewerRegistry()
  const { group, hostKey } = registry.createGroup({
    hostTabId: 'tab-1',
    hostSessionId: 'sess-1',
    profileId: 'prof-1',
    projectPath: '/tmp/daq-service',
    repository: 'omaha:3001/daq/daq-service',
    prLabel: 'PR #12',
    prNumber: 12,
    prUrl: 'http://omaha:3001/daq/daq-service/pulls/12',
    head: HEAD,
    base: BASE,
    context: 'PR #12: Offline DAQ buffer improvements',
    clis: ['copilot', 'claude'],
    origin: 'http://omaha:3001/daq/daq-service.git',
  })
  group.stage = 'active'
  for (const seat of group.requiredSeats.values()) seat.lifecycle = 'running'
  assert.equal(registry.authorizeHostKey(hostKey), group)
  assert.equal(registry.authorizeHostKey('f'.repeat(64)), null)

  const copilotSeat = group.requiredSeats.get('copilot')!
  const claudeSeat = group.requiredSeats.get('claude')!
  assert.equal(registry.authorizeBearer(claudeSeat.bearerToken)?.seat, claudeSeat)

  // Cannot approve before reading round 1 context:
  assert.equal(validateSeatReviewSubmission(group, copilotSeat, true).ok, false)

  // Both seats read round 1:
  const read1 = JSON.parse(readGroupStateForSeat(group, copilotSeat)) as { round: number; nextPage: string | null; entries: Array<{ kind: string }> }
  assert.equal(read1.round, 1)
  assert.equal(read1.nextPage, null)
  assert.equal(read1.entries[0]?.kind, 'context')
  readGroupStateForSeat(group, claudeSeat)

  // Copilot approves round 1, while Claude finds a blocking bug:
  const copilotApprovedR1 = registry.recordSeatReview(group.id, 'copilot', {
    body: `Approved at ${HEAD}\n\n[Copilot CLI] Tests pass.`,
    approve: true,
    comments: [],
    checks: { ran: ['npm test'], missing: [] },
  })
  assert.equal(copilotApprovedR1.ok, true)
  assert.equal(registry.view(group).confirmTarget, null, 'still waiting on Claude')

  // Sibling approval did NOT invalidate Claude's read; now Claude posts a Blocking finding:
  const claudeFindingR1 = registry.recordSeatReview(group.id, 'claude', {
    body: '[Claude Code] Found ring-buffer overflow.',
    approve: false,
    comments: [{ path: 'src/buffer.ts', line: 44, body: 'Blocking: off-by-one when wrapping.' }],
  })
  assert.equal(claudeFindingR1.ok, true)
  const afterFindingView = registry.view(group)
  // Claude's finding changed materialStateSignature -> Copilot's prior approval is invalidated too!
  assert.deepEqual(afterFindingView.seats.map((s) => s.verdict), ['reviewing', 'changes-requested'])
  assert.throws(() => registry.finishByHost(group.id, 'approved'), /Cannot finish as approved/)

  // Host fixes the bug, pushes HEAD2, and advances to Round 2:
  registry.advanceRound(group.id, HEAD2, BASE, `🤖 Fixed ring-buffer wrap in ${HEAD2.slice(0, 8)}.`)
  assert.equal(group.round, 2)
  assert.equal(group.head, HEAD2)

  // Stale submission from Round 1 checkout is rejected:
  const staleSubmit = registry.recordSeatReview(group.id, 'copilot', {
    body: `Approved at ${HEAD}`,
    approve: true,
    comments: [],
    checks: { ran: ['npm test'], missing: [] },
  })
  assert.equal(staleSubmit.ok, false)

  // Desktop refreshes both seats' detached worktrees to HEAD2:
  for (const seat of group.requiredSeats.values()) {
    seat.checkedOut = HEAD2
    seat.checkedOutBase = BASE
    seat.lastSeenRound = 2
    seat.lastSeenHead = HEAD2
    seat.lastSeenBase = BASE
    readGroupStateForSeat(group, seat)
  }

  // Both seats approve Round 2 with zero missing checks -> finishByHost('approved') succeeds!
  assert.equal(registry.recordSeatReview(group.id, 'copilot', {
    body: `Approved at ${HEAD2}\n\n[Copilot CLI] Verified fix.`,
    approve: true,
    comments: [],
    checks: { ran: ['npm test'], missing: [] },
  }).ok, true)
  assert.equal(registry.recordSeatReview(group.id, 'claude', {
    body: `Approved at ${HEAD2}\n\n[Claude Code] Wrap logic is now sound.`,
    approve: true,
    comments: [],
    checks: { ran: ['static-source-and-diff-review'], missing: [] },
  }).ok, true)

  const statusBeforeFinish = JSON.parse(registry.statusPayload(group)) as { allApproved: boolean; readyToConfirm: boolean }
  assert.equal(statusBeforeFinish.allApproved, true)
  assert.equal(statusBeforeFinish.readyToConfirm, true)

  const finished = registry.finishByHost(group.id, 'approved')
  assert.equal(finished.view.stage, 'ended')
  assert.equal(finished.view.outcome, 'approved')
  assert.equal(finished.seats.length, 2)
  assert.equal(registry.authorizeBearer(claudeSeat.bearerToken), null, 'seat bearer tokens revoked on finish')
})

test('held-approval blocks host auto-finish while enabling user Approve anyway confirmation in ReviewerBar', () => {
  const registry = new TempReviewerRegistry()
  const { group } = registry.createGroup({
    hostTabId: 'tab-held',
    hostSessionId: 'sess-held',
    profileId: 'prof-1',
    projectPath: '/tmp/repo',
    repository: 'omaha:3001/org/repo',
    prLabel: 'PR #5',
    prNumber: 5,
    prUrl: 'http://omaha:3001/org/repo/pulls/5',
    head: HEAD,
    base: BASE,
    clis: ['claude'],
    origin: 'http://omaha:3001/org/repo.git',
  })
  group.stage = 'active'
  const claudeSeat = group.requiredSeats.get('claude')!
  claudeSeat.lifecycle = 'running'
  readGroupStateForSeat(group, claudeSeat)

  const res = registry.recordSeatReview(group.id, 'claude', {
    body: `Approved at ${HEAD}\n\n[Claude Code] Clean diff.`,
    approve: true,
    comments: [],
    checks: { ran: ['diff-review'], missing: ['integration suite'] },
  })
  assert.equal(res.ok, true)
  if (res.ok) assert.equal(res.held, true)

  const payload = JSON.parse(registry.statusPayload(group)) as { allApproved: boolean; readyToConfirm: boolean }
  assert.equal(payload.allApproved, false, 'held-approval cannot auto-finish without user confirmation')
  assert.equal(payload.readyToConfirm, true)
  assert.throws(() => registry.finishByHost(group.id, 'approved'), /Approve anyway/)

  const target = registry.view(group).confirmTarget!
  assert.equal(target.approveAnyway, true)
  const confirmed = registry.verifyAndConfirm(group.id, target)
  assert.equal(confirmed.outcome, 'confirmed')
  assert.equal(group.stage, 'ended')
})

test('dismissing the last required seat ends the group as stopped, never confirmed or approved', () => {
  const registry = new TempReviewerRegistry()
  const { group } = registry.createGroup({
    hostTabId: 'tab-2',
    hostSessionId: 'sess-2',
    profileId: 'prof-1',
    projectPath: '/tmp/repo',
    repository: 'owner/repo',
    prLabel: 'PR #20',
    prNumber: 20,
    prUrl: null,
    head: HEAD,
    base: BASE,
    clis: ['claude'],
    origin: '',
  })
  group.stage = 'active'
  const { groupEnded } = registry.dismissSeat(group.id, 'claude')
  assert.equal(groupEnded, true)
  assert.equal(group.stage, 'ended')
  assert.equal(group.outcome, 'stopped')
})

test('prepareAgnosticReviewWorktree and refreshAgnosticReviewWorktree work on local / non-GitHub repositories without gh', async () => {
  const gitExe = await resolveGitExecutable()
  assert.ok(gitExe, 'git executable required')
  const dir = mkdtempSync(join(tmpdir(), 'agnostic-worktree-'))
  try {
    const repo = join(dir, 'gitea-clone')
    const hooks = join(dir, 'hooks')
    mkdirSync(repo, { recursive: true })
    mkdirSync(hooks, { recursive: true })
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') }
    writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n')
    execFileSync(gitExe.path, ['init', '-q'], { cwd: repo, env: gitEnv })
    writeFileSync(join(repo, 'app.ts'), 'export const v = 1\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'base'], { cwd: repo, env: gitEnv })
    const baseSha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()

    writeFileSync(join(repo, 'app.ts'), 'export const v = 2\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'round-1'], { cwd: repo, env: gitEnv })
    const head1Sha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()

    const runner = new GitRunner({ gitPath: gitExe.path, hooksDirectory: hooks, baseEnvironment: gitEnv })
    const area = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    await prepareAgnosticReviewWorktree(runner, repo, '', area, head1Sha, baseSha, 12)
    assert.equal(readFileSync(join(area.checkout, 'app.ts'), 'utf8'), 'export const v = 2\n')
    assert.deepEqual(await reviewCheckoutState(runner, area), { head: head1Sha, clean: true })

    // Author commits round 2 in main repo; refreshAgnosticReviewWorktree updates detached worktree without GitHub:
    writeFileSync(join(repo, 'app.ts'), 'export const v = 3\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'round-2'], { cwd: repo, env: gitEnv })
    const head2Sha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()

    const refreshed = await refreshAgnosticReviewWorktree(runner, area, '', head2Sha, baseSha, 12)
    assert.equal(refreshed, head2Sha)
    assert.equal(readFileSync(join(area.checkout, 'app.ts'), 'utf8'), 'export const v = 3\n')

    const removed = await removeReviewerArea(area, runner)
    assert.equal(removed, 'removed')
    assert.equal(existsSync(area.root), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

    const line = `${'x'.repeat(99)}\n`
    writeFileSync(join(repo, 'large-a.txt'), line.repeat(24_000))
    writeFileSync(join(repo, 'large-b.txt'), `${line.repeat(24_000)}TAIL_MARKER_END\n`)
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'head'], { cwd: repo, env: gitEnv })
    const headSha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()
    const gitdir = execFileSync(gitExe.path, ['rev-parse', '--absolute-git-dir'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()

    const runner = new GitRunner({ gitPath: gitExe.path, hooksDirectory: hooks, baseEnvironment: gitEnv })
    const area = { root: dir, gitdir, checkout: repo }

    const first = await readReviewerDiffPage(runner, area, baseSha, headSha, { offset: 0, pageChars: 20_000 })
    assert.equal(first.ok, true)
    const firstJson = JSON.parse(first.text) as { offset: number; nextOffset: number | null; complete: boolean; diff: string }
    assert.equal(firstJson.complete, false)
    assert.equal(firstJson.nextOffset, 20_000)
    assert.equal(firstJson.diff.length, 20_000)

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

test('cleanupReviewerSeatCredentials and restart recovery sync rotated Codex OAuth tokens atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-quit-recovery-'))
  try {
    const reservationsFile = join(dir, 'pr-review-reservations.json')
    const fakeRealCodex = join(dir, 'disposable-codex-home')
    mkdirSync(fakeRealCodex, { recursive: true })
    const initialAuth = JSON.stringify({ tokens: { refresh_token: 'rt_v1', access_token: 'at_v1' } })
    writeFileSync(join(fakeRealCodex, 'auth.json'), initialAuth)

    const registry = new TempReviewerRegistry()
    const { group } = registry.createGroup({
      hostTabId: 'tab-quit',
      hostSessionId: 'sess-quit',
      profileId: 'prof-1',
      projectPath: join(dir, 'project'),
      repository: 'omaha:3001/org/repo',
      prLabel: 'PR #77',
      prNumber: 77,
      prUrl: 'http://omaha:3001/org/repo/pulls/77',
      head: HEAD,
      base: BASE,
      clis: ['codex'],
      origin: 'http://omaha:3001/org/repo.git',
    })
    group.stage = 'active'
    const seat = group.requiredSeats.get('codex')!
    seat.lifecycle = 'running'

    const areaQuit = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    const launchIdQuit = resolve(areaQuit.root).split(/[\\/]/).at(-1)!
    seat.launchId = launchIdQuit
    seat.area = areaQuit

    const reservations = new ReviewReservations(reservationsFile)
    await reservations.reserve({
      launchId: launchIdQuit,
      repository: 'omaha:3001/org/repo',
      number: 77,
      reviewer: 'temp:codex',
      project: join(dir, 'project'),
      root: areaQuit.root,
      checkout: areaQuit.checkout,
      ref: areaQuit.ref,
    })

    const { codexHome: quitCodexHome, authSync: quitAuthSync } = await prepareCodexReviewerHome({
      areaHome: areaQuit.home,
      realCodexHome: fakeRealCodex,
      checkoutPath: areaQuit.checkout,
    })
    seat.codexAuthSync = quitAuthSync
    if (quitAuthSync) await reservations.setCodexAuthSync(launchIdQuit, quitAuthSync)

    const rotatedDuringRun = JSON.stringify({ tokens: { refresh_token: 'rt_v2_quit', access_token: 'at_v2_quit' } })
    writeFileSync(join(quitCodexHome, 'auth.json'), rotatedDuringRun)
    let stoppedSeat = false
    await shutdownActiveReviewerSeats(registry.list(), reservations, async () => { stoppedSeat = true })

    assert.equal(stoppedSeat, true)
    assert.equal(readFileSync(join(fakeRealCodex, 'auth.json'), 'utf8'), rotatedDuringRun)
    assert.equal(existsSync(join(quitCodexHome, 'auth.json')), false)
    assert.equal(reservations.list()[0]?.codexAuthSync, undefined)
    await reservations.release(launchIdQuit)

    const areaIoFail = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    const launchIdIo = resolve(areaIoFail.root).split(/[\\/]/).at(-1)!
    mkdirSync(areaIoFail.checkout, { recursive: true })
    await reservations.reserve({
      launchId: launchIdIo,
      repository: 'omaha:3001/org/repo',
      number: 79,
      reviewer: 'temp:codex-io',
      project: join(dir, 'project'),
      root: areaIoFail.root,
      checkout: areaIoFail.checkout,
      ref: areaIoFail.ref,
    })
    const { codexHome: ioCodexHome, authSync: ioAuthSync } = await prepareCodexReviewerHome({
      areaHome: areaIoFail.home,
      realCodexHome: fakeRealCodex,
      checkoutPath: areaIoFail.checkout,
    })
    assert.ok(ioAuthSync)
    await reservations.setCodexAuthSync(launchIdIo, ioAuthSync)

    const rotatedRetryToken = JSON.stringify({ tokens: { refresh_token: 'rt_v4_retry', access_token: 'at_v4_retry' } })
    writeFileSync(join(ioCodexHome, 'auth.json'), rotatedRetryToken)

    const recordAttempt1 = reservations.list().find((r) => r.launchId === launchIdIo)!
    const firstAttempt = await recoverSweptReviewerCredentials(recordAttempt1, reservations, {
      writeRealAuth: async () => {
        const err = new Error('Simulated file lock') as NodeJS.ErrnoException
        err.code = 'EBUSY'
        throw err
      },
    })
    assert.equal(firstAttempt, 'retry-sync')
    assert.equal(existsSync(join(ioCodexHome, 'auth.json')), true)

    const reopenedReservations = new ReviewReservations(reservationsFile)
    const recordAttempt2 = reopenedReservations.list().find((r) => r.launchId === launchIdIo)!
    const secondAttempt = await recoverSweptReviewerCredentials(recordAttempt2, reopenedReservations)
    assert.equal(secondAttempt, 'clean')
    assert.equal(readFileSync(join(fakeRealCodex, 'auth.json'), 'utf8'), rotatedRetryToken)
    assert.equal(existsSync(join(ioCodexHome, 'auth.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
