import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readUntrackedFile, safeRepoSegments } from './git-untracked.js'

function repoFolder(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'git-untracked-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  return repo
}

test('safeRepoSegments rejects traversal, devices, streams and trailing dots', () => {
  assert.deepEqual(safeRepoSegments('src/app.ts'), ['src', 'app.ts'])
  assert.deepEqual(safeRepoSegments('dir/'), ['dir'])
  for (const bad of ['', '../x', 'a/../b', '/abs', 'a//b', 'a\\b', 'C:/x', 'file.txt:stream', 'CON', 'dir/nul.txt', 'COM1', 'aux.log', 'trailing.', 'space ', 'a\0b']) {
    assert.equal(safeRepoSegments(bad), null, JSON.stringify(bad))
  }
  assert.deepEqual(safeRepoSegments('console.ts'), ['console.ts'], 'names that merely start like a device are fine')
})

test('text files come back whole, with their size', async (t) => {
  const repo = repoFolder(t)
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  assert.deepEqual(await readUntrackedFile(repo, 'a.txt'), { kind: 'text', text: 'one\ntwo\n', truncated: false, totalBytes: 8 })
})

test('large text is cut at the cap and marked truncated', async (t) => {
  const repo = repoFolder(t)
  writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2_000))
  const result = await readUntrackedFile(repo, 'big.txt', 1_000)
  assert.equal(result.kind, 'text')
  if (result.kind === 'text') { assert.equal(result.text.length, 1_000); assert.equal(result.truncated, true) }
})

test('files far beyond the cap are not read at all', async (t) => {
  const repo = repoFolder(t)
  writeFileSync(join(repo, 'huge.bin'), Buffer.alloc(9_000, 'a'))
  assert.equal((await readUntrackedFile(repo, 'huge.bin', 1_000)).kind, 'too-large')
})

test('binary content, directories and missing files are classified', async (t) => {
  const repo = repoFolder(t)
  writeFileSync(join(repo, 'img.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
  mkdirSync(join(repo, 'folder'))
  assert.equal((await readUntrackedFile(repo, 'img.png')).kind, 'binary')
  assert.equal((await readUntrackedFile(repo, 'folder/')).kind, 'directory')
  assert.equal((await readUntrackedFile(repo, 'folder')).kind, 'directory')
  assert.equal((await readUntrackedFile(repo, 'gone.txt')).kind, 'unsafe')
})

test('a path through a junction that leaves the repository is refused', async (t) => {
  const repo = repoFolder(t)
  const outside = join(repo, '..', 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', join(repo, 'portal'), outside], { stdio: 'ignore' })
  const result = await readUntrackedFile(repo, 'portal/secret.txt')
  assert.equal(result.kind, 'unsafe')
  assert.match(result.kind === 'unsafe' ? result.reason : '', /outside the repository/)
})

test('traversal, devices and streams are refused before touching the disk', async (t) => {
  const repo = repoFolder(t)
  writeFileSync(join(repo, '..', 'outside.txt'), 'secret')
  for (const bad of ['../outside.txt', 'file.txt:hidden', 'con', 'NUL.txt']) {
    assert.equal((await readUntrackedFile(repo, bad)).kind, 'unsafe', bad)
  }
})
