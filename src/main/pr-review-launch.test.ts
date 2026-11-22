import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createGitFixture } from './fixtures/git-fixture.js'
import { cloneForReview, createReviewerArea, firstReviewPrompt, projectOrigin, refreshReviewCheckout, removeReviewerArea, reviewCheckoutState, verifyReviewerPolicy, writeReviewerPolicy } from './pr-review-launch.js'

test('the reviewer clone holds the PR head detached, keeps no remote, runs no hook, and moves only while clean', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
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
    assert.deepEqual(await reviewCheckoutState(f.runner, area.checkout), { head: first, clean: true })
    assert.equal(f.plain(area.checkout, 'remote').trim(), '', 'nothing to push to')
    assert.match(f.plain(area.checkout, 'status', '--branch', '--porcelain=v2'), /# branch.head \(detached\)/)
    assert.equal(existsSync(join(f.root, 'hook-ran')), false)

    writeFileSync(join(upstream, 'a.txt'), 'second\n'); f.plain(upstream, 'commit', '-qam', 'second')
    const second = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/7/head', second)
    await assert.rejects(refreshReviewCheckout(f.runner, area.checkout, upstream, 'c'.repeat(40), 7), /moved the pull request again/)
    writeFileSync(join(area.checkout, 'scratch.txt'), 'reviewer notes')
    await assert.rejects(refreshReviewCheckout(f.runner, area.checkout, upstream, second, 7), /has changes/)
    f.plain(area.checkout, 'clean', '-fq')
    assert.equal(await refreshReviewCheckout(f.runner, area.checkout, upstream, second, 7), second)
    assert.equal(readFileSync(join(area.checkout, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'second\n')
    assert.equal(await refreshReviewCheckout(f.runner, area.checkout, upstream, second, 7), second, 'already there')
    writeFileSync(join(area.checkout, 'a.txt'), 'reviewer edit\n')
    await assert.rejects(refreshReviewCheckout(f.runner, area.checkout, upstream, second, 7), /has changes/, 'dirty at the same head too')
    f.plain(area.checkout, 'checkout', '--', 'a.txt')
    await assert.rejects(cloneForReview(f.runner, project, upstream, area, { head: 'not-a-sha' }, 7), /Invalid/)

    await removeReviewerArea(area)
    assert.equal(existsSync(area.root), false)
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

test('the reviewer policy lets the sandbox read the helper folder and is verified as written', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    const policy = await writeReviewerPolicy(area, { userHome: join(f.root, 'user'), personCopilotHome: join(f.root, 'user', '.copilot'), desktopData: join(f.root, 'desktop'), appData: null, localAppData: null })
    assert.deepEqual(policy.readonly, [area.helper])
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
