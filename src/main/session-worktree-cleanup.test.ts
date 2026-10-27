import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import {
  inspectDesktopWorktree,
  isDesktopWorktreeFolder,
  isWorktreeCleanupMode,
  removalDeletesBranch,
  removalIsSafe,
  removeDesktopWorktree,
  worktreeCleanupDecision,
  worktreeCleanupPrompt,
  type DesktopWorktreeState,
} from './session-worktree-cleanup.js'
import { createGitFixture, type GitFixture } from './fixtures/git-fixture.js'
import { TRASH_NAME } from './host-path.js'

const name = 'desktop-fix-the-bug-abc123'
/** A main checkout and the folder beside it where the desktop makes worktrees, in this platform's spelling. */
const PROJECT = resolve('/project')
const WORKTREES = `${PROJECT}.worktrees`

const state = (patch: Partial<DesktopWorktreeState> = {}): DesktopWorktreeState => ({
  path: join(WORKTREES, name), name, mainPath: PROJECT, branch: name, head: 'a'.repeat(40),
  locked: false, changes: 0, uniqueCommits: 0, ...patch,
})

test('only the desktop\'s own worktree folders qualify', () => {
  assert.equal(isDesktopWorktreeFolder(join(WORKTREES, name)), true)
  assert.equal(isDesktopWorktreeFolder(join(WORKTREES, name) + sep), true)
  assert.equal(isDesktopWorktreeFolder(join(PROJECT, name)), false, 'not beside the main checkout')
  assert.equal(isDesktopWorktreeFolder(join(WORKTREES, 'feature')), false)
  assert.equal(isDesktopWorktreeFolder(join(WORKTREES, 'desktop-fix-zzzzzz')), false)
  assert.equal(isWorktreeCleanupMode('safe'), true)
  assert.equal(isWorktreeCleanupMode('always'), false)
})

test('safe mode removes only what loses nothing, asks otherwise; keep and locked never remove', () => {
  assert.equal(worktreeCleanupDecision('safe', state()), 'remove')
  assert.equal(worktreeCleanupDecision('safe', state({ uniqueCommits: 3 })), 'remove', 'the branch keeps the commits')
  assert.equal(worktreeCleanupDecision('safe', state({ changes: 1 })), 'ask')
  assert.equal(worktreeCleanupDecision('safe', state({ branch: null, uniqueCommits: 1 })), 'ask')
  assert.equal(worktreeCleanupDecision('safe', state({ branch: null })), 'remove')
  assert.equal(worktreeCleanupDecision('ask', state()), 'ask')
  assert.equal(worktreeCleanupDecision('keep', state()), 'keep')
  assert.equal(worktreeCleanupDecision('safe', state({ locked: true })), 'keep')
  assert.equal(worktreeCleanupDecision('ask', state({ locked: true })), 'keep')
})

test('only the desktop branch without commits of its own is deleted', () => {
  assert.equal(removalDeletesBranch(state()), true)
  assert.equal(removalDeletesBranch(state({ uniqueCommits: 1 })), false)
  assert.equal(removalDeletesBranch(state({ branch: 'feature' })), false)
  assert.equal(removalDeletesBranch(state({ branch: null })), false)
  assert.equal(removalIsSafe(state({ branch: 'feature', uniqueCommits: 2 })), true)
})

test('the prompt says what is deleted and what is kept', () => {
  assert.match(worktreeCleanupPrompt(state()).detail, /branch "desktop-fix-the-bug-abc123" has no commits .* deleted too/)
  assert.match(worktreeCleanupPrompt(state({ uniqueCommits: 2 })).detail, /is kept, with 2 commits no other branch has/)
  assert.match(worktreeCleanupPrompt(state({ changes: 1 })).detail, new RegExp(`1 uncommitted change\\. .*${TRASH_NAME}`))
  assert.match(worktreeCleanupPrompt(state({ branch: null, uniqueCommits: 1 })).detail, /detached HEAD has 1 commit that no branch has/)
  assert.equal(worktreeCleanupPrompt(state()).title, `Remove worktree "${name}"?`)
})

async function withWorktree(t: test.TestContext, run: (fixture: GitFixture, repo: string, worktree: string) => Promise<void>): Promise<void> {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('Git unavailable'); return }
  try {
    const repo = fixture.repo('project with spaces', directory => {
      writeFileSync(join(directory, '.gitignore'), 'build/\n')
      fixture.plain(directory, 'add', '.gitignore')
      fixture.plain(directory, 'commit', '-q', '-m', 'ignore build')
    })
    const worktree = join(`${repo}.worktrees`, name)
    fixture.plain(repo, 'worktree', 'add', '-q', '-b', name, worktree, 'HEAD')
    await run(fixture, repo, worktree)
  } finally { fixture.cleanup() }
}

const branches = (fixture: GitFixture, repo: string): string[] =>
  fixture.plain(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)
const trashByDeleting = async (path: string): Promise<void> => { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }

test('a fresh worktree is removed with its branch, whatever the main checkout has', async t => {
  await withWorktree(t, async (fixture, repo, worktree) => {
    writeFileSync(join(repo, 'unrelated.txt'), 'main checkout changes do not count\n')
    const run = (request: Parameters<GitFixture['runner']['run']>[0]) => fixture.runner.run(request)
    const inspected = await inspectDesktopWorktree(worktree, run)
    assert.ok(inspected)
    assert.equal(inspected.changes, 0)
    assert.equal(inspected.uniqueCommits, 0)
    assert.equal(inspected.branch, name)
    assert.equal(inspected.name, name)
    assert.equal(worktreeCleanupDecision('safe', inspected), 'remove')
    const removed = await removeDesktopWorktree(inspected, run, { trash: async () => { throw new Error('A clean worktree is not trashed') } })
    assert.equal(removed.branchDeleted, true)
    assert.equal(existsSync(worktree), false)
    assert.deepEqual(branches(fixture, repo), ['main'])
  })
})

test('ignored build output does not count as a change', async t => {
  await withWorktree(t, async (fixture, _repo, worktree) => {
    mkdirSync(join(worktree, 'build'))
    writeFileSync(join(worktree, 'build', 'out.js'), 'built\n')
    const inspected = await inspectDesktopWorktree(worktree, request => fixture.runner.run(request))
    assert.equal(inspected?.changes, 0)
  })
})

test('a branch with commits of its own is kept when its worktree is removed; a merged one is deleted', async t => {
  await withWorktree(t, async (fixture, repo, worktree) => {
    const run = (request: Parameters<GitFixture['runner']['run']>[0]) => fixture.runner.run(request)
    fixture.plain(worktree, 'commit', '--allow-empty', '-q', '-m', 'work')
    const unmerged = await inspectDesktopWorktree(worktree, run)
    assert.equal(unmerged?.uniqueCommits, 1)
    assert.equal(unmerged && removalDeletesBranch(unmerged), false)
    fixture.plain(repo, 'merge', '-q', '--ff-only', name)
    const merged = await inspectDesktopWorktree(worktree, run)
    assert.equal(merged?.uniqueCommits, 0)
    fixture.plain(worktree, 'commit', '--allow-empty', '-q', '-m', 'more work')
    const again = await inspectDesktopWorktree(worktree, run)
    assert.ok(again)
    assert.equal(worktreeCleanupDecision('safe', again), 'remove')
    assert.equal((await removeDesktopWorktree(again, run, { trash: trashByDeleting })).branchDeleted, false)
    assert.equal(existsSync(worktree), false)
    assert.deepEqual(branches(fixture, repo).sort(), [name, 'main'].sort())
  })
})

test('uncommitted changes need a confirmation, and then go to the trash', async t => {
  await withWorktree(t, async (fixture, repo, worktree) => {
    const run = (request: Parameters<GitFixture['runner']['run']>[0]) => fixture.runner.run(request)
    writeFileSync(join(worktree, 'a.txt'), 'changed\n')
    writeFileSync(join(worktree, 'new.txt'), 'new\n')
    const inspected = await inspectDesktopWorktree(worktree, run)
    assert.ok(inspected)
    assert.equal(inspected.changes, 2)
    assert.equal(worktreeCleanupDecision('safe', inspected), 'ask')
    const trashed: string[] = []
    await removeDesktopWorktree(inspected, run, { trash: async path => { trashed.push(path); await trashByDeleting(path) } })
    assert.deepEqual(trashed.map(path => path.toLowerCase()), [worktree.toLowerCase()])
    assert.equal(fixture.plain(repo, 'worktree', 'list', '--porcelain').includes(name), false, 'git forgot the worktree')
  })
})

test('a branch that moved after it was checked is not deleted', async t => {
  await withWorktree(t, async (fixture, repo, worktree) => {
    const run = (request: Parameters<GitFixture['runner']['run']>[0]) => fixture.runner.run(request)
    const inspected = await inspectDesktopWorktree(worktree, run)
    assert.ok(inspected)
    fixture.plain(worktree, 'commit', '--allow-empty', '-q', '-m', 'late work')
    assert.equal((await removeDesktopWorktree(inspected, run, { trash: trashByDeleting })).branchDeleted, false)
    assert.equal(existsSync(worktree), false)
    assert.ok(branches(fixture, repo).includes(name))
  })
})

test('locked worktrees, the main checkout and other folders are not inspected as session worktrees', async t => {
  await withWorktree(t, async (fixture, repo, worktree) => {
    const run = (request: Parameters<GitFixture['runner']['run']>[0]) => fixture.runner.run(request)
    assert.equal(await inspectDesktopWorktree(repo, run), null)
    fixture.plain(repo, 'worktree', 'lock', worktree)
    const locked = await inspectDesktopWorktree(worktree, run)
    assert.equal(locked?.locked, true)
    assert.equal(locked && worktreeCleanupDecision('safe', locked), 'keep')
    const other = join(`${repo}.worktrees`, 'feature')
    fixture.plain(repo, 'worktree', 'add', '-q', '-b', 'feature', other)
    assert.equal(await inspectDesktopWorktree(other, run), null)
  })
})

test('a locked worktree is refused even when removal was confirmed', async () => {
  await assert.rejects(removeDesktopWorktree(state({ locked: true, changes: 1 }), async () => { throw new Error('No git command may run') },
    { trash: async () => { throw new Error('A locked worktree is not trashed') } }), /is locked/)
})
