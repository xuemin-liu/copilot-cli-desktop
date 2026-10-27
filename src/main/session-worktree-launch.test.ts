import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { prepareSessionWorktree } from './session-worktree-launch.js'
import { createGitFixture } from './fixtures/git-fixture.js'
import type { GitRunOptions, GitRunResult } from './git-runner.js'

const name = 'desktop-large-checkout-abcdef'
/** A main checkout in this platform's spelling, as Git prints it (forward slashes), and where its worktrees go. */
const project = resolve('/project')
const printed = project.replace(/\\/g, '/')
const worktree = join(`${project}.worktrees`, name)
const success = (stdout = ''): GitRunResult => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: '',
  stdoutTruncated: false, timedOut: false, cancelled: false, durationMs: 0 })

test('worktree checkout gets ten minutes and preserves private browser environment and other launch flags', async () => {
  const calls: GitRunOptions[] = []
  const controller = new AbortController()
  const options = { cwd: join(project, 'subfolder'), env: { PRIVATE_BROWSER_ENDPOINT: 'private' }, cols: 100, rows: 30, signal: controller.signal }
  const args = ['--mouse=on', `--worktree=${name}`, '--name=Large checkout']
  const prepared = await prepareSessionWorktree(args, options, async request => {
    calls.push(request)
    return success(`worktree ${printed}\0HEAD abc\0\0`)
  })
  assert.equal(calls[1]!.timeoutMs, 600_000)
  assert.equal(calls[1]!.disableHooks, true)
  assert.equal(calls[1]!.signal, controller.signal)
  assert.deepEqual(calls[1]!.args, ['worktree', 'add', '-b', name, worktree, 'HEAD'])
  assert.deepEqual(prepared.args, ['--mouse=on', '--name=Large checkout'])
  assert.equal(prepared.options.cwd, worktree)
  assert.equal(prepared.options.env, options.env)
  assert.equal(args[1], `--worktree=${name}`, 'the saved launch arguments are unchanged')
})

test('ordinary and resumed sessions do not create worktrees', async () => {
  const args = ['--resume=session']
  const options = { cwd: project, env: {}, cols: 80, rows: 24 }
  const prepared = await prepareSessionWorktree(args, options, async () => { throw new Error('Unexpected Git command') })
  assert.equal(prepared.args, args)
  assert.equal(prepared.options, options)
})

test('worktree checkout uses the configured timeout in minutes', async () => {
  const calls: GitRunOptions[] = []
  await prepareSessionWorktree([`--worktree=${name}`],
    { cwd: project, env: {}, cols: 80, rows: 24, worktreeTimeoutMinutes: 25 }, async request => {
      calls.push(request)
      return success(`worktree ${printed}\0\0`)
    })
  assert.equal(calls[1]!.timeoutMs, 25 * 60_000)
  assert.equal(calls[0]!.timeoutMs, undefined, 'repository discovery keeps its own timeout')
})

test('checkout failures and cancellation prevent a CLI launch', async () => {
  for (const cancelled of [false, true]) {
    let calls = 0
    await assert.rejects(prepareSessionWorktree([`--worktree=${name}`], { cwd: project, env: {}, cols: 80, rows: 24 },
      async () => ++calls === 1 ? success(`worktree ${printed}\0\0`) : { ...success(), exitCode: null, timedOut: !cancelled, cancelled }),
    cancelled ? /cancelled/ : /timed out/)
  }
})

test('creates a real linked worktree from the selected HEAD, including when launched in another worktree', async t => {
  const fixture = await createGitFixture()
  if (!fixture) return t.skip('Git unavailable')
  try {
    const repo = fixture.repo('project with spaces')
    const linked = join(fixture.root, 'existing worktree')
    fixture.plain(repo, 'worktree', 'add', '-q', '-b', 'existing', linked)
    fixture.plain(linked, 'commit', '--allow-empty', '-q', '-m', 'linked HEAD')
    const expectedHead = fixture.plain(linked, 'rev-parse', 'HEAD').trim()
    const prepared = await prepareSessionWorktree([`--worktree=${name}`],
      { cwd: linked, env: fixture.env, cols: 80, rows: 24 }, request => fixture.runner.run(request))
    // Git prints the main checkout's real path (a long name on Windows, /private/var on macOS).
    assert.equal(prepared.options.cwd, join(`${realpathSync.native(repo)}.worktrees`, name))
    assert.equal(fixture.plain(prepared.options.cwd, 'rev-parse', 'HEAD').trim(), expectedHead)
    assert.equal(await readFile(join(prepared.options.cwd, 'a.txt'), 'utf8'), 'one\n')
    assert.equal(fixture.plain(prepared.options.cwd, 'branch', '--show-current').trim(), name)
    assert.deepEqual(prepared.args, [])
  } finally { fixture.cleanup() }
})
