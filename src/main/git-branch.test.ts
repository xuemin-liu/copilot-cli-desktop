import assert from 'node:assert/strict'
import test from 'node:test'
import { RECENT_ACTIVITY_MS, branchNameProblem, describeSwitchFailure, projectActivity } from './git-branch.js'
import { branchListArgs, createBranchArgs, refFormatArgs, switchArgs } from './git-commands.js'
import { parseBranches } from './git-parse.js'
import type { GitRunResult } from './git-runner.js'
import type { DesktopSessionTab } from './types.js'

const failed = (stderr: string): GitRunResult => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr, stdoutTruncated: false, timedOut: false, cancelled: false, durationMs: 1 })

test('branch names the panel will create', () => {
  for (const name of ['feature', 'feature/login', 'fix-123', 'release_1.2', 'ünï-çødé', '日本語', 'a.b', 'user/topic-x']) assert.equal(branchNameProblem(name), null, name)
})

test('branch names it will not, with a reason', () => {
  const bad: Array<[string, RegExp]> = [
    ['', /Type a branch name/], ['   ', /Type a branch name/], [' x', /start or end with a space/], ['x ', /start or end with a space/],
    ['-x', /cannot start with "-"/], ['--force', /cannot start with "-"/], ['@', /reserved/], ['HEAD', /reserved/],
    ['a\u0001b', /control characters/], ['a\u007fb', /control characters/], ['x'.repeat(201), /at most 200/],
    ['a b', /cannot contain spaces/], ['a~b', /cannot contain/], ['a^b', /cannot contain/], ['a:b', /cannot contain/], ['a?b', /cannot contain/],
    ['a*b', /cannot contain/], ['a[b', /cannot contain/], ['a\\b', /cannot contain/], ['a..b', /cannot contain/], ['a@{b', /cannot contain/],
    ['/x', /not a valid/], ['x/', /not a valid/], ['x.', /not a valid/], ['x.lock', /not a valid/], ['a//b', /not a valid/],
  ]
  for (const [name, reason] of bad) assert.match(branchNameProblem(name) ?? '', reason, JSON.stringify(name))
})

test('a failed switch says when local changes were the reason, and that nothing changed', () => {
  for (const stderr of [
    'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.\nAborting',
    'error: The following untracked working tree files would be overwritten by checkout:\n\tb.txt\nPlease move or remove them before you switch branches.',
  ]) {
    const failure = describeSwitchFailure(failed(stderr), 'switch')
    assert.equal(failure.reason, 'local-changes')
    assert.match(failure.message, /would be overwritten.*Nothing was changed/)
  }
  assert.deepEqual(describeSwitchFailure(failed("fatal: a branch named 'x' already exists"), 'create'), { reason: 'failed', message: 'A branch with that name already exists.' })
  assert.deepEqual(describeSwitchFailure(failed('hint: do something\nfatal: invalid reference: nope'), 'switch'), { reason: 'failed', message: 'fatal: invalid reference: nope' })
  assert.match(describeSwitchFailure(failed(''), 'switch').message, /git switch failed \(exit 1\)/)
})

const tab = (extra: Partial<DesktopSessionTab> = {}): DesktopSessionTab => ({
  id: 't', title: 'Main session', workspaceProfileId: 'p1', lastSessionId: null, status: 'running', activity: 'idle', processId: 1, cliVersion: null,
  sessionPermissionPreset: null, sessionPermissionMode: null, permissionWarning: null, remote: false, lastActivityAt: 0, ...extra,
})

test('a session counts as working when it is, is starting, waits for approval, or was active a moment ago without a signal', () => {
  const now = 1_000_000
  assert.deepEqual(projectActivity([], 'p1', now), { busy: false, detail: '' })
  assert.deepEqual(projectActivity([tab({ activity: 'idle' })], 'p1', now), { busy: false, detail: '' })
  assert.equal(projectActivity([tab({ activity: 'working' })], 'p1', now).detail, '"Main session" is working')
  assert.equal(projectActivity([tab({ status: 'starting', activity: null })], 'p1', now).busy, true)
  assert.match(projectActivity([tab({ status: 'approval-needed', activity: null })], 'p1', now).detail, /waiting for you to approve/)
  // No reliable signal: recent output means "maybe", old output means "not".
  assert.equal(projectActivity([tab({ activity: null, lastActivityAt: now - 5_000 })], 'p1', now).busy, true)
  const unreported = tab({ lastActivityAt: now - 5_000 })
  delete unreported.activity
  assert.equal(projectActivity([unreported], 'p1', now).busy, true, 'a tab that never reported activity')
  assert.equal(projectActivity([tab({ activity: null, lastActivityAt: now - RECENT_ACTIVITY_MS - 1 })], 'p1', now).busy, false)
  // Observed idleness wins over recent output.
  assert.equal(projectActivity([tab({ activity: 'idle', lastActivityAt: now })], 'p1', now).busy, false)
})

test('only sessions of this project, and only live ones, count', () => {
  const now = 1_000_000
  assert.equal(projectActivity([tab({ workspaceProfileId: 'other', activity: 'working' })], 'p1', now).busy, false)
  for (const status of ['completed', 'crashed', 'stopping'] as const) assert.equal(projectActivity([tab({ status, activity: 'working' })], 'p1', now).busy, false, status)
  assert.equal(projectActivity([tab({ workspaceProfileId: 'other', activity: 'working' }), tab({ title: 'Second', activity: 'working' })], 'p1', now).detail, '"Second" is working')
  assert.equal(projectActivity([tab({ title: '', activity: 'working' })], 'p1', now).detail, '"A session" is working')
})

test('branches are read from one line each and parsed with their upstream distance', () => {
  const unit = String.fromCharCode(31)
  const oid = 'a'.repeat(40)
  const line = (...fields: string[]): string => fields.join(unit)
  const output = [
    line('*', 'refs/heads/main', oid, 'origin/main', 'ahead 2, behind 1', '1700000300', 'newest work'),
    line(' ', 'refs/heads/feature/x', oid, 'origin/feature/x', '', '1700000200', 'in sync'),
    line(' ', 'refs/heads/old', oid, 'origin/old', 'gone', '1700000100', 'upstream deleted'),
    line(' ', 'refs/heads/local', oid, '', '', '1700000000', 'subject with spaces and: punctuation'),
    line(' ', 'refs/heads/ahead-only', oid, 'origin/a', 'ahead 3', '1700000000', 's'),
    line(' ', 'refs/heads/behind-only', oid, 'origin/b', 'behind 4', '1700000000', 's'),
    'not a branch line',
    line(' ', 'refs/heads/bad-oid', 'zz', '', '', '1', 's'),
    line(' ', 'refs/heads/', oid, '', '', '1', 's'),
    line(' ', 'refs/tags/not-a-branch', oid, '', '', '1', 's'),
    line(' ', 'heads/feature', oid, '', '', '1', 's'),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10)
  const branches = parseBranches(output)
  assert.deepEqual(branches.map(branch => branch.name), ['main', 'feature/x', 'old', 'local', 'ahead-only', 'behind-only'])
  const by = Object.fromEntries(branches.map(branch => [branch.name, branch]))
  assert.deepEqual([by.main!.current, by.main!.ahead, by.main!.behind, by.main!.upstream], [true, 2, 1, 'origin/main'])
  assert.deepEqual([by['feature/x']!.ahead, by['feature/x']!.behind, by['feature/x']!.current], [0, 0, false])
  assert.deepEqual([by.old!.upstreamGone, by.old!.ahead, by.old!.behind], [true, null, null])
  assert.deepEqual([by.local!.upstream, by.local!.ahead, by.local!.behind, by.local!.subject], [null, null, null, 'subject with spaces and: punctuation'])
  assert.deepEqual([by['ahead-only']!.ahead, by['ahead-only']!.behind], [3, 0])
  assert.deepEqual([by['behind-only']!.ahead, by['behind-only']!.behind], [0, 4])
  assert.equal(by.main!.committedAt, 1_700_000_300)
  assert.equal(parseBranches(output, 2).length, 2, 'capped')
  assert.deepEqual(parseBranches(''), [])
})

test('branch commands never force or merge, never recurse into submodules, and refuse option-like names', () => {
  assert.deepEqual(switchArgs('feature'), ['switch', '--no-guess', '--no-recurse-submodules', 'feature'])
  assert.deepEqual(createBranchArgs('idea'), ['switch', '--no-guess', '--no-recurse-submodules', '--no-track', '--create', 'idea'])
  for (const args of [switchArgs('x'), createBranchArgs('x')]) {
    assert.equal(args.some(arg => /^(--force|-f|--merge|-m|--discard-changes|--detach|-d|--orphan)$/.test(arg)), false, args.join(' '))
  }
  for (const bad of ['-f', '--force', '-c']) {
    assert.throws(() => switchArgs(bad), /cannot start with "-"/)
    assert.throws(() => createBranchArgs(bad), /cannot start with "-"/)
  }
  assert.throws(() => switchArgs('a\0b'), /NUL/)
  assert.deepEqual(refFormatArgs('@{-1}'), ['check-ref-format', 'refs/heads/@{-1}'], 'shorthand is checked as a literal name')
  assert.ok(branchListArgs().includes('refs/heads'))
  assert.ok(branchListArgs().includes('--count=500'))
})
