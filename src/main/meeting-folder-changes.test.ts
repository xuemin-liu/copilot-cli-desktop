import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { GitRunner, resolveGitExecutable } from './git-runner.js'
import { GitTrustStore, scanRepoConfig } from './git-trust.js'
import { folderChanges } from './meeting-folder-changes.js'

/** A repository with one committed file, and the hardened runner and trust store the desktop uses. */
async function repository(): Promise<{ folder: string; git(...args: string[]): string; runner: GitRunner; trust: GitTrustStore; cleanup(): Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'meeting-folder-'))
  const folder = join(base, 'repo')
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Check', GIT_AUTHOR_EMAIL: 'check@example.com', GIT_COMMITTER_NAME: 'Check', GIT_COMMITTER_EMAIL: 'check@example.com',
  }
  await writeFile(join(base, 'gitconfig'), '[core]\n\tautocrlf = false\n')
  execFileSync('git', ['init', '-q', folder], { env })
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: folder, env, encoding: 'utf8' })
  await writeFile(join(folder, 'login.cfg'), 'retry = 1\n')
  git('add', 'login.cfg')
  git('commit', '-q', '-m', 'init')
  const executable = await resolveGitExecutable()
  assert.ok(executable, 'git is installed')
  const runner = new GitRunner({ gitPath: executable.path, hooksDirectory: join(base, 'no-hooks'), trackProcess: null, baseEnvironment: env })
  return { folder, git, runner, trust: new GitTrustStore(join(base, 'trust.json')), cleanup: () => rm(base, { recursive: true, force: true }) }
}

test('a folder\'s changes: tracked edits and new files as one patch, no changes said so, and no repository refused', async () => {
  const repo = await repository()
  try {
    const outside = await mkdtemp(join(tmpdir(), 'meeting-folder-none-'))
    await assert.rejects(folderChanges(outside, repo), /is not a Git repository/)
    await rm(outside, { recursive: true, force: true })
    assert.equal(await folderChanges(repo.folder, repo), '# No uncommitted changes.')
    await writeFile(join(repo.folder, 'login.cfg'), 'retry = 3\n')
    await writeFile(join(repo.folder, 'plan.md'), '# Plan\n')
    const patch = await folderChanges(repo.folder, repo)
    assert.match(patch, /^diff --git a\/login\.cfg b\/login\.cfg$/m)
    assert.match(patch, /^\+retry = 3$/m)
    assert.match(patch, /^\+\+\+ b\/plan\.md$/m, 'a new file is included as added')
    assert.match(patch, /^\+# Plan$/m)
  } finally {
    await repo.cleanup()
  }
})

test('a repository whose own config names a program is refused, and nothing runs, until the person accepted it', async () => {
  const repo = await repository()
  try {
    // A clean filter runs on `diff` too: without the trust gate this would create FILTER_RAN.
    repo.git('config', 'filter.probe.clean', 'sh -c "touch FILTER_RAN; cat"')
    await writeFile(join(repo.folder, '.gitattributes'), '* filter=probe\n')
    await writeFile(join(repo.folder, 'login.cfg'), 'retry = 3\n')
    await assert.rejects(folderChanges(repo.folder, repo), /name programs Git could run \(filter\.probe\.clean\)\. The person has to review them in the Git panel first/)
    await assert.rejects(access(join(repo.folder, 'FILTER_RAN')), 'the filter did not run')

    // Accepted in the Git panel (the same trust store): the changes go.
    const root = resolve(repo.git('rev-parse', '--show-toplevel').trim())
    await repo.trust.trust(root, (await scanRepoConfig(repo.runner, root)).hash)
    assert.match(await folderChanges(repo.folder, repo), /^\+retry = 3$/m)
    await access(join(repo.folder, 'FILTER_RAN')) // The setup is real: once accepted, the filter runs, as the person allowed.
  } finally {
    await repo.cleanup()
  }
})

test('a Git command that fails is an error that says why, never an empty patch', async () => {
  const repo = await repository()
  try {
    await writeFile(join(repo.folder, 'login.cfg'), `${'retry = 3\n'.repeat(200)}`)
    await assert.rejects(folderChanges(repo.folder, { ...repo, maxOutputBytes: 512 }), /The tracked changes are larger than <1 MB, too large to attach\./)
  } finally {
    await repo.cleanup()
  }
})
