import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GitRunner, resolveGitExecutable } from './git-runner.js'
import {
  inspectReviewCommitAgentConfigs,
  makeReviewerArea,
  planReviewerArea,
  prepareAgnosticReviewWorktree,
  refreshAgnosticReviewWorktree,
  removeReviewerArea,
  reviewCheckoutState,
} from './pr-review-launch.js'
import { ReviewReservations } from './pr-review-reservations.js'
import {
  buildReviewerBrief,
  cleanupReviewerSeatCredentials,
  parseAnyPullRequestInput,
  prReviewAndFixRequest,
  recoverSweptReviewerCredentials,
  repositoryLabelFromOrigin,
  shutdownActiveReviewerSeats,
  TempReviewerRegistry,
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
  assert.throws(() => parseAnyPullRequestInput('https://github.com/octo/demo/pull/0'), /Invalid pull request number/)
  assert.throws(() => parseAnyPullRequestInput('https://gitlab.example.com/team/project/-/merge_requests/0'), /Invalid merge request number/)
  assert.throws(() => parseAnyPullRequestInput('http://omaha:3001/daq/daq-service/0'), /Invalid pull request number/)

  assert.equal(repositoryLabelFromOrigin('http://omaha:3001/daq/daq-service.git', 'fallback'), 'omaha:3001/daq/daq-service')
  assert.equal(repositoryLabelFromOrigin('git@omaha.local:daq/daq-service.git', 'fallback'), 'omaha.local/daq/daq-service')
  assert.equal(repositoryLabelFromOrigin('https://github.com/octo/demo.git', 'fallback'), 'octo/demo')
  assert.equal(repositoryLabelFromOrigin('file:///path/to/repo.git', 'local-repo'), 'local-repo')
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

  // Plain single-role commands and malformed/ambiguous targets must be rejected
  assert.equal(prReviewAndFixRequest('review PR 42'), null)
  assert.equal(prReviewAndFixRequest('fix PR 42'), null)
  assert.equal(prReviewAndFixRequest('do not review and fix PR 42'), null)
  assert.equal(prReviewAndFixRequest('review and fix PR 42 and PR 43'), null)
  assert.equal(prReviewAndFixRequest('/review-and-fix-pr 18 19'), null)
  assert.equal(prReviewAndFixRequest('/review-and-fix-pr foo'), null)
  assert.equal(prReviewAndFixRequest('/review-and-fix-pr 0'), null)
  assert.equal(prReviewAndFixRequest('review and fix 2 bugs'), null)
})

test('buildReviewerBrief instructs every reviewer CLI to run review-pr directly on the remote PR host and never perform local-only review', () => {
  for (const [cli, tag] of [['copilot', '[Copilot CLI]'], ['claude', '[Claude Code]'], ['codex', '[Codex CLI]']] as const) {
    const brief = buildReviewerBrief({
      cli,
      repository: 'xuemin-liu/copilot-cli-desktop',
      prLabel: 'PR #322',
      prNumber: 322,
      prUrl: 'https://github.com/xuemin-liu/copilot-cli-desktop/pull/322',
      round: 1,
      head: HEAD,
      base: BASE,
      marker: '🤖 ',
      reviewPrSkillPath: '/app/resources/pr-workflows/skills/review-pr/SKILL.md',
      prToolsDir: '/app/resources/pr-workflows',
      seatStateDir: '/tmp/seat-state',
      checkoutPath: '/tmp/seat-checkout',
    })
    assert.match(brief, /review-pr\/SKILL\.md/)
    assert.match(brief, /Post all reviews, inline findings, thread replies, and approvals directly onto the PR on its remote host/)
    assert.ok(brief.includes(tag), `brief includes reviewer tag ${tag}`)
    assert.ok(brief.includes(`Approved at ${HEAD}\\n\\n${tag}`), 'documents pr-approve.mjs multi-line tagged format')
    assert.ok(brief.includes(`Approved at ${HEAD} ${tag}`), 'documents single-line tagged format')
    assert.doesNotMatch(brief, /copilot-pr-reviewer|pr_review\(|pr-review -File/, 'never uses local review endpoints')
  }
})

test('TempReviewerRegistry refuses local-only / PR-less runs, tracks hidden reviewer seats across rounds, and finishes cleanly', () => {
  const registry = new TempReviewerRegistry()

  // Local repos without remote origin or without a PR number/URL are refused:
  assert.throws(() => registry.createGroup({
    hostTabId: 'tab-1',
    hostSessionId: 'sess-1',
    profileId: 'prof-1',
    projectPath: '/tmp/local',
    repository: 'local',
    prLabel: 'Branch main',
    prNumber: 12,
    prUrl: null,
    head: HEAD,
    base: BASE,
    clis: ['copilot'],
    origin: '',
  }), /remote Git origin/)

  assert.throws(() => registry.createGroup({
    hostTabId: 'tab-1',
    hostSessionId: 'sess-1',
    profileId: 'prof-1',
    projectPath: '/tmp/local',
    repository: 'omaha:3001/daq/daq-service',
    prLabel: 'Branch feat',
    prNumber: null,
    prUrl: null,
    head: HEAD,
    base: BASE,
    clis: ['copilot'],
    origin: 'http://omaha:3001/daq/daq-service.git',
  }), /local branch-only reviews are not supported/)

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
    clis: ['copilot', 'claude'],
    origin: 'http://omaha:3001/daq/daq-service.git',
  })
  assert.equal(registry.authorizeHostKey(hostKey), group)
  assert.equal(registry.authorizeHostKey('f'.repeat(64)), null)
  assert.equal(registry.activeSeatCount(), 2)

  // Cannot finish while seats are still starting:
  assert.throws(() => registry.finishByHost(group.id, 'approved'), /still starting/)

  // Concurrent group in the same workspace profile is rejected while active:
  assert.throws(() => registry.createGroup({
    hostTabId: null,
    hostSessionId: null,
    profileId: 'prof-1',
    projectPath: '/tmp/daq-service',
    repository: 'omaha:3001/daq/daq-service',
    prLabel: 'PR #13',
    prNumber: 13,
    prUrl: 'http://omaha:3001/daq/daq-service/pulls/13',
    head: HEAD,
    base: BASE,
    clis: ['copilot'],
    origin: 'http://omaha:3001/daq/daq-service.git',
  }), /already running temporary reviewers/)

  group.stage = 'active'
  const copilotSeat = group.requiredSeats.get('copilot')!
  const claudeSeat = group.requiredSeats.get('claude')!
  copilotSeat.lifecycle = 'running'
  claudeSeat.lifecycle = 'running'

  const status = JSON.parse(registry.statusPayload(group)) as {
    done: boolean
    expectedReviewerTags: string[]
    group: { round: number; seats: Array<{ cli: string; verdict: string }> }
  }
  assert.equal(status.done, false)
  assert.deepEqual(status.expectedReviewerTags, ['[Copilot CLI]', '[Claude Code]'])
  assert.equal(registry.settledStateKey(group), null, 'healthy reviewing seats block wait up to timeout')

  // Attention needed (e.g. tool approval prompt in hidden tab) surfaces immediately to wait:
  claudeSeat.needsAttention = true
  const attentionKey = registry.settledStateKey(group)
  assert.ok(attentionKey)
  claudeSeat.needsAttention = false

  // Failed seat blocks approved finish until retried or dismissed:
  registry.revokeSeat(claudeSeat, 'failed', 'Claude exited unexpectedly')
  assert.throws(() => registry.finishByHost(group.id, 'approved'), /failed/)
  const retried = registry.resetSeatGeneration(group.id, 'claude')
  retried.lifecycle = 'running'

  // Advance to Round 2 after author pushes HEAD2 on PR:
  registry.advanceRound(group.id, HEAD2, BASE, `🤖 Fixed findings in ${HEAD2.slice(0, 8)}.`)
  assert.equal(group.round, 2)
  assert.equal(group.head, HEAD2)

  // Once author fix-pr verifies PR-host approvals, finishByHost('approved') closes all seats cleanly:
  retried.lifecycle = 'stopped'
  const finished = registry.finishByHost(group.id, 'approved')
  assert.equal(finished.view.stage, 'ended')
  assert.equal(finished.view.outcome, 'approved')
  assert.equal(finished.seats.length, 2)
})

test('dismissing the last required seat ends the group as stopped, never approved', () => {
  const registry = new TempReviewerRegistry()
  const { group } = registry.createGroup({
    hostTabId: 'tab-2',
    hostSessionId: 'sess-2',
    profileId: 'prof-1',
    projectPath: '/tmp/repo',
    repository: 'owner/repo',
    prLabel: 'PR #20',
    prNumber: 20,
    prUrl: 'https://github.com/owner/repo/pull/20',
    head: HEAD,
    base: BASE,
    clis: ['claude'],
    origin: 'https://github.com/owner/repo.git',
  })
  group.stage = 'active'
  const { groupEnded } = registry.dismissSeat(group.id, 'claude')
  assert.equal(groupEnded, true)
  assert.equal(group.stage, 'ended')
  assert.equal(group.outcome, 'stopped')
})

test('prepareAgnosticReviewWorktree, refreshAgnosticReviewWorktree, and inspectReviewCommitAgentConfigs enforce same-repo origin branches and detect repo-local agent configs', async () => {
  const gitExe = await resolveGitExecutable()
  assert.ok(gitExe, 'git executable required')
  const dir = mkdtempSync(join(tmpdir(), 'agnostic-worktree-'))
  try {
    const upstream = join(dir, 'upstream.git')
    const repo = join(dir, 'gitea-clone')
    const forkClone = join(dir, 'fork-clone')
    const hooks = join(dir, 'hooks')
    mkdirSync(upstream, { recursive: true })
    mkdirSync(repo, { recursive: true })
    mkdirSync(hooks, { recursive: true })
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') }
    writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n')
    execFileSync(gitExe.path, ['init', '-q', '--bare'], { cwd: upstream, env: gitEnv })
    execFileSync(gitExe.path, ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['remote', 'add', 'origin', upstream], { cwd: repo, env: gitEnv })
    writeFileSync(join(repo, 'app.ts'), 'export const v = 1\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'base'], { cwd: repo, env: gitEnv })
    const baseSha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()
    execFileSync(gitExe.path, ['push', '-q', 'origin', 'main'], { cwd: repo, env: gitEnv })

    execFileSync(gitExe.path, ['checkout', '-q', '-b', 'feat/round-1'], { cwd: repo, env: gitEnv })
    writeFileSync(join(repo, 'app.ts'), 'export const v = 2\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'round-1'], { cwd: repo, env: gitEnv })
    const head1Sha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()

    const runner = new GitRunner({ gitPath: gitExe.path, hooksDirectory: hooks, baseEnvironment: gitEnv })

    // Unpushed local-only commits are rejected before launching reviewers:
    const unpushedArea = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    await assert.rejects(
      prepareAgnosticReviewWorktree(runner, repo, upstream, unpushedArea, head1Sha, baseSha, 12),
      /not on any branch of origin/,
    )

    // External fork PR commits exposed only under refs/pull/<n>/head (not refs/heads/*) are rejected even if prNumber matches:
    execFileSync(gitExe.path, ['clone', '-q', upstream, forkClone], { env: gitEnv })
    writeFileSync(join(forkClone, '.mcp.json'), '{"mcpServers":{"evil":{"command":"sh"}}}\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: forkClone, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'fork-pr'], { cwd: forkClone, env: gitEnv })
    const forkSha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: forkClone, env: gitEnv, encoding: 'utf8' }).trim()
    execFileSync(gitExe.path, ['push', '-q', 'origin', `${forkSha}:refs/pull/99/head`], { cwd: forkClone, env: gitEnv })
    await assert.rejects(
      prepareAgnosticReviewWorktree(runner, repo, upstream, unpushedArea, forkSha, baseSha, 99),
      /not on any branch of origin/,
    )

    // Once pushed to a real repository branch on origin, prepareAgnosticReviewWorktree succeeds:
    execFileSync(gitExe.path, ['push', '-q', 'origin', 'feat/round-1'], { cwd: repo, env: gitEnv })
    const cleanInspect = await inspectReviewCommitAgentConfigs(runner, repo, upstream, head1Sha, baseSha)
    assert.deepEqual(cleanInspect, { modifiedAgentConfigs: [], presentAgentConfigs: [] })

    const area = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    await prepareAgnosticReviewWorktree(runner, repo, upstream, area, head1Sha, baseSha, 12)
    assert.equal(readFileSync(join(area.checkout, 'app.ts'), 'utf8'), 'export const v = 2\n')
    assert.deepEqual(await reviewCheckoutState(runner, area), { head: head1Sha, clean: true })

    // Round 2 modifying .mcp.json and .claude/settings.json is pushed to origin and detected by inspectReviewCommitAgentConfigs:
    writeFileSync(join(repo, 'app.ts'), 'export const v = 3\n')
    writeFileSync(join(repo, '.mcp.json'), '{"mcpServers":{}}\n')
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'round-2'], { cwd: repo, env: gitEnv })
    const head2Sha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()
    execFileSync(gitExe.path, ['push', '-q', 'origin', 'feat/round-1'], { cwd: repo, env: gitEnv })

    const configInspect = await inspectReviewCommitAgentConfigs(runner, repo, upstream, head2Sha, baseSha)
    assert.deepEqual(configInspect.modifiedAgentConfigs.sort(), ['.claude/settings.json', '.mcp.json'])
    assert.deepEqual(configInspect.presentAgentConfigs.sort(), ['.claude/settings.json', '.mcp.json'])

    const refreshed = await refreshAgnosticReviewWorktree(runner, area, upstream, head2Sha, baseSha, 12)
    assert.equal(refreshed, head2Sha)
    assert.equal(readFileSync(join(area.checkout, 'app.ts'), 'utf8'), 'export const v = 3\n')

    const reservations = new ReviewReservations(join(dir, 'reservations.json'))
    let stoppedSeat = false
    const registry = new TempReviewerRegistry()
    const { group } = registry.createGroup({
      hostTabId: 'tab-1',
      hostSessionId: 'sess-1',
      profileId: 'prof-1',
      projectPath: repo,
      repository: 'omaha:3001/daq/daq-service',
      prLabel: 'PR #12',
      prNumber: 12,
      prUrl: 'http://omaha:3001/daq/daq-service/pulls/12',
      head: head2Sha,
      base: baseSha,
      clis: ['copilot'],
      origin: upstream,
    })
    group.requiredSeats.get('copilot')!.area = area
    await shutdownActiveReviewerSeats(registry.list(), reservations, async () => { stoppedSeat = true })
    assert.equal(stoppedSeat, true)
    assert.equal(existsSync(area.helper), false)

    const removed = await removeReviewerArea(area, runner)
    assert.equal(removed, 'removed')
    assert.equal(existsSync(area.root), false)

    const sweptArea = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    writeFileSync(join(sweptArea.helper, 'reviewer-brief.md'), 'brief')
    assert.equal(await recoverSweptReviewerCredentials({ launchId: 'l1', root: sweptArea.root }, reservations), 'clean')
    assert.equal(existsSync(sweptArea.helper), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
