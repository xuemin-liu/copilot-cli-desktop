import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('GIT_DIR and GIT_WORK_TREE in the desktop\'s environment cannot point the patch at another repository', async () => {
  const repo = await repository()
  const other = await repository()
  try {
    await writeFile(join(other.folder, 'secret.txt'), 'from the other repository\n')
    other.git('add', 'secret.txt')
    other.git('commit', '-q', '-m', 'other')
    await writeFile(join(repo.folder, 'login.cfg'), 'retry = 3\n')
    const env = { ...process.env, GIT_DIR: join(other.folder, '.git'), GIT_WORK_TREE: repo.folder }
    const executable = (await resolveGitExecutable())!
    const runner = new GitRunner({ gitPath: executable.path, hooksDirectory: join(repo.folder, '..', 'no-hooks'), trackProcess: null, baseEnvironment: env })
    const patch = await folderChanges(repo.folder, { runner, trust: repo.trust })
    assert.match(patch, /^\+retry = 3$/m)
    assert.ok(!patch.includes('from the other repository'), 'only the picked folder\'s repository')
  } finally {
    await repo.cleanup()
    await other.cleanup()
  }
})

test('the .git entry is inspected on the filesystem before any Git process starts, and a network folder is refused', async () => {
  const base = await mkdtemp(join(tmpdir(), 'meeting-folder-pointer-'))
  const calls: string[][] = []
  // Records every Git call; none may happen before the refusal.
  const runner = { run: async (options: { args: readonly string[] }) => { calls.push([...options.args]); throw new Error('git must not run') } } as unknown as GitRunner
  const trust = new GitTrustStore(join(base, 'trust.json'))
  try {
    // A .git file that names no git directory, which inspectGitEntry refuses; a picked subfolder finds it by walking up.
    await mkdir(join(base, 'repo', 'src'), { recursive: true })
    await writeFile(join(base, 'repo', '.git'), 'not a pointer\n')
    await assert.rejects(folderChanges(join(base, 'repo', 'src'), { runner, trust }), /The repository in .*repo is not opened: The \.git file does not name a git directory\./)
    assert.deepEqual(calls, [], 'no Git process before the entry was inspected')
    // A UNC share is the network path Windows would open (isLocalFilesystemPath has its own tests for other platforms).
    if (process.platform === 'win32') {
      await assert.rejects(folderChanges('\\\\server\\share\\project', { runner, trust }), /is not on this computer/)
      assert.deepEqual(calls, [])
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a repository that encloses the home folder is never the one attached: a dotfiles repository leaks nothing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'meeting-folder-home-'))
  const home = join(base, 'home')
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Check', GIT_AUTHOR_EMAIL: 'check@example.com', GIT_COMMITTER_NAME: 'Check', GIT_COMMITTER_EMAIL: 'check@example.com',
  }
  const calls: string[][] = []
  const runner = { run: async (options: { args: readonly string[] }) => { calls.push([...options.args]); throw new Error('git must not run') } } as unknown as GitRunner
  try {
    await writeFile(join(base, 'gitconfig'), '[core]\n\tautocrlf = false\n')
    execFileSync('git', ['init', '-q', home], { env })
    await writeFile(join(home, '.bashrc'), 'export A=1\n')
    execFileSync('git', ['add', '.bashrc'], { cwd: home, env })
    execFileSync('git', ['commit', '-q', '-m', 'dotfiles'], { cwd: home, env })
    await writeFile(join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=SECRET-TOKEN-123\n')
    await mkdir(join(home, 'projects', 'app'), { recursive: true })
    await writeFile(join(home, 'projects', 'app', 'main.js'), 'run()\n')
    const error = await folderChanges(join(home, 'projects', 'app'), { runner, trust: new GitTrustStore(join(base, 'trust.json')), homeDirectory: home })
      .then(() => null, (reason: unknown) => reason as Error)
    assert.ok(error, 'refused')
    assert.match(error.message, /is not a Git repository itself; the repository around it, at .*home, is a home folder or drive root, so its changes are not attached\./)
    assert.ok(!error.message.includes('SECRET-TOKEN-123'))
    assert.deepEqual(calls, [], 'no Git process ran')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a picked subfolder attaches the changes of its whole repository, found from its root', async () => {
  const repo = await repository()
  try {
    await mkdir(join(repo.folder, 'docs'))
    await writeFile(join(repo.folder, 'login.cfg'), 'retry = 3\n')
    await writeFile(join(repo.folder, 'docs', 'plan.md'), '# Plan\n')
    const patch = await folderChanges(join(repo.folder, 'docs'), repo)
    assert.match(patch, /^\+retry = 3$/m)
    assert.match(patch, /^\+\+\+ b\/docs\/plan\.md$/m)
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
