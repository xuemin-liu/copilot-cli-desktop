import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture } from './fixtures/git-fixture.js'
import { samePath } from './host-path.js'
import { NEEDS_REVIEW, checkpointGate, resolveCheckpointTarget, type CheckpointTrust } from './turn-checkpoint-target.js'

test('the repository a session is snapshotted in, and when there is none', async (t) => {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('git is not installed'); return }
  t.after(() => fixture.cleanup())
  const resolve = (cwd: string, projectPath: string) => resolveCheckpointTarget({ sessionId: 's', cwd, projectPath }, join(fixture.root, 'home'))

  const project = fixture.repo('project')
  mkdirSync(join(project, 'src'))
  const root = realpathSync.native(project)
  const plain = await resolve(project, project)
  assert.ok(plain && samePath(plain.worktreeRoot, root))
  assert.ok(samePath(plain.projectPath, root))
  assert.equal(plain.sessionId, 's')
  const inside = await resolve(join(project, 'src'), project)
  assert.ok(inside && samePath(inside.worktreeRoot, root), 'a subfolder belongs to the repository above it, inside the project')

  // A repository above the project folder is not the project's: its changes would be everything under it.
  assert.equal(await resolve(join(project, 'src'), join(project, 'src')), null)
  const bare = join(fixture.root, 'no-repository')
  mkdirSync(bare)
  assert.equal(await resolve(bare, bare), null)
  assert.equal(await resolve('relative/path', project), null)
  assert.equal(await resolve('\\\\server\\share\\repo', project), null)

  // A linked worktree outside the project folder counts when it belongs to the project's repository, and only then.
  const worktree = join(fixture.root, 'project-worktree')
  fixture.plain(project, 'worktree', 'add', '-q', worktree, '-b', 'side')
  const linked = await resolve(worktree, project)
  assert.ok(linked && samePath(linked.worktreeRoot, realpathSync.native(worktree)))
  const other = fixture.repo('other')
  assert.equal(await resolve(worktree, other), null, 'a worktree of another repository')
  assert.equal(await resolve(other, project), null, 'a repository that is not the project')
})

test('the gate says no for unreviewed settings, moved pointers and an old Git, each time it is asked', async (t) => {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('git is not installed'); return }
  t.after(() => fixture.cleanup())
  let trusted = false
  const trust: CheckpointTrust = { isTrusted: async () => trusted, areIncludesApproved: async () => false }
  const deps = { executable: fixture.git, runner: fixture.runner, trust }
  const project = realpathSync.native(fixture.repo('project'))
  const target = { worktreeRoot: project, projectPath: project }
  assert.equal(await checkpointGate(target, deps), null)

  // Settings that can start a program hold the repository until the person accepts them in the Git panel. The gate
  // reads them again every time, so a setting added during a turn is seen before the end snapshot.
  fixture.plain(project, 'config', 'filter.custom.clean', 'some-program')
  assert.equal(await checkpointGate(target, deps), NEEDS_REVIEW)
  trusted = true
  assert.equal(await checkpointGate(target, deps), null)
  fixture.plain(project, 'config', 'include.path', '../elsewhere')
  assert.equal(await checkpointGate(target, deps), NEEDS_REVIEW, 'include lines nobody accepted')
  fixture.plain(project, 'config', '--unset', 'include.path')
  assert.equal(await checkpointGate(target, deps), null)

  const old = { ...fixture.git, version: { ...fixture.git.version, major: 2, minor: 31, text: 'git version 2.31.0' } }
  assert.match(await checkpointGate(target, { ...deps, executable: old }) ?? '', /need Git 2\.32 or newer/)

  // A worktree that stops being a worktree of the project's repository during a turn.
  const worktree = join(fixture.root, 'project-worktree')
  fixture.plain(project, 'worktree', 'add', '-q', worktree, '-b', 'side')
  const linked = { worktreeRoot: realpathSync.native(worktree), projectPath: project }
  assert.equal(await checkpointGate(linked, deps), null)
  const foreign = fixture.repo('foreign')
  fixture.plain(foreign, 'worktree', 'add', '-q', join(fixture.root, 'foreign-worktree'), '-b', 'side')
  // Git hides this file on Windows, and a hidden file cannot be overwritten in place.
  rmSync(join(worktree, '.git'), { force: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(foreign, '.git', 'worktrees', 'foreign-worktree').replace(/\\/g, '/')}\n`)
  assert.match(await checkpointGate(linked, deps) ?? '', /no longer a worktree of its repository/)

  // The .git entry replaced or removed.
  renameSync(join(project, '.git'), join(project, 'git-moved'))
  assert.equal(await checkpointGate(target, deps), 'The .git entry is gone')
  rmSync(join(project, 'git-moved'), { recursive: true, force: true })
})
