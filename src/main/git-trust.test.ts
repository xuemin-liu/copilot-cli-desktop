import assert from 'node:assert/strict'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture, findGitForTests, shellPath } from './fixtures/git-fixture.js'
import { GitTrustStore, configItemsHash, isBenignConfigItem, parseConfigScan, scanRepoConfig } from './git-trust.js'
import { statusArgs } from './git-commands.js'

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
  assert.equal(scan.hash, configItemsHash(scan.items))
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
  const folder = fixture?.root ?? join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-trust-${process.pid}`)
  mkdirSync(folder, { recursive: true })
  t.after(() => fixture?.cleanup())
  const file = join(folder, 'git-trust.json')
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const store = new GitTrustStore(file)
  assert.equal(await store.isTrusted('C:\\Work\\Repo', hashA), false)
  await store.trust('C:\\Work\\Repo', hashA)
  assert.equal(await store.isTrusted('c:\\work\\repo', hashA), true, 'path comparison ignores case')
  assert.equal(await store.isTrusted('C:\\Work\\Repo', hashB), false, 'a changed config is a new question')
  assert.equal(await store.isTrusted('C:\\Work\\Other', hashA), false)
  const reopened = new GitTrustStore(file)
  assert.equal(await reopened.isTrusted('C:\\Work\\Repo', hashA), true)
})

test('a corrupt trust file is treated as empty, not as trust', async (t) => {
  const fixture = (await createGitFixture())
  const folder = fixture?.root ?? join(process.env.TEMP ?? 'C:\\Windows\\Temp', `git-trust-bad-${process.pid}`)
  mkdirSync(folder, { recursive: true })
  t.after(() => fixture?.cleanup())
  const file = join(folder, 'git-trust.json')
  writeFileSync(file, '{"version":1,"repos":{"c:\\\\work\\\\repo":"not-a-hash"}}')
  assert.equal(await new GitTrustStore(file).isTrusted('C:\\Work\\Repo', 'not-a-hash'), false)
  writeFileSync(file, 'not json')
  assert.equal(await new GitTrustStore(file).isTrusted('C:\\Work\\Repo', 'a'.repeat(64)), false)
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
