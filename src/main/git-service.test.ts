import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  /** Every command the runner was given, with its options. */
  runs: GitRunOptions[]
  trustStore: GitTrustStore
  project: string
  /** Runs the action once, right after the first commit attempt fails on the index lock and before the next attempt is prepared. */
  whenCommitBlocked(action: () => void): void
}

/** Wraps the real runner so tests can see which git commands ran. */
function countingRunner(fixture: GitFixture, calls: string[], afterRun?: (options: GitRunOptions, result: GitRunResult) => void): GitRunner {
  return {
    run: (options: GitRunOptions): Promise<GitRunResult> => {
      calls.push(String(options.args[0]))
      return fixture.runner.run(options).then(result => { afterRun?.(options, result); return result })
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
  const runs: GitRunOptions[] = []
  let blocked: (() => void) | null = null
  const afterRun = (options: GitRunOptions, result: GitRunResult): void => {
    runs.push(options)
    if (blocked && options.args[0] === 'commit' && isIndexLockFailure(result)) { const action = blocked; blocked = null; action() }
  }
  const trustStore = new GitTrustStore(join(fixture.root, 'git-trust.json'))
  const service = new GitService({
    getRuntime: async () => ({ runner: countingRunner(fixture, calls, afterRun), executable: fixture.git }),
    trustStore,
    resolveProject: (profileId) => profileId === PROFILE ? project : null,
    onChanged: (_subscriber, _profile, view) => { events.push(view) },
    debounceMs: 20,
    fallbackMs: 60_000,
    ...extra,
  })
  t.after(async () => { await service.dispose(); fixture.cleanup() })
  return { fixture, service, events, calls, runs, trustStore, project, whenCommitBlocked: action => { blocked = action } }
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

// ---- review fixes on phase 2 ------------------------------------------------------------------------------------

test('replacing an approved oversized hook with different contents of the same size needs a new approval', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-hook-big-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const hookText = (word: string): string => `#!/bin/sh\n#${'x'.repeat(524_300)}\necho ${word} >> "${shellPath(marker)}"\n`
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.git', 'hooks', 'pre-commit'), hookText('OLD'))
  })
  assert.ok(hookText('OLD').length > 512 * 1024, 'the hook is larger than the old hashing limit')
  const { repoId, status } = await open(h)
  let current = await status()
  const asked = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'first', current.generation, null)
  assert.equal(asked.reason, 'hooks-need-approval')
  assert.equal((await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'first', current.generation, asked.hooksHash)).ok, true)
  assert.equal(readFileSync(marker, 'utf8').trim(), 'OLD')

  // Same size, different contents: the replacement must not inherit the approval.
  writeFileSync(join(h.project, '.git', 'hooks', 'pre-commit'), hookText('NEW'))
  assert.equal(hookText('NEW').length, hookText('OLD').length)
  writeFileSync(join(h.project, 'a.txt'), 'three\n'); h.fixture.plain(h.project, 'add', '.')
  current = await status()
  const again = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'second', current.generation, null)
  assert.equal(again.reason, 'hooks-need-approval', 'a same-size edit is a new question')
  assert.notEqual(again.hooksHash, asked.hooksHash)
  assert.equal(readFileSync(marker, 'utf8').trim(), 'OLD', 'the replacement did not run')
})

test('a hook that cannot be fully checked can never be approved, and a commit refuses to run it', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-hook-unverifiable-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n#${'x'.repeat(2_000)}\necho ran > "${shellPath(marker)}"\n`)
  }, { maxHookBytes: 1_000 })
  const { repoId, status } = await open(h)
  const current = await status()
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'try', current.generation, 'a'.repeat(64))
  assert.deepEqual([result.ok, result.reason], [false, 'hooks-unverifiable'])
  assert.match(result.message, /pre-commit.*too large to check/s)
  assert.equal(existsSync(marker), false, 'the hook did not run')
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed')
})

test('a commit refuses files that were staged after the panel last looked, and so does restaging different content', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
  })
  const { repoId, status } = await open(h)
  const seen = await status()
  assert.deepEqual(seen.staged.map(item => item.path), ['a.txt'])

  // Another program stages an unseen file without the panel being told: the cached list is now out of date.
  writeFileSync(join(h.project, 'not-reviewed.txt'), 'x\n'); h.fixture.plain(h.project, 'add', 'not-reviewed.txt')
  await assert.rejects(h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', seen.generation, null), /staged files changed/)
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed')

  // The same file name with different staged content is a different list too.
  const second = await status()
  writeFileSync(join(h.project, 'a.txt'), 'three\n'); h.fixture.plain(h.project, 'add', 'a.txt')
  await assert.rejects(h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', second.generation, null), GitStaleError)
  const third = await status()
  assert.notEqual(third.generation, second.generation, 'the file-list version covers the staged content')
  const ok = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', third.generation, null)
  assert.equal(ok.ok, true, `${ok.reason}: ${ok.message}`)
  assert.equal(h.fixture.plain(h.project, 'show', '--name-only', '--format=', 'HEAD').trim().split(/\r?\n/).sort().join(','), 'a.txt,not-reviewed.txt')
})

test('staging after an unseen external change is refused for the same reason', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { committed(f, project, { 'a.txt': 'one\n' }); writeFileSync(join(project, 'a.txt'), 'two\n') })
  const { repoId, status } = await open(h)
  const seen = await status()
  writeFileSync(join(h.project, 'other.txt'), 'x\n'); h.fixture.plain(h.project, 'add', 'other.txt')
  await assert.rejects(h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(seen, 'a.txt')], seen.generation), GitStaleError)
})

test('a commit also notices a change that lands while it waits for the index lock', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
  }, { lockWaitMs: 5_000, lockPollMs: 100 })
  const { repoId, status } = await open(h)
  const seen = await status()
  // git cannot stage while the lock is held, so the other tool's finished index is prepared on the side and swapped in while the lock is still held.
  const index = join(h.project, '.git', 'index')
  const sideIndex = join(h.project, '.git', 'index.side')
  copyFileSync(index, sideIndex)
  writeFileSync(join(h.project, 'late.txt'), 'x\n')
  execFileSync(h.fixture.git.path, ['add', 'late.txt'], { cwd: h.project, env: { ...h.fixture.env, GIT_INDEX_FILE: sideIndex }, stdio: 'ignore' })
  rmSync(join(h.project, 'late.txt'))
  const lock = join(h.project, '.git', 'index.lock')
  writeFileSync(lock, '')
  // The other tool finishes its change and lets go of the lock only after the commit has really failed on the lock once.
  h.whenCommitBlocked(() => { writeFileSync(join(h.project, 'late.txt'), 'x\n'); copyFileSync(sideIndex, index); rmSync(lock, { force: true }) })
  await assert.rejects(h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', seen.generation, null), /staged files changed while the commit was waiting/)
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed')
})

test('before the first commit, a file staged and then edited again can still be unstaged, and the edit is kept', { skip }, async (t) => {
  const h = await harness(t, (f, project) => { f.plain(project, 'init', '-q'); writeFileSync(join(project, 'a.txt'), 'first\n') })
  const { repoId, status } = await open(h)
  let current = await status()
  const staged = await h.service.stage(SUBSCRIBER, PROFILE, repoId, [idOf(current, 'a.txt')], current.generation)
  assert.equal(staged.ok, true, staged.message)
  writeFileSync(join(h.project, 'a.txt'), 'second, edited after staging\n')
  current = await status()
  const unstaged = await h.service.unstage(SUBSCRIBER, PROFILE, repoId, [idOf(current, 'a.txt')], current.generation)
  assert.equal(unstaged.ok, true, `${unstaged.reason}: ${unstaged.message} ${unstaged.output}`)
  assert.equal(unstaged.status!.staged.length, 0)
  assert.deepEqual(unstaged.status!.untracked.map(item => item.path), ['a.txt'])
  assert.equal(readFileSync(join(h.project, 'a.txt'), 'utf8'), 'second, edited after staging\n', 'the working file keeps the edit')
})

// ---- the lock wait must not outlive the checks that were made before it --------------------------------------------

const lockWaitHarness = (t: test.TestContext, setup: (f: GitFixture, project: string) => void) =>
  harness(t, setup, { lockWaitMs: 5_000, lockPollMs: 100 })

test('a hook swapped while the commit waits for the index lock is not run on the old approval', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-hook-lockwait-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await lockWaitHarness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
    hookFile(project, 'pre-commit', `echo OLD >> "${shellPath(marker)}"`)
  })
  const { repoId, status } = await open(h)
  const current = await status()
  const asked = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, null)
  assert.equal(asked.reason, 'hooks-need-approval')

  // The person approves OLD. Something else holds the index lock, so the commit waits and retries.
  const lock = join(h.project, '.git', 'index.lock')
  writeFileSync(lock, '')
  // The change lands, and the lock goes, only after the commit has really failed on the lock once.
  h.whenCommitBlocked(() => { hookFile(h.project, 'pre-commit', `echo NEW >> "${shellPath(marker)}"`); rmSync(lock, { force: true }) })
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, asked.hooksHash)
  assert.deepEqual([result.ok, result.reason], [false, 'hooks-need-approval'], 'the changed hook asks again')
  assert.notEqual(result.hooksHash, asked.hooksHash)
  assert.equal(existsSync(marker), false, 'neither the old nor the new hook ran')
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed')
})

test('a hook that appears while the commit waits for the lock needs approval too', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-hook-appeared-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await lockWaitHarness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
  })
  const { repoId, status } = await open(h)
  const current = await status()
  const lock = join(h.project, '.git', 'index.lock')
  writeFileSync(lock, '')
  h.whenCommitBlocked(() => { hookFile(h.project, 'pre-commit', `echo ran >> "${shellPath(marker)}"`); rmSync(lock, { force: true }) })
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, null)
  assert.deepEqual([result.ok, result.reason, result.hooks], [false, 'hooks-need-approval', ['pre-commit']])
  assert.equal(existsSync(marker), false, 'the new hook did not run')
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1')
})

test('repository settings that start naming a program while the commit waits stop it', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-hook-settings-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await lockWaitHarness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
    hookFile(project, 'pre-commit', `echo ran >> "${shellPath(marker)}"`)
  })
  const { repoId, status } = await open(h)
  const current = await status()
  const asked = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, null)
  const lock = join(h.project, '.git', 'index.lock')
  writeFileSync(lock, '')
  h.whenCommitBlocked(() => { h.fixture.plain(h.project, 'config', 'core.sshCommand', 'ssh -i somewhere'); rmSync(lock, { force: true }) })
  await assert.rejects(h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, asked.hooksHash), /need review|not available/)
  assert.equal(existsSync(marker), false, 'the approved hook did not run once the settings needed review again')
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '1')
})

test('a commit whose hooks stay approved still goes through after waiting for a lock', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-hook-ok-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await lockWaitHarness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', '.')
    hookFile(project, 'pre-commit', `echo ran >> "${shellPath(marker)}"`)
  })
  const { repoId, status } = await open(h)
  const current = await status()
  const asked = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, null)
  const lock = join(h.project, '.git', 'index.lock')
  writeFileSync(lock, '')
  h.whenCommitBlocked(() => rmSync(lock, { force: true }))
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, asked.hooksHash)
  assert.equal(result.ok, true, `${result.reason}: ${result.message}`)
  assert.equal(existsSync(marker), true)
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), '2')
})

// ---- staged entries the panel does not list ------------------------------------------------------------------------------

test('a commit is refused while a staged submodule update is in the index but not in the list', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'a.txt': 'one\n' })
    f.plain(project, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`)
    f.plain(project, 'commit', '-q', '-m', 'add submodule pointer')
    f.plain(project, 'update-index', '--cacheinfo', `160000,${'2'.repeat(40)},sub`)
    writeFileSync(join(project, 'a.txt'), 'two\n'); f.plain(project, 'add', 'a.txt')
  })
  const { repoId, status } = await open(h)
  const current = await status()
  assert.deepEqual(current.staged.map(item => item.path), ['a.txt'], 'the list does not show the submodule')
  const before = h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim()
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, null)
  assert.deepEqual([result.ok, result.reason], [false, 'hidden-staged'])
  assert.match(result.message, /submodule changes.*sub/)
  assert.equal(h.fixture.plain(h.project, 'rev-list', '--count', 'HEAD').trim(), before, 'nothing was committed')

  // Once it is unstaged the commit goes through.
  h.fixture.plain(h.project, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},sub`)
  const fresh = await status()
  const done = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', fresh.generation, null)
  assert.equal(done.ok, true, `${done.reason}: ${done.message}`)
})

test('a staged rename is listed under both names, so a commit with it is not refused', { skip }, async (t) => {
  const h = await harness(t, (f, project) => {
    committed(f, project, { 'old.txt': 'content that is long enough to be detected as a rename\n' })
    f.plain(project, 'mv', 'old.txt', 'renamed.txt')
  })
  const { repoId, status } = await open(h)
  const current = await status()
  const result = await h.service.commit(SUBSCRIBER, PROFILE, repoId, 'msg', current.generation, null)
  assert.equal(result.ok, true, `${result.reason}: ${result.message}`)
})

// ---- fetch, pull and push ---------------------------------------------------------------------------------------------------

/** A bare remote with the project's branch pushed to it, and a clone of it that stands for a colleague. */
function withRemote(f: GitFixture, project: string): void {
  const remote = join(f.root, 'remote.git')
  mkdirSync(remote)
  f.plain(remote, 'init', '-q', '--bare')
  f.plain(project, 'remote', 'add', 'origin', remote)
  f.plain(project, 'push', '-q', '-u', 'origin', 'main')
  f.plain(f.root, 'clone', '-q', remote, 'other')
}

/** The colleague commits a file and pushes it. */
function colleaguePushes(f: GitFixture, name: string, text: string): void {
  const other = join(f.root, 'other')
  writeFileSync(join(other, name), text)
  f.plain(other, 'add', '.'); f.plain(other, 'commit', '-q', '-m', `add ${name}`); f.plain(other, 'push', '-q', 'origin', 'HEAD')
}

const remoteHead = (h: Harness, branch = 'main'): string => h.fixture.plain(join(h.fixture.root, 'remote.git'), 'rev-parse', `refs/heads/${branch}`).trim()
const localHead = (h: Harness): string => h.fixture.plain(h.project, 'rev-parse', 'HEAD').trim()

const withOrigin = (t: test.TestContext, extra?: (f: GitFixture, project: string) => void, options: Partial<GitServiceOptions> = {}) =>
  harness(t, (f, project) => { committed(f, project, { 'a.txt': 'one\n' }); withRemote(f, project); extra?.(f, project) }, options)

test('fetch brings in what the remote has, tells how far behind the branch is, and leaves the files alone', { skip }, async (t) => {
  const h = await withOrigin(t)
  const { repoId, status } = await open(h)
  assert.equal((await status()).summary.behind, 0)
  colleaguePushes(h.fixture, 'theirs.txt', 'x\n')
  const result = await h.service.fetch(SUBSCRIBER, PROFILE, repoId)
  assert.equal(result.ok, true, `${result.reason}: ${result.message}`)
  assert.equal(result.message, 'Fetched origin.')
  assert.equal(result.status!.summary.behind, 1)
  assert.equal(existsSync(join(h.project, 'theirs.txt')), false, 'a fetch changes no file')
})

test('pull fast-forwards to the upstream and nothing else', { skip }, async (t) => {
  const h = await withOrigin(t)
  const { repoId } = await open(h)
  colleaguePushes(h.fixture, 'theirs.txt', 'x\n')
  const result = await h.service.pull(SUBSCRIBER, PROFILE, repoId)
  assert.equal(result.ok, true, `${result.reason}: ${result.message}`)
  assert.match(result.message, /Fast-forwarded main/)
  assert.equal(readFileSync(join(h.project, 'theirs.txt'), 'utf8').replace(/\r/g, ''), 'x\n')
  assert.equal(result.status!.summary.behind, 0)
  const again = await h.service.pull(SUBSCRIBER, PROFILE, repoId)
  assert.deepEqual([again.ok, again.message], [true, 'Already up to date.'])
})

test('a pull that cannot fast-forward changes nothing and says so', { skip }, async (t) => {
  const h = await withOrigin(t, (f, project) => {
    writeFileSync(join(project, 'mine.txt'), 'm\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'mine')
  })
  const { repoId } = await open(h)
  colleaguePushes(h.fixture, 'theirs.txt', 'x\n')
  const before = localHead(h)
  const result = await h.service.pull(SUBSCRIBER, PROFILE, repoId)
  assert.deepEqual([result.ok, result.reason], [false, 'diverged'])
  assert.match(result.message, /Nothing was changed/)
  assert.equal(localHead(h), before)
  assert.equal(existsSync(join(h.project, 'theirs.txt')), false)
})

test('pull does not run the repository\'s hooks', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-pull-hook-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await withOrigin(t, (f, project) => {
    for (const name of ['post-merge', 'post-checkout', 'reference-transaction']) hookFile(project, name, `echo ${name} >> "${shellPath(marker)}"`)
  })
  const { repoId } = await open(h)
  colleaguePushes(h.fixture, 'theirs.txt', 'x\n')
  const result = await h.service.pull(SUBSCRIBER, PROFILE, repoId)
  assert.equal(result.ok, true, `${result.reason}: ${result.message}`)
  assert.equal(existsSync(marker), false, 'no hook ran')
})

test('push sends the branch to its upstream', { skip }, async (t) => {
  const h = await withOrigin(t)
  const { repoId } = await open(h)
  writeFileSync(join(h.project, 'mine.txt'), 'm\n'); h.fixture.plain(h.project, 'add', '.'); h.fixture.plain(h.project, 'commit', '-q', '-m', 'mine')
  const result = await h.service.push(SUBSCRIBER, PROFILE, repoId, null)
  assert.equal(result.ok, true, `${result.reason}: ${result.message}`)
  assert.equal(result.message, 'Pushed main to origin/main.')
  assert.equal(remoteHead(h), localHead(h))
  assert.equal(result.status!.summary.ahead, 0)
  const again = await h.service.push(SUBSCRIBER, PROFILE, repoId, null)
  assert.deepEqual([again.ok, again.message], [true, 'Everything is already up to date.'])
})

test('a push the remote would have to overwrite is refused, even when the repository configures a forced push', { skip }, async (t) => {
  const h = await withOrigin(t, (f, project) => {
    writeFileSync(join(project, 'mine.txt'), 'm\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'mine')
    f.plain(project, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*')
  })
  const { repoId } = await open(h)
  colleaguePushes(h.fixture, 'theirs.txt', 'x\n')
  const theirs = remoteHead(h)
  const result = await h.service.push(SUBSCRIBER, PROFILE, repoId, null)
  assert.deepEqual([result.ok, result.reason], [false, 'rejected'])
  assert.match(result.message, /never forces/)
  assert.equal(remoteHead(h), theirs, 'the remote kept its own commit')
})

test('a branch with no upstream is only published after the remote is chosen', { skip }, async (t) => {
  const h = await withOrigin(t, (f, project) => {
    f.plain(project, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(project, 'f.txt'), 'f\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'feature work')
  })
  const { repoId } = await open(h)
  const asked = await h.service.push(SUBSCRIBER, PROFILE, repoId, null)
  assert.deepEqual([asked.ok, asked.reason, asked.remotes], [false, 'needs-upstream', ['origin']])
  assert.throws(() => h.fixture.plain(join(h.fixture.root, 'remote.git'), 'rev-parse', '--verify', 'refs/heads/feature'), 'nothing was pushed yet')
  await assert.rejects(h.service.push(SUBSCRIBER, PROFILE, repoId, 'elsewhere'), /not a remote/)
  const done = await h.service.push(SUBSCRIBER, PROFILE, repoId, 'origin')
  assert.equal(done.ok, true, `${done.reason}: ${done.message}`)
  assert.match(done.message, /Published feature to origin/)
  assert.equal(remoteHead(h, 'feature'), localHead(h))
  assert.equal(h.fixture.plain(h.project, 'rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/feature')
})

test('a branch that tracks a differently named branch is not pushed by the panel', { skip }, async (t) => {
  const h = await withOrigin(t, (f, project) => {
    f.plain(project, 'checkout', '-q', '-b', 'feature', '--track', 'origin/main')
    writeFileSync(join(project, 'f.txt'), 'f\n'); f.plain(project, 'add', '.'); f.plain(project, 'commit', '-q', '-m', 'feature work')
  })
  const { repoId } = await open(h)
  const before = remoteHead(h)
  const result = await h.service.push(SUBSCRIBER, PROFILE, repoId, null)
  assert.equal(result.ok, false)
  assert.match(result.message, /differently named branch/)
  assert.equal(remoteHead(h), before)
})

test('pull and push need a branch, fetch does not', { skip }, async (t) => {
  const h = await withOrigin(t, (f, project) => f.plain(project, 'checkout', '-q', '--detach'))
  const { repoId } = await open(h)
  for (const operation of ['pull', 'push'] as const) {
    const result = await (operation === 'pull' ? h.service.pull(SUBSCRIBER, PROFILE, repoId) : h.service.push(SUBSCRIBER, PROFILE, repoId, null))
    assert.deepEqual([result.ok, result.reason], [false, 'detached'], operation)
  }
  assert.equal((await h.service.fetch(SUBSCRIBER, PROFILE, repoId)).ok, true)
})

test('a remote that points at a network share or runs a program is never contacted', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-ext-remote-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await withOrigin(t)
  const { repoId } = await open(h)
  for (const address of ['\\\\attacker.invalid\\share\\r.git', '//attacker.invalid/share/r.git', 'file://attacker.invalid/share/r.git', `ext::sh -c "echo x > ${shellPath(marker)}"`, 'ssh://-oProxyCommand=calc/x']) {
    h.fixture.plain(h.project, 'config', 'remote.origin.url', address)
    for (const result of [await h.service.fetch(SUBSCRIBER, PROFILE, repoId), await h.service.pull(SUBSCRIBER, PROFILE, repoId), await h.service.push(SUBSCRIBER, PROFILE, repoId, null)]) {
      assert.deepEqual([result.ok, result.reason], [false, 'no-remote'], address)
      assert.match(result.message, /will not contact it/)
    }
  }
  assert.equal(h.calls.includes('fetch') || h.calls.includes('push'), false, 'no network command was started')
  assert.equal(existsSync(marker), false)
})

test('a push is refused while the repository has a pre-push hook, which the panel does not run', { skip }, async (t) => {
  const marker = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-prepush-${process.pid}.marker`)
  rmSync(marker, { force: true })
  t.after(() => rmSync(marker, { force: true }))
  const h = await withOrigin(t, (f, project) => hookFile(project, 'pre-push', `echo ran >> "${shellPath(marker)}"`))
  const { repoId } = await open(h)
  writeFileSync(join(h.project, 'mine.txt'), 'm\n'); h.fixture.plain(h.project, 'add', '.'); h.fixture.plain(h.project, 'commit', '-q', '-m', 'mine')
  const before = remoteHead(h)
  const result = await h.service.push(SUBSCRIBER, PROFILE, repoId, null)
  assert.deepEqual([result.ok, result.reason, result.hooks], [false, 'hooks-unsupported', ['pre-push']])
  assert.equal(remoteHead(h), before)
  assert.equal(existsSync(marker), false)
  assert.equal((await h.service.fetch(SUBSCRIBER, PROFILE, repoId)).ok, true, 'a fetch has no hook to skip')
})

/** A local web server that answers every request with `handler`, for the failures that need a real network peer. */
async function serve(t: test.TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ port: number; requests: () => number }> {
  let count = 0
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => { count++; handler(request, response) })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  return { port: (server.address() as AddressInfo).port, requests: () => count }
}

test('a remote that wants credentials fails fast with the terminal hint, and no secret reaches the result or the progress', { skip }, async (t) => {
  const server = await serve(t, (_request, response) => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); response.end() })
  const progress: string[] = []
  const h = await withOrigin(t, (f, project) => f.plain(project, 'config', 'remote.origin.url', `http://someone:hunter2secret@127.0.0.1:${server.port}/r.git`),
    { onProgress: (_subscriber, _profile, event) => { progress.push(event.text) } })
  const { repoId } = await open(h)
  const started = Date.now()
  for (const result of [await h.service.fetch(SUBSCRIBER, PROFILE, repoId), await h.service.pull(SUBSCRIBER, PROFILE, repoId), await h.service.push(SUBSCRIBER, PROFILE, repoId, null)]) {
    assert.deepEqual([result.ok, result.reason], [false, 'auth-required'])
    assert.match(result.message, /Authentication required.*terminal.*git fetch/s)
    assert.equal(`${result.message}${result.output}`.includes('hunter2secret'), false)
  }
  assert.ok(Date.now() - started < 30_000, 'it did not wait for a prompt')
  assert.equal(progress.join('').includes('hunter2secret'), false)
  assert.ok(server.requests() > 0, 'the server really was contacted')
})

test('Cancel stops a fetch that is waiting for a slow remote', { skip }, async (t) => {
  const server = await serve(t, () => { /* never answers */ })
  const h = await withOrigin(t, (f, project) => f.plain(project, 'config', 'remote.origin.url', `http://127.0.0.1:${server.port}/r.git`))
  const { repoId } = await open(h)
  const running = h.service.fetch(SUBSCRIBER, PROFILE, repoId)
  await waitFor(() => server.requests() > 0)
  const started = Date.now()
  h.service.cancel(SUBSCRIBER, PROFILE, repoId)
  const result = await running
  assert.deepEqual([result.ok, result.reason, result.message], [false, 'cancelled', 'Cancelled.'])
  assert.ok(Date.now() - started < 15_000)
})

test('network commands run with prompts off, only the supported transports, and SSH batch mode unless the user has their own SSH command', { skip }, async (t) => {
  const h = await withOrigin(t)
  const { repoId } = await open(h)
  assert.equal((await h.service.fetch(SUBSCRIBER, PROFILE, repoId)).ok, true)
  const first = h.runs.filter(run => run.kind === 'network').at(-1)!
  assert.equal(first.environment?.sshBatchMode, true)
  assert.equal(first.environment?.extra?.GIT_ALLOW_PROTOCOL, 'http:https:ssh:git:file')
  assert.equal(first.disableHooks, true)

  h.fixture.plain(h.project, 'config', '--global', 'core.sshCommand', 'ssh -i somewhere')
  assert.equal((await h.service.fetch(SUBSCRIBER, PROFILE, repoId)).ok, true)
  assert.equal(h.runs.filter(run => run.kind === 'network').at(-1)!.environment?.sshBatchMode, false, 'GIT_SSH_COMMAND would have overridden the user\'s own')
})
