import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, renameSync, symlinkSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createGitFixture, type GitFixture } from './fixtures/git-fixture.js'
import { ReviewReservations } from './pr-review-reservations.js'
import { cloneForReview, createReviewerArea, endedReviewNote, firstReviewPrompt, planReviewerArea, projectCredentialSettings, projectOrigin, pruneReviewerAreas, refreshReviewCheckout, removeReviewerArea, removeReviewerAreaDetailed, reviewCandidateReason, reviewCheckoutState, verifyReviewerPolicy, writeReviewerPolicy } from './pr-review-launch.js'

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
    assert.equal(realpathSync.native(area.commonDir), realpathSync.native(join(project, '.git')), 'the worktree uses the project\'s own Git directory')
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
    const listedAs = realpathSync.native(area.checkout).replace(/\\/g, '/')
    await removeReviewerArea(area, f.runner)
    assert.equal(existsSync(area.root), false)
    assert.ok(!f.plain(project, 'worktree', 'list', '--porcelain').toLowerCase().includes(listedAs.toLowerCase()), 'its registration is gone')
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
  assert.match(text, /pr-read/); assert.match(text, /pr-review/); assert.match(text, process.platform === 'win32' ? /ExecutionPolicy Bypass/ : /sh "\$COPILOT_DESKTOP_MEETING_HELPER"/)
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

test('a folder a clean removal left behind goes on a later try, also with its .git file; an unrecorded one is not touched', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f)
    // What a removal that failed part-way can leave on Windows: the project no longer registers the worktree, but its
    // folder is still there, with the worktree's .git file (a handle held on it) and other files.
    const leftover = async (): Promise<Awaited<ReturnType<typeof createReviewerArea>>> => {
      const area = await createReviewerArea(join(f.root, 'reviewers'))
      await cloneForReview(f.runner, project, upstream, area, { head, base }, 7)
      const marker = readFileSync(join(area.checkout, '.git'), 'utf8')
      rmSync(join(area.checkout, '.git'))
      f.plain(project, 'worktree', 'prune')
      writeFileSync(join(area.checkout, '.git'), marker)
      await new Promise((done) => setTimeout(done, 30))
      return area
    }
    // Without a record that Git detached it while clean, an unregistered folder with a .git file is left alone.
    const unknown = await leftover()
    assert.deepEqual(await removeReviewerAreaDetailed(unknown, f.runner), { outcome: 'kept', reason: 'unregistered' })
    assert.ok(existsSync(join(unknown.checkout, 'a.txt')))
    // With that record, the same state is cleared: folder and ref.
    assert.deepEqual(await removeReviewerAreaDetailed(unknown, f.runner, { detachedAt: Date.now() }), { outcome: 'removed' })
    assert.equal(existsSync(unknown.root), false)
    assert.throws(() => f.plain(project, 'rev-parse', '--verify', unknown.ref), 'its ref goes with it')
    // A file saved in the leftover folder after the removal is the person's: nothing is deleted.
    const noted = await leftover()
    const removedAt = Date.now()
    await new Promise((done) => setTimeout(done, 30))
    mkdirSync(join(noted.checkout, 'notes'))
    writeFileSync(join(noted.checkout, 'notes', 'recovery.txt'), 'saved after the worktree was removed')
    const keptNote = await removeReviewerAreaDetailed(noted, f.runner, { detachedAt: removedAt })
    assert.equal(keptNote.outcome === 'kept' && keptNote.reason, 'dirty')
    assert.match(keptNote.outcome === 'kept' ? keptNote.detail ?? '' : '', /recovery\.txt was saved after/)
    assert.ok(existsSync(join(noted.checkout, 'notes', 'recovery.txt')))
    // So is a file moved in afterwards, although a move keeps the file's own creation and write times.
    const movedInto = await leftover()
    writeFileSync(join(f.root, 'old-note.txt'), 'written long before')
    await new Promise((done) => setTimeout(done, 30))
    const movedCutoff = Date.now()
    await new Promise((done) => setTimeout(done, 30))
    renameSync(join(f.root, 'old-note.txt'), join(movedInto.checkout, 'old-note.txt'))
    assert.ok(statSync(join(movedInto.checkout, 'old-note.txt')).mtimeMs < movedCutoff, 'the move kept the write time')
    const keptMoved = await removeReviewerAreaDetailed(movedInto, f.runner, { detachedAt: movedCutoff })
    assert.equal(keptMoved.outcome === 'kept' && keptMoved.reason, 'dirty')
    assert.ok(existsSync(join(movedInto.checkout, 'old-note.txt')))
    // Git gives a later review's worktree the entry name this one had ("checkout"). The old pointer then names an
    // entry that exists but belongs to the other checkout: still stale, and the other review is not touched.
    const first = await leftover()
    const second = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, second, { head, base }, 7)
    assert.equal(readFileSync(join(first.checkout, '.git'), 'utf8'), readFileSync(join(second.checkout, '.git'), 'utf8'), 'Git reused the entry')
    assert.deepEqual(await removeReviewerAreaDetailed(first, f.runner, { detachedAt: Date.now() }), { outcome: 'removed' })
    assert.equal(f.plain(second.checkout, 'rev-parse', 'HEAD').trim(), head)
    // The entry's own checkout is real Git metadata even with the record.
    assert.equal((await removeReviewerAreaDetailed(second, f.runner)).outcome, 'removed')
    // A repository someone made of the leftover folder is real Git metadata: the record does not let it go.
    const recovered = await leftover()
    rmSync(join(recovered.checkout, '.git'))
    f.plain(recovered.checkout, 'init', '-q')
    f.plain(recovered.checkout, 'add', '-A'); f.plain(recovered.checkout, 'commit', '-qm', 'recovered by the person')
    assert.deepEqual(await removeReviewerAreaDetailed(recovered, f.runner, { detachedAt: Date.now() }), { outcome: 'kept', reason: 'unregistered' })
    assert.match(f.plain(recovered.checkout, 'log', '--oneline'), /recovered by the person/)
    // So is a .git file that points anywhere but a missing entry of this project's own worktrees folder.
    const foreign = await leftover()
    writeFileSync(join(foreign.checkout, '.git'), `gitdir: ${join(f.root, 'not-the-project', 'worktrees', 'gone')}\n`)
    assert.deepEqual(await removeReviewerAreaDetailed(foreign, f.runner, { detachedAt: Date.now() }), { outcome: 'kept', reason: 'unregistered' })
    assert.ok(existsSync(join(foreign.checkout, 'a.txt')))
    // The record does not weaken the path guard: a checkout that is not this review's own folder is never removed.
    const linked = await leftover()
    const elsewhere = join(f.root, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'mine.txt'), 'the person\'s')
    rmSync(linked.checkout, { recursive: true, force: true })
    let linkMade = true
    try { symlinkSync(elsewhere, linked.checkout, 'junction') } catch { linkMade = false }
    if (linkMade) {
      assert.deepEqual(await removeReviewerAreaDetailed(linked, f.runner, { detachedAt: Date.now() }), { outcome: 'kept', reason: 'unregistered' })
      assert.ok(existsSync(join(elsewhere, 'mine.txt')))
    }
    // A worktree still registered goes through the usual check even with the record: changes keep it.
    const dirty = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, dirty, { head, base }, 7)
    writeFileSync(join(dirty.checkout, 'reviewer-notes.txt'), 'kept for the person')
    assert.deepEqual(await removeReviewerAreaDetailed(dirty, f.runner, { detachedAt: Date.now() }), { outcome: 'kept', reason: 'dirty' })
    assert.ok(existsSync(join(dirty.checkout, 'reviewer-notes.txt')))
  } finally { f.cleanup() }
})

test('a clean worktree whose folder cannot be deleted is reported as detached, and goes once the folder is free', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  let holder: ChildProcess | null = null
  try {
    const { upstream, project, base, head } = repos(f)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, area, { head, base }, 7)
    // A process whose working folder is the checkout (a reviewer's leftover child) keeps Windows from deleting it.
    holder = spawn(process.execPath, ['-e', 'process.stdout.write("up");setInterval(()=>{},1000)'], { cwd: area.checkout, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((done, fail) => { holder!.stdout!.once('data', () => done()); holder!.once('error', fail) })
    await new Promise((done) => setTimeout(done, 30))
    const started = Date.now()
    // A note saved after Git took the worktree out, while the removal is still going on, is not its leftover.
    const savingRunner = {
      run: async (req: Parameters<typeof f.runner.run>[0]) => {
        const result = await f.runner.run(req)
        if (req.args[0] === 'worktree' && req.args[1] === 'remove' && existsSync(area.checkout) && !existsSync(join(area.checkout, 'during.txt'))) {
          writeFileSync(join(area.checkout, 'during.txt'), 'saved while the removal was running')
        }
        return result
      },
    } as unknown as typeof f.runner
    const held = await removeReviewerAreaDetailed(area, savingRunner, { retryDelaysMs: [5, 5], folderRetries: 1 })
    assert.ok(Date.now() - started < 20_000, 'a held folder is given up on quickly')
    const cutoff = held.outcome === 'kept' ? held.detachedAt : undefined
    assert.ok(typeof cutoff === 'number' && cutoff >= started && cutoff <= statSync(join(area.checkout, 'during.txt')).mtimeMs, 'the cutoff is from before Git was asked')
    assert.equal(held.outcome, 'kept')
    assert.equal(held.outcome === 'kept' && held.reason, 'detached', 'Git took the clean worktree out; only the folder stayed')
    assert.ok(existsSync(area.checkout))
    assert.doesNotMatch(f.plain(project, 'worktree', 'list', '--porcelain'), new RegExp(basename(area.root)))
    const exited = new Promise<void>((done) => holder!.once('exit', () => done()))
    holder.kill(); await exited; holder = null
    const withNote = await removeReviewerAreaDetailed(area, f.runner, { detachedAt: cutoff })
    assert.equal(withNote.outcome === 'kept' && withNote.reason, 'dirty', 'the note saved during the removal keeps the folder')
    assert.ok(existsSync(join(area.checkout, 'during.txt')))
    // Once the person has taken their note, what the removal left goes.
    rmSync(join(area.checkout, 'during.txt'))
    assert.deepEqual(await removeReviewerAreaDetailed(area, f.runner, { detachedAt: cutoff }), { outcome: 'removed' })
    assert.equal(existsSync(area.root), false)
  } finally { holder?.kill(); f.cleanup() }
})

test('a kept reservation records a detached removal, keeps it across a restart, and never loses it', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const path = join(f.root, 'reservations.json')
    const store = new ReviewReservations(path)
    const mk = (n: number): { launchId: string; root: string } => { const a = planReviewerArea(join(f.root, 'reviewers')); return { launchId: basename(a.root), root: a.root } }
    const a = mk(1), b = mk(2)
    for (const [r, number] of [[a, 1], [b, 2]] as const) {
      await store.reserve({ launchId: r.launchId, repository: 'o/r', number, reviewer: 'x', project: f.root, root: r.root, checkout: join(r.root, 'checkout'), ref: `refs/desktop-review/${r.launchId}` })
    }
    // Kept for the person (changes, or an outcome nobody recorded): not detached.
    await store.keep(a.launchId)
    assert.equal(store.holder('o/r', 1, 'x')?.kept, true)
    assert.equal(store.holder('o/r', 1, 'x')?.detachedAt, undefined)
    // A later clean removal that only left the folder upgrades it; a plain keep after that does not take it back.
    await store.keep(a.launchId, 1_000)
    assert.equal(store.holder('o/r', 1, 'x')?.detachedAt, 1_000)
    await store.keep(a.launchId)
    assert.equal(store.holder('o/r', 1, 'x')?.detachedAt, 1_000)
    await store.keep(b.launchId, 2_000)
    const reread = new ReviewReservations(path)
    assert.equal(reread.holder('o/r', 1, 'x')?.detachedAt, 1_000)
    assert.equal(reread.holder('o/r', 2, 'x')?.detachedAt, 2_000)
    // A new start of the same review says what is in the way: changes for the person, or a folder still in use.
    const again = mk(3)
    await assert.rejects(store.reserve({ launchId: again.launchId, repository: 'o/r', number: 1, reviewer: 'x', project: f.root, root: again.root, checkout: join(again.root, 'checkout'), ref: `refs/desktop-review/${again.launchId}` }), /still in use and could not be deleted/)
    const c = mk(4)
    await store.reserve({ launchId: c.launchId, repository: 'o/r', number: 3, reviewer: 'x', project: f.root, root: c.root, checkout: join(c.root, 'checkout'), ref: `refs/desktop-review/${c.launchId}` })
    await store.keep(c.launchId)
    await assert.rejects(store.reserve({ launchId: again.launchId, repository: 'o/r', number: 3, reviewer: 'x', project: f.root, root: again.root, checkout: join(again.root, 'checkout'), ref: `refs/desktop-review/${again.launchId}` }), /left changes in its worktree/)
    // Something saved in the leftover folder later makes the record the person's again, with the message for changes.
    await store.undetach(b.launchId)
    assert.equal(store.holder('o/r', 2, 'x')?.kept, true)
    assert.equal(store.holder('o/r', 2, 'x')?.detachedAt, undefined)
    await assert.rejects(store.reserve({ launchId: again.launchId, repository: 'o/r', number: 2, reviewer: 'x', project: f.root, root: again.root, checkout: join(again.root, 'checkout'), ref: `refs/desktop-review/${again.launchId}` }), /left changes in its worktree/)
    // A record whose time is not a number is not trusted at all.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[]
    raw[0]!.detachedAt = 'yes'
    writeFileSync(path, JSON.stringify(raw))
    const tampered = new ReviewReservations(path)
    assert.equal(tampered.list().length, 2)
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

test('a merged or closed PR is reported only from a clear answer; a failed read is asked again', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40)
  assert.equal(endedReviewNote(5, null, []), null, 'the read failed')
  assert.equal(endedReviewNote(5, { state: 'open', merged: false }, []), null)
  assert.equal(endedReviewNote(5, { state: 'closed' }, []), null, 'no merged flag')
  assert.match(endedReviewNote(5, { state: 'closed', merged: false, head: { sha: a } }, []) ?? '', /closed without merging/)
  assert.match(endedReviewNote(5, { state: 'closed', merged: true, head: { sha: a } }, [{ kind: 'approval', head: a, createdAt: 2 }, { kind: 'review', head: b, createdAt: 1 }]) ?? '', /head its review loop approved/)
  assert.match(endedReviewNote(5, { state: 'closed', merged: true, head: { sha: a } }, [{ kind: 'approval', head: b, createdAt: 1 }, { kind: 'review', head: a, createdAt: 2 }]) ?? '', /findings of its last review/)
  assert.match(endedReviewNote(5, { state: 'closed', merged: true, head: { sha: a } }, [{ kind: 'approval', head: b, createdAt: 1 }]) ?? '', /had not approved \(it approved bbbbbbbbbbbb\)/)
  assert.match(endedReviewNote(5, { state: 'closed', merged: true, head: { sha: a } }, [{ kind: 'reply', head: a, createdAt: 1 }]) ?? '', /had not approved\.$/)
})

test('an approval held for missing checks is not reported as open findings', () => {
  const a = 'a'.repeat(40)
  assert.match(endedReviewNote(5, { state: 'closed', merged: true, head: { sha: a } }, [{ kind: 'review', head: a, createdAt: 1, heldApproval: true }]) ?? '', /held its approval .* because some checks could not run/)
})

test('a reviewer folder reached through a link (macOS /var, a Windows short name) is still recognized as its worktree', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f)
    mkdirSync(join(f.root, 'real-reviewers'))
    const alias = join(f.root, 'reviewers-alias')
    symlinkSync(join(f.root, 'real-reviewers'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    // The desktop names the folder through the link; Git lists the worktree by its real path.
    const incomplete = await createReviewerArea(alias)
    incomplete.project = project
    assert.equal(await removeReviewerArea(incomplete, f.runner), 'removed', 'a missing checkout is compared through its real parent')
    const dirty = await createReviewerArea(alias)
    await cloneForReview(f.runner, project, upstream, dirty, { head, base }, 7)
    writeFileSync(join(dirty.checkout, 'notes.txt'), 'the reviewer\'s changes')
    assert.equal(await removeReviewerArea(dirty, f.runner), 'kept', 'a worktree with changes is never deleted')
    assert.ok(existsSync(join(dirty.checkout, 'notes.txt')))
    rmSync(join(dirty.checkout, 'notes.txt'))
    assert.equal(await removeReviewerArea(dirty, f.runner), 'removed')
    assert.doesNotMatch(f.plain(project, 'worktree', 'list', '--porcelain'), /real-reviewers/, 'and its registration went with it')
  } finally { f.cleanup() }
})

test('a checkout replaced by a link to another worktree is never removed, nor is that worktree', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f)
    const area = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, area, { head, base }, 7)
    const other = join(f.root, 'other-worktree')
    f.plain(project, 'worktree', 'add', '-q', '--detach', other, base)
    // What sandboxed code could do: swap the review's checkout for a link to the person's other worktree.
    rmSync(area.checkout, { recursive: true, force: true })
    symlinkSync(other, area.checkout, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(await removeReviewerArea(area, f.runner), 'kept')
    assert.ok(existsSync(join(other, 'a.txt')), 'the other worktree is untouched')
    assert.match(f.plain(project, 'worktree', 'list'), /other-worktree/)
  } finally { f.cleanup() }
})

test('removeReviewerAreaDetailed removes worktrees with gitignored build/dependency folders, retries transient handle locks without --force, and distinguishes dirty vs git-failed', async (t) => {
  const f = await createGitFixture(); if (!f) { t.skip('Git unavailable'); return }
  try {
    const { upstream, project, base, head } = repos(f)
    writeFileSync(join(upstream, '.gitignore'), 'node_modules/\ndist/\n')
    f.plain(upstream, 'add', '.gitignore')
    f.plain(upstream, 'commit', '-qm', 'add gitignore')
    const headWithIgnore = f.plain(upstream, 'rev-parse', 'HEAD').trim()
    f.plain(upstream, 'update-ref', 'refs/pull/7/head', headWithIgnore)

    // 1. Gitignored directories inside the detached worktree are removed cleanly without --force:
    const cleanWithIgnored = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, cleanWithIgnored, { head: headWithIgnore, base }, 7)
    mkdirSync(join(cleanWithIgnored.checkout, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(cleanWithIgnored.checkout, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    mkdirSync(join(cleanWithIgnored.checkout, 'dist'), { recursive: true })
    writeFileSync(join(cleanWithIgnored.checkout, 'dist', 'bundle.js'), 'console.log(1)\n')
    const resIgnored = await removeReviewerAreaDetailed(cleanWithIgnored, f.runner, { retryDelaysMs: [10] })
    assert.deepEqual(resIgnored, { outcome: 'removed' })
    assert.equal(existsSync(cleanWithIgnored.root), false)

    // 2. Transient Windows handle lock retries worktree remove (never passing --force) and succeeds once released:
    const transientArea = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, transientArea, { head: headWithIgnore, base }, 7)
    let removeAttempts = 0
    const seenRemoveArgs: string[][] = []
    const flakyRunner = {
      run: async (req: Parameters<typeof f.runner.run>[0]) => {
        if (req.args[0] === 'worktree' && req.args[1] === 'remove') {
          seenRemoveArgs.push([...req.args])
          removeAttempts += 1
          if (removeAttempts < 3) {
            return {
              exitCode: 128,
              stdout: Buffer.alloc(0),
              stderr: 'fatal: failed to remove worktree: Permission denied (EBUSY)',
              timedOut: false,
              cancelled: false,
            }
          }
        }
        return f.runner.run(req)
      },
    } as unknown as typeof f.runner
    const resTransient = await removeReviewerAreaDetailed(transientArea, flakyRunner, { retryDelaysMs: [5, 5, 5] })
    assert.deepEqual(resTransient, { outcome: 'removed' })
    assert.equal(removeAttempts, 3)
    for (const args of seenRemoveArgs) {
      assert.equal(args.includes('--force'), false, 'never passes --force to git worktree remove')
      assert.equal(args.includes('-f'), false, 'never passes -f to git worktree remove')
    }

    // 3. Dirty worktree returns reason: 'dirty' immediately without retrying worktree remove:
    const dirtyArea = await createReviewerArea(join(f.root, 'reviewers'))
    await cloneForReview(f.runner, project, upstream, dirtyArea, { head: headWithIgnore, base }, 7)
    writeFileSync(join(dirtyArea.checkout, 'untracked.txt'), 'keep me\n')
    let dirtyRemoveCalls = 0
    const countingRunner = {
      run: async (req: Parameters<typeof f.runner.run>[0]) => {
        if (req.args[0] === 'worktree' && req.args[1] === 'remove') dirtyRemoveCalls += 1
        return f.runner.run(req)
      },
    } as unknown as typeof f.runner
    const resDirty = await removeReviewerAreaDetailed(dirtyArea, countingRunner, { retryDelaysMs: [5, 5] })
    assert.deepEqual(resDirty, { outcome: 'kept', reason: 'dirty' })
    assert.equal(dirtyRemoveCalls, 0, 'skips worktree remove when git status reports dirty files')
    rmSync(join(dirtyArea.checkout, 'untracked.txt'))

    // 4. Clean worktree whose removal persistently fails reports reason: 'git-failed' (not 'dirty'):
    const alwaysFailRunner = {
      run: async (req: Parameters<typeof f.runner.run>[0]) => {
        if (req.args[0] === 'worktree' && req.args[1] === 'remove') {
          return {
            exitCode: 128,
            stdout: Buffer.alloc(0),
            stderr: 'fatal: locked by external process',
            timedOut: false,
            cancelled: false,
          }
        }
        return f.runner.run(req)
      },
    } as unknown as typeof f.runner
    const resFailed = await removeReviewerAreaDetailed(dirtyArea, alwaysFailRunner, { retryDelaysMs: [5, 5] })
    assert.equal(resFailed.outcome, 'kept')
    if (resFailed.outcome === 'kept') {
      assert.equal(resFailed.reason, 'git-failed')
      assert.match(resFailed.detail ?? '', /locked by external process/)
    }
    assert.equal(await removeReviewerArea(dirtyArea, f.runner), 'removed')
  } finally { f.cleanup() }
})
