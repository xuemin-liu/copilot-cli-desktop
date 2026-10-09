import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture, findGitForTests } from './fixtures/git-fixture.js'
import { COMMIT_HOOKS, hookNameOf, inspectCommitHooks } from './git-hooks.js'

const git = await findGitForTests()
const skip = git ? false : 'git is not installed'

test('a file counts as a commit hook by its name, and samples never do', () => {
  for (const name of ['pre-commit', 'commit-msg', 'prepare-commit-msg', 'post-commit', 'post-index-change', 'reference-transaction', 'Pre-Commit', 'pre-commit.exe', 'pre-commit.cmd']) {
    assert.ok(hookNameOf(name), name)
  }
  for (const name of ['pre-commit.sample', 'commit-msg.sample', 'pre-push', 'update', 'readme.md', 'pre-commit-extra', 'applypatch-msg.sample']) {
    assert.equal(hookNameOf(name), null, name)
  }
  assert.ok(COMMIT_HOOKS.has('pre-commit') && !COMMIT_HOOKS.has('pre-push'))
})

test('the inventory lists the repository\'s real hooks and hashes their exact contents', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('hooked')
  const hooks = join(repo, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  const none = await inspectCommitHooks(fixture.runner, repo)
  assert.deepEqual(none.hooks, [], 'a fresh repository has only .sample files')
  assert.match(none.hash, /^[0-9a-f]{64}$/)

  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n')
  const one = await inspectCommitHooks(fixture.runner, repo)
  // Regression: reads point core.hooksPath at an empty folder, so asking through a read made every repository look hook-free.
  assert.deepEqual(one.hooks, ['pre-commit'])
  assert.notEqual(one.hash, none.hash)
  assert.equal((await inspectCommitHooks(fixture.runner, repo)).hash, one.hash, 'the hash is stable')

  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n')
  assert.notEqual((await inspectCommitHooks(fixture.runner, repo)).hash, one.hash, 'editing a hook changes the hash')

  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\n')
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\n')
  assert.deepEqual((await inspectCommitHooks(fixture.runner, repo)).hooks, ['commit-msg', 'pre-commit'], 'only hooks a commit can run are listed')
})

test('a repository that points git at another hooks folder is inspected there', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('elsewhere')
  const custom = join(fixture.root, 'custom-hooks')
  mkdirSync(custom, { recursive: true })
  writeFileSync(join(custom, 'post-commit'), '#!/bin/sh\n')
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n')
  fixture.plain(repo, 'config', 'core.hooksPath', custom)
  const inventory = await inspectCommitHooks(fixture.runner, repo)
  assert.deepEqual(inventory.hooks, ['post-commit'], 'git would run the custom folder, not .git/hooks')
  assert.equal(inventory.directory.toLowerCase(), custom.toLowerCase())
})

test('every byte of a hook counts, however large it is', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('big')
  const hooks = join(repo, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  const body = (word: string): string => `#!/bin/sh\n#${'x'.repeat(600_000)}\necho ${word}\n`
  writeFileSync(join(hooks, 'pre-commit'), body('OLD'))
  const old = await inspectCommitHooks(fixture.runner, repo)
  writeFileSync(join(hooks, 'pre-commit'), body('NEW'))
  const next = await inspectCommitHooks(fixture.runner, repo)
  assert.equal(old.unverifiable.length, 0, 'a hook this size is hashed completely')
  assert.notEqual(next.hash, old.hash, 'a same-size replacement changes the hash')
})

test('a hook larger than the limit, a link and a folder in a hook\'s place cannot be verified', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('odd')
  const hooks = join(repo, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n#${'x'.repeat(2_000)}\n`)
  mkdirSync(join(hooks, 'commit-msg'))
  const target = join(fixture.root, 'real-hook.sh')
  writeFileSync(target, '#!/bin/sh\n')
  let linked = false
  try { symlinkSync(target, join(hooks, 'post-commit')); linked = true } catch { t.diagnostic('symlinks need a privilege here; the link case is covered only where they can be made') }
  const inventory = await inspectCommitHooks(fixture.runner, repo, undefined, 1_000)
  const reasons = Object.fromEntries(inventory.unverifiable.map(item => [item.name, item.reason]))
  assert.match(reasons['pre-commit'] ?? '', /too large to check/)
  assert.match(reasons['commit-msg'] ?? '', /not a regular file/)
  if (linked) assert.match(reasons['post-commit'] ?? '', /link/)
  assert.ok(inventory.hooks.includes('pre-commit') && inventory.hooks.includes('commit-msg'), 'they are still listed by name')
  // Changing what a link points at must not keep an approval.
  if (linked) {
    const before = inventory.hash
    writeFileSync(target, '#!/bin/sh\necho changed\n')
    assert.equal((await inspectCommitHooks(fixture.runner, repo, undefined, 1_000)).hash, before, 'the hash cannot see through a link, which is why a link is refused')
  }
})
