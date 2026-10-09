import assert from 'node:assert/strict'
import { existsSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture, findGitForTests, shellPath } from './fixtures/git-fixture.js'
import type { GitFixture } from './fixtures/git-fixture.js'
import { GitCancelledError, GitService, GitStaleError } from './git-service.js'
import type { GitServiceOptions } from './git-service.js'
import { GitTrustStore } from './git-trust.js'
import type { GitProjectView } from './git-types.js'
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
