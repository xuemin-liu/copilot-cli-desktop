import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverRepos, inspectGitEntry } from './git-discovery.js'

function workspace(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'git-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}

const makeRepo = (folder: string): void => { mkdirSync(join(folder, '.git'), { recursive: true }) }
const junction = (link: string, target: string): void => { execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' }) }

test('a project that is itself a repository is returned alone and its children are not scanned', async (t) => {
  const root = workspace(t)
  makeRepo(root)
  makeRepo(join(root, 'vendor', 'lib'))
  const result = await discoverRepos(root)
  assert.deepEqual(result.repos.map(repo => [repo.kind, repo.relativePath, repo.issue]), [['project', '.', null]])
})

test('nested repositories are found to depth three, skipping build folders, and are not entered', async (t) => {
  const root = workspace(t)
  makeRepo(join(root, 'a'))
  makeRepo(join(root, 'group', 'b'))
  makeRepo(join(root, 'group', 'deep', 'c'))
  makeRepo(join(root, 'one', 'two', 'three', 'too-deep'))
  makeRepo(join(root, 'node_modules', 'pkg'))
  makeRepo(join(root, 'a', 'inner'))
  const result = await discoverRepos(root)
  assert.deepEqual(result.repos.map(repo => repo.relativePath), ['a', 'group\\b', 'group\\deep\\c'])
  assert.ok(result.repos.every(repo => repo.kind === 'nested'))
})

test('the repository cap truncates and says so', async (t) => {
  const root = workspace(t)
  for (const name of ['a', 'b', 'c', 'd']) makeRepo(join(root, name))
  const result = await discoverRepos(root, { maxRepos: 2 })
  assert.equal(result.repos.length, 2)
  assert.equal(result.truncated, true)
  assert.match(result.notes.join(' '), /first 2 repositories/)
})

test('a project inside a larger repository reports it as the parent', async (t) => {
  const root = workspace(t)
  makeRepo(root)
  const project = join(root, 'packages', 'app')
  mkdirSync(project, { recursive: true })
  const result = await discoverRepos(project, { homeDirectory: 'C:\\somewhere\\else' })
  assert.deepEqual(result.repos.map(repo => [repo.kind, repo.relativePath]), [['parent', '..\\..']])
})

test('an enclosing repository at the home folder or a drive root is ignored', async (t) => {
  const root = workspace(t)
  makeRepo(root)
  const project = join(root, 'work', 'app')
  mkdirSync(project, { recursive: true })
  const result = await discoverRepos(project, { homeDirectory: root })
  assert.equal(result.repos.length, 0)
  assert.match(result.notes.join(' '), /home folder/)
})

test('the home folder is recognized when it is reached through a junction', async (t) => {
  const root = workspace(t)
  makeRepo(root)
  const project = join(root, 'work', 'app')
  mkdirSync(project, { recursive: true })
  const links = workspace(t)
  junction(join(links, 'home'), root)
  const result = await discoverRepos(project, { homeDirectory: join(links, 'home') })
  assert.equal(result.repos.length, 0)
  assert.match(result.notes.join(' '), /home folder/)
})

test('the home folder is recognized through its 8.3 short name', async (t) => {
  const root = workspace(t)
  makeRepo(root)
  const project = join(root, 'work', 'app')
  mkdirSync(project, { recursive: true })
  // The same folder spelled with its short name, as os.homedir() or a CI runner profile can report it.
  const short = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${root}').ShortPath`], { encoding: 'utf8' }).trim()
  if (short.toLowerCase() === root.toLowerCase()) t.diagnostic('short names are disabled for this folder; the case is covered only by the long form')
  const result = await discoverRepos(project, { homeDirectory: short })
  assert.equal(result.repos.length, 0)
  assert.match(result.notes.join(' '), /home folder/)
})

test('a .git file must point at a local git directory', async (t) => {
  const root = workspace(t)
  const real = join(root, 'real-gitdir')
  mkdirSync(real)
  for (const [name, text] of [
    ['ok-relative', 'gitdir: ../real-gitdir\n'],
    ['unc', 'gitdir: \\\\attacker\\share\\x\n'],
    ['unc-slash', 'gitdir: //attacker/share/x\n'],
    ['empty', 'nothing useful\n'],
  ] as const) {
    mkdirSync(join(root, 'repos', name), { recursive: true })
    writeFileSync(join(root, 'repos', name, '.git'), text)
  }
  const result = await discoverRepos(join(root, 'repos'))
  const issues = Object.fromEntries(result.repos.map(repo => [repo.relativePath, repo.issue]))
  assert.equal(issues['ok-relative'], null)
  assert.match(issues['unc'] ?? '', /outside local storage/)
  assert.match(issues['unc-slash'] ?? '', /outside local storage/)
  assert.match(issues['empty'] ?? '', /does not name/)
})

test('a linked worktree whose commondir points at a share is refused', async (t) => {
  const root = workspace(t)
  const gitDir = join(root, 'wt-gitdir')
  mkdirSync(gitDir)
  writeFileSync(join(gitDir, 'commondir'), '\\\\attacker\\share\\common\n')
  mkdirSync(join(root, 'wt'))
  writeFileSync(join(root, 'wt', '.git'), `gitdir: ${gitDir}\n`)
  const found = await inspectGitEntry(join(root, 'wt'))
  assert.match(found?.issue ?? '', /outside local storage/)
})

test('a .git junction is listed but marked unsafe, and junctioned folders are not followed', async (t) => {
  const root = workspace(t)
  const outside = join(root, 'outside')
  mkdirSync(join(outside, 'hidden-repo', '.git'), { recursive: true })
  const project = join(root, 'project')
  mkdirSync(join(project, 'linked-git'), { recursive: true })
  junction(join(project, 'linked-git', '.git'), join(outside, 'hidden-repo', '.git'))
  junction(join(project, 'portal'), outside)
  const result = await discoverRepos(project)
  assert.deepEqual(result.repos.map(repo => repo.relativePath), ['linked-git'])
  assert.match(result.repos[0]?.issue ?? '', /link/)
})

test('UNC and device project folders are refused', async () => {
  await assert.rejects(discoverRepos('\\\\server\\share\\project'), /local project folders/)
  await assert.rejects(discoverRepos('\\\\?\\C:\\work'), /local project folders/)
})

test('an absent project folder rejects instead of reporting no repositories', async () => {
  await assert.rejects(discoverRepos(join(tmpdir(), 'git-discovery-missing-folder-xyz')))
})

test('a directory-form .git whose commondir points at a share is refused', async (t) => {
  const root = workspace(t)
  mkdirSync(join(root, 'repo', '.git'), { recursive: true })
  writeFileSync(join(root, 'repo', '.git', 'commondir'), '\\\\review-invalid-host\\share\\repo\n')
  assert.match((await inspectGitEntry(join(root, 'repo')))?.issue ?? '', /outside local storage/)
  const result = await discoverRepos(root)
  assert.match(result.repos[0]?.issue ?? '', /outside local storage/)
})

test('a local commondir is accepted, in the directory form and through a .git file', async (t) => {
  const root = workspace(t)
  mkdirSync(join(root, 'shared'), { recursive: true })
  mkdirSync(join(root, 'repo', '.git'), { recursive: true })
  writeFileSync(join(root, 'repo', '.git', 'commondir'), '../../shared\n')
  assert.equal((await inspectGitEntry(join(root, 'repo')))?.issue, null)
  mkdirSync(join(root, 'wt-gitdir'))
  writeFileSync(join(root, 'wt-gitdir', 'commondir'), '..\\shared\n')
  mkdirSync(join(root, 'wt'))
  writeFileSync(join(root, 'wt', '.git'), `gitdir: ${join(root, 'wt-gitdir')}\n`)
  assert.equal((await inspectGitEntry(join(root, 'wt')))?.issue, null)
})

test('alternates that borrow objects from a share are refused in both forms; local ones are fine', async (t) => {
  const root = workspace(t)
  for (const [name, text] of [['dir-unc', '\\\\review-invalid-host\\share\\objects\n'], ['dir-local', '../../other/objects\n']] as const) {
    mkdirSync(join(root, name, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(root, name, '.git', 'objects', 'info', 'alternates'), `# comment\n${text}`)
  }
  assert.match((await inspectGitEntry(join(root, 'dir-unc')))?.issue ?? '', /borrows objects/)
  assert.equal((await inspectGitEntry(join(root, 'dir-local')))?.issue, null)
  const gitDir = join(root, 'real-gitdir')
  mkdirSync(join(gitDir, 'objects', 'info'), { recursive: true })
  writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), '//review-invalid-host/share/objects\n')
  mkdirSync(join(root, 'file-form'))
  writeFileSync(join(root, 'file-form', '.git'), `gitdir: ${gitDir}\n`)
  assert.match((await inspectGitEntry(join(root, 'file-form')))?.issue ?? '', /borrows objects/)
})
