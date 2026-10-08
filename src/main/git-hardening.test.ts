import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture, findGitForTests, shellPath } from './fixtures/git-fixture.js'
import type { GitFixture } from './fixtures/git-fixture.js'
import { diffArgs, logArgs, statusArgs } from './git-commands.js'

/**
 * A repository is untrusted input. Each case configures something that makes git run a program, then
 * proves two things: the plain command really does run it (the control), and the hardened runner does not.
 * `filter` is the documented exception: no flag turns it off, so only the trust gate stops it.
 */

const git = await findGitForTests()
const skip = git ? false : 'git is not installed'

interface Case {
  name: string
  setup(fixture: GitFixture, repo: string, marker: string): void
  plain(fixture: GitFixture, repo: string): void
  hardened(fixture: GitFixture, repo: string): Promise<unknown>
  /** True when a flag is expected to stop the program. False documents a hole the trust gate must cover. */
  blockedByHardening: boolean
}

const cases: Case[] = [
  {
    name: 'core.fsmonitor on status',
    blockedByHardening: true,
    setup: (f, repo, marker) => f.plain(repo, 'config', 'core.fsmonitor', `echo x > "${shellPath(marker)}"; echo`),
    plain: (f, repo) => { f.plain(repo, 'status', '--porcelain') },
    hardened: (f, repo) => f.runner.run({ cwd: repo, args: statusArgs() }),
  },
  {
    name: 'diff.<driver>.textconv on diff',
    blockedByHardening: true,
    setup: (f, repo, marker) => {
      f.plain(repo, 'config', 'diff.evil.textconv', `sh -c 'echo x > "${shellPath(marker)}"; cat' --`)
      writeFileSync(join(repo, '.gitattributes'), '*.txt diff=evil\n')
      writeFileSync(join(repo, 'a.txt'), 'changed\n')
    },
    plain: (f, repo) => { f.plain(repo, 'diff', '--', 'a.txt') },
    hardened: (f, repo) => f.runner.run({ cwd: repo, args: diffArgs({ staged: false, path: 'a.txt' }) }),
  },
  {
    name: 'diff.external on diff',
    blockedByHardening: true,
    setup: (f, repo, marker) => {
      writeFileSync(join(repo, 'ext.sh'), `#!/bin/sh\necho x > "${shellPath(marker)}"\n`)
      f.plain(repo, 'config', 'diff.external', `sh ${shellPath(join(repo, 'ext.sh'))}`)
      writeFileSync(join(repo, 'a.txt'), 'changed\n')
    },
    plain: (f, repo) => { f.plain(repo, 'diff', '--', 'a.txt') },
    hardened: (f, repo) => f.runner.run({ cwd: repo, args: diffArgs({ staged: false, path: 'a.txt' }) }),
  },
  {
    name: 'gpg.program through log.showSignature on log',
    blockedByHardening: true,
    setup: (f, repo, marker) => {
      writeFileSync(join(repo, 'gpg.sh'), `#!/bin/sh\necho x > "${shellPath(marker)}"\nexit 1\n`)
      f.plain(repo, 'config', 'gpg.program', shellPath(join(repo, 'gpg.sh')))
      f.plain(repo, 'config', 'log.showSignature', 'true')
      const tree = f.plain(repo, 'write-tree').trim()
      const parent = f.plain(repo, 'rev-parse', 'HEAD').trim()
      const body = `tree ${tree}\nparent ${parent}\nauthor T <t@example.com> 1700000000 +0000\ncommitter T <t@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n bogus\n -----END PGP SIGNATURE-----\n\nsigned\n`
      const oid = execFileSync(f.git.path, ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, env: f.env, input: body, encoding: 'utf8' }).trim()
      f.plain(repo, 'update-ref', 'HEAD', oid)
    },
    plain: (f, repo) => { f.plain(repo, 'log', '-1') },
    hardened: (f, repo) => f.runner.run({ cwd: repo, args: logArgs({ limit: 5 }) }),
  },
  {
    name: 'filter.<name>.clean on status (the trust gate\'s job, not a flag\'s)',
    blockedByHardening: false,
    setup: (f, repo, marker) => {
      f.plain(repo, 'config', 'filter.evil.clean', `sh -c 'echo x > "${shellPath(marker)}"; cat'`)
      writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n')
      writeFileSync(join(repo, 'a.txt'), 'two\n')
      const later = new Date(Date.now() + 5_000)
      utimesSync(join(repo, 'a.txt'), later, later)
    },
    plain: (f, repo) => { f.plain(repo, 'status', '--porcelain') },
    hardened: (f, repo) => f.runner.run({ cwd: repo, args: statusArgs() }),
  },
]

for (const item of cases) {
  test(`repository config cannot run a program: ${item.name}`, { skip }, async (t) => {
    const fixture = (await createGitFixture())!
    t.after(() => fixture.cleanup())
    const controlMarker = join(fixture.root, 'control.marker')
    const controlRepo = fixture.repo('control')
    item.setup(fixture, controlRepo, controlMarker)
    try { item.plain(fixture, controlRepo) } catch { /* a failing command can still have run the program */ }
    assert.equal(existsSync(controlMarker), true, 'control: plain git is expected to run the configured program, otherwise this test proves nothing')

    const marker = join(fixture.root, 'hardened.marker')
    const repo = fixture.repo('hardened')
    item.setup(fixture, repo, marker)
    await item.hardened(fixture, repo)
    assert.equal(existsSync(marker), !item.blockedByHardening ? true : false,
      item.blockedByHardening ? 'the hardened runner ran a repository-configured program' : 'git no longer runs clean filters on status; the trust gate may be relaxed for this case')
  })
}

test('a config that only the trust gate can see is easy to detect without running anything', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('scan')
  fixture.plain(repo, 'config', 'filter.evil.clean', 'cat')
  fixture.plain(repo, 'config', 'core.sshCommand', 'ssh -i k')
  fixture.plain(repo, 'config', 'user.name', 'harmless')
  const result = await fixture.runner.run({ cwd: repo, args: ['config', '--local', '--show-origin', '-z', '--get-regexp', '^(filter\\..*|core\\.(fsmonitor|sshcommand|hookspath|askpass|gitproxy|worktree)|credential\\..*|diff\\..*\\.(command|textconv)|gpg\\..*|include.*)$'] })
  assert.equal(result.exitCode, 0, result.stderr)
  const text = result.stdout.toString()
  assert.match(text, /filter\.evil\.clean/)
  assert.match(text, /core\.sshcommand/i)
  assert.doesNotMatch(text, /user\.name/)
})
