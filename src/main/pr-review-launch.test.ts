import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createGitFixture, type GitFixture } from './fixtures/git-fixture.js'
import { cloneForReview, createReviewerArea, firstReviewPrompt, projectOrigin, refreshReviewCheckout, removeReviewerArea, reviewCheckoutState, verifyReviewerPolicy, writeReviewerPolicy } from './pr-review-launch.js'

let fixtureRef: GitFixture | null = null
/** The upstream's first commit: a base every clone already holds. */
const baseOf = (upstream: string): string => fixtureRef!.plain(upstream, 'rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0]!

test('the reviewer clone holds the PR head detached, keeps no remote, runs no hook, and moves only while clean', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  fixtureRef = f
  try {
    // "GitHub": a repository whose refs/pull/7/head is the PR.
    const upstream = f.repo('upstream')
    f.plain(upstream, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(upstream, 'a.txt'), 'pr change\n'); f.plain(upstream, 'commit', '-qam', 'pr')
    const first = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/7/head', first)
    const project = join(f.root, 'project')
    f.plain(f.root, 'clone', '-q', upstream, project)
    // A hook in the person's checkout must never run for the reviewer.
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > "${join(f.root, 'hook-ran').replace(/\\/g, '/')}"\n`, { mode: 0o755 })

    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, area, { head: first }, 7)
    assert.deepEqual(await reviewCheckoutState(f.runner, area), { head: first, clean: true })
    assert.equal(f.plain(area.checkout, 'remote').trim(), '', 'nothing to push to')
    assert.match(f.plain(area.checkout, 'status', '--branch', '--porcelain=v2'), /# branch.head \(detached\)/)
    assert.equal(existsSync(join(f.root, 'hook-ran')), false)

    writeFileSync(join(upstream, 'a.txt'), 'second\n'); f.plain(upstream, 'commit', '-qam', 'second')
    const second = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/7/head', second)
    await assert.rejects(refreshReviewCheckout(f.runner, area, upstream, 'c'.repeat(40), 7, baseOf(upstream)), /moved the pull request again/)
    writeFileSync(join(area.checkout, 'scratch.txt'), 'reviewer notes')
    await assert.rejects(refreshReviewCheckout(f.runner, area, upstream, second, 7, baseOf(upstream)), /has changes/)
    f.plain(area.checkout, 'clean', '-fq')
    assert.equal(await refreshReviewCheckout(f.runner, area, upstream, second, 7, baseOf(upstream)), second)
    assert.equal(readFileSync(join(area.checkout, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'second\n')
    assert.equal(await refreshReviewCheckout(f.runner, area, upstream, second, 7, baseOf(upstream)), second, 'already there')
    writeFileSync(join(area.checkout, 'a.txt'), 'reviewer edit\n')
    await assert.rejects(refreshReviewCheckout(f.runner, area, upstream, second, 7, baseOf(upstream)), /has changes/, 'dirty at the same head too')
    f.plain(area.checkout, 'checkout', '--', 'a.txt')
    await assert.rejects(cloneForReview(f.runner, project, upstream, area, { head: 'not-a-sha' }, 7), /Invalid/)

    await removeReviewerArea(area)
    assert.equal(existsSync(area.root), false)
  } finally { f.cleanup() }
})

test('the project must be a clone of the PR repository', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  fixtureRef = f
  try {
    const project = f.repo('project')
    await assert.rejects(projectOrigin(f.runner, project, 'owner/repo'))
    f.plain(project, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git')
    assert.equal(await projectOrigin(f.runner, project, 'Owner/Repo'), 'https://github.com/owner/repo.git')
    await assert.rejects(projectOrigin(f.runner, project, 'other/repo'), /not the pull request/)
  } finally { f.cleanup() }
})

test('the reviewer policy lets the sandbox read the helper folder and is verified as written', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  fixtureRef = f
  try {
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    const policy = await writeReviewerPolicy(area, { userHome: join(f.root, 'user'), personCopilotHome: join(f.root, 'user', '.copilot'), desktopData: join(f.root, 'desktop'), appData: null, localAppData: null })
    assert.deepEqual(policy.readonly, [area.helper, area.gitdir])
    assert.ok(policy.denied.includes(area.home))
    await verifyReviewerPolicy(area, policy)
    await assert.rejects(verifyReviewerPolicy(area, { ...policy, readonly: [] }), /changed/)
  } finally { f.cleanup() }
})

test('the first review prompt names the head, the helper and the rules', () => {
  const text = firstReviewPrompt('owner/repo', 7, 'a'.repeat(40), '🤖 ')
  assert.match(text, /pr-read/); assert.match(text, /pr-review/); assert.match(text, /ExecutionPolicy Bypass/)
  assert.match(text, new RegExp(`Approved at ${'a'.repeat(40)}`))
  assert.match(text, /never approve/i); assert.match(text, /never fix the code/)
})

test('the reviewer clone owns its objects and keeps its Git directory outside the checkout', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  fixtureRef = f
  try {
    const { readdirSync, statSync, readFileSync: read } = await import('node:fs')
    const upstream = f.repo('upstream')
    const head = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/3/head', head)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, upstream, upstream, area, { head }, 3)
    assert.match(read(join(area.checkout, '.git'), 'utf8'), /^gitdir: /, 'the checkout holds only a pointer to its Git directory')
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
    const objects = walk(join(area.gitdir, 'objects'))
    assert.ok(objects.length > 0)
    for (const file of objects) assert.equal(statSync(file).nlink, 1, `${file} is shared with the project`)
    const policy = await writeReviewerPolicy(area, { userHome: join(f.root, 'user'), personCopilotHome: join(f.root, 'user', '.copilot'), desktopData: join(f.root, 'desktop'), appData: null, localAppData: null })
    assert.deepEqual(policy.readonly, [area.helper, area.gitdir], 'the sandbox may read the Git directory, never write it')
  } finally { f.cleanup() }
})

test('leftover reviewer folders older than a week are removed; others and anything not ours stay', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  fixtureRef = f
  try {
    const { mkdirSync: mk, utimesSync, existsSync: exists } = await import('node:fs')
    const { pruneReviewerAreas } = await import('./pr-review-launch.js')
    const base = join(f.root, 'reviewers'), old = join(base, '11111111-1111-4111-8111-111111111111'), fresh = join(base, '22222222-2222-4222-8222-222222222222')
    const kept = join(base, '33333333-3333-4333-8333-333333333333'), foreign = join(base, 'my-notes')
    for (const dir of [old, fresh, kept, foreign]) mk(dir, { recursive: true })
    const week = 8 * 24 * 60 * 60
    for (const dir of [old, kept, foreign]) utimesSync(dir, Date.now() / 1000 - week, Date.now() / 1000 - week)
    const removed = await pruneReviewerAreas(base, new Set([kept]), Date.now())
    assert.deepEqual(removed, [old])
    assert.ok(!exists(old)); assert.ok(exists(fresh)); assert.ok(exists(kept)); assert.ok(exists(foreign))
  } finally { f.cleanup() }
})

test('a rewritten .git pointer and a planted filter in the checkout are never followed by the desktop', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  fixtureRef = f
  try {
    const upstream = f.repo('upstream')
    writeFileSync(join(upstream, '.gitattributes'), 'a.txt filter=probe\n'); f.plain(upstream, 'add', '.'); f.plain(upstream, 'commit', '-qm', 'attributes')
    const first = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/5/head', first)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, upstream, upstream, area, { head: first }, 5)
    // What code in the sandbox could do: a Git directory of its own with a filter, and the checkout pointing at it.
    const evil = join(f.root, 'evil-git')
    f.plain(f.root, 'clone', '-q', '--bare', upstream, evil)
    const marker = join(f.root, 'filter-ran').replace(/\\/g, '/')
    f.plain(evil, 'config', 'filter.probe.smudge', `sh -c "echo ran > '${marker}'; cat"`)
    f.plain(evil, 'config', 'filter.probe.clean', `sh -c "echo ran > '${marker}'; cat"`)
    // Git marks the pointer hidden on Windows, where it cannot be overwritten in place; deleting it first works.
    rmSync(join(area.checkout, '.git'), { force: true })
    writeFileSync(join(area.checkout, '.git'), `gitdir: ${evil.replace(/\\/g, '/')}\n`)
    writeFileSync(join(upstream, 'a.txt'), 'next\n'); f.plain(upstream, 'commit', '-qam', 'next')
    const second = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/5/head', second)
    // The rewritten pointer is an untracked change only for the desktop's own Git directory, which stays clean.
    assert.deepEqual(await reviewCheckoutState(f.runner, area), { head: first, clean: true })
    assert.equal(await refreshReviewCheckout(f.runner, area, upstream, second, 5, baseOf(upstream)), second)
    assert.equal(existsSync(join(f.root, 'filter-ran')), false, 'the planted filter never ran')
  } finally { f.cleanup() }
})

test('a base that moved while the head stayed is fetched before the reviewer is told about it', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  fixtureRef = f
  try {
    const upstream = f.repo('upstream')
    f.plain(upstream, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    const base = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(upstream, 'b.txt'), 'pr\n'); f.plain(upstream, 'add', '.'); f.plain(upstream, 'commit', '-qm', 'pr')
    const head = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/9/head', head)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, upstream, upstream, area, { head, base }, 9)
    // The base branch moves on GitHub; the PR's head does not.
    f.plain(upstream, 'checkout', '-q', '-'); writeFileSync(join(upstream, 'c.txt'), 'base moved\n'); f.plain(upstream, 'add', '.'); f.plain(upstream, 'commit', '-qm', 'base')
    const newBase = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    const has = (sha: string): boolean => { try { f.plain(area.root, '--git-dir', area.gitdir, 'cat-file', '-e', `${sha}^{commit}`); return true } catch { return false } }
    assert.equal(has(newBase), false, 'the clone does not have the new base yet')
    assert.equal(await refreshReviewCheckout(f.runner, area, upstream, head, 9, newBase), head)
    assert.equal(has(newBase), true, 'the new base is in the clone before the turn')
    await assert.rejects(refreshReviewCheckout(f.runner, area, upstream, head, 9, 'e'.repeat(40)), /base commit could not be fetched/)
  } finally { f.cleanup() }
})

test('a new PR is reviewed only if it is your own, from the same repository, and not already in review', async () => {
  const { reviewCandidateReason } = await import('./pr-review-launch.js')
  const own = { user: { id: 42 }, head: { repo: { full_name: 'Owner/Repo' } }, base: { repo: { full_name: 'owner/repo' } } }
  assert.equal(reviewCandidateReason(own, 42, false), null)
  assert.match(reviewCandidateReason({ ...own, head: { repo: { full_name: 'fork/repo' } } }, 42, false) ?? '', /fork/)
  assert.match(reviewCandidateReason({ ...own, head: { repo: null } }, 42, false) ?? '', /fork/, 'a deleted fork')
  assert.match(reviewCandidateReason({ ...own, user: { id: 7 } }, 42, false) ?? '', /Not your pull request/)
  assert.match(reviewCandidateReason(own, 42, true) ?? '', /already has a review loop/)
})
