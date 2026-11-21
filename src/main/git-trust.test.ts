import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createGitFixture, findGitForTests, shellPath } from './fixtures/git-fixture.js'
import { GitTrustStore, configItemsHash, isBenignConfigItem, parseConfigScan, scanRepoConfig } from './git-trust.js'
import { statusArgs } from './git-commands.js'
import type { GitRunOptions, GitRunner } from './git-runner.js'
import { caseInsensitivePaths, pathKey } from './host-path.js'

/** A repository folder in this platform's spelling, and the same text in lower case. */
const REPO = resolve('/Work/Repo')
const LOWER = REPO.toLowerCase()

const git = await findGitForTests()
const skip = git ? false : 'git is not installed'

test('parseConfigScan reads origin/key/value records and lowercases keys', () => {
  const output = 'file:.git/config\0core.sshCommand\nssh -i k\0file:.git/config\0filter.x.clean\ncat\0'
  assert.deepEqual(parseConfigScan(output), [{ key: 'core.sshcommand', value: 'ssh -i k' }, { key: 'filter.x.clean', value: 'cat' }])
  assert.deepEqual(parseConfigScan(''), [])
})

test('only the standard Git LFS filter and boolean fsmonitor values are benign', () => {
  assert.equal(isBenignConfigItem('filter.lfs.clean', 'git-lfs clean -- %f'), true)
  assert.equal(isBenignConfigItem('filter.lfs.smudge', 'git-lfs smudge -- %f'), true)
  assert.equal(isBenignConfigItem('filter.lfs.process', 'git-lfs filter-process'), true)
  assert.equal(isBenignConfigItem('filter.lfs.required', 'true'), true)
  assert.equal(isBenignConfigItem('filter.lfs.clean', 'git-lfs clean -- %f && evil'), false)
  assert.equal(isBenignConfigItem('filter.lfs.clean', 'sh -c "evil"'), false)
  assert.equal(isBenignConfigItem('filter.evil.clean', 'cat'), false)
  assert.equal(isBenignConfigItem('core.fsmonitor', 'false'), true)
  assert.equal(isBenignConfigItem('core.fsmonitor', 'true'), true)
  assert.equal(isBenignConfigItem('core.fsmonitor', 'echo x > f'), false)
  assert.equal(isBenignConfigItem('core.sshcommand', 'ssh'), false)
})

test('the config hash ignores order and changes with any value', () => {
  const a = { key: 'core.sshcommand', value: 'ssh' }
  const b = { key: 'filter.x.clean', value: 'cat' }
  assert.equal(configItemsHash([a, b]), configItemsHash([b, a]))
  assert.notEqual(configItemsHash([a, b]), configItemsHash([a, { ...b, value: 'dog' }]))
  assert.match(configItemsHash([]), /^[0-9a-f]{64}$/)
})

test('scanRepoConfig lists only settings that can run a program', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const clean = fixture.repo('clean')
  assert.deepEqual((await scanRepoConfig(fixture.runner, clean)).items, [])

  const lfs = fixture.repo('lfs', (d) => {
    fixture.plain(d, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f')
    fixture.plain(d, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f')
    fixture.plain(d, 'config', 'filter.lfs.process', 'git-lfs filter-process')
    fixture.plain(d, 'config', 'filter.lfs.required', 'true')
    fixture.plain(d, 'config', 'core.fsmonitor', 'false')
  })
  assert.deepEqual((await scanRepoConfig(fixture.runner, lfs)).items, [], 'standard LFS settings do not need review')

  const risky = fixture.repo('risky', (d) => {
    fixture.plain(d, 'config', 'core.sshCommand', 'ssh -i k')
    fixture.plain(d, 'config', 'filter.evil.clean', 'cat')
    fixture.plain(d, 'config', 'credential.helper', 'store')
    fixture.plain(d, 'config', 'diff.x.textconv', 'cat')
    fixture.plain(d, 'config', 'include.path', '../elsewhere')
    fixture.plain(d, 'config', 'user.name', 'harmless')
    fixture.plain(d, 'config', 'core.autocrlf', 'true')
  })
  const scan = await scanRepoConfig(fixture.runner, risky)
  assert.deepEqual(scan.items.map(item => item.key).sort(), ['core.sshcommand', 'credential.helper', 'diff.x.textconv', 'filter.evil.clean', 'include.path'])
  // It has an include line nobody accepted, so the scan is held and its hash is not the plain hash of the items.
  assert.equal(scan.includes, 'held')
  assert.equal(scan.ownHash, configItemsHash(scan.items))
  assert.notEqual(scan.hash, scan.ownHash)
})

test('settings that redirect a fetch are reviewed: alternate refs and the repository\'s own http settings', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('redirect', (d) => {
    fixture.plain(d, 'config', 'core.alternateRefsCommand', 'sh -c evil')
    fixture.plain(d, 'config', 'http.proxy', 'http://proxy.invalid:8080')
    fixture.plain(d, 'config', 'http.sslVerify', 'false')
    fixture.plain(d, 'config', 'http.https://example.invalid/.extraHeader', 'X: y')
  })
  const scan = await scanRepoConfig(fixture.runner, repo)
  assert.deepEqual(scan.items.map(item => item.key).sort(), ['core.alternaterefscommand', 'http.https://example.invalid/.extraheader', 'http.proxy', 'http.sslverify'])
  assert.equal(scan.includes, 'none')
})

test('an included file is read only after its include line is accepted, and its settings are then part of the review', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const included = (d: string): string => join(d, 'shared.gitconfig')
  const repo = fixture.repo('includes', (d) => {
    writeFileSync(included(d), '[user]\n\tname = harmless\n')
    fixture.plain(d, 'config', 'include.path', '../shared.gitconfig')
  })
  const store = new GitTrustStore(join(fixture.root, 'includes-trust.json'))

  const held = await scanRepoConfig(fixture.runner, repo, undefined, store)
  assert.equal(held.includes, 'held')
  assert.deepEqual(held.items.map(item => item.key), ['include.path'])
  assert.notEqual(held.hash, configItemsHash(held.items), 'a held scan matches nothing trusted before includes were followed')
  assert.equal(held.ownHash, configItemsHash(held.items))
  assert.equal((await scanRepoConfig(fixture.runner, repo)).includes, 'held', 'no approvals means never followed')

  await store.approveIncludes(repo, held.ownHash)
  const followed = await scanRepoConfig(fixture.runner, repo, undefined, store)
  assert.equal(followed.includes, 'followed')
  assert.deepEqual(followed.items.map(item => item.key), ['include.path'])
  assert.equal(followed.hash, configItemsHash(followed.items))

  // The include line is unchanged; what it brings in is not. That is a new question.
  writeFileSync(included(repo), '[core]\n\tsshCommand = evil\n[http]\n\tproxy = http://proxy.invalid\n')
  const changed = await scanRepoConfig(fixture.runner, repo, undefined, store)
  assert.deepEqual(changed.items.map(item => item.key).sort(), ['core.sshcommand', 'http.proxy', 'include.path'])
  assert.notEqual(changed.hash, followed.hash)

  // A different include line has not been accepted: its file is not read.
  fixture.plain(repo, 'config', 'include.path', '../shared.gitconfig')
  fixture.plain(repo, 'config', '--add', 'include.path', '../other.gitconfig')
  writeFileSync(join(repo, 'other.gitconfig'), '[core]\n\tfsmonitor = evil\n')
  const again = await scanRepoConfig(fixture.runner, repo, undefined, store)
  assert.equal(again.includes, 'held')
  assert.deepEqual([...new Set(again.items.map(item => item.key))], ['include.path'])
  assert.equal(await new GitTrustStore(join(fixture.root, 'includes-trust.json')).areIncludesApproved(repo, held.ownHash), true, 'survives a restart')
})

test('before its include line is accepted, an included file is never opened: one Git cannot even parse changes nothing', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('unparsable', (d) => {
    fixture.plain(d, 'config', 'include.path', '../bad.gitconfig')
    writeFileSync(join(d, 'bad.gitconfig'), '[broken syntax\n')
  })
  // Control: any Git command started in the repository opens the file, whatever it was asked.
  assert.throws(() => fixture.plain(repo, 'config', '--local', '--no-includes', '--get-regexp', 'include'))
  const store = new GitTrustStore(join(fixture.root, 'unparsable-trust.json'))
  const held = await scanRepoConfig(fixture.runner, repo, undefined, store)
  assert.equal(held.includes, 'held')
  assert.deepEqual(held.items, [{ key: 'include.path', value: '../bad.gitconfig' }])
  // Once accepted the file is opened, and a scan that cannot be completed is an error, never "nothing to review".
  await store.approveIncludes(repo, held.ownHash)
  await assert.rejects(scanRepoConfig(fixture.runner, repo, undefined, store), /bad config/)
})

test('a scan that was cut short or failed is an error, not an empty review', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('incomplete', (d) => {
    for (let index = 0; index < 20; index++) fixture.plain(d, 'config', `filter.f${index}.clean`, `program-${index}`)
  })
  assert.equal((await scanRepoConfig(fixture.runner, repo)).items.length, 20)
  const limited = (limit: number): GitRunner => ({ run: (options: GitRunOptions) => fixture.runner.run({ ...options, maxStdoutBytes: limit }) } as unknown as GitRunner)
  await assert.rejects(scanRepoConfig(limited(200), repo), /too large to review/)
  const slow = { run: (options: GitRunOptions) => fixture.runner.run({ ...options, timeoutMs: 1 }) } as unknown as GitRunner
  await assert.rejects(scanRepoConfig(slow, repo), /took too long|cancelled|Could not read/)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(scanRepoConfig(fixture.runner, repo, aborted.signal))
})

test('the worktree config is reviewed when Git reads it, and one that cannot be read is an error', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('worktree-config')
  const file = join(repo, '.git', 'config.worktree')
  writeFileSync(file, '[core]\n\tsshCommand = from-worktree-config\n')
  assert.deepEqual((await scanRepoConfig(fixture.runner, repo)).items, [], 'Git ignores the file while the extension is off, and so does the review')
  fixture.plain(repo, 'config', 'extensions.worktreeConfig', 'true')
  assert.deepEqual((await scanRepoConfig(fixture.runner, repo)).items, [{ key: 'core.sshcommand', value: 'from-worktree-config' }])
  // An include line in the worktree config is held like one in the shared config.
  writeFileSync(file, '[include]\n\tpath = ../../elsewhere.gitconfig\n')
  assert.equal((await scanRepoConfig(fixture.runner, repo)).includes, 'held')
  writeFileSync(file, '[broken syntax\n')
  await assert.rejects(scanRepoConfig(fixture.runner, repo), /bad config/)
})

test('a linked worktree is reviewed by the config of the repository it belongs to', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('main-tree', (d) => fixture.plain(d, 'config', 'core.sshCommand', 'shared'))
  const linked = join(fixture.root, 'linked-tree')
  fixture.plain(repo, 'worktree', 'add', '-q', linked, '-b', 'side')
  assert.deepEqual((await scanRepoConfig(fixture.runner, linked)).items, [{ key: 'core.sshcommand', value: 'shared' }])
  await assert.rejects(scanRepoConfig(fixture.runner, fixture.root), /Could not find the repository config/)
})

test('the scan ignores the user\'s own global config', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  writeFileSync(join(fixture.root, 'gitconfig'), '[user]\n\tname = T\n\temail = t@example.com\n[core]\n\tsshCommand = ssh -i mine\n[credential]\n\thelper = manager\n')
  const repo = fixture.repo('global-only')
  assert.deepEqual((await scanRepoConfig(fixture.runner, repo)).items, [])
})

test('the gate holds: a repository with a clean filter is never asked to run it until trusted', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const marker = join(fixture.root, 'filter.marker')
  const repo = fixture.repo('evil', (d) => {
    fixture.plain(d, 'config', 'filter.evil.clean', `sh -c 'echo x > "${shellPath(marker)}"; cat'`)
    writeFileSync(join(d, '.gitattributes'), '*.txt filter=evil\n')
    // Same size, newer timestamp: git cannot tell the file is unchanged without running the filter.
    writeFileSync(join(d, 'a.txt'), 'two\n')
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(d, 'a.txt'), later, later)
  })
  const scan = await scanRepoConfig(fixture.runner, repo)
  assert.equal(scan.items.length, 1)
  assert.equal(existsSync(marker), false, 'scanning the config must not run the filter')
  // For contrast: status is what would have run it.
  await fixture.runner.run({ cwd: repo, args: statusArgs() })
  assert.equal(existsSync(marker), true, 'control: status does run the filter, which is why the gate is required')
})

test('trust is remembered by repository and exact config hash, and survives a restart', async (t) => {
  const fixture = (await createGitFixture())
  const folder = fixture?.root ?? join(tmpdir(), `git-trust-${process.pid}`)
  mkdirSync(folder, { recursive: true })
  t.after(() => fixture?.cleanup())
  const file = join(folder, 'git-trust.json')
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const store = new GitTrustStore(file)
  assert.equal(await store.isTrusted(REPO, hashA), false)
  await store.trust(REPO, hashA)
  assert.equal(await store.isTrusted(LOWER, hashA), caseInsensitivePaths, 'path comparison ignores case where the platform does')
  assert.equal(await store.isTrusted(REPO, hashB), false, 'a changed config is a new question')
  assert.equal(await store.isTrusted('C:\\Work\\Other', hashA), false)
  const reopened = new GitTrustStore(file)
  assert.equal(await reopened.isTrusted(REPO, hashA), true)
})

test('a corrupt trust file is treated as empty, not as trust', async (t) => {
  const fixture = (await createGitFixture())
  const folder = fixture?.root ?? join(tmpdir(), `git-trust-bad-${process.pid}`)
  mkdirSync(folder, { recursive: true })
  t.after(() => fixture?.cleanup())
  const file = join(folder, 'git-trust.json')
  writeFileSync(file, '{"version":1,"repos":{"c:\\\\work\\\\repo":"not-a-hash"}}')
  assert.equal(await new GitTrustStore(file).isTrusted(REPO, 'not-a-hash'), false)
  writeFileSync(file, 'not json')
  assert.equal(await new GitTrustStore(file).isTrusted(REPO, 'a'.repeat(64)), false)
})

test('values that contain newlines or key=value text cannot imitate a different configuration', () => {
  const smuggled = [{ key: 'core.sshcommand', value: 'ssh\nfilter.evil.clean=cmd' }]
  const separate = [{ key: 'core.sshcommand', value: 'ssh' }, { key: 'filter.evil.clean', value: 'cmd' }]
  assert.notEqual(configItemsHash(smuggled), configItemsHash(separate))
  assert.notEqual(configItemsHash([{ key: 'a.b', value: 'c\0d' }]), configItemsHash([{ key: 'a.b', value: 'c' }, { key: 'd', value: '' }]))
})

test('a repository-local excludes or attributes file needs review, because status reads it', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('paths', (d) => {
    fixture.plain(d, 'config', 'core.excludesFile', '\\\\review-invalid-host\\share\\ignore')
    fixture.plain(d, 'config', 'core.attributesFile', '\\\\review-invalid-host\\share\\attributes')
  })
  const scan = await scanRepoConfig(fixture.runner, repo)
  assert.deepEqual(scan.items.map(item => item.key).sort(), ['core.attributesfile', 'core.excludesfile'])
})

test('hook approvals are remembered by repository and exact hash, separately from config trust, and survive a restart', async (t) => {
  const fixture = (await createGitFixture())
  const folder = fixture?.root ?? join(tmpdir(), `git-hooks-trust-${process.pid}`)
  mkdirSync(folder, { recursive: true })
  t.after(() => fixture?.cleanup())
  const file = join(folder, 'git-trust-hooks.json')
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const store = new GitTrustStore(file)
  assert.equal(await store.areHooksApproved(REPO, hashA), false)
  await store.approveHooks(REPO, hashA)
  assert.equal(await store.areHooksApproved(LOWER, hashA), caseInsensitivePaths, 'path comparison ignores case where the platform does')
  assert.equal(await store.areHooksApproved(REPO, hashB), false, 'a changed hook is a new question')
  assert.equal(await store.isTrusted(REPO, hashA), false, 'approving hooks does not trust the config')
  await store.trust(REPO, hashB)
  assert.equal(await store.areHooksApproved(REPO, hashA), true, 'trusting the config does not undo a hook approval')
  const reopened = new GitTrustStore(file)
  assert.equal(await reopened.areHooksApproved(REPO, hashA), true)
  assert.equal(await reopened.isTrusted(REPO, hashB), true)
})

test('an older trust file without hook approvals still loads', async (t) => {
  const fixture = (await createGitFixture())
  const folder = fixture?.root ?? join(tmpdir(), `git-hooks-old-${process.pid}`)
  mkdirSync(folder, { recursive: true })
  t.after(() => fixture?.cleanup())
  const file = join(folder, 'old-trust.json')
  writeFileSync(file, JSON.stringify({ version: 1, repos: { [pathKey(REPO)]: 'c'.repeat(64) } }))
  const store = new GitTrustStore(file)
  assert.equal(await store.isTrusted(REPO, 'c'.repeat(64)), true)
  assert.equal(await store.areHooksApproved(REPO, 'c'.repeat(64)), false)
})
