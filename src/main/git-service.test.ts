import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture, findGitForTests, shellPath } from './fixtures/git-fixture.js'
import type { GitFixture } from './fixtures/git-fixture.js'
import { GitCancelledError, GitService, GitStaleError, isIndexLockFailure } from './git-service.js'
import type { GitServiceOptions } from './git-service.js'
import { GitTrustStore } from './git-trust.js'
import type { GitProjectView, GitRepoStatusView } from './git-types.js'
import type { GitRunOptions, GitRunResult, GitRunner } from './git-runner.js'

const git = await findGitForTests()
const skip = git ? false : 'git is not installed'
const PROFILE = '0123456789abcdef'
const SUBSCRIBER = 7

interface Harness {
  fixture: GitFixture
  service: GitService
  events: GitProjectView[]
  /** Subcommands the runner was asked to run, for example `status` or `config`. */
  calls: string[]
  trustStore: GitTrustStore
  project: string
}

/** Wraps the real runner so tests can see which git commands ran. */
function countingRunner(fixture: GitFixture, calls: string[]): GitRunner {
  return {
    run: (options: GitRunOptions): Promise<GitRunResult> => {
      calls.push(String(options.args[0]))
      return fixture.runner.run(options)
    },
  } as unknown as GitRunner
}

async function harness(t: test.TestContext, setup: (fixture: GitFixture, project: string) => void, extra: Partial<GitServiceOptions> = {}): Promise<Harness> {
  const fixture = (await createGitFixture())!
  const project = join(fixture.root, 'project')
  mkdirSync(project)
  setup(fixture, project)
  const events: GitProjectView[] = []
  const calls: string[] = []
  const trustStore = new GitTrustStore(join(fixture.root, 'git-trust.json'))
  const service = new GitService({
    getRuntime: async () => ({ runner: countingRunner(fixture, calls), executable: fixture.git }),
    trustStore,
    resolveProject: (profileId) => profileId === PROFILE ? project : null,
    onChanged: (_subscriber, _profile, view) => { events.push(view) },
    debounceMs: 20,
    fallbackMs: 60_000,
    ...extra,
  })
  t.after(async () => { await service.dispose(); fixture.cleanup() })
  return { fixture, service, events, calls, trustStore, project }
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const repoAt = (view: GitProjectView, relativePath: string) => view.repos.find(repo => repo.relativePath === relativePath)

test('subscribing lists the project repository with its branch and no changes', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  const view = await h.service.subscribe(SUBSCRIBER, PROFILE)
  assert.equal(view.git.available, true)
  assert.equal(view.git.supported, true)
  const repo = repoAt(view, '.')
  assert.equal(repo?.kind, 'project')
  assert.equal(repo?.state, 'ready')
  assert.equal(repo?.branch, 'main')
  assert.equal(repo?.changeCount, 0)
  assert.match(repo?.id ?? '', /^repo-\d+$/)
})

test('a requested refresh picks up edits and pushes one change event', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { f.plain(project, 'init', '-q'); writeFileSync(join(project, 'a.txt'), 'one\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'init') })
  await h.service.subscribe(SUBSCRIBER, PROFILE)
  const baseline = h.events.length
  writeFileSync(join(h.project, 'a.txt'), 'changed\n')
  writeFileSync(join(h.project, 'new.txt'), 'x\n')
  h.service.requestRefresh(PROFILE)
  h.service.requestRefresh(PROFILE)
  const event = await waitFor(() => h.events.length > baseline && h.events.at(-1))
  assert.equal(repoAt(event, '.')?.changeCount, 2)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(h.events.length, baseline + 1, 'two quick requests produce one change, and an unchanged poll pushes nothing')
  const status = await h.service.getStatus(SUBSCRIBER, PROFILE, repoAt(event, '.')!.id)
  assert.deepEqual(status.unstaged.map(entry => entry.path), ['a.txt'])
  assert.deepEqual(status.untracked.map(entry => entry.path), ['new.txt'])
})

test('nested repositories keep their ids across rescans and a removed id is never reused', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { for (const name of ['a', 'b']) { mkdirSync(join(project, name)); f.plain(join(project, name), 'init', '-q') } })
  const first = await h.service.subscribe(SUBSCRIBER, PROFILE)
  const [a, b] = [repoAt(first, 'a')!, repoAt(first, 'b')!]
  assert.notEqual(a.id, b.id)
  rmSync(join(h.project, 'a'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  mkdirSync(join(h.project, 'c')); h.fixture.plain(join(h.project, 'c'), 'init', '-q')
  const second = await h.service.rescan(SUBSCRIBER, PROFILE)
  assert.equal(repoAt(second, 'b')?.id, b.id)
  assert.equal(repoAt(second, 'a'), undefined)
  const c = repoAt(second, 'c')!
  assert.notEqual(c.id, a.id)
  assert.notEqual(c.id, b.id)
})

test('a repository whose config runs a program waits for review and is never read until trusted', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-service-filter-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await harness(t, (f, project) => {
    f.plain(project, 'init', '-q')
    writeFileSync(join(project, 'a.txt'), 'one\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'init')
    f.plain(project, 'config', 'filter.evil.clean', `sh -c 'echo x > "${shellPath(marker)}"; cat'`)
    writeFileSync(join(project, '.gitattributes'), '*.txt filter=evil\n')
    writeFileSync(join(project, 'a.txt'), 'two\n')
    const later = new Date(Date.now() + 5_000); utimesSync(join(project, 'a.txt'), later, later)
  })
  const view = await h.service.subscribe(SUBSCRIBER, PROFILE)
  const repo = repoAt(view, '.')!
  assert.equal(repo.state, 'needs-review')
  assert.deepEqual(repo.reviewItems.map(item => item.key), ['filter.evil.clean'])
  assert.match(repo.configHash ?? '', /^[0-9a-f]{64}$/)
  assert.equal(h.calls.includes('status'), false, 'status must not run before the user trusts the repository')
  assert.equal(existsSync(marker), false)
  await assert.rejects(h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, 'e1-0', false), /not available/)

  await assert.rejects(h.service.trust(SUBSCRIBER, PROFILE, repo.id, 'f'.repeat(64)), GitStaleError)
  const trusted = await h.service.trust(SUBSCRIBER, PROFILE, repo.id, repo.configHash!)
  assert.equal(repoAt(trusted, '.')?.state, 'ready')
  assert.equal(h.calls.includes('status'), true)
  // The service keys trust by canonical path; the temp folder may be reached through an 8.3 short name.
  assert.equal(await h.trustStore.isTrusted(realpathSync.native(h.project), repo.configHash!), true)
})

test('trusting is undone by changing the config', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { f.plain(project, 'init', '-q'); f.plain(project, 'config', 'core.sshCommand', 'ssh -i one') })
  const first = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  assert.equal(first.state, 'needs-review')
  await h.service.trust(SUBSCRIBER, PROFILE, first.id, first.configHash!)
  h.fixture.plain(h.project, 'config', 'core.sshCommand', 'ssh -i two')
  const again = repoAt(await h.service.rescan(SUBSCRIBER, PROFILE), '.')!
  assert.equal(again.state, 'needs-review')
  assert.notEqual(again.configHash, first.configHash)
})

test('status groups staged, unstaged, untracked and conflicted files', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    f.plain(project, 'init', '-q')
    for (const name of ['both.txt', 'unstaged.txt', 'staged.txt']) writeFileSync(join(project, name), 'v1\n')
    f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'init')
    writeFileSync(join(project, 'both.txt'), 'v2\n'); f.plain(project, 'add', 'both.txt'); writeFileSync(join(project, 'both.txt'), 'v3\n')
    writeFileSync(join(project, 'unstaged.txt'), 'v2\n')
    writeFileSync(join(project, 'staged.txt'), 'v2\n'); f.plain(project, 'add', 'staged.txt')
    writeFileSync(join(project, 'untracked.txt'), 'u\n')
    mkdirSync(join(project, 'newdir')); writeFileSync(join(project, 'newdir', 'x.txt'), 'x\n')
  })
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  const status = await h.service.getStatus(SUBSCRIBER, PROFILE, repo.id)
  assert.deepEqual(status.staged.map(entry => entry.path).sort(), ['both.txt', 'staged.txt'])
  assert.deepEqual(status.unstaged.map(entry => entry.path).sort(), ['both.txt', 'unstaged.txt'])
  assert.deepEqual(status.untracked.map(entry => [entry.path, entry.isDirectory]).sort(), [['newdir/', true], ['untracked.txt', false]])
  assert.equal(status.summary.changeCount, 5)
})

test('diffs cover modified, staged, untracked, binary and directory entries', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    f.plain(project, 'init', '-q')
    writeFileSync(join(project, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(project, 'img.bin'), Buffer.from([0, 1, 2, 3]))
    f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'init')
    writeFileSync(join(project, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(project, 'img.bin'), Buffer.from([0, 9, 9, 9, 9]))
    writeFileSync(join(project, 'new.txt'), 'hello\nworld\n')
    mkdirSync(join(project, 'dir')); writeFileSync(join(project, 'dir', 'f.txt'), 'f')
  })
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  const status = await h.service.getStatus(SUBSCRIBER, PROFILE, repo.id)
  const id = (path: string): string => [...status.unstaged, ...status.untracked].find(entry => entry.path === path)!.id

  const modified = await h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, id('a.txt'), false)
  assert.equal(modified.kind, 'text')
  assert.match(modified.text, /^diff --git a\/a\.txt b\/a\.txt/m)
  assert.match(modified.text, /^-two$/m)
  assert.match(modified.text, /^\+TWO$/m)
  assert.deepEqual([modified.added, modified.deleted], [2, 1])

  assert.equal((await h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, id('img.bin'), false)).kind, 'binary')

  const added = await h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, id('new.txt'), false)
  assert.equal(added.kind, 'text')
  assert.match(added.text, /^\+\+\+ b\/new\.txt$/m)
  assert.match(added.text, /^@@ -0,0 \+1,2 @@$/m)
  assert.deepEqual([added.added, added.deleted], [2, 0])

  assert.equal((await h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, id('dir/'), false)).kind, 'directory')
})

test('staged diffs are separate from unstaged ones', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    f.plain(project, 'init', '-q'); writeFileSync(join(project, 'a.txt'), 'one\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'init')
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', 'a.txt'); writeFileSync(join(project, 'a.txt'), 'three\n')
  })
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  const status = await h.service.getStatus(SUBSCRIBER, PROFILE, repo.id)
  const entryId = status.staged[0]!.id
  assert.match((await h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, entryId, true)).text, /^\+two$/m)
  assert.match((await h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, entryId, false)).text, /^\+three$/m)
})

test('an entry id from an older file list is rejected', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { f.plain(project, 'init', '-q'); writeFileSync(join(project, 'a.txt'), 'x\n') })
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  const old = (await h.service.getStatus(SUBSCRIBER, PROFILE, repo.id)).untracked[0]!.id
  writeFileSync(join(h.project, 'b.txt'), 'y\n')
  await h.service.getStatus(SUBSCRIBER, PROFILE, repo.id)
  await assert.rejects(h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, old, false), GitStaleError)
  await assert.rejects(h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, 'e999-0', false), GitStaleError)
})

test('log returns commits newest first and pages with skip', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  writeFileSync(join(h.project, 'a.txt'), 'x\n')
  h.fixture.plain(h.project, 'add', '.')
  h.fixture.plain(h.project, 'commit', '-q', '-m', 'first: a thing')
  h.fixture.plain(h.project, 'commit', '-q', '--allow-empty', '-m', 'second')
  const view = await h.service.subscribe(SUBSCRIBER, PROFILE)
  const repo = repoAt(view, '.')!
  const log = await h.service.getLog(SUBSCRIBER, PROFILE, repo.id, 10, 0)
  assert.deepEqual(log.map(entry => entry.subject), ['second', 'first: a thing'])
  assert.equal(log[0]?.author, 'Test')
  assert.deepEqual((await h.service.getLog(SUBSCRIBER, PROFILE, repo.id, 1, 1)).map(entry => entry.subject), ['first: a thing'])
})

test('an empty repository has no log and does not fail', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  assert.deepEqual(await h.service.getLog(SUBSCRIBER, PROFILE, repo.id, 10, 0), [])
})

test('unsubscribing stops every refresh and releases the project', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  await h.service.subscribe(SUBSCRIBER, PROFILE)
  assert.equal(h.service.hasSubscribers(), true)
  h.service.unsubscribeAll(SUBSCRIBER)
  assert.equal(h.service.hasSubscribers(), false)
  const before = h.calls.length
  h.service.requestRefresh(PROFILE)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(h.calls.length, before, 'no git process may start for a project nobody is watching')
  await assert.rejects(h.service.getStatus(SUBSCRIBER, PROFILE, 'repo-1'), /Open the Git panel/)
})

test('two subscribers share one project and it stays until the last one leaves', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  await h.service.subscribe(1, PROFILE)
  await h.service.subscribe(2, PROFILE)
  h.service.unsubscribe(1, PROFILE)
  assert.equal(h.service.hasSubscribers(), true)
  h.service.unsubscribe(2, PROFILE)
  assert.equal(h.service.hasSubscribers(), false)
})

test('pausing stops refreshes and resuming runs one', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  await h.service.subscribe(SUBSCRIBER, PROFILE)
  h.service.setPaused(true)
  const before = h.calls.length
  writeFileSync(join(h.project, 'a.txt'), 'x\n')
  h.service.requestRefresh(PROFILE)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(h.calls.length, before)
  const baseline = h.events.length
  h.service.setPaused(false)
  const event = await waitFor(() => h.events.length > baseline && h.events.at(-1))
  assert.equal(repoAt(event, '.')?.changeCount, 1)
})

test('shouldPause defers work without losing the subscription', { skip }, async (t) => {
  let blocked = false
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'), { shouldPause: () => blocked })
  await h.service.subscribe(SUBSCRIBER, PROFILE)
  blocked = true
  const before = h.calls.length
  h.service.requestRefresh(PROFILE)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(h.calls.length, before)
  blocked = false
  writeFileSync(join(h.project, 'a.txt'), 'x\n')
  h.service.requestRefresh(PROFILE)
  await waitFor(() => h.events.at(-1))
})

test('opening the panel works while background refreshing is paused, but background requests stay quiet', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'), { shouldPause: () => true })
  const view = await h.service.subscribe(SUBSCRIBER, PROFILE)
  assert.equal(view.git.available, true, 'a hidden window must not turn an explicit open into "git not found"')
  assert.equal(repoAt(view, '.')?.state, 'ready')
  const before = h.calls.length
  h.service.requestRefresh(PROFILE)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(h.calls.length, before)
  const status = await h.service.getStatus(SUBSCRIBER, PROFILE, repoAt(view, '.')!.id)
  assert.equal(status.summary.state, 'ready', 'an explicit read still refreshes')
})

test('dispose stops the service and refuses new subscriptions', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  await h.service.subscribe(SUBSCRIBER, PROFILE)
  await h.service.dispose()
  assert.equal(h.service.hasSubscribers(), false)
  await assert.rejects(h.service.subscribe(SUBSCRIBER, PROFILE), /stopped/)
})

test('a missing git reports itself instead of failing', async (t) => {
  const service = new GitService({
    getRuntime: async () => null,
    trustStore: new GitTrustStore(join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-none-${process.pid}.json`)),
    resolveProject: () => process.env.TEMP ?? 'C:\\Windows\\Temp',
    onChanged: () => undefined,
  })
  t.after(() => service.dispose())
  const view = await service.subscribe(1, PROFILE)
  assert.equal(view.git.available, false)
  assert.match(view.git.error ?? '', /Install Git/)
  assert.deepEqual(view.repos, [])
})

test('an unknown profile and an unsafe .git are reported without running git', { skip }, async (t) => {
  const h = await harness(t, (_f, project) => { mkdirSync(join(project, 'bad')); writeFileSync(join(project, 'bad', '.git'), 'gitdir: \\\\attacker\\share\\x\n') })
  await assert.rejects(h.service.subscribe(SUBSCRIBER, 'ffffffffffffffff'), /Unknown workspace/)
  const view = await h.service.subscribe(SUBSCRIBER, PROFILE)
  const bad = repoAt(view, 'bad')!
  assert.equal(bad.state, 'error')
  assert.match(bad.error ?? '', /outside local storage/)
  assert.equal(h.calls.includes('status'), false)
  assert.equal(h.calls.includes('config'), false)
})

test('a corrupt repository is an error row, not an exception', { skip }, async (t) => {
  const h = await harness(t, (_f, project) => { mkdirSync(join(project, '.git')) })
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  assert.equal(repo.state, 'error')
  assert.ok((repo.error ?? '').length > 0)
})

test('an explicit diff re-checks the settings and refuses a config that appeared after the last refresh', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-service-diffgate-${process.pid}.marker`)
  const control = `${marker}.control`
  for (const file of [marker, control]) rmSync(file, { force: true })
  t.after(() => { for (const file of [marker, control]) rmSync(file, { force: true }) })
  const modified = (f: GitFixture, project: string): void => {
    f.plain(project, 'init', '-q')
    writeFileSync(join(project, 'a.txt'), 'one\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'init')
    writeFileSync(join(project, 'a.txt'), 'two\n')
  }
  // Same size, newer timestamp: git cannot tell the file is unchanged without running the clean filter.
  const arm = (f: GitFixture, project: string, file: string): void => {
    f.plain(project, 'config', 'filter.evil.clean', `sh -c 'echo x > "${shellPath(file)}"; cat'`)
    writeFileSync(join(project, '.gitattributes'), '*.txt filter=evil\n')
    const later = new Date(Date.now() + 5_000); utimesSync(join(project, 'a.txt'), later, later)
  }
  const h = await harness(t, modified)
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  assert.equal(repo.state, 'ready')
  const status = await h.service.getStatus(SUBSCRIBER, PROFILE, repo.id)
  const entryId = status.unstaged[0]!.id

  // Control: this is what the reviewer saw. A plain diff in an identical repository runs the filter.
  const other = h.fixture.repo('control-repo')
  writeFileSync(join(other, 'a.txt'), 'two\n')
  arm(h.fixture, other, control)
  h.fixture.plain(other, 'diff', '--', 'a.txt')
  assert.equal(existsSync(control), true, 'control: git diff does run a clean filter')

  arm(h.fixture, h.project, marker)
  await assert.rejects(h.service.getDiff(SUBSCRIBER, PROFILE, repo.id, entryId, false), /need review/)
  await assert.rejects(h.service.getLog(SUBSCRIBER, PROFILE, repo.id, 5, 0), /not available|need review/)
  assert.equal(existsSync(marker), false, 'the filter must not run without approval')
  assert.equal(repoAt(h.events.at(-1)!, '.')?.state, 'needs-review', 'the panel is told at once')
})

test('a .git pointer that turns unsafe after discovery is caught before the next command', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  assert.equal(repo.state, 'ready')
  writeFileSync(join(h.project, '.git', 'commondir'), '\\\\review-invalid-host\\share\\repo\n')
  await assert.rejects(h.service.getLog(SUBSCRIBER, PROFILE, repo.id, 5, 0), /outside local storage/)
  assert.equal(repoAt(h.events.at(-1)!, '.')?.state, 'error')
})

test('closing the panel while an open is still resolving the folder leaves nothing running', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  const pending = h.service.subscribe(SUBSCRIBER, PROFILE)
  h.service.unsubscribeAll(SUBSCRIBER)
  await assert.rejects(pending, GitCancelledError)
  assert.equal(h.service.hasSubscribers(), false)

  const second = h.service.subscribe(SUBSCRIBER, PROFILE)
  h.service.unsubscribe(SUBSCRIBER, PROFILE)
  await assert.rejects(second, GitCancelledError)
  assert.equal(h.service.hasSubscribers(), false)

  h.service.requestRefresh(PROFILE)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(h.calls.length, 0, 'no git process may run after the panel was closed')
})

test('a later open of the same profile still works after a cancelled one', { skip }, async (t) => {
  const h = await harness(t, (f, project) => f.plain(project, 'init', '-q'))
  const first = h.service.subscribe(SUBSCRIBER, PROFILE)
  h.service.unsubscribeAll(SUBSCRIBER)
  await assert.rejects(first, GitCancelledError)
  const view = await h.service.subscribe(SUBSCRIBER, PROFILE)
  assert.equal(repoAt(view, '.')?.state, 'ready')
})

test('the status summary follows a branch change even when the file list does not change', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { f.plain(project, 'init', '-q'); writeFileSync(join(project, 'a.txt'), 'x\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'init') })
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  const before = await h.service.getStatus(SUBSCRIBER, PROFILE, repo.id)
  assert.equal(before.summary.branch, 'main')
  h.fixture.plain(h.project, 'checkout', '-q', '-b', 'second-branch')
  const after = await h.service.getStatus(SUBSCRIBER, PROFILE, repo.id)
  assert.equal(after.summary.branch, 'second-branch')
  assert.equal(after.generation, before.generation, 'entry ids stay valid when the file list is unchanged')
})

test('a setting too long to have been shown in full cannot be trusted, even if asked directly', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { f.plain(project, 'init', '-q'); f.plain(project, 'config', 'core.sshCommand', `ssh${' '.repeat(9_000)}-i key`) })
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  assert.equal(repo.state, 'needs-review')
  assert.ok((repo.reviewItems[0]?.value.length ?? 0) > 8_000)
  await assert.rejects(h.service.trust(SUBSCRIBER, PROFILE, repo.id, repo.configHash!), /too long to review/)
  assert.equal(repoAt(await h.service.rescan(SUBSCRIBER, PROFILE), '.')?.state, 'needs-review', 'still not trusted')
  assert.equal(await h.trustStore.isTrusted(realpathSync.native(h.project), repo.configHash!), false)
})

// ---- writes: stage, unstage, commit ----------------------------------------------------------------------------

const idOf = (status: GitRepoStatusView, path: string): string => {
  const entry = [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted].find(item => item.path === path)
  if (!entry) throw new Error(`no entry for ${path}: ${JSON.stringify([...status.staged, ...status.unstaged, ...status.untracked].map(item => item.path))}`)
  return entry.id
}

async function open(h: Harness): Promise<{ repoId: string; status: () => Promise<GitRepoStatusView> }> {
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  return { repoId: repo.id, status: () => h.service.getStatus(SUBSCRIBER, PROFILE, repo.id) }
}

const committed = (f: GitFixture, project: string, files: Record<string, string>): void => {
  f.plain(project, 'init', '-q')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text)
  f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'init')
}

test('staging moves files, a new folder and a deletion into the index and leaves the files alone', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n', 'b.txt': 'bee\n' })
    writeFileSync(join(project, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(project, 'new.txt'), 'n\n')
    mkdirSync(join(project, 'newdir')); writeFileSync(join(project, 'newdir', 'x.txt'), 'x\n')
    rmSync(join(project, 'b.txt'))
  })
  const { repoId, status } = await open(h)
  const before = await status()
  const result = await h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(before, 'a.txt'), idOf(before, 'new.txt'), idOf(before, 'newdir/'), idOf(before, 'b.txt')], before.generation)
  assert.equal(result.ok, true, result.message)
  assert.match(result.message, /Staged 4 files/)
  const after = result.status!
  assert.deepEqual(after.staged.map(item => item.path).sort(), ['a.txt', 'b.txt', 'new.txt', 'newdir/x.txt'])
  assert.equal(after.unstaged.length + after.untracked.length, 0)
  assert.equal(readFileSync(join(h.project, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the working file is untouched')
  assert.equal(existsSync(join(h.project, 'b.txt')), false, 'a staged deletion stays deleted')
})

test('unstaging puts files back where they were without touching their contents', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'changed\n'); writeFileSync(join(project, 'new.txt'), 'n\n')
    f.plain(project, 'add', '.')
  })
  const { repoId, status } = await open(h)
  const before = await status()
  assert.equal(before.staged.length, 2)
  const result = await h.service.unstage(SUBSCRIBER, PROFILE, repoId, before.staged.map(item => item.id), before.generation)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(result.status!.unstaged.map(item => item.path), ['a.txt'])
  assert.deepEqual(result.status!.untracked.map(item => item.path), ['new.txt'])
  assert.equal(result.status!.staged.length, 0)
  assert.equal(readFileSync(join(h.project, 'a.txt'), 'utf8'), 'changed\n')
})

test('a file named like a glob stages only itself, and a leading dash is just a name', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'seed.txt': 's\n' })
    for (const name of ['a.ts', 'b.ts', '[a].ts', '-dash.ts']) writeFileSync(join(project, name), 'x\n')
  })
  const { repoId, status } = await open(h)
  const before = await status()
  const result = await h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(before, '[a].ts'), idOf(before, '-dash.ts')], before.generation)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(result.status!.staged.map(item => item.path).sort(), ['-dash.ts', '[a].ts'])
  assert.deepEqual(result.status!.untracked.map(item => item.path).sort(), ['a.ts', 'b.ts'], 'a.ts and b.ts were not swept up by the glob')
})

test('unstaging a staged rename restores both the old and the new path', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'old.txt': 'content that is long enough to be detected as a rename\n' })
    f.plain(project, 'mv', 'old.txt', 'renamed.txt')
  })
  const { repoId, status } = await open(h)
  const before = await status()
  assert.equal(before.staged[0]?.kind, 'renamed')
  const result = await h.service.unstage(SUBSCRIBER, PROFILE, repoId, [before.staged[0]!.id], before.generation)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.status!.staged.length, 0)
  assert.deepEqual(result.status!.unstaged.map(item => item.path), ['old.txt'])
  assert.deepEqual(result.status!.untracked.map(item => item.path), ['renamed.txt'])
})

test('a repository with no commits can stage and unstage', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { f.plain(project, 'init', '-q'); writeFileSync(join(project, 'first.txt'), 'hi\n') })
  const { repoId, status } = await open(h)
  let current = await status()
  const staged = await h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(current, 'first.txt')], current.generation)
  assert.equal(staged.ok, true, staged.message)
  assert.deepEqual(staged.status!.staged.map(item => item.path), ['first.txt'])
  current = staged.status!
  const unstaged = await h.service.unstage(SUBSCRIBER, PROFILE, repoId, [idOf(current, 'first.txt')], current.generation)
  assert.equal(unstaged.ok, true, unstaged.message)
  assert.deepEqual(unstaged.status!.untracked.map(item => item.path), ['first.txt'])
  assert.equal(readFileSync(join(h.project, 'first.txt'), 'utf8'), 'hi\n')
})

test('a request that quotes an old file list is refused, and so is one with nothing to do', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { committed(f, project, { 'a.txt': 'one\n' }); writeFileSync(join(project, 'a.txt'), 'two\n') })
  const { repoId, status } = await open(h)
  const before = await status()
  writeFileSync(join(h.project, 'extra.txt'), 'x\n')
  await status()
  await assert.rejects(h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(before, 'a.txt')], before.generation), GitStaleError)
  await assert.rejects(h.service.stage(SUBSCRIBER, PROFILE, repoId, ['e999-0'], 999), GitStaleError)
  const current = await status()
  const staged = await h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(current, 'a.txt')], current.generation)
  const again = staged.status!
  await assert.rejects(h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(again, 'a.txt')], again.generation), /nothing to stage/)
  await assert.rejects(h.service.unstage(SUBSCRIBER, PROFILE, repoId, [idOf(again, 'extra.txt')], again.generation), /nothing to unstage/)
})

test('two writes queued on one repository both happen, one after the other', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { committed(f, project, { 'seed.txt': 's\n' }); writeFileSync(join(project, 'one.txt'), '1\n'); writeFileSync(join(project, 'two.txt'), '2\n') })
  const { repoId, status } = await open(h)
  const before = await status()
  const first = h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(before, 'one.txt')], before.generation)
  // The second was composed from the same file list; by the time it runs the first has changed it, so it is refused as stale.
  const second = h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(before, 'two.txt')], before.generation)
  assert.equal((await first).ok, true)
  await assert.rejects(second, GitStaleError)
  const current = await status()
  assert.deepEqual(current.staged.map(item => item.path), ['one.txt'])
  const again = await h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(current, 'two.txt')], current.generation)
  assert.deepEqual(again.status!.staged.map(item => item.path).sort(), ['one.txt', 'two.txt'])
})

test('another process holding index.lock is waited for, then reported, and the lock is never deleted', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { committed(f, project, { 'a.txt': 'one\n' }); writeFileSync(join(project, 'new.txt'), 'n\n') }, { lockWaitMs: 1_500, lockPollMs: 100 })
  const { repoId, status } = await open(h)
  const lock = join(h.project, '.git', 'index.lock')
  writeFileSync(lock, '')
  const before = await status()
  setTimeout(() => rmSync(lock, { force: true }), 600)
  const released = await h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(before, 'new.txt')], before.generation)
  assert.equal(released.ok, true, `${released.reason}: ${released.message}`)

  writeFileSync(join(h.project, 'two.txt'), '2\n')
  const next = await status()
  writeFileSync(lock, '')
  const started = Date.now()
  const blocked = await h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(next, 'two.txt')], next.generation)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'busy')
  assert.match(blocked.message, /Another Git process/)
  assert.ok(Date.now() - started >= 1_400, 'it waited before giving up')
  assert.equal(existsSync(lock), true, 'a lock that is not ours is never removed')
})

test('a commit records exactly the message, whatever it contains, and clears the staged list', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { committed(f, project, { 'a.txt': 'one\n' }); writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.') })
  const { repoId, status } = await open(h)
  const before = await status()
  const message = '-feat: dash first\n\nBody with 名前, "quotes", $(echo no) and a # not a comment\n'
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, message, before.generation, null)
  assert.equal(result.ok, true, `${result.reason}: ${result.message}`)
  assert.match(result.message, /^Committed [0-9a-f]{7}: -feat: dash first$/)
  assert.equal(result.commit?.subject, '-feat: dash first')
  assert.equal(result.status!.staged.length, 0)
  assert.equal(h.fixture.plain(h.project, 'log', '-1', '--format=%B').trim(), message.trim())
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '2')
})

test('a commit with nothing staged, an empty message or unresolved conflicts does not happen', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { committed(f, project, { 'a.txt': 'one\n' }); writeFileSync(join(project, 'a.txt'), 'two\n') })
  const { repoId, status } = await open(h)
  const before = await status()
  const none = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', before.generation, null)
  assert.deepEqual([none.ok, none.reason], [false, 'nothing-staged'])
  await assert.rejects(h.service.commit(SUBSCRIBER, PROFILE, repoId, '   \n', before.generation, null), /commit message/)
  await assert.rejects(h.service.commit(SUBSCRIBER, PROFILE, repoId, 'a\0b', before.generation, null), /not valid/)
  await assert.rejects(h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', before.generation + 5, null), GitStaleError)
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1')
})

test('unresolved conflicts block a commit', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'base\n' })
    f.plain(project, 'checkout', '-q', '-b', 'side'); writeFileSync(join(project, 'a.txt'), 'side\n'); f.plain(project, 'commit', '-q', '-am', 'side')
    f.plain(project, 'checkout', '-q', 'main'); writeFileSync(join(project, 'a.txt'), 'main\n'); f.plain(project, 'commit', '-q', '-am', 'main')
    try { f.plain(project, 'merge', 'side') } catch { /* the conflict is the point */ }
  })
  const { repoId, status } = await open(h)
  const before = await status()
  assert.equal(before.conflicted.length, 1)
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'merge', before.generation, null)
  assert.deepEqual([result.ok, result.reason], [false, 'conflicts'])
})

test('a commit asks to configure git when it does not know who the author is', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { committed(f, project, { 'a.txt': 'one\n' }); writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.') })
  writeFileSync(join(h.fixture.root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n')
  const { repoId, status } = await open(h)
  const before = await status()
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'message', before.generation, null)
  assert.deepEqual([result.ok, result.reason], [false, 'identity-missing'])
  assert.match(result.message, /git config --global user\.name/)
  assert.match(result.message, /git config --global user\.email/)
  assert.equal(result.status!.staged.length, 1, 'nothing was committed or unstaged')
})

const hookFile = (project: string, name: string, body: string): void => {
  mkdirSync(join(project, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(project, '.git', 'hooks', name), `#!/bin/sh\n${body}\n`)
}

test('hooks a commit would run need approval of their exact contents, once per change', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-hook-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
    hookFile(project, 'pre-commit', `echo ran > "${shellPath(marker)}"`)
    writeFileSync(join(project, '.git', 'hooks', 'commit-msg.sample'), '#!/bin/sh\nexit 1\n')
  })
  const { repoId, status } = await open(h)
  let current = await status()
  const asked = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'first', current.generation, null)
  assert.deepEqual([asked.ok, asked.reason, asked.hooks], [false, 'hooks-need-approval', ['pre-commit']], 'the .sample file is not a hook')
  assert.match(asked.hooksHash ?? '', /^[0-9a-f]{64}$/)
  assert.equal(existsSync(marker), false, 'nothing ran before approval')

  const wrong = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'first', current.generation, 'f'.repeat(64))
  assert.equal(wrong.reason, 'hooks-need-approval', 'an approval of something else is not an approval')
  assert.equal(existsSync(marker), false)

  const approved = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'first', current.generation, asked.hooksHash)
  assert.equal(approved.ok, true, `${approved.reason}: ${approved.message}`)
  assert.equal(existsSync(marker), true, 'the approved hook ran')
  assert.equal(await h.trustStore.areHooksApproved(realpathSync.native(h.project), asked.hooksHash!), true)

  // Approved hooks are remembered: the next commit needs no new approval.
  rmSync(marker, { force: true })
  writeFileSync(join(h.project, 'a.txt'), 'three\n'); h.fixture.plain(h.project, 'add', '.')
  current = await status()
  assert.equal((await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'second', current.generation, null)).ok, true)
  assert.equal(existsSync(marker), true)

  // Editing a hook is a new question.
  hookFile(h.project, 'pre-commit', `echo changed > "${shellPath(marker)}"`)
  rmSync(marker, { force: true })
  writeFileSync(join(h.project, 'a.txt'), 'four\n'); h.fixture.plain(h.project, 'add', '.')
  current = await status()
  const changed = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'third', current.generation, null)
  assert.equal(changed.reason, 'hooks-need-approval')
  assert.notEqual(changed.hooksHash, asked.hooksHash)
  assert.equal(existsSync(marker), false)
})

test('a failing hook blocks the commit, its output is shown and streamed, and nothing is committed', { skip }, async (t) => {
  const progress: string[] = []
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
    hookFile(project, 'pre-commit', 'echo "lint: missing semicolon" >&2\nexit 1')
  }, { onProgress: (_subscriber, _profile, event) => { progress.push(`${event.operation}:${event.stream}:${event.text}`) } })
  const { repoId, status } = await open(h)
  const current = await status()
  const hooks = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'try', current.generation, null)
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'try', current.generation, hooks.hooksHash)
  assert.deepEqual([result.ok, result.reason], [false, 'failed'])
  assert.match(result.output, /lint: missing semicolon/)
  assert.ok(progress.some(line => /^commit:stderr:.*lint: missing semicolon/s.test(line)), `streamed: ${JSON.stringify(progress)}`)
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed')
  assert.equal(result.status!.staged.length, 1, 'the file is still staged for another try')
})

test('Cancel stops a commit that is waiting on a slow hook, and says what to check', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-hook-cancel-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const lines: string[] = []
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
    hookFile(project, 'pre-commit', `echo started\nsleep 4\necho finished > "${shellPath(marker)}"`)
  }, { onProgress: (_subscriber, _profile, event) => { lines.push(event.text) } })
  const { repoId, status } = await open(h)
  const current = await status()
  const hooks = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'slow', current.generation, null)
  const pending = h.service.commit(SUBSCRIBER, PROFILE, repoId, 'slow', current.generation, hooks.hooksHash)
  await waitFor(() => lines.some(line => line.includes('started')))
  const began = Date.now()
  h.service.cancel(SUBSCRIBER, PROFILE, repoId)
  const result = await pending
  assert.deepEqual([result.ok, result.reason], [false, 'cancelled'])
  assert.match(result.message, /index\.lock/)
  assert.ok(Date.now() - began < 3_500, 'it returned well before the hook would have finished')
  await new Promise(resolve => setTimeout(resolve, 4_500))
  assert.equal(existsSync(marker), false, 'the hook was stopped, not left running')
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1')
})

test('writes are refused for a repository that has not been trusted, and cannot start for an unknown one', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { f.plain(project, 'init', '-q'); f.plain(project, 'config', 'core.sshCommand', 'ssh -i k'); writeFileSync(join(project, 'a.txt'), 'x\n') })
  const repo = repoAt(await h.service.subscribe(SUBSCRIBER, PROFILE), '.')!
  assert.equal(repo.state, 'needs-review')
  await assert.rejects(h.service.stage(SUBSCRIBER, PROFILE, repo.id, ['e1-0'], 1), /not available/)
  await assert.rejects(h.service.commit(SUBSCRIBER, PROFILE, repo.id, 'm', 1, null), /not available/)
  await assert.rejects(h.service.stage(SUBSCRIBER, PROFILE, 'repo-999', ['e1-0'], 1), GitStaleError)
})

test('isIndexLockFailure recognises git\'s lock message and nothing else', () => {
  const run = (exitCode: number, stderr: string): GitRunResult => ({ exitCode, stdout: Buffer.alloc(0), stderr, stdoutTruncated: false, timedOut: false, cancelled: false, durationMs: 1 })
  assert.equal(isIndexLockFailure(run(128, "fatal: Unable to create 'C:/r/.git/index.lock': File exists.\n\nAnother git process seems to be running")), true)
  assert.equal(isIndexLockFailure(run(0, "warning: index.lock File exists (but it worked)")), false)
  assert.equal(isIndexLockFailure(run(1, 'error: pathspec did not match')), false)
})
