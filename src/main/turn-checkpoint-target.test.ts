import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture } from './fixtures/git-fixture.js'
import { samePath } from './host-path.js'
import { NEEDS_REVIEW, resolveCheckpointTarget, type CheckpointTrust } from './turn-checkpoint-target.js'

test('the repository a session is snapshotted in, and when there is none', async (t) => {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('git is not installed'); return }
  t.after(() => fixture.cleanup())
  const trusted = new Set<string>()
  const trust: CheckpointTrust = { isTrusted: async (_root, hash) => trusted.has(hash), areIncludesApproved: async () => false }
  const deps = { executable: fixture.git, runner: fixture.runner, trust, homeDirectory: join(fixture.root, 'home') }
  const resolve = (cwd: string, projectPath: string, executable = fixture.git) => resolveCheckpointTarget({ sessionId: 's', cwd, projectPath }, { ...deps, executable })

  const project = fixture.repo('project')
  mkdirSync(join(project, 'src'))
  const root = realpathSync.native(project)
  const plain = await resolve(project, project)
  assert.ok(plain && samePath(plain.worktreeRoot, root))
  assert.equal(plain.refused, null)
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
  assert.equal(linked.refused, null)
  const other = fixture.repo('other')
  assert.equal(await resolve(worktree, other), null, 'a worktree of another repository')
  assert.equal(await resolve(other, project), null, 'a repository that is not the project')

  // Settings that can start a program hold the repository until the person accepts them in the Git panel.
  fixture.plain(project, 'config', 'filter.custom.clean', 'some-program')
  assert.equal((await resolve(project, project))?.refused, NEEDS_REVIEW)
  trust.isTrusted = async () => true
  assert.equal((await resolve(project, project))?.refused, null)
  fixture.plain(project, 'config', 'include.path', '../elsewhere')
  assert.equal((await resolve(project, project))?.refused, NEEDS_REVIEW, 'include lines nobody accepted')

  const old = { ...fixture.git, version: { ...fixture.git.version, major: 2, minor: 31, text: 'git version 2.31.0' } }
  assert.match((await resolve(other, other, old))?.refused ?? '', /need Git 2\.32 or newer/)
})
