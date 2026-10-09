import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture } from './fixtures/git-fixture.js'
import { decodeGitQuoted, discoverRepos, inspectGitEntry } from './git-discovery.js'

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

test('a share named past the first 4 KB of a long alternates file is still found', async (t) => {
  const root = workspace(t)
  mkdirSync(join(root, 'repo', '.git', 'objects', 'info'), { recursive: true })
  const local = Array.from({ length: 150 }, (_item, index) => `../../donor-${String(index).padStart(3, '0')}/objects-with-a-long-name-to-pad`).join('\n')
  const file = join(root, 'repo', '.git', 'objects', 'info', 'alternates')
  writeFileSync(file, `${local}\n\\\\review-invalid-host\\share\\objects\n`)
  assert.ok(statSync(file).size > 6_000, 'the share starts well past the old 4 KB limit')
  assert.match((await inspectGitEntry(join(root, 'repo')))?.issue ?? '', /borrows objects/)
})

test('a long alternates file that is entirely local is accepted', async (t) => {
  const root = workspace(t)
  mkdirSync(join(root, 'repo', '.git', 'objects', 'info'), { recursive: true })
  // Over 4 KB but within the entry cap: 40 long lines.
  const local = Array.from({ length: 40 }, (_item, index) => `../../donor-${String(index).padStart(3, '0')}/${'x'.repeat(100)}`).join('\n')
  const file = join(root, 'repo', '.git', 'objects', 'info', 'alternates')
  writeFileSync(file, `${local}\n`)
  assert.ok(statSync(file).size > 4_096)
  assert.equal((await inspectGitEntry(join(root, 'repo')))?.issue, null)
})

test('pointer files too large to inspect completely, or unreadable, are refused rather than treated as absent', async (t) => {
  const root = workspace(t)
  mkdirSync(join(root, 'huge-alternates', '.git', 'objects', 'info'), { recursive: true })
  writeFileSync(join(root, 'huge-alternates', '.git', 'objects', 'info', 'alternates'), `${'#'.repeat(70_000)}\n`)
  assert.match((await inspectGitEntry(join(root, 'huge-alternates')))?.issue ?? '', /could not be checked completely/)

  mkdirSync(join(root, 'huge-commondir', '.git'), { recursive: true })
  writeFileSync(join(root, 'huge-commondir', '.git', 'commondir'), `../${'a'.repeat(5_000)}\n`)
  assert.match((await inspectGitEntry(join(root, 'huge-commondir')))?.issue ?? '', /could not be checked completely/)

  // Present but not a readable file: git would not use it either, but its safety cannot be established.
  mkdirSync(join(root, 'dir-alternates', '.git', 'objects', 'info', 'alternates'), { recursive: true })
  assert.match((await inspectGitEntry(join(root, 'dir-alternates')))?.issue ?? '', /could not be checked completely/)
})

test('a repository with no pointer files at all is still accepted', async (t) => {
  const root = workspace(t)
  mkdirSync(join(root, 'plain', '.git'), { recursive: true })
  assert.equal((await inspectGitEntry(join(root, 'plain')))?.issue, null)
})

test('decodeGitQuoted follows git\'s C-style quoting and refuses anything it cannot decode exactly', () => {
  assert.equal(decodeGitQuoted('"plain"'), 'plain')
  assert.equal(decodeGitQuoted('"\\\\\\\\host\\\\share"'), '\\\\host\\share')
  assert.equal(decodeGitQuoted('"quote\\"inside"'), 'quote"inside')
  assert.equal(decodeGitQuoted('"tab\\there\\nnewline"'), 'tab\there\nnewline')
  assert.equal(decodeGitQuoted('"\\134\\134host"'), '\\\\host', 'octal escapes decode to bytes')
  assert.equal(decodeGitQuoted('"caf\\303\\251"'), 'café', 'octal bytes combine into UTF-8')
  for (const bad of ['unquoted', '"unterminated', '"trailing"junk', '"bad\\q"', '"bad\\9"', '"short\\12"', '"\\400"', '"ends with backslash\\"', '']) {
    assert.equal(decodeGitQuoted(bad), null, JSON.stringify(bad))
  }
})

test('a quoted alternates line that decodes to a share is refused, whatever the quoting', async (t) => {
  const root = workspace(t)
  const cases: Array<[string, string]> = [
    ['json-escaped', JSON.stringify('\\\\review-invalid-host\\share\\objects')],
    ['octal-escaped', '"\\134\\134review-invalid-host\\\\share"'],
    ['forward-slashes', '"//review-invalid-host/share/objects"'],
  ]
  for (const [name, line] of cases) {
    mkdirSync(join(root, name, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(root, name, '.git', 'objects', 'info', 'alternates'), `${line}\n`)
    assert.match((await inspectGitEntry(join(root, name)))?.issue ?? '', /borrows objects/, name)
  }
})

test('a quoted alternates line that is local is accepted, and an undecodable one is refused', async (t) => {
  const root = workspace(t)
  const write = (name: string, line: string): void => {
    mkdirSync(join(root, name, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(root, name, '.git', 'objects', 'info', 'alternates'), `${line}\n`)
  }
  write('local', '"../../donor/objects"')
  write('local-spaces', '"../../my donor/objects"')
  write('broken', '"../../donor/objects')
  write('junk', '"../../donor/objects"extra')
  assert.equal((await inspectGitEntry(join(root, 'local')))?.issue, null)
  assert.equal((await inspectGitEntry(join(root, 'local-spaces')))?.issue, null)
  assert.match((await inspectGitEntry(join(root, 'broken')))?.issue ?? '', /could not be checked completely/)
  assert.match((await inspectGitEntry(join(root, 'junk')))?.issue ?? '', /could not be checked completely/)
})

/** Make `<root>/<name>/.git/objects` and return its path (forward slashes, as git writes them). */
function objectsDir(root: string, name: string): string {
  const directory = join(root, name, '.git', 'objects')
  mkdirSync(join(directory, 'info'), { recursive: true })
  return directory
}
const setAlternates = (directory: string, ...lines: string[]): void => {
  writeFileSync(join(directory, 'info', 'alternates'), `${lines.join('\n')}\n`)
}
const slashes = (path: string): string => path.replace(/\\/g, '/')

test('a share named by a later hop of the alternates chain is found', async (t) => {
  const root = workspace(t)
  const [a, b, c] = ['a', 'b', 'c'].map(name => objectsDir(root, name)) as [string, string, string]
  setAlternates(a, slashes(b))
  setAlternates(b, slashes(c))
  assert.equal((await inspectGitEntry(join(root, 'a')))?.issue, null, 'a local chain is fine')
  setAlternates(b, '\\\\review-invalid-host\\share\\objects')
  assert.match((await inspectGitEntry(join(root, 'a')))?.issue ?? '', /borrows objects/)
  setAlternates(b, slashes(c))
  setAlternates(c, JSON.stringify('\\\\review-invalid-host\\share\\objects'))
  assert.match((await inspectGitEntry(join(root, 'a')))?.issue ?? '', /borrows objects/, 'a quoted entry on the third hop')
})

test('git really follows a chained alternate, so the chain has to be checked', async (t) => {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('git is not installed'); return }
  t.after(() => fixture.cleanup())
  const donor = fixture.repo('donor')
  const middle = join(fixture.root, 'middle')
  const front = join(fixture.root, 'front')
  for (const folder of [middle, front]) { mkdirSync(folder); fixture.plain(folder, 'init', '-q') }
  setAlternates(join(middle, '.git', 'objects'), slashes(join(donor, '.git', 'objects')))
  setAlternates(join(front, '.git', 'objects'), slashes(join(middle, '.git', 'objects')))
  const commit = fixture.plain(donor, 'rev-parse', 'HEAD').trim()
  assert.equal(fixture.plain(front, 'cat-file', '-t', commit).trim(), 'commit', 'control: git read an object that only the second hop has')
  assert.equal((await inspectGitEntry(front))?.issue, null)
  setAlternates(join(middle, '.git', 'objects'), '\\\\review-invalid-host\\share\\objects')
  assert.match((await inspectGitEntry(front))?.issue ?? '', /borrows objects/)
})

test('an alternates chain that leads back to itself ends and is accepted', async (t) => {
  const root = workspace(t)
  const a = objectsDir(root, 'a')
  const b = objectsDir(root, 'b')
  setAlternates(a, slashes(b))
  setAlternates(b, slashes(a), slashes(b))
  assert.equal((await inspectGitEntry(join(root, 'a')))?.issue, null)
})

test('a chain deeper than git follows, or wider than any real repository, is refused', async (t) => {
  const root = workspace(t)
  const links = Array.from({ length: 8 }, (_item, index) => objectsDir(root, `hop${index}`))
  for (let index = 0; index < links.length - 1; index++) setAlternates(links[index]!, slashes(links[index + 1]!))
  assert.equal((await inspectGitEntry(join(root, 'hop3')))?.issue, null, 'a short chain is fine')
  assert.match((await inspectGitEntry(join(root, 'hop0')))?.issue ?? '', /could not be checked completely/)

  const wide = objectsDir(root, 'wide')
  setAlternates(wide, ...Array.from({ length: 70 }, (_item, index) => slashes(join(root, `missing-${index}`, 'objects'))))
  assert.match((await inspectGitEntry(join(root, 'wide')))?.issue ?? '', /could not be checked completely/)
})

test('an alternate reached through a junction is checked where it really lives', async (t) => {
  const root = workspace(t)
  const real = objectsDir(root, 'real')
  setAlternates(real, '\\\\review-invalid-host\\share\\objects')
  const front = objectsDir(root, 'front')
  mkdirSync(join(root, 'links'))
  junction(join(root, 'links', 'objects'), real)
  setAlternates(front, slashes(join(root, 'links', 'objects')))
  assert.match((await inspectGitEntry(join(root, 'front')))?.issue ?? '', /borrows objects/)
})

test('the repository\'s own objects directory and a shared common directory are both walked', async (t) => {
  const root = workspace(t)
  const common = join(root, 'common')
  mkdirSync(join(common, 'objects', 'info'), { recursive: true })
  setAlternates(join(common, 'objects'), '\\\\review-invalid-host\\share\\objects')
  const gitDir = join(root, 'wt-gitdir')
  mkdirSync(gitDir)
  writeFileSync(join(gitDir, 'commondir'), `${common}\n`)
  mkdirSync(join(root, 'wt'))
  writeFileSync(join(root, 'wt', '.git'), `gitdir: ${gitDir}\n`)
  assert.match((await inspectGitEntry(join(root, 'wt')))?.issue ?? '', /borrows objects/)
})
