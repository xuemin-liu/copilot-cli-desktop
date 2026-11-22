import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createGitFixture, type GitFixture } from './fixtures/git-fixture.js'
import { ReviewReservations } from './pr-review-reservations.js'
import { cloneForReview, createReviewerArea, firstReviewPrompt, planReviewerArea, projectCredentialSettings, projectOrigin, pruneReviewerAreas, refreshReviewCheckout, removeReviewerArea, reviewCandidateReason, reviewCheckoutState, verifyReviewerPolicy, writeReviewerPolicy } from './pr-review-launch.js'

/** "GitHub" (upstream, with refs/pull/<n>/head) and the person's project, a clone of it on its own branch. */
function repos(f: GitFixture, number = 7): { upstream: string; project: string; base: string; head: string } {
  const upstream = f.repo('upstream')
  const base = f.plain(upstream, 'rev-parse', 'HEAD').trim()
  f.plain(upstream, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(upstream, 'a.txt'), 'pr change\n'); f.plain(upstream, 'commit', '-qam', 'pr')
  const head = f.plain(upstream, 'rev-parse', 'HEAD').trim()
  f.plain(upstream, 'update-ref', `refs/pull/${number}/head`, head)
  f.plain(upstream, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  const project = join(f.root, 'project')
  f.plain(f.root, 'clone', '-q', upstream, project)
  // The person works on the PR's own branch in their main worktree, as with b1.
  f.plain(project, 'checkout', '-q', '-b', 'b1', 'origin/feature')
  return { upstream, project, base, head }
}
const size = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0)

test('the review runs in a detached worktree of the project: nothing copied, no hook, the person\'s branch untouched', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f)
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > "${join(f.root, 'hook-ran').replace(/\\/g, '/')}"\n`, { mode: 0o755 })
    writeFileSync(join(project, 'work-in-progress.txt'), 'the person\'s own uncommitted work')
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, area, { head, base }, 7)
    assert.deepEqual(await reviewCheckoutState(f.runner, area), { head, clean: true })
    assert.match(f.plain(area.checkout, 'status', '--branch', '--porcelain=v2'), /# branch.head \(detached\)/)
    assert.equal(existsSync(join(f.root, 'hook-ran')), false, 'no hook ran')
    assert.equal(resolve(area.commonDir), resolve(project, '.git'), 'the worktree uses the project\'s own Git directory')
    assert.ok(!existsSync(join(area.root, 'checkout', '.git', 'objects')) && size(area.root) < 200_000, 'no objects were copied')
    assert.equal(f.plain(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'b1', 'the person\'s worktree stays on its branch')
    assert.ok(existsSync(join(project, 'work-in-progress.txt')))
    assert.equal(f.plain(project, 'rev-parse', area.ref).trim(), head, 'the PR is kept under this review\'s own ref')
  } finally { f.cleanup() }
})

test('the worktree moves to a new head only while clean, and refuses a PR that moved during the fetch', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, area, { head, base }, 7)
    writeFileSync(join(upstream, 'a.txt'), 'second\n'); f.plain(upstream, 'commit', '-qam', 'second')
    const second = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/7/head', second)
    await assert.rejects(refreshReviewCheckout(f.runner, area, upstream, 'c'.repeat(40), 7, base), /moved the pull request again/)
    writeFileSync(join(area.checkout, 'scratch.txt'), 'reviewer notes')
    await assert.rejects(refreshReviewCheckout(f.runner, area, upstream, second, 7, base), /has changes/)
    rmSync(join(area.checkout, 'scratch.txt'))
    assert.equal(await refreshReviewCheckout(f.runner, area, upstream, second, 7, base), second)
    assert.equal(readFileSync(join(area.checkout, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'second\n')
    writeFileSync(join(area.checkout, 'a.txt'), 'reviewer edit\n')
    await assert.rejects(refreshReviewCheckout(f.runner, area, upstream, second, 7, base), /has changes/, 'dirty at the same head too')
    await assert.rejects(cloneForReview(f.runner, project, upstream, await createReviewerArea(join(f.root, 'reviewers')), { head: 'not-a-sha' }, 7), /Invalid/)
  } finally { f.cleanup() }
})

test('a base that moved while the head stayed is fetched before the reviewer is told about it', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f, 9)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, area, { head, base }, 9)
    f.plain(upstream, 'checkout', '-q', 'main', '--'); writeFileSync(join(upstream, 'c.txt'), 'base moved\n'); f.plain(upstream, 'add', '.'); f.plain(upstream, 'commit', '-qm', 'base')
    const newBase = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    const has = (sha: string): boolean => { try { f.plain(project, 'cat-file', '-e', `${sha}^{commit}`); return true } catch { return false } }
    assert.equal(has(newBase), false)
    assert.equal(await refreshReviewCheckout(f.runner, area, upstream, head, 9, newBase), head)
    assert.equal(has(newBase), true, 'the new base is in the repository before the turn')
    await assert.rejects(refreshReviewCheckout(f.runner, area, upstream, head, 9, 'e'.repeat(40)), /base commit could not be fetched/)
  } finally { f.cleanup() }
})

test('a rewritten .git pointer and a planted filter in the worktree are never followed by the desktop', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f, 5)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, area, { head, base }, 5)
    // What code in the sandbox could do: a Git directory of its own with a filter, and the worktree pointing at it.
    const evil = join(f.root, 'evil-git')
    f.plain(f.root, 'clone', '-q', '--bare', upstream, evil)
    const marker = join(f.root, 'filter-ran').replace(/\\/g, '/')
    f.plain(evil, 'config', 'filter.probe.smudge', `sh -c "echo ran > '${marker}'; cat"`)
    f.plain(evil, 'config', 'filter.probe.clean', `sh -c "echo ran > '${marker}'; cat"`)
    writeFileSync(join(upstream, '.gitattributes'), 'a.txt filter=probe\n'); writeFileSync(join(upstream, 'a.txt'), 'next\n')
    f.plain(upstream, 'add', '.'); f.plain(upstream, 'commit', '-qm', 'next')
    const second = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/5/head', second)
    rmSync(join(area.checkout, '.git'), { force: true })
    writeFileSync(join(area.checkout, '.git'), `gitdir: ${evil.replace(/\\/g, '/')}\n`)
    assert.deepEqual(await reviewCheckoutState(f.runner, area), { head, clean: true })
    assert.equal(await refreshReviewCheckout(f.runner, area, upstream, second, 5, base), second)
    assert.equal(existsSync(join(f.root, 'filter-ran')), false, 'the planted filter never ran')
  } finally { f.cleanup() }
})

test('removing a review takes out only its own worktree and ref; the policy reads the shared .git, never writes it', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await assert.rejects(writeReviewerPolicy(area, { userHome: join(f.root, 'user'), personCopilotHome: join(f.root, 'user', '.copilot'), desktopData: join(f.root, 'desktop'), appData: null, localAppData: null }), /not been made/)
    await cloneForReview(f.runner, project, upstream, area, { head, base }, 7)
    const policy = await writeReviewerPolicy(area, { userHome: join(f.root, 'user'), personCopilotHome: join(f.root, 'user', '.copilot'), desktopData: join(f.root, 'desktop'), appData: null, localAppData: null })
    assert.deepEqual(policy.readonly, [area.helper, area.commonDir])
    await verifyReviewerPolicy(area, policy)
    const other = join(f.root, 'other-worktree')
    f.plain(project, 'worktree', 'add', '-q', '--detach', other, base)
    await removeReviewerArea(area, f.runner)
    assert.equal(existsSync(area.root), false)
    assert.doesNotMatch(f.plain(project, 'worktree', 'list', '--porcelain'), new RegExp(area.checkout.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    assert.match(f.plain(project, 'worktree', 'list'), /other-worktree/, 'another worktree stays')
    assert.throws(() => f.plain(project, 'rev-parse', '--verify', area.ref), 'this review\'s ref is gone')
  } finally { f.cleanup() }
})

test('the project must be a clone of the PR repository', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const project = f.repo('project')
    await assert.rejects(projectOrigin(f.runner, project, 'owner/repo'))
    f.plain(project, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git')
    assert.equal(await projectOrigin(f.runner, project, 'Owner/Repo'), 'https://github.com/owner/repo.git')
    await assert.rejects(projectOrigin(f.runner, project, 'other/repo'), /not the pull request/)
  } finally { f.cleanup() }
})

test('leftover reviewer folders older than a week are removed; others and anything not ours stay', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const base = join(f.root, 'reviewers'), old = join(base, '11111111-1111-4111-8111-111111111111'), fresh = join(base, '22222222-2222-4222-8222-222222222222')
    const kept = join(base, '33333333-3333-4333-8333-333333333333'), foreign = join(base, 'my-notes')
    for (const dir of [old, fresh, kept, foreign]) mkdirSync(dir, { recursive: true })
    const week = 8 * 24 * 60 * 60
    for (const dir of [old, kept, foreign]) utimesSync(dir, Date.now() / 1000 - week, Date.now() / 1000 - week)
    const removed = await pruneReviewerAreas(base, new Set([kept]), Date.now())
    assert.deepEqual(removed, [old])
    assert.ok(!existsSync(old)); assert.ok(existsSync(fresh)); assert.ok(existsSync(kept)); assert.ok(existsSync(foreign))
  } finally { f.cleanup() }
})

test('the first review prompt names the head, the helper and the rules', () => {
  const text = firstReviewPrompt('owner/repo', 7, 'a'.repeat(40), '🤖 ')
  assert.match(text, /pr-read/); assert.match(text, /pr-review/); assert.match(text, /ExecutionPolicy Bypass/)
  assert.match(text, new RegExp(`Approved at ${'a'.repeat(40)}`))
  assert.match(text, /never approve/i); assert.match(text, /never fix the code/)
})

test('a new PR is reviewed only if it is your own, from the same repository, and not already in review', () => {
  const own = { user: { id: 42 }, head: { repo: { full_name: 'Owner/Repo' } }, base: { repo: { full_name: 'owner/repo' } } }
  assert.equal(reviewCandidateReason(own, 42, false), null)
  assert.match(reviewCandidateReason({ ...own, head: { repo: { full_name: 'fork/repo' } } }, 42, false) ?? '', /fork/)
  assert.match(reviewCandidateReason({ ...own, head: { repo: null } }, 42, false) ?? '', /fork/, 'a deleted fork')
  assert.match(reviewCandidateReason({ ...own, user: { id: 7 } }, 42, false) ?? '', /Not your pull request/)
  assert.match(reviewCandidateReason(own, 42, true) ?? '', /already has a review loop/)
})

test('a credential in the project\'s own Git config refuses the review, named by kind and never by value', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const project = f.repo('project')
    f.plain(project, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git')
    f.plain(project, 'remote', 'add', 'ssh', 'ssh://git@github.com/owner/repo.git')
    assert.deepEqual(await projectCredentialSettings(f.runner, project), [], 'a plain https URL and an ssh user name are no credential')
    f.plain(project, 'remote', 'set-url', 'origin', 'https://ghp_SECRETTOKEN@github.com/owner/repo.git')
    f.plain(project, 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic SECRETHEADER')
    f.plain(project, 'config', 'credential.helper', 'store --file /tmp/SECRETFILE')
    f.plain(project, 'config', 'url.https://user:SECRETPASS@example.com/.insteadOf', 'https://example.com/')
    const kinds = await projectCredentialSettings(f.runner, project)
    assert.deepEqual(kinds.sort(), ['a URL rewrite with a user name or token', 'a credential helper', 'a remote URL with a user name or token', 'an http extraHeader'].sort())
    assert.doesNotMatch(kinds.join(' '), /SECRET/)
  } finally { f.cleanup() }
})

test('a review whose worktree has changes is kept, with its ref; a clean one goes', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, area, { head, base }, 7)
    writeFileSync(join(area.checkout, 'reviewer-notes.txt'), 'kept for the person')
    assert.equal(await removeReviewerArea(area, f.runner), 'kept')
    assert.ok(existsSync(join(area.checkout, 'reviewer-notes.txt')))
    assert.equal(f.plain(project, 'rev-parse', area.ref).trim(), head)
    assert.equal(await removeReviewerArea(area, null), 'kept', 'without Git nothing of the project is touched')
    rmSync(join(area.checkout, 'reviewer-notes.txt'))
    assert.equal(await removeReviewerArea(area, f.runner), 'removed')
    assert.equal(existsSync(area.root), false)
    // A folder whose worktree never got made (a crash mid-start) is removed without touching the project.
    const early = await createReviewerArea(join(f.root, 'reviewers')); early.project = project
    assert.equal(await removeReviewerArea(early, f.runner), 'removed')
  } finally { f.cleanup() }
})

test('a review is reserved before its folder exists; a second start of it is refused until it is released', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const path = join(f.root, 'reservations.json')
    const store = new ReviewReservations(path)
    const area = planReviewerArea(join(f.root, 'reviewers'))
    const record = { launchId: basename(area.root), repository: 'owner/repo', number: 7, reviewer: '42', project: join(f.root, 'project'), root: area.root, checkout: area.checkout, ref: area.ref }
    await store.reserve(record)
    assert.equal(existsSync(area.root), false, 'nothing made yet')
    const other = planReviewerArea(join(f.root, 'reviewers'))
    await assert.rejects(store.reserve({ ...record, launchId: basename(other.root), root: other.root, checkout: other.checkout, ref: other.ref, repository: 'Owner/Repo' }), /already has a review/)
    await store.bind(record.launchId, 'task-1')
    const reread = new ReviewReservations(path)
    assert.equal(reread.holder('owner/repo', 7, '42')?.taskId, 'task-1', 'it survives a restart')
    await reread.keep(record.launchId)
    await assert.rejects(reread.reserve({ ...record, launchId: basename(other.root), root: other.root, checkout: other.checkout, ref: other.ref }), /left changes/)
    await reread.release(record.launchId)
    await reread.reserve({ ...record, launchId: basename(other.root), root: other.root, checkout: other.checkout, ref: other.ref })
    await assert.rejects(reread.reserve({ ...record, launchId: 'not-a-uuid' }), /Invalid/)
  } finally { f.cleanup() }
})
