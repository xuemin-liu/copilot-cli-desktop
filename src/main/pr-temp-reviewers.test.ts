import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GitRunner, resolveGitExecutable } from './git-runner.js'
import {
  githubPullUrlKey,
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
  buildCopilotOneShotReviewerArgs,
  buildOtherCliReviewerCliArgs,
  otherCliReviewerOneShot,
  claudeBypassesPermissions,
  claudeTrustFolderForCheckout,
  interactiveSeatsToReconcile,
  buildReviewerBrief,
  cleanupReviewerSeatCredentials,
  parseAnyPullRequestInput,
  prReviewAndFixRequest,
  reconcileSeatWithEvidenceLoader,
  recoverSweptReviewerCredentials,
  repositoryLabelFromOrigin,
  resolveCopilotReviewerPreset,
  resolveOtherCliReviewerArgs,
  reviewerHelperDirAccess,
  shutdownActiveReviewerSeats,
  TempReviewerRegistry,
  discloseAgentConfigs,
  undisclosedAgentConfigs,
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
  assert.deepEqual(
    prReviewAndFixRequest('/review-and-fix-pr 18 focus on edge cases'),
    { number: 18, repository: null },
  )
  assert.deepEqual(
    prReviewAndFixRequest('/review-and-fix-pr http://omaha:3001/daq/daq-service/pulls/12 and check tests'),
    { number: 12, repository: 'omaha:3001/daq/daq-service', prUrl: 'http://omaha:3001/daq/daq-service/pulls/12' },
  )
  assert.deepEqual(
    prReviewAndFixRequest('review and fix PR 42 and make sure tests pass'),
    { number: 42, repository: null },
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
  for (const [cli, tag] of [
    ['copilot', '[Copilot CLI]'],
    ['claude', '[Claude Code]'],
    ['codex', '[Codex CLI]'],
    ['antigravity', '[Antigravity CLI]'],
  ] as const) {
    const brief = buildReviewerBrief({
      cli,
      repository: 'xuemin-liu/copilot-cli-desktop',
      prLabel: 'PR #322',
      prNumber: 322,
      prUrl: 'https://github.com/xuemin-liu/copilot-cli-desktop/pull/322',
      round: 2,
      head: HEAD,
      base: BASE,
      marker: '🤖 ',
      reviewPrSkillPath: '/app/resources/pr-workflows/skills/review-pr/SKILL.md',
      prToolsDir: '/app/resources/pr-workflows',
      seatStateDir: '/tmp/seat-state',
      checkoutPath: '/tmp/seat-checkout',
      roundHistory: [{ round: 2, head: HEAD, base: BASE, summary: '🤖 Fixed edge case' }],
      seatReceiptConfigPath: '/tmp/seat-receipt.json',
    })
    assert.match(brief, /review-pr\/SKILL\.md/)
    assert.match(brief, /Post all reviews, inline findings, thread replies, and approvals directly onto the PR on its remote host/)
    assert.ok(brief.includes(tag), `brief includes reviewer tag ${tag}`)
    assert.ok(
      brief.includes(`pr-approve.mjs" "https://github.com/xuemin-liu/copilot-cli-desktop/pull/322" 322 ${HEAD} ${BASE}`),
      'passes full PR URL as first argument to pr-approve.mjs when available',
    )
    assert.ok(brief.includes(`Approved at ${HEAD}\\n\\n${tag} ...\\n\\nReviewed base: ${BASE}`), 'documents pr-approve.mjs base-bound tagged format')
    assert.ok(brief.includes('pr-seat-receipt.mjs'), 'documents seat completion receipt helper')
    assert.ok(brief.includes('Prior Round Context'), 'includes prior round summary')
    assert.match(brief, /Do NOT start `pr-poll\.mjs --watch-head`/, 'managed single-round brief forbids background poll loop')
    assert.doesNotMatch(brief, /--invert --watch-head --wait/, 'managed single-round brief never gives reviewer a watch-head wait command')
    assert.doesNotMatch(brief, /copilot-pr-reviewer|pr_review\(|pr-review -File/, 'never uses local review endpoints')
  }
  const giteaBrief = buildReviewerBrief({
    cli: 'claude',
    repository: 'omaha:3001/daq/daq-service',
    prLabel: 'PR #12',
    prNumber: 12,
    prUrl: 'http://omaha:3001/daq/daq-service/pulls/12',
    round: 1,
    head: HEAD,
    base: BASE,
    marker: '🤖 ',
    prToolsDir: '/app/resources/pr-workflows',
  })
  assert.ok(
    giteaBrief.includes(`pr-approve.mjs" "http://omaha:3001/daq/daq-service/pulls/12" 12 ${HEAD} ${BASE}`),
    'self-hosted Gitea brief passes PR URL (not host-prefixed repository label) as first pr-approve.mjs argument',
  )
})

test('resolveCopilotReviewerPreset and resolveOtherCliReviewerArgs apply verified allow-all flags when enabled and respect workspace settings when disabled', () => {
  assert.equal(resolveCopilotReviewerPreset('default', true, 'demo'), 'full-access')
  assert.equal(resolveCopilotReviewerPreset('read-only', true, 'demo'), 'full-access')
  assert.equal(resolveCopilotReviewerPreset('trusted-directory', false, 'demo'), 'trusted-directory')
  assert.throws(() => resolveCopilotReviewerPreset('read-only', false, 'demo'), /Restricted \(read-only\)/)

  assert.deepEqual(
    resolveOtherCliReviewerArgs('claude', { approval: 'plan', model: 'claude-sonnet-5', reasoningEffort: 'max' }, true, '  --dangerously-skip-permissions\n  --model <m>\n  --effort <effort>', 'demo'),
    { configForLaunch: { model: 'claude-sonnet-5', reasoningEffort: 'max' }, allowAllArgs: ['--dangerously-skip-permissions'] },
  )
  assert.deepEqual(
    resolveOtherCliReviewerArgs('claude', undefined, true, '  --permission-mode <mode>', 'demo'),
    { configForLaunch: undefined, allowAllArgs: ['--permission-mode', 'bypassPermissions'] },
  )
  assert.throws(
    () => resolveOtherCliReviewerArgs('claude', undefined, true, null, 'demo'),
    /Could not confirm that this Claude Code installation supports/,
  )

  assert.deepEqual(
    resolveOtherCliReviewerArgs('codex', { approval: 'on-request', sandbox: 'read-only', model: 'gpt-5-codex', reasoningEffort: 'high' }, true, '  --dangerously-bypass-approvals-and-sandbox\n  --model <m>\n  --config <value>', 'demo'),
    { configForLaunch: { model: 'gpt-5-codex', reasoningEffort: 'high' }, allowAllArgs: ['--dangerously-bypass-approvals-and-sandbox'] },
  )
  assert.deepEqual(
    resolveOtherCliReviewerArgs('codex', undefined, true, '  --ask-for-approval <a>\n  --sandbox <s>', 'demo'),
    { configForLaunch: undefined, allowAllArgs: ['--ask-for-approval', 'never', '--sandbox', 'danger-full-access'] },
  )
  assert.throws(
    () => resolveOtherCliReviewerArgs('codex', { sandbox: 'read-only' }, false, '  --sandbox <s>', 'demo'),
    /Read only/,
  )
  assert.deepEqual(
    resolveOtherCliReviewerArgs('codex', { approval: 'allow-all', sandbox: 'read-only' }, false, '  --dangerously-bypass-approvals-and-sandbox', 'demo'),
    { configForLaunch: { approval: 'allow-all', sandbox: 'read-only' }, allowAllArgs: [] },
  )

  assert.deepEqual(
    resolveOtherCliReviewerArgs('antigravity', { approval: 'plan', model: 'gemini-3-pro' }, true, '  --dangerously-skip-permissions\n  --model <m>', 'demo'),
    { configForLaunch: { model: 'gemini-3-pro' }, allowAllArgs: ['--dangerously-skip-permissions'] },
  )
  assert.deepEqual(
    resolveOtherCliReviewerArgs('antigravity', undefined, true, '  --mode <m>', 'demo'),
    { configForLaunch: undefined, allowAllArgs: ['--mode', 'auto'] },
  )
  assert.throws(
    () => resolveOtherCliReviewerArgs('antigravity', undefined, true, null, 'demo'),
    /Could not confirm that this Antigravity CLI installation supports/,
  )

  // Claude Code gets its helper folder via --settings permissions.additionalDirectories so interactive mode never stalls at an --add-dir trust prompt:
  assert.deepEqual(
    reviewerHelperDirAccess('claude', '  --add-dir <directories...>\n  --settings <file-or-json>', '/tmp/helper', '/tmp/helper/claude-settings.json'),
    { args: ['--settings', '/tmp/helper/claude-settings.json'], settings: '{"permissions":{"additionalDirectories":["/tmp/helper"]}}' },
  )
  assert.deepEqual(
    reviewerHelperDirAccess('claude', '  --add-dir <directories...>', '/tmp/helper', '/tmp/helper/claude-settings.json'),
    { args: ['--add-dir', '/tmp/helper'], settings: null },
  )
  assert.deepEqual(
    reviewerHelperDirAccess('codex', '  --add-dir <dir>\n  --settings <file>', '/tmp/helper', '/tmp/helper/claude-settings.json'),
    { args: ['--add-dir', '/tmp/helper'], settings: null },
  )
  assert.deepEqual(reviewerHelperDirAccess('antigravity', null, '/tmp/helper', '/tmp/x.json'), { args: [], settings: null })

  // Claude Code's one-shot mode prints nothing until it ends, so it stays interactive; the others run one-shot with allow-all.
  // A meeting's reviewer reaches this computer only: Codex read-only is refused for a pull request, and fine for a meeting.
  assert.throws(() => resolveOtherCliReviewerArgs('codex', { sandbox: 'read-only' }, false, null, 'demo'), /blocks network access to the pull request host/)
  assert.deepEqual(resolveOtherCliReviewerArgs('codex', { sandbox: 'read-only' }, false, null, 'demo', false), { configForLaunch: { sandbox: 'read-only' }, allowAllArgs: [] })
  assert.equal(otherCliReviewerOneShot('claude', true, true), false)
  // In a project Claude Code does not trust, interactive would stop at its trust question: it stays one-shot.
  assert.equal(otherCliReviewerOneShot('claude', true, false), true)
  assert.equal(otherCliReviewerOneShot('claude', true), true)
  assert.equal(otherCliReviewerOneShot('claude', false, true), false)
  assert.equal(otherCliReviewerOneShot('codex', true, true), true)
  // Bypass mode is recognised by either spelling, wherever the arguments came from.
  assert.equal(claudeBypassesPermissions(['--model', 'x', '--dangerously-skip-permissions']), true)
  assert.equal(claudeBypassesPermissions(['--permission-mode', 'bypassPermissions']), true)
  assert.equal(claudeBypassesPermissions(['--permission-mode=bypassPermissions']), true)
  assert.equal(claudeBypassesPermissions(['--permission-mode', 'acceptEdits']), false)
  assert.equal(claudeBypassesPermissions(['--model', 'bypassPermissions']), false)
  assert.equal(claudeBypassesPermissions([]), false)
  // Trust is asked about the main repository folder only: a linked worktree's own folder is never the answer.
  assert.equal(claudeTrustFolderForCheckout(join('work', 'main', '.git')), join('work', 'main'))
  assert.equal(claudeTrustFolderForCheckout(`${join('work', 'main', '.git')}/`), join('work', 'main'))
  assert.equal(claudeTrustFolderForCheckout(join('work', 'bare.git')), null, 'a bare repository has no main folder')
  assert.equal(claudeTrustFolderForCheckout(join('work', 'main', '.git', 'worktrees', 'feature-wt')), null)
  assert.equal(claudeTrustFolderForCheckout(''), null)
  assert.equal(claudeTrustFolderForCheckout(null), null)
  assert.equal(otherCliReviewerOneShot('codex', true), true)
  assert.equal(otherCliReviewerOneShot('antigravity', true), true)
  assert.equal(otherCliReviewerOneShot('codex', false), false)

  // With --dangerously-skip-permissions, the interactive session's bypass notice is answered in the same settings file.
  assert.deepEqual(
    reviewerHelperDirAccess('claude', '  --settings <file-or-json>', '/tmp/helper', '/tmp/helper/claude-settings.json', true),
    { args: ['--settings', '/tmp/helper/claude-settings.json'], settings: '{"permissions":{"additionalDirectories":["/tmp/helper"]},"skipDangerousModePermissionPrompt":true}' },
  )
  assert.equal(reviewerHelperDirAccess('claude', '  --settings <file-or-json>', '/tmp/helper', '/tmp/x.json', false).settings, '{"permissions":{"additionalDirectories":["/tmp/helper"]}}')
  assert.deepEqual(reviewerHelperDirAccess('codex', '  --add-dir <dir>', '/tmp/helper', '/tmp/x.json', true), { args: ['--add-dir', '/tmp/helper'], settings: null })

  // Only running seats of an interactive non-Copilot CLI, in a group under way, are asked about at the PR host.
  const seatOf = (cli: string, lifecycle: string): unknown => ({ cli, lifecycle })
  const groupOf = (stage: string, seats: unknown[]): unknown => ({ stage, requiredSeats: new Map(seats.map((s) => [(s as { cli: string }).cli, s])) })
  const groups = [
    groupOf('active', [seatOf('claude', 'running'), seatOf('codex', 'running'), seatOf('antigravity', 'running'), seatOf('copilot', 'running')]),
    groupOf('active', [seatOf('claude', 'approved')]),
    groupOf('starting', [seatOf('claude', 'running')]),
    groupOf('ended', [seatOf('claude', 'running')]),
  ] as Parameters<typeof interactiveSeatsToReconcile>[0]
  assert.deepEqual(interactiveSeatsToReconcile(groups, true).map(({ seat }) => seat.cli), ['claude'])
  assert.deepEqual(interactiveSeatsToReconcile(groups, false).map(({ seat }) => seat.cli), ['claude', 'codex', 'antigravity'])

  assert.deepEqual(
    buildOtherCliReviewerCliArgs('claude', {
      configArgs: ['--dangerously-skip-permissions'],
      addDirArgs: ['--add-dir', '/tmp/helper'],
      generation: '11111111-1111-4111-8111-111111111111',
      prompt: 'Review PR',
      help: '  --session-id <id>',
    }),
    ['--dangerously-skip-permissions', '--session-id', '11111111-1111-4111-8111-111111111111', '--add-dir', '/tmp/helper', '--', 'Review PR'],
  )
  assert.deepEqual(
    buildOtherCliReviewerCliArgs('codex', {
      configArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      addDirArgs: ['--add-dir', '/tmp/helper'],
      generation: '11111111-1111-4111-8111-111111111111',
      prompt: 'Review PR',
      help: '  --add-dir <dir>',
    }),
    ['--dangerously-bypass-approvals-and-sandbox', '--add-dir', '/tmp/helper', 'Review PR'],
  )
  assert.deepEqual(
    buildOtherCliReviewerCliArgs('antigravity', {
      configArgs: ['--dangerously-skip-permissions'],
      addDirArgs: ['--add-dir', '/tmp/helper'],
      generation: '11111111-1111-4111-8111-111111111111',
      prompt: 'Review PR',
      help: '  --prompt-interactive\n  --add-dir',
    }),
    ['--dangerously-skip-permissions', '--add-dir', '/tmp/helper', '--prompt-interactive', 'Review PR'],
  )
  assert.deepEqual(
    buildOtherCliReviewerCliArgs('antigravity', {
      configArgs: ['--dangerously-skip-permissions'],
      addDirArgs: [],
      generation: '11111111-1111-4111-8111-111111111111',
      prompt: '-leading-dash',
      help: '  --prompt-interactive',
    }),
    ['--dangerously-skip-permissions', '--prompt-interactive', ' -leading-dash'],
  )

  // One-shot non-interactive launch args across all 4 CLIs when reviewerAllowAll is true:
  assert.deepEqual(
    buildCopilotOneShotReviewerArgs(
      ['--mouse=on', '--session-id=11111111-1111-4111-8111-111111111111', '--allow-all'],
      true,
      { checkout: '/tmp/co', helper: '/tmp/hlp' },
      'Review PR',
    ),
    ['--session-id=11111111-1111-4111-8111-111111111111', '--allow-all', '--add-dir', '/tmp/co', '--add-dir', '/tmp/hlp', '-p', 'Review PR'],
  )
  assert.deepEqual(
    buildOtherCliReviewerCliArgs('claude', {
      configArgs: ['--dangerously-skip-permissions'],
      addDirArgs: ['--add-dir', '/tmp/helper'],
      generation: '11111111-1111-4111-8111-111111111111',
      prompt: 'Review PR',
      help: '  -p, --print\n  --verbose\n  --session-id <id>\n  --resume <id>',
      oneShot: true,
    }),
    ['--dangerously-skip-permissions', '--session-id', '11111111-1111-4111-8111-111111111111', '--add-dir', '/tmp/helper', '-p', '--verbose', '--', 'Review PR'],
  )
  assert.deepEqual(
    buildOtherCliReviewerCliArgs('claude', {
      configArgs: ['--dangerously-skip-permissions'],
      addDirArgs: ['--add-dir', '/tmp/helper'],
      generation: '22222222-2222-4222-8222-222222222222',
      prompt: 'Review Round 2',
      help: '  -p, --print\n  --verbose\n  --session-id <id>\n  --resume <id>',
      oneShot: true,
      resumeSessionId: '11111111-1111-4111-8111-111111111111',
    }),
    ['--dangerously-skip-permissions', '--resume', '11111111-1111-4111-8111-111111111111', '--add-dir', '/tmp/helper', '-p', '--verbose', '--', 'Review Round 2'],
  )
  assert.deepEqual(
    buildOtherCliReviewerCliArgs('codex', {
      configArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      addDirArgs: ['--add-dir', '/tmp/helper'],
      generation: '11111111-1111-4111-8111-111111111111',
      prompt: 'Review PR',
      help: 'Commands:\n  exec  Run Codex non-interactively\nOptions:\n  --add-dir <dir>',
      oneShot: true,
    }),
    ['exec', '--dangerously-bypass-approvals-and-sandbox', '--add-dir', '/tmp/helper', 'Review PR'],
  )
  assert.deepEqual(
    buildOtherCliReviewerCliArgs('antigravity', {
      configArgs: ['--dangerously-skip-permissions'],
      addDirArgs: ['--add-dir', '/tmp/helper'],
      generation: '11111111-1111-4111-8111-111111111111',
      prompt: 'Review PR',
      help: '  --prompt-interactive\n  --print\n  --conversation <id>\n  --add-dir',
      oneShot: true,
      resumeSessionId: '99999999-9999-4999-8999-999999999999',
    }),
    ['--dangerously-skip-permissions', '--conversation', '99999999-9999-4999-8999-999999999999', '--add-dir', '/tmp/helper', '--print', 'Review PR'],
  )
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
  copilotSeat.checkedOut = HEAD
  copilotSeat.checkedOutBase = BASE
  claudeSeat.checkedOut = HEAD
  claudeSeat.checkedOutBase = BASE
  copilotSeat.lifecycle = 'running'
  claudeSeat.lifecycle = 'running'

  const status = JSON.parse(registry.statusPayload(group)) as {
    done: boolean
    allSeatsSettledForRound: boolean
    allApprovedCurrentHead: boolean
    expectedReviewerTags: string[]
    group: { round: number; seats: Array<{ cli: string; verdict: string }> }
  }
  assert.equal(status.done, false)
  assert.equal(status.allSeatsSettledForRound, false)
  assert.equal(status.allApprovedCurrentHead, false)
  assert.deepEqual(status.expectedReviewerTags, ['[Copilot CLI]', '[Claude Code]'])
  assert.equal(registry.settledStateKey(group), null, 'healthy reviewing seats block wait up to timeout')

  // Advancing round while seats are still running is refused unless force: true:
  assert.throws(
    () => registry.advanceRound(group.id, HEAD2, BASE, `🤖 Premature round`),
    /Cannot advance to a new round while reviewer seat\(s\) are still active/,
  )

  // Attention needed (e.g. tool approval prompt in hidden tab) surfaces immediately to wait:
  claudeSeat.needsAttention = true
  const attentionKey = registry.settledStateKey(group)
  assert.ok(attentionKey)
  claudeSeat.needsAttention = false

  // Incomplete exit (exit 0 without verified PR post) blocks finish('approved') and marks needsAttention:
  registry.recordSeatOutcome(claudeSeat, 'incomplete', { error: 'No verified PR post' })
  assert.equal(registry.view(group).seats.find((s) => s.cli === 'claude')?.needsAttention, true)
  assert.throws(() => registry.finishByHost(group.id, 'approved'), /incomplete/)

  // Failed seat blocks approved finish until retried or dismissed:
  registry.revokeSeat(claudeSeat, 'failed', 'Claude exited unexpectedly')
  assert.throws(() => registry.finishByHost(group.id, 'approved'), /failed/)

  // Copilot posts findings, Claude is retried and posts findings -> allSeatsSettledForRound becomes true!
  registry.recordSeatOutcome(copilotSeat, 'findings', { claimedKeys: ['review:101'] })
  const retried = registry.resetSeatGeneration(group.id, 'claude')
  retried.checkedOut = HEAD
  retried.checkedOutBase = BASE
  retried.lifecycle = 'running'
  // Force-skipping an active seat records skippedSeatsForHead and blocks finish('approved') until retried/dismissed:
  registry.advanceRound(group.id, HEAD2, BASE, `🤖 Force round`, { force: true })
  assert.equal(group.round, 2)
  assert.equal(group.head, HEAD2)
  assert.equal(copilotSeat.checkedOut, HEAD, 'advanceRound never mutates seat.checkedOut before worktree refresh succeeds')
  assert.equal(group.skippedSeatsForHead.has('claude'), true)

  // Refresh worktrees to HEAD2 and verify skippedSeatsForHead still blocks finish('approved') until explicit retry:
  copilotSeat.checkedOut = HEAD2
  copilotSeat.checkedOutBase = BASE
  retried.checkedOut = HEAD2
  retried.checkedOutBase = BASE
  registry.recordSeatOutcome(copilotSeat, 'approved', { claimedKeys: ['issue:201'] })
  registry.recordSeatOutcome(retried, 'approved', { claimedKeys: ['issue:202'] })
  assert.throws(() => registry.finishByHost(group.id, 'approved'), /force-skipped/)

  // Non-retry round reset (without clearForceSkip: true) MUST NOT clear skippedSeatsForHead!
  const roundReset = registry.resetSeatGeneration(group.id, 'claude', { keepArea: true })
  assert.equal(group.skippedSeatsForHead.has('claude'), true, 'round relaunch does not clear force-skip gate')
  roundReset.checkedOut = HEAD2
  roundReset.checkedOutBase = BASE
  registry.recordSeatOutcome(roundReset, 'approved', { claimedKeys: ['issue:202b'] })
  assert.throws(() => registry.finishByHost(group.id, 'approved'), /force-skipped/)

  // Explicit user Retry ({ clearForceSkip: true }) clears skippedSeatsForHead; once verified approved at (HEAD2, BASE), allApprovedCurrentHead is true and finishByHost('approved') succeeds!
  const cleanRetry = registry.resetSeatGeneration(group.id, 'claude', { clearForceSkip: true })
  assert.equal(group.skippedSeatsForHead.has('claude'), false)
  cleanRetry.checkedOut = HEAD2
  cleanRetry.checkedOutBase = BASE
  registry.recordSeatOutcome(cleanRetry, 'approved', { claimedKeys: ['issue:203'] })
  assert.equal(registry.allSeatsSettledForRound(group), true)
  assert.equal(registry.allApprovedCurrentHead(group), true)

  const finished = registry.finishByHost(group.id, 'approved')
  assert.equal(finished.view.stage, 'ended')
  assert.equal(finished.view.outcome, 'approved')
  assert.equal(finished.seats.length, 2)
})

test('reconcileSeatWithEvidenceLoader refuses to overwrite timed-out or round-advanced seats when in-flight verification resolves or rejects late', async () => {
  const registry = new TempReviewerRegistry()
  const { group } = registry.createGroup({
    hostTabId: 'tab-race',
    hostSessionId: 'sess-race',
    profileId: 'prof-race',
    projectPath: '/tmp/repo',
    repository: 'owner/repo',
    prLabel: 'PR #50',
    prNumber: 50,
    prUrl: 'https://github.com/owner/repo/pull/50',
    head: HEAD,
    base: BASE,
    clis: ['claude', 'codex'],
    origin: 'https://github.com/owner/repo.git',
  })
  group.stage = 'active'
  const claudeSeat = group.requiredSeats.get('claude')!
  const codexSeat = group.requiredSeats.get('codex')!
  claudeSeat.checkedOut = HEAD
  claudeSeat.checkedOutBase = BASE
  claudeSeat.lifecycle = 'running'
  codexSeat.checkedOut = HEAD
  codexSeat.checkedOutBase = BASE
  codexSeat.lifecycle = 'running'

  // 1. In-flight resolve after seat already transitioned to 'timed-out' must NOT overwrite 'timed-out'!
  const lateResolve = await reconcileSeatWithEvidenceLoader({
    registry,
    group,
    seat: claudeSeat,
    trigger: 'completed',
    loadEvidence: async () => {
      registry.revokeSeat(claudeSeat, 'timed-out', 'Claude timed out after 45 minutes.')
      return { supported: true, verified: { verdict: 'approved', claimedKeys: ['issue:901'] } }
    },
  })
  assert.equal(lateResolve.ok, false)
  assert.equal(claudeSeat.lifecycle, 'timed-out')
  assert.equal(claudeSeat.error, 'Claude timed out after 45 minutes.')
  assert.equal(group.claimedEvidenceKeys.has('issue:901'), false)

  // 2. In-flight reject/throw after seat already transitioned to 'timed-out' must NOT overwrite 'timed-out' with 'incomplete'!
  const lateReject = await reconcileSeatWithEvidenceLoader({
    registry,
    group,
    seat: codexSeat,
    trigger: 'completed',
    loadEvidence: async () => {
      registry.revokeSeat(codexSeat, 'timed-out', 'Codex timed out after 45 minutes.')
      throw new Error('Forge GET failed (503)')
    },
  })
  assert.equal(lateReject.ok, false)
  assert.equal(codexSeat.lifecycle, 'timed-out')
  assert.equal(codexSeat.error, 'Codex timed out after 45 minutes.')

  // 3. In-flight resolve after force round advance must NOT apply stale round outcome to new round!
  const retriedCodex = registry.resetSeatGeneration(group.id, 'codex', { clearForceSkip: true })
  retriedCodex.lifecycle = 'running'
  const staleRound = await reconcileSeatWithEvidenceLoader({
    registry,
    group,
    seat: retriedCodex,
    trigger: 'completed',
    loadEvidence: async () => {
      registry.advanceRound(group.id, HEAD2, BASE, '🤖 Superseded round', { force: true })
      return { supported: true, verified: { verdict: 'approved', claimedKeys: ['issue:902'] } }
    },
  })
  assert.equal(staleRound.ok, false)
  assert.equal(group.claimedEvidenceKeys.has('issue:902'), false)

  // 4. Event queued behind another seat's verification when seat is reset BEFORE this verification starts:
  // Capturing expectedRound/expectedGeneration at enqueue time ensures the reused seat's new generation stays 'running' and its timer is untouched!
  const freshClaude = registry.resetSeatGeneration(group.id, 'claude', { clearForceSkip: true })
  freshClaude.lifecycle = 'running'
  const enqueuedRound = group.round
  const enqueuedGen = freshClaude.generation
  let releaseBlocker!: () => void
  const blockerPromise = new Promise<void>((resolveBlocker) => {
    releaseBlocker = resolveBlocker
  })

  let clearedReplacementTimer = false
  const queuedOldCompletion = blockerPromise.then(() =>
    reconcileSeatWithEvidenceLoader({
      registry,
      group,
      seat: freshClaude,
      trigger: 'completed',
      expectedRound: enqueuedRound,
      expectedGeneration: enqueuedGen,
      onClearTimer: () => {
        clearedReplacementTimer = true
      },
      loadEvidence: async () => ({ supported: true, verified: null }),
    }),
  )

  // Reset seat to a new generation BEFORE releasing the queue blocker!
  const replacementClaude = registry.resetSeatGeneration(group.id, 'claude', { clearForceSkip: true })
  assert.equal(replacementClaude, freshClaude, 'resetSeatGeneration mutates the seat object in place')
  replacementClaude.lifecycle = 'running'
  releaseBlocker()

  const queuedRes = await queuedOldCompletion
  assert.equal(queuedRes.ok, false)
  assert.equal(replacementClaude.lifecycle, 'running', 'queued old completion did not mark replacement generation incomplete')
  assert.equal(clearedReplacementTimer, false, 'queued old completion did not clear replacement generation timer')
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

test('a run started without the question discloses configuration only by naming it in an approved question', () => {
  const asked = { startedWithoutQuestion: false, disclosedAgentConfigs: new Set<string>() }
  assert.deepEqual(undisclosedAgentConfigs(asked, ['.mcp.json']), [], 'a run that asked at start was shown the tree')
  const quiet = { startedWithoutQuestion: true, disclosedAgentConfigs: new Set<string>() }
  assert.deepEqual(undisclosedAgentConfigs(quiet, []), [])
  // A verification-only question at a round with no configuration discloses nothing.
  discloseAgentConfigs(quiet, undisclosedAgentConfigs(quiet, []))
  // Configuration then arrives through the base, present in the tree but not in base...head: still asked.
  assert.deepEqual(undisclosedAgentConfigs(quiet, ['.github/hooks/pre.json']), ['.github/hooks/pre.json'])
  discloseAgentConfigs(quiet, ['.github/hooks/pre.json'])
  assert.deepEqual(undisclosedAgentConfigs(quiet, ['.github/hooks/pre.json']), [], 'shown and approved')
  assert.deepEqual(undisclosedAgentConfigs(quiet, ['.github/hooks/pre.json', '.mcp.json']), ['.mcp.json'], 'a new file is asked about')
})

test('githubPullUrlKey names the same pull request only for the same repository and number', () => {
  const checked = 'https://github.com/owner/repo/pull/12'
  for (const same of ['https://github.com/Owner/Repo/pull/12', 'https://github.com/owner/repo/pull/12/', 'https://github.com/owner/repo/pull/12/files', 'https://github.com/owner/repo/pull/12#discussion_r1', 'https://github.com/owner/repo/pull/12?w=1']) {
    assert.equal(githubPullUrlKey(same), checked, same)
  }
  for (const other of ['https://github.com/attacker/repo/pull/12', 'https://github.com/owner/repo/pull/120', 'https://ghe.example.com/owner/repo/pull/12', 'http://omaha:3001/owner/repo/pulls/12']) {
    assert.notEqual(githubPullUrlKey(other), checked, other)
  }
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
    assert.deepEqual(cleanInspect, { modifiedAgentConfigs: [], presentAgentConfigs: [], complete: true })

    // A pushed branch with no history in common with base: the diff cannot be read, so the scan says it is incomplete.
    execFileSync(gitExe.path, ['checkout', '-q', '--orphan', 'unrelated'], { cwd: repo, env: gitEnv })
    writeFileSync(join(repo, 'app.ts'), 'export const v = 9\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'unrelated'], { cwd: repo, env: gitEnv })
    const unrelatedSha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()
    execFileSync(gitExe.path, ['push', '-q', 'origin', 'unrelated'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['checkout', '-q', '-f', 'feat/round-1'], { cwd: repo, env: gitEnv })
    const unrelatedInspect = await inspectReviewCommitAgentConfigs(runner, repo, upstream, unrelatedSha, baseSha)
    assert.equal(unrelatedInspect.complete, false, 'a diff that could not be read is not a clean result')

    const area = await makeReviewerArea(planReviewerArea(join(dir, 'areas')))
    await prepareAgnosticReviewWorktree(runner, repo, upstream, area, head1Sha, baseSha, 12)
    assert.equal(readFileSync(join(area.checkout, 'app.ts'), 'utf8'), 'export const v = 2\n')
    assert.deepEqual(await reviewCheckoutState(runner, area), { head: head1Sha, clean: true })

    // Round 2 modifying .mcp.json, .claude/..., .codex/..., .github/..., .vscode/..., .gemini/..., and Antigravity [._]agents?/... configs is pushed to origin and detected:
    writeFileSync(join(repo, 'app.ts'), 'export const v = 3\n')
    writeFileSync(join(repo, '.mcp.json'), '{"mcpServers":{}}\n')
    mkdirSync(join(repo, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n')
    writeFileSync(join(repo, '.claude', 'hooks', 'run.sh'), '#!/bin/sh\n')
    // A name Git would quote without -z: still matched.
    writeFileSync(join(repo, '.claude', 'hooks', 'ü.sh'), '#!/bin/sh\n')
    mkdirSync(join(repo, '.codex'), { recursive: true })
    writeFileSync(join(repo, '.codex', 'hooks.json'), '{}\n')
    mkdirSync(join(repo, '.github', 'hooks'), { recursive: true })
    writeFileSync(join(repo, '.github', 'hooks', 'pre.json'), '{}\n')
    mkdirSync(join(repo, '.vscode'), { recursive: true })
    writeFileSync(join(repo, '.vscode', 'mcp.json'), '{}\n')
    mkdirSync(join(repo, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(repo, '.gemini', 'hooks.json'), '{}\n')
    writeFileSync(join(repo, '.gemini', 'config', 'mcp_config.json'), '{}\n')
    mkdirSync(join(repo, '.agents', 'plugins', 'demo'), { recursive: true })
    writeFileSync(join(repo, '.agents', 'hooks.json'), '{}\n')
    writeFileSync(join(repo, '.agents', 'plugins', 'demo', 'mcp_config.json'), '{}\n')
    mkdirSync(join(repo, 'nested', '_agent'), { recursive: true })
    writeFileSync(join(repo, 'nested', '_agent', 'plugins.json'), '{}\n')
    execFileSync(gitExe.path, ['add', '.'], { cwd: repo, env: gitEnv })
    execFileSync(gitExe.path, ['commit', '-q', '-m', 'round-2'], { cwd: repo, env: gitEnv })
    const head2Sha = execFileSync(gitExe.path, ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim()
    execFileSync(gitExe.path, ['push', '-q', 'origin', 'feat/round-1'], { cwd: repo, env: gitEnv })

    const configInspect = await inspectReviewCommitAgentConfigs(runner, repo, upstream, head2Sha, baseSha)
    const expectedConfigs = [
      '.agents/hooks.json',
      '.agents/plugins/demo/mcp_config.json',
      '.claude/hooks/run.sh',
      '.claude/hooks/ü.sh',
      '.claude/settings.json',
      '.codex/hooks.json',
      '.gemini/config/mcp_config.json',
      '.gemini/hooks.json',
      '.github/hooks/pre.json',
      '.mcp.json',
      '.vscode/mcp.json',
      'nested/_agent/plugins.json',
    ]
    assert.deepEqual(configInspect.modifiedAgentConfigs.sort(), expectedConfigs)
    assert.deepEqual(configInspect.presentAgentConfigs.sort(), expectedConfigs)

    // From a subfolder with diff.relative on, the whole repository is still scanned.
    execFileSync(gitExe.path, ['config', 'diff.relative', 'true'], { cwd: repo, env: gitEnv })
    const fromSubfolder = await inspectReviewCommitAgentConfigs(runner, join(repo, 'nested'), upstream, head2Sha, baseSha)
    execFileSync(gitExe.path, ['config', '--unset', 'diff.relative'], { cwd: repo, env: gitEnv })
    assert.equal(fromSubfolder.complete, true)
    assert.deepEqual(fromSubfolder.modifiedAgentConfigs.sort(), expectedConfigs)
    assert.deepEqual(fromSubfolder.presentAgentConfigs.sort(), expectedConfigs)

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
