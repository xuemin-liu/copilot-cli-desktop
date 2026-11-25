import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CheckpointStore, checkpointRef, folderBytes, sessionRefKey, storeNameFor, turnLabel, type CheckpointLimits } from './checkpoint-store.js'
import { createGitFixture, folderLink, shellPath, type GitFixture } from './fixtures/git-fixture.js'

async function setup(t: test.TestContext, limits: Partial<CheckpointLimits> = {}): Promise<{ fixture: GitFixture; store: CheckpointStore; root: string } | null> {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('git is not installed'); return null }
  t.after(() => fixture.cleanup())
  const root = join(fixture.root, 'checkpoints')
  return { fixture, root, store: new CheckpointStore({ root, runner: fixture.runner, limits }) }
}

/** Everything of a repository that a capture must leave alone. */
function fingerprint(fixture: GitFixture, repo: string): string {
  const objects = (folder: string): string[] => existsSync(folder) ? readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort() : []
  return JSON.stringify({
    index: readFileSync(join(repo, '.git', 'index')).toString('base64'),
    head: readFileSync(join(repo, '.git', 'HEAD'), 'utf8'),
    refs: fixture.plain(repo, 'for-each-ref'),
    status: fixture.plain(repo, 'status', '--porcelain=v1', '--ignored'),
    stash: fixture.plain(repo, 'stash', 'list'),
    objects: objects(join(repo, '.git', 'objects')),
    config: readFileSync(join(repo, '.git', 'config'), 'utf8'),
  })
}

async function snap(store: CheckpointStore, repo: string, session = 'session-1'): Promise<{ turn: number; commit: string | null; reason: string | null; notCaptured: string[] }> {
  const turn = await store.beginTurn(repo, session, 'a prompt')
  const taken = await store.capture(repo, session, turn, 'before')
  assert.ok(taken)
  return { turn, commit: taken.commit, reason: taken.reason, notCaptured: taken.notCapturedSample }
}

test('names: a store and a session ref never carry the path or the session id', () => {
  assert.match(storeNameFor('D:\\work\\secret-project'), /^[0-9a-f]{24}$/)
  assert.equal(sessionRefKey('abc..def.lock'), sessionRefKey('abc..def.lock'))
  assert.match(checkpointRef('abc..def.lock', 3, 'before'), /^refs\/checkpoints\/s-[0-9a-f]{24}\/3-before$/)
  assert.throws(() => checkpointRef('x', 0, 'after'))
  assert.equal(turnLabel('\n  fix the build\u0007 now  \nsecond line'), 'fix the build  now')
  assert.equal(turnLabel('x'.repeat(500)).length, 120)
})

test('a capture holds tracked and untracked files, not ignored ones, and leaves the repository untouched', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('plain', (directory) => {
    writeFileSync(join(directory, '.gitignore'), '*.log\n')
    fixture.plain(directory, 'add', '.')
    fixture.plain(directory, 'commit', '-q', '-m', 'ignore')
  })
  writeFileSync(join(repo, 'a.txt'), 'edited\n')
  writeFileSync(join(repo, 'staged.txt'), 'staged\n')
  fixture.plain(repo, 'add', 'staged.txt')
  writeFileSync(join(repo, 'staged.txt'), 'staged then edited\n')
  writeFileSync(join(repo, 'new.txt'), 'untracked\n')
  writeFileSync(join(repo, 'debug.log'), 'ignored\n')
  const before = fingerprint(fixture, repo)

  const first = await snap(store, repo)
  assert.equal(first.reason, null)
  assert.ok(first.commit)
  assert.equal(fingerprint(fixture, repo), before, 'the index, HEAD, refs, objects, config and status are unchanged')
  assert.equal((await store.fileAt(repo, first.commit, 'a.txt'))?.toString(), 'edited\n')
  assert.equal((await store.fileAt(repo, first.commit, 'staged.txt'))?.toString(), 'staged then edited\n', 'the file on disk, not the staged version')
  assert.equal((await store.fileAt(repo, first.commit, 'new.txt'))?.toString(), 'untracked\n')
  assert.equal(await store.fileAt(repo, first.commit, 'debug.log'), null)

  // Nothing changed: the same commit is reused, and nothing new is written.
  const second = await snap(store, repo)
  assert.equal(second.commit, first.commit)

  rmSync(join(repo, 'new.txt'))
  const third = await snap(store, repo)
  assert.notEqual(third.commit, first.commit)
  assert.equal(await store.fileAt(repo, third.commit!, 'new.txt'), null, 'a deleted file is absent from the next snapshot')
  assert.equal((await store.fileAt(repo, first.commit, 'new.txt'))?.toString(), 'untracked\n', 'and still in the earlier one')
  assert.equal(fingerprint(fixture, repo).replace(/\?\? new\.txt\\n/, ''), before.replace(/\?\? new\.txt\\n/, ''))
})

test('a snapshot holds the bytes on disk: no line-ending conversion and no filter program runs', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, store } = made
  const marker = join(fixture.root, 'FILTER_RAN')
  // A filter driver in the person's global config, which the fixture's runner reads for the project.
  writeFileSync(join(fixture.root, 'gitconfig'), readFileSync(join(fixture.root, 'gitconfig'), 'utf8')
    + `[filter "mark"]\n\tclean = "sh -c 'echo ran > \\"${shellPath(marker)}\\"; cat'"\n\trequired = true\n`)
  const repo = fixture.repo('bytes')
  writeFileSync(join(repo, '.gitattributes'), '* text=auto\n*.dat filter=mark\n*.txt eol=lf\n')
  const crlf = Buffer.from('one\r\ntwo\r\n')
  writeFileSync(join(repo, 'windows.txt'), crlf)
  writeFileSync(join(repo, 'data.dat'), 'filtered?\r\n')
  const taken = await snap(store, repo)
  assert.equal(taken.reason, null)
  assert.deepEqual(await store.fileAt(repo, taken.commit!, 'windows.txt'), crlf)
  assert.equal((await store.fileAt(repo, taken.commit!, 'data.dat'))?.toString(), 'filtered?\r\n')
  assert.equal(existsSync(marker), false, 'the filter program did not run')
})

test('the project decides what is eligible on every capture', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('eligible')
  writeFileSync(join(repo, 'notes.txt'), 'public\n')
  const first = await snap(store, repo)
  assert.equal((await store.fileAt(repo, first.commit!, 'notes.txt'))?.toString(), 'public\n')

  // The person now ignores the file and keeps private text in it.
  writeFileSync(join(repo, '.gitignore'), 'notes.txt\nforced.env\n')
  writeFileSync(join(repo, 'notes.txt'), 'private\n')
  writeFileSync(join(repo, 'forced.env'), 'not yet\n')
  const second = await snap(store, repo)
  assert.equal(await store.fileAt(repo, second.commit!, 'notes.txt'), null, 'a file that became ignored drops out')
  assert.equal(await store.fileAt(repo, second.commit!, 'forced.env'), null)

  fixture.plain(repo, 'add', '-f', 'forced.env')
  const third = await snap(store, repo)
  assert.equal((await store.fileAt(repo, third.commit!, 'forced.env'))?.toString(), 'not yet\n', 'a force-added ignored file comes in')
})

test('unborn HEAD, a split index and a SHA-256 repository are all captured', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, store } = made
  const unborn = join(fixture.root, 'unborn')
  mkdirSync(unborn)
  fixture.plain(unborn, 'init', '-q')
  writeFileSync(join(unborn, 'first.txt'), 'no commits yet\n')
  const one = await snap(store, unborn)
  assert.equal((await store.fileAt(unborn, one.commit!, 'first.txt'))?.toString(), 'no commits yet\n')

  const split = fixture.repo('split')
  fixture.plain(split, 'update-index', '--split-index')
  writeFileSync(join(split, 'b.txt'), 'b\n')
  fixture.plain(split, 'add', 'b.txt')
  const two = await snap(store, split)
  assert.equal((await store.fileAt(split, two.commit!, 'b.txt'))?.toString(), 'b\n')

  const sha256 = join(fixture.root, 'sha256')
  mkdirSync(sha256)
  fixture.plain(sha256, 'init', '-q', '--object-format=sha256')
  writeFileSync(join(sha256, 'c.txt'), 'c\n')
  fixture.plain(sha256, 'add', '.')
  fixture.plain(sha256, 'commit', '-q', '-m', 'init')
  const three = await snap(store, sha256)
  assert.equal(three.reason, null)
  assert.equal((await store.fileAt(sha256, three.commit!, 'c.txt'))?.toString(), 'c\n')
})

test('links, oversized files and embedded repositories are left out and named', async (t) => {
  const made = await setup(t, { maxFileBytes: 1_000 })
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('leftout')
  const outside = join(fixture.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'outside the repository\n')
  folderLink(join(repo, 'linked'), outside)
  writeFileSync(join(repo, 'big.bin'), Buffer.alloc(2_000, 1))
  mkdirSync(join(repo, 'embedded'))
  fixture.plain(join(repo, 'embedded'), 'init', '-q')
  writeFileSync(join(repo, 'embedded', 'inner.txt'), 'inner\n')
  writeFileSync(join(repo, 'ok.txt'), 'ok\n')
  const taken = await snap(store, repo)
  assert.equal(taken.reason, null)
  assert.equal((await store.fileAt(repo, taken.commit!, 'ok.txt'))?.toString(), 'ok\n')
  assert.equal(await store.fileAt(repo, taken.commit!, 'linked/secret.txt'), null, 'nothing behind a linked folder is read')
  assert.equal(await store.fileAt(repo, taken.commit!, 'big.bin'), null)
  assert.equal(await store.fileAt(repo, taken.commit!, 'embedded/inner.txt'), null)
  assert.ok(taken.notCaptured.includes('big.bin'))
  assert.ok(taken.notCaptured.some(path => path.startsWith('embedded')))
  assert.ok(taken.notCaptured.some(path => path.startsWith('linked')))
})

test('no checkpoint, with the reason, for a sparse checkout, too many files, too many bytes and a refusal', async (t) => {
  const made = await setup(t, { maxPaths: 3, maxTreeBytes: 50 })
  if (!made) return
  const { fixture, store, root } = made
  const sparse = fixture.repo('sparse')
  fixture.plain(sparse, 'config', 'core.sparseCheckout', 'true')
  assert.match((await snap(store, sparse)).reason ?? '', /sparse checkout/)

  const many = fixture.repo('many')
  for (const name of ['1', '2', '3', '4']) writeFileSync(join(many, `${name}.txt`), name)
  assert.match((await snap(store, many)).reason ?? '', /more than 3 files/)

  const large = fixture.repo('large')
  writeFileSync(join(large, 'b.txt'), 'x'.repeat(100))
  assert.match((await snap(store, large)).reason ?? '', /larger than the checkpoint limit/)

  const refused = fixture.repo('refused')
  const turn = await store.beginTurn(refused, 's', 'p')
  const taken = await store.capture(refused, 's', turn, 'before', { refused: 'This repository needs review in the Git panel' })
  assert.equal(taken?.reason, 'This repository needs review in the Git panel')
  assert.equal(existsSync(join(root, storeNameFor(refused), 'git')), false, 'a refused capture starts no Git at all')
})

test('a turn records both snapshots and its state', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('turns')
  const turn = await store.beginTurn(repo, 's', 'add a file\nwith details')
  await store.capture(repo, 's', turn, 'before')
  writeFileSync(join(repo, 'made.txt'), 'by the agent\n')
  await store.capture(repo, 's', turn, 'after')
  const [record] = (await store.turns(repo)).s!
  assert.equal(record!.label, 'add a file')
  assert.equal(record!.state, 'complete')
  assert.notEqual(record!.before!.commit, record!.after!.commit)
  assert.equal(await store.fileAt(repo, record!.before!.commit!, 'made.txt'), null)
  assert.equal((await store.fileAt(repo, record!.after!.commit!, 'made.txt'))?.toString(), 'by the agent\n')

  const second = await store.beginTurn(repo, 's', 'next')
  assert.equal(second, 2)
  await store.closeOpenTurns()
  const records = (await store.turns(repo)).s!
  assert.equal(records[1]!.state, 'incomplete')
  assert.match(records[1]!.note ?? '', /closed during this turn/)
  assert.equal(records[0]!.state, 'complete')
})

test('prune drops sessions Copilot no longer has, old turns and turns over the cap, and gives the space back', async (t) => {
  const made = await setup(t, { maxTurnsPerSession: 2 })
  if (!made) return
  const { fixture, root } = made
  let now = 1_000_000_000_000
  const store = new CheckpointStore({ root, runner: fixture.runner, limits: { maxTurnsPerSession: 2 }, now: () => now })
  const repo = fixture.repo('prune')
  for (let index = 0; index < 4; index++) {
    writeFileSync(join(repo, 'blob.bin'), randomBytes(300_000))
    const turn = await store.beginTurn(repo, 'kept', `turn ${index}`)
    await store.capture(repo, 'kept', turn, 'before')
    await store.capture(repo, 'kept', turn, 'after')
    now += 1_000
  }
  writeFileSync(join(repo, 'blob.bin'), randomBytes(300_000))
  const gone = await store.beginTurn(repo, 'gone', 'from a deleted session')
  await store.capture(repo, 'gone', gone, 'before')
  await store.capture(repo, 'gone', gone, 'after')
  const directory = store.storeDirectory(repo)
  const bytesBefore = await folderBytes(directory)
  assert.ok(bytesBefore > 1_400_000, 'five different 300 kB files are stored')

  const report = await store.prune({ sessionExists: id => id === 'kept' })
  assert.equal(report.removedTurns, 3)
  const turns = await store.turns(repo)
  assert.deepEqual(Object.keys(turns), ['kept'])
  assert.deepEqual(turns.kept!.map(turn => turn.n), [3, 4])
  const bytesAfter = await folderBytes(directory)
  assert.ok(bytesAfter < bytesBefore - 500_000, `space was reclaimed (${bytesBefore} -> ${bytesAfter})`)
  assert.ok((await store.fileAt(repo, turns.kept![1]!.after!.commit!, 'blob.bin'))?.length === 300_000, 'kept turns still read')

  now += 40 * 24 * 60 * 60 * 1000
  const aged = await store.prune({ sessionExists: () => true })
  assert.equal(aged.deletedStores, 1, 'a store with nothing left is deleted')
  assert.equal(existsSync(directory), false)
})

test('prune enforces the size cap, deletes a store whose folder is gone, and clear deletes everything', async (t) => {
  const made = await setup(t, { maxStoreBytes: 500_000 })
  if (!made) return
  const { fixture, store, root } = made
  const repo = fixture.repo('cap')
  for (let index = 0; index < 3; index++) {
    writeFileSync(join(repo, 'blob.bin'), randomBytes(300_000))
    const turn = await store.beginTurn(repo, 's', `turn ${index}`)
    await store.capture(repo, 's', turn, 'before')
    await store.capture(repo, 's', turn, 'after')
  }
  await store.prune({ sessionExists: () => true })
  const left = (await store.turns(repo)).s ?? []
  assert.ok(left.length < 3, 'old turns went to get under the cap')
  if (existsSync(store.storeDirectory(repo))) assert.ok(await folderBytes(store.storeDirectory(repo)) <= 500_000)

  const vanished = fixture.repo('vanished')
  await snap(store, vanished)
  const other = fixture.repo('other')
  await snap(store, other)
  rmSync(vanished, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await store.prune({ sessionExists: () => true })
  assert.equal(existsSync(store.storeDirectory(vanished)), false)
  assert.equal(existsSync(store.storeDirectory(other)), true)

  // Something that is not a store is never deleted.
  mkdirSync(join(root, 'not-a-store'))
  writeFileSync(join(root, 'not-a-store', 'keep.txt'), 'keep')
  await store.clear()
  assert.equal(existsSync(store.storeDirectory(other)), false)
  assert.equal(statSync(join(root, 'not-a-store', 'keep.txt')).size, 4)
})
