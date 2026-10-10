import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DiscardRefused, checkSnapshotable, checkTrashable, pruneSnapshots, saveSnapshot, stampFiles } from './git-discard.js'

function workspace(t: test.TestContext): { root: string; repo: string; snapshots: string } {
  const root = mkdtempSync(join(tmpdir(), 'git-discard-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const repo = join(root, 'repo')
  const snapshots = join(root, 'snapshots')
  mkdirSync(repo); mkdirSync(snapshots)
  return { root, repo, snapshots }
}

test('a saved copy holds exactly what was on disk, with a manifest, and the working file is untouched', async (t) => {
  const { repo, snapshots } = workspace(t)
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'a.txt'), 'edited a\n'); writeFileSync(join(repo, 'src', 'b.txt'), 'edited b\n')
  const when = new Date('2026-10-09T12:00:00.000Z')
  const snapshot = await saveSnapshot(snapshots, repo, ['a.txt', 'src/b.txt', 'deleted-in-the-working-tree.txt'], when)
  assert.equal(snapshot.files, 2, 'a file that is already gone has nothing to copy')
  assert.equal(snapshot.bytes, 'edited a\n'.length + 'edited b\n'.length)
  assert.match(snapshot.directory, /2026-10-09T12-00-00-000Z-repo$/)
  assert.equal(readFileSync(join(snapshot.directory, 'files', 'a.txt'), 'utf8'), 'edited a\n')
  assert.equal(readFileSync(join(snapshot.directory, 'files', 'src', 'b.txt'), 'utf8'), 'edited b\n')
  const manifest = JSON.parse(readFileSync(join(snapshot.directory, 'manifest.json'), 'utf8')) as { repository: string; savedAt: string; files: Array<{ path: string }> }
  assert.deepEqual([manifest.repository, manifest.savedAt, manifest.files.map(file => file.path)], [repo, when.toISOString(), ['a.txt', 'src/b.txt']])
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'edited a\n', 'the file is still there')
})

test('files that cannot be copied safely stop the discard before anything is touched', async (t) => {
  const { repo, snapshots } = workspace(t)
  writeFileSync(join(repo, 'big.bin'), Buffer.alloc(2_000)); writeFileSync(join(repo, 'ok.txt'), 'x')
  mkdirSync(join(repo, 'folder'))
  assert.match((await checkSnapshotable(repo, ['big.bin'], { maxFileBytes: 1_000 }))[0] ?? '', /"big.bin" is larger than/)
  assert.match((await checkSnapshotable(repo, ['ok.txt', 'big.bin'], { maxFileBytes: 5_000, maxTotalBytes: 1_000 }))[0] ?? '', /together are larger/)
  assert.match((await checkSnapshotable(repo, ['folder']))[0] ?? '', /not a regular file/)
  for (const unsafe of ['../outside.txt', 'a:b.txt', 'CON', 'trailing.', '', 'a\\b']) assert.match((await checkSnapshotable(repo, [unsafe]))[0] ?? '', /not safe to touch/, JSON.stringify(unsafe))
  await assert.rejects(saveSnapshot(snapshots, repo, ['big.bin'], new Date(), { maxFileBytes: 1_000 }), DiscardRefused)
  assert.deepEqual(readdirSync(snapshots), [], 'no folder was created for a refused copy')
  assert.deepEqual(await checkSnapshotable(repo, ['ok.txt', 'missing.txt']), [], 'a missing file needs no copy')
})

test('a link is never copied or followed', async (t) => {
  const { root, repo, snapshots } = workspace(t)
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'secret')
  try { symlinkSync(outside, join(repo, 'link'), 'junction') } catch { t.skip('links cannot be created here'); return }
  assert.match((await checkSnapshotable(repo, ['link']))[0] ?? '', /not a regular file/)
  await assert.rejects(saveSnapshot(snapshots, repo, ['link'], new Date()), DiscardRefused)
})

test('a file that changes while its copy is being saved stops the discard', async (t) => {
  const { repo, snapshots } = workspace(t)
  writeFileSync(join(repo, 'a.txt'), 'one')
  await assert.rejects(
    saveSnapshot(snapshots, repo, ['a.txt'], new Date(), { afterCopy: () => writeFileSync(join(repo, 'a.txt'), 'one, then something longer') }),
    /changed while its copy was being saved/,
  )
  // The same size with a new modification time is a change too.
  writeFileSync(join(repo, 'b.txt'), 'same')
  await assert.rejects(
    saveSnapshot(snapshots, repo, ['b.txt'], new Date(), { afterCopy: () => utimesSync(join(repo, 'b.txt'), new Date(), new Date(Date.now() + 60_000)) }),
    /changed while its copy was being saved/,
  )
  const ok = await saveSnapshot(snapshots, repo, ['b.txt'], new Date(5_000))
  assert.equal(ok.files, 1, 'without a change it is fine')
})

test('only the oldest saved copies are pruned, and only folders the module made', async (t) => {
  const { snapshots } = workspace(t)
  const names = ['2026-01-01T00-00-00-000Z-a', '2026-01-02T00-00-00-000Z-a', '2026-01-03T00-00-00-000Z-a', '2026-01-04T00-00-00-000Z-a']
  for (const name of names) mkdirSync(join(snapshots, name))
  mkdirSync(join(snapshots, 'my-own-folder')); writeFileSync(join(snapshots, 'notes.txt'), 'keep')
  assert.equal(await pruneSnapshots(snapshots, 2), 2)
  assert.deepEqual(readdirSync(snapshots).sort(), ['2026-01-03T00-00-00-000Z-a', '2026-01-04T00-00-00-000Z-a', 'my-own-folder', 'notes.txt'])
  assert.equal(await pruneSnapshots(snapshots, 2), 0)
  assert.equal(await pruneSnapshots(join(snapshots, 'nope'), 2), 0, 'a missing place is not an error')
})

test('an untracked file or ordinary folder may go to the Recycle Bin', async (t) => {
  const { repo } = workspace(t)
  writeFileSync(join(repo, 'scratch.txt'), 'x'); mkdirSync(join(repo, 'build', 'deep'), { recursive: true }); writeFileSync(join(repo, 'build', 'deep', 'out.js'), 'x')
  assert.deepEqual(await checkTrashable(repo, 'scratch.txt'), { ok: true, absolute: join(repo, 'scratch.txt') })
  assert.deepEqual(await checkTrashable(repo, 'build/'), { ok: true, absolute: join(repo, 'build') })
})

test('a folder holding a git repository, a git folder, a link or an unsafe name is never trashed', async (t) => {
  const { root, repo } = workspace(t)
  mkdirSync(join(repo, 'vendored', 'lib', '.git'), { recursive: true }); writeFileSync(join(repo, 'vendored', 'lib', '.git', 'HEAD'), 'ref')
  mkdirSync(join(repo, 'plain')); writeFileSync(join(repo, 'plain', '.GIT'), 'a file named like it')
  mkdirSync(join(repo, '.git')); mkdirSync(join(root, 'outside')); writeFileSync(join(repo, 'ok.txt'), 'x')
  const refuse = async (path: string, reason: RegExp): Promise<void> => {
    const verdict = await checkTrashable(repo, path)
    assert.equal(verdict.ok, false, path)
    if (!verdict.ok) assert.match(verdict.reason, reason, path)
  }
  await refuse('vendored/', /contains a git repository/)
  await refuse('plain/', /contains a git repository/)
  await refuse('.git/', /inside a git folder/)
  await refuse('.git/HEAD', /inside a git folder/)
  await refuse('missing.txt', /no longer exists/)
  for (const unsafe of ['../outside', 'a:b', 'CON', 'x.', '', 'a\\b']) await refuse(unsafe, /not safe to touch/)
  let linked = true
  try { symlinkSync(join(root, 'outside'), join(repo, 'jump'), 'junction') } catch { linked = false }
  if (linked) await refuse('jump', /is a link/)
  assert.equal(existsSync(join(repo, 'vendored', 'lib', '.git', 'HEAD')), true, 'checking deletes nothing')
})

test('a junction or link anywhere above a tracked or untracked path is refused, wherever it is, and the target is never opened', async (t) => {
  const { root, repo, snapshots } = workspace(t)
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'a.txt'), 'outside'); mkdirSync(join(outside, 'deeper')); writeFileSync(join(outside, 'deeper', 'b.txt'), 'b')
  mkdirSync(join(repo, 'real')); writeFileSync(join(repo, 'real', 'ok.txt'), 'ok')
  let linked = true
  try { symlinkSync(outside, join(repo, 'parent'), 'junction'); symlinkSync(outside, join(repo, 'real', 'inner'), 'junction') } catch { linked = false }
  if (!linked) { t.skip('links cannot be created here'); return }
  for (const path of ['parent/a.txt', 'parent/deeper/b.txt', 'real/inner/a.txt', 'parent/missing.txt']) {
    assert.match((await checkSnapshotable(repo, [path]))[0] ?? '', /inside a folder that is a link/, path)
    await assert.rejects(saveSnapshot(snapshots, repo, [path], new Date()), DiscardRefused, path)
    const trash = await checkTrashable(repo, path)
    assert.equal(trash.ok, false, path)
  }
  assert.deepEqual(await checkSnapshotable(repo, ['real/ok.txt', 'real/missing/deleted.txt']), [], 'ordinary folders, including ones that do not exist yet, are fine')
  assert.deepEqual(readdirSync(snapshots), [], 'nothing was copied')
  assert.equal(readFileSync(join(outside, 'a.txt'), 'utf8'), 'outside')
})

test('stamps say whether a file looks the same as when it was copied', async (t) => {
  const { repo, snapshots } = workspace(t)
  writeFileSync(join(repo, 'a.txt'), 'one'); writeFileSync(join(repo, 'b.txt'), 'two')
  const snapshot = await saveSnapshot(snapshots, repo, ['a.txt', 'b.txt', 'gone.txt'], new Date(0))
  assert.deepEqual(await stampFiles(repo, ['a.txt', 'b.txt', 'gone.txt']), snapshot.stamps, 'unchanged files match their copy')
  assert.equal(snapshot.stamps.get('gone.txt'), 'missing')
  writeFileSync(join(repo, 'a.txt'), 'one, more')
  const later = await stampFiles(repo, ['a.txt', 'b.txt', 'gone.txt'])
  assert.notEqual(later.get('a.txt'), snapshot.stamps.get('a.txt'))
  assert.equal(later.get('b.txt'), snapshot.stamps.get('b.txt'))
  utimesSync(join(repo, 'b.txt'), new Date(), new Date(Date.now() + 120_000))
  assert.notEqual((await stampFiles(repo, ['b.txt'])).get('b.txt'), snapshot.stamps.get('b.txt'), 'a new modification time counts as a change')
})

test('stamps are kept for every file name, including ones that are special on a plain object', async (t) => {
  const { repo, snapshots } = workspace(t)
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype']
  for (const name of names) writeFileSync(join(repo, name), `content of ${name}`)
  const snapshot = await saveSnapshot(snapshots, repo, names, new Date(0))
  assert.deepEqual([...snapshot.stamps.keys()], names, 'every name has its own stamp')
  const before = await stampFiles(repo, names)
  assert.deepEqual([...before.keys()], names)
  writeFileSync(join(repo, '__proto__'), 'content of __proto__, but longer')
  const after = await stampFiles(repo, names)
  assert.notEqual(after.get('__proto__'), snapshot.stamps.get('__proto__'), 'a change to __proto__ is noticed')
  assert.equal(after.get('constructor'), snapshot.stamps.get('constructor'))
  for (const name of names) assert.equal(readFileSync(join(snapshot.directory, 'files', name), 'utf8'), `content of ${name}`, name)
})
