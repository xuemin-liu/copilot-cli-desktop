import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CheckpointStore, checkpointRef, clearCheckpointFolder, folderBytes, sessionRefKey, storeNameFor, turnLabel, type CheckpointLimits } from './checkpoint-store.js'
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
  // The value Git would use decides: a later `false` wins over an earlier `true`, and a bare key means true.
  appendFileSync(join(sparse, '.git', 'config'), '[core]\n\tsparseCheckout = false\n')
  assert.equal((await snap(store, sparse)).reason, null)
  const bare = fixture.repo('sparse-bare')
  appendFileSync(join(bare, '.git', 'config'), '[index]\n\tsparse\n')
  assert.match((await snap(store, bare)).reason ?? '', /sparse checkout/)

  const many = fixture.repo('many')
  for (const name of ['1', '2', '3', '4']) writeFileSync(join(many, `${name}.txt`), name)
  assert.match((await snap(store, many)).reason ?? '', /more than 3 files/)

  const large = fixture.repo('large')
  writeFileSync(join(large, 'b.txt'), 'x'.repeat(100))
  assert.match((await snap(store, large)).reason ?? '', /larger than the checkpoint limit/)

  const refused = fixture.repo('refused')
  const turn = await store.beginTurn(refused, 's', 'p')
  const taken = await store.capture(refused, 's', turn, 'before', { gate: async () => 'This repository needs review in the Git panel' })
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
  // Taken with roomy caps, as by an older run; pruned by a store with a cap of two turns.
  const roomy = new CheckpointStore({ root, runner: fixture.runner, now: () => now })
  const store = new CheckpointStore({ root, runner: fixture.runner, limits: { maxTurnsPerSession: 2 }, now: () => now })
  const repo = fixture.repo('prune')
  for (let index = 0; index < 4; index++) {
    writeFileSync(join(repo, 'blob.bin'), randomBytes(300_000))
    const turn = await roomy.beginTurn(repo, 'kept', `turn ${index}`)
    await roomy.capture(repo, 'kept', turn, 'before')
    await roomy.capture(repo, 'kept', turn, 'after')
    now += 1_000
  }
  writeFileSync(join(repo, 'blob.bin'), randomBytes(300_000))
  const gone = await roomy.beginTurn(repo, 'gone', 'from a deleted session')
  await roomy.capture(repo, 'gone', gone, 'before')
  await roomy.capture(repo, 'gone', gone, 'after')
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

test('a snapshot can be discarded until its last file has been read, and nothing of it is recorded', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, root } = made
  let listed = 0
  class Watched extends CheckpointStore {
    override async eligiblePaths(worktreeRoot: string, signal?: AbortSignal) { const found = await super.eligiblePaths(worktreeRoot, signal); listed++; return found }
  }
  const store = new Watched({ root, runner: fixture.runner })
  const repo = fixture.repo('discard')
  const turn = await store.beginTurn(repo, 's', 'p')
  await store.capture(repo, 's', turn, 'before')
  writeFileSync(join(repo, 'late.txt'), 'belongs to the next turn\n')
  // Wanted when the capture starts, unwanted by the time Git has listed the files.
  const asked: number[] = []
  const taken = await store.capture(repo, 's', turn, 'after', { skip: () => { asked.push(listed); return listed === 2 } })
  assert.equal(taken, null)
  assert.deepEqual(asked, [1, 2], 'asked before the capture and again after the files were read')
  const [record] = (await store.turns(repo)).s!
  assert.equal(record!.after, null)
  assert.equal(record!.state, 'open')
  const refs = fixture.plain(join(store.storeDirectory(repo), 'empty'), `--git-dir=${join(store.storeDirectory(repo), 'git')}`, 'for-each-ref', '--format=%(refname)').trim().split('\n')
  assert.equal(refs.length, 1, 'only the start snapshot has a ref')
  // A later capture is not confused by the discarded one.
  const next = await store.capture(repo, 's', turn, 'after')
  assert.equal((await store.fileAt(repo, next!.commit!, 'late.txt'))?.toString(), 'belongs to the next turn\n')
})

test('the turn caps hold after every turn, and space comes back while the app stays open', async (t) => {
  const made = await setup(t, { maxTurnsPerSession: 2 })
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('open')
  const sizes: number[] = []
  for (let index = 0; index < 12; index++) {
    writeFileSync(join(repo, 'blob.bin'), randomBytes(300_000))
    const turn = await store.beginTurn(repo, 's', `turn ${index}`)
    await store.capture(repo, 's', turn, 'before')
    await store.capture(repo, 's', turn, 'after')
    // No prune call: the end snapshot enforces the caps by itself.
    assert.ok((await store.turns(repo)).s!.length <= 2, `after turn ${index + 1}`)
    sizes.push(await folderBytes(store.storeDirectory(repo)))
  }
  assert.deepEqual((await store.turns(repo)).s!.map(turn => turn.n), [11, 12])
  const peak = Math.max(...sizes)
  assert.ok(peak < 12 * 300_000, `never all twelve files at once (peak ${peak})`)
  // Space is reclaimed once ten turns have ended: the store shrinks then, with no restart and no prune call.
  assert.ok(sizes[9]! < sizes[8]! - 1_500_000, `space was reclaimed without a restart (${sizes.join(', ')})`)
  assert.ok((await store.fileAt(repo, (await store.turns(repo)).s![1]!.after!.commit!, 'blob.bin'))?.length === 300_000)
})

test('deleting the checkpoint folder needs no Git, leaves other folders, and reports a store it could not delete', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { root } = made
  const first = join(root, 'a'.repeat(24))
  const second = join(root, 'b'.repeat(24))
  for (const folder of [first, second, join(root, 'not-a-store')]) { mkdirSync(join(folder, 'git'), { recursive: true }); writeFileSync(join(folder, 'git', 'x'), 'x') }
  writeFileSync(join(root, 'c'.repeat(24)), 'a file, not a store')
  await assert.rejects(() => clearCheckpointFolder(root, async folder => { if (folder === first) throw new Error('busy'); rmSync(folder, { recursive: true }) }), /1 checkpoint store could not be deleted/)
  assert.equal(existsSync(first), true)
  assert.equal(existsSync(second), false, 'the others are still deleted')
  await clearCheckpointFolder(root)
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(join(root, 'not-a-store', 'git', 'x')), true)
  assert.equal(existsSync(join(root, 'c'.repeat(24))), true)
  await clearCheckpointFolder(join(root, 'missing'))
})

test('a store with a turn still running is never deleted for its size, and a turn whose record is gone gets nothing', async (t) => {
  const made = await setup(t, { maxStoreBytes: 100_000 })
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('running')
  writeFileSync(join(repo, 'blob.bin'), randomBytes(300_000))
  const turn = await store.beginTurn(repo, 's', 'still running')
  const before = await store.capture(repo, 's', turn, 'before')
  // The startup prune runs while the turn is open, and the store is over its size cap.
  const report = await store.prune({ sessionExists: () => true })
  assert.equal(report.deletedStores, 0)
  assert.equal((await store.turns(repo)).s![0]!.state, 'open')
  assert.equal((await store.fileAt(repo, before!.commit!, 'blob.bin'))?.length, 300_000, 'its start snapshot still reads')

  // The store is deleted (the feature was turned off) while a capture for the turn is still on its way.
  await store.clear()
  let gateAsked = false
  assert.equal(await store.capture(repo, 's', turn, 'after', { gate: async () => { gateAsked = true; return null } }), null)
  assert.equal(gateAsked, false, 'no Git is run for it')
  assert.equal(existsSync(store.storeDirectory(repo)), false, 'and nothing is written back')
})

test('clear deletes each store inside its queue, a store whose first write is still queued too', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, store } = made
  const busy = fixture.repo('busy')
  const turn = await store.beginTurn(busy, 's', 'p')
  const fresh = fixture.repo('fresh')
  // A capture is under way in one store, and another store's very first write is queued and not on disk yet.
  const capture = store.capture(busy, 's', turn, 'before')
  const begun = store.beginTurn(fresh, 's', 'p')
  assert.equal(existsSync(store.storeDirectory(fresh)), false)
  await store.clear()
  await Promise.all([capture, begun])
  assert.equal(existsSync(store.storeDirectory(busy)), false)
  assert.equal(existsSync(store.storeDirectory(fresh)), false, 'deleted after its queued write, not missed')
  // Work that was queued behind the delete finds no record and writes nothing back.
  assert.equal(await store.capture(fresh, 's', await begun, 'before'), null)
  assert.equal(existsSync(store.storeDirectory(fresh)), false)
})

test('the Turns list: newest first, with the files and the patch of a turn, read from the store alone', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('listed')
  writeFileSync(join(repo, 'gone.txt'), 'to be deleted\n')
  writeFileSync(join(repo, 'picture.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  assert.deepEqual(await store.listTurns(repo), [], 'nothing before the first turn, and nothing is created by asking')
  assert.equal(existsSync(store.storeDirectory(repo)), false)

  const first = await store.beginTurn(repo, 'one', 'edit three files\nand more')
  await store.capture(repo, 'one', first, 'before')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'new file.txt'), 'added\n')
  rmSync(join(repo, 'gone.txt'))
  writeFileSync(join(repo, 'picture.bin'), Buffer.from([0, 9, 9, 9, 0, 255]))
  await store.capture(repo, 'one', first, 'after')
  const quiet = await store.beginTurn(repo, 'two', 'just a question')
  await store.capture(repo, 'two', quiet, 'before')
  await store.capture(repo, 'two', quiet, 'after')
  const refused = await store.beginTurn(repo, 'two', 'held')
  await store.capture(repo, 'two', refused, 'before', { gate: async () => 'This repository needs review' })
  await store.capture(repo, 'two', refused, 'after', { gate: async () => 'This repository needs review' })
  const running = await store.beginTurn(repo, 'one', 'still going')
  await store.capture(repo, 'one', running, 'before')

  // The project's Git is not needed to read any of it.
  renameSync(join(repo, '.git'), join(repo, 'git-hidden'))
  const turns = await store.listTurns(repo)
  assert.deepEqual(turns.map(turn => [turn.sessionId, turn.n, turn.label, turn.state, turn.diffable, turn.unchanged]), [
    ['one', 2, 'still going', 'open', false, false],
    ['two', 2, 'held', 'incomplete', false, false],
    ['two', 1, 'just a question', 'complete', true, true],
    ['one', 1, 'edit three files', 'complete', true, false],
  ])
  assert.equal(turns[1]!.note, 'This repository needs review')

  const files = await store.turnFiles(repo, 'one', first)
  assert.equal(files.truncated, false)
  assert.equal(files.uncertain, false)
  assert.deepEqual(files.files, [
    { path: 'a.txt', added: 1, deleted: 0, binary: false, leftOut: false },
    { path: 'gone.txt', added: 0, deleted: 1, binary: false, leftOut: false },
    { path: 'new file.txt', added: 1, deleted: 0, binary: false, leftOut: false },
    { path: 'picture.bin', added: null, deleted: null, binary: true, leftOut: false },
  ])
  const patch = await store.turnDiff(repo, 'one', first, 'a.txt')
  assert.match(patch.text, /^diff --git a\/a\.txt b\/a\.txt/)
  assert.match(patch.text, /\n one\n\+two\n$/)
  assert.match((await store.turnDiff(repo, 'one', first, 'new file.txt')).text, /\+added/)
  assert.equal((await store.turnDiff(repo, 'one', first, 'not-changed.txt')).text, '')
  assert.deepEqual(await store.turnFiles(repo, 'two', quiet), { files: [], truncated: false, uncertain: false })
  for (const [session, turn] of [['two', refused], ['one', running], ['one', 99], ['nobody', 1]] as const) {
    await assert.rejects(() => store.turnFiles(repo, session, turn), /no snapshots to compare/)
  }

  // Objects that are gone (space reclaimed, or a damaged store) are reported for that turn, not as a crash.
  rmSync(join(store.storeDirectory(repo), 'git', 'objects'), { recursive: true, force: true })
  mkdirSync(join(store.storeDirectory(repo), 'git', 'objects'))
  await assert.rejects(() => store.turnFiles(repo, 'one', first), /no longer available/)
  await assert.rejects(() => store.turnDiff(repo, 'one', first, 'a.txt'), /no longer available/)
  assert.equal((await store.listTurns(repo)).length, 4, 'the list itself still reads')
  // A store that lost a folder Git runs in is reported the same way, not as a missing Git.
  for (const lost of ['empty', join('git', 'HEAD')]) {
    const path = join(store.storeDirectory(repo), lost)
    renameSync(path, path + '.lost')
    await assert.rejects(() => store.turnFiles(repo, 'one', first), /no longer available/, lost)
    renameSync(path + '.lost', path)
  }
})

test('a file left out of one snapshot of a turn is not shown as added or deleted', async (t) => {
  const made = await setup(t, { maxFileBytes: 1_000 })
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('grown')
  writeFileSync(join(repo, 'shrinks.txt'), 'x'.repeat(2_000))
  // a.txt is small at the start of the turn and over the per-file limit at its end; shrinks.txt is the other way round.
  const turn = await store.beginTurn(repo, 's', 'grow a file')
  await store.capture(repo, 's', turn, 'before')
  writeFileSync(join(repo, 'a.txt'), 'one\n' + 'y'.repeat(2_000))
  writeFileSync(join(repo, 'shrinks.txt'), 'small now\n')
  writeFileSync(join(repo, 'real.txt'), 'really added\n')
  await store.capture(repo, 's', turn, 'after')
  assert.equal(existsSync(join(repo, 'a.txt')), true, 'the file was never deleted')

  const files = await store.turnFiles(repo, 's', turn)
  assert.deepEqual(files.files, [
    { path: 'a.txt', added: null, deleted: null, binary: false, leftOut: true },
    { path: 'real.txt', added: 1, deleted: 0, binary: false, leftOut: false },
    { path: 'shrinks.txt', added: null, deleted: null, binary: false, leftOut: true },
  ])
  assert.equal(files.uncertain, false)
  for (const path of ['a.txt', 'shrinks.txt']) assert.deepEqual(await store.turnDiff(repo, 's', turn, path), { text: '', truncated: false, leftOut: true }, 'no "deleted file" or "new file" patch')
  assert.match((await store.turnDiff(repo, 's', turn, 'real.txt')).text, /new file mode/)

  // A snapshot from before the full list was kept: when more paths were left out than are on record, the turn says so.
  const metaFile = join(store.storeDirectory(repo), 'meta.json')
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
  const record = meta.sessions.s.turns[0]
  delete record.before.notCapturedPaths
  delete record.after.notCapturedPaths
  record.after.notCaptured = 40
  writeFileSync(metaFile, JSON.stringify(meta))
  const older = await store.turnFiles(repo, 's', turn)
  assert.equal(older.uncertain, true)
  assert.equal(older.files.find(file => file.path === 'a.txt')?.leftOut, true, 'a path in the sample is still known')
})

test('a patch is read only up to what is shown', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, root } = made
  const read: number[] = []
  const counting = { run: async (options: Parameters<typeof fixture.runner.run>[0]) => { const result = await fixture.runner.run(options); if (options.args.includes('--patch')) read.push(result.stdout.length); return result } }
  const store = new CheckpointStore({ root, runner: counting as unknown as typeof fixture.runner })
  const repo = fixture.repo('large-patch')
  const turn = await store.beginTurn(repo, 's', 'write a large file')
  await store.capture(repo, 's', turn, 'before')
  writeFileSync(join(repo, 'big.txt'), Array.from({ length: 60_000 }, (_, index) => `line ${index} ${'z'.repeat(50)}`).join('\n') + '\n')
  await store.capture(repo, 's', turn, 'after')
  const patch = await store.turnDiff(repo, 's', turn, 'big.txt')
  assert.equal(patch.truncated, true)
  assert.ok(Buffer.byteLength(patch.text) <= 512 * 1024)
  assert.equal(read.length, 1)
  assert.ok(read[0]! <= 512 * 1024 + 64 * 1024, `Git was stopped near the cap (read ${read[0]} bytes of a 3.8 MB patch)`)
})

test('a tracked folder that is removed or renamed during a turn shows as deleted files, not as left out', async (t) => {
  const made = await setup(t)
  if (!made) return
  const { fixture, store } = made
  const repo = fixture.repo('folders', (directory) => {
    for (const folder of ['nested', join('deep', 'er'), 'renamed-from']) mkdirSync(join(directory, folder), { recursive: true })
    writeFileSync(join(directory, 'nested', 'file.txt'), 'in a folder\n')
    writeFileSync(join(directory, 'deep', 'er', 'file.txt'), 'two levels down\n')
    writeFileSync(join(directory, 'renamed-from', 'file.txt'), 'moves\n')
    fixture.plain(directory, 'add', '.')
    fixture.plain(directory, 'commit', '-q', '-m', 'folders')
  })
  const turn = await store.beginTurn(repo, 's', 'remove folders')
  await store.capture(repo, 's', turn, 'before')
  // Removed without staging: the project's Git still lists the paths, and nothing is on disk.
  rmSync(join(repo, 'nested'), { recursive: true })
  rmSync(join(repo, 'deep'), { recursive: true })
  renameSync(join(repo, 'renamed-from'), join(repo, 'renamed-to'))
  assert.match(fixture.plain(repo, 'status', '--porcelain=v1'), / D nested\/file\.txt/)
  const after = await store.capture(repo, 's', turn, 'after')
  assert.equal(after!.notCaptured, 0, 'a deleted folder leaves nothing out')

  const files = await store.turnFiles(repo, 's', turn)
  assert.equal(files.uncertain, false)
  assert.deepEqual(files.files, [
    { path: 'deep/er/file.txt', added: 0, deleted: 1, binary: false, leftOut: false },
    { path: 'nested/file.txt', added: 0, deleted: 1, binary: false, leftOut: false },
    { path: 'renamed-from/file.txt', added: 0, deleted: 1, binary: false, leftOut: false },
    { path: 'renamed-to/file.txt', added: 1, deleted: 0, binary: false, leftOut: false },
  ])
  const patch = await store.turnDiff(repo, 's', turn, 'nested/file.txt')
  assert.equal(patch.leftOut, false)
  assert.match(patch.text, /deleted file mode/)

  // A folder replaced by a link is still not walked, and its files are left out, not called deleted.
  const outside = join(fixture.root, 'elsewhere')
  mkdirSync(outside)
  writeFileSync(join(outside, 'file.txt'), 'outside the repository\n')
  const next = await store.beginTurn(repo, 's', 'swap a folder for a link')
  await store.capture(repo, 's', next, 'before')
  rmSync(join(repo, 'renamed-to'), { recursive: true })
  folderLink(join(repo, 'renamed-to'), outside)
  const linked = await store.capture(repo, 's', next, 'after')
  assert.ok(linked!.notCapturedSample.includes('renamed-to/file.txt'))
  assert.deepEqual((await store.turnFiles(repo, 's', next)).files, [{ path: 'renamed-to/file.txt', added: null, deleted: null, binary: false, leftOut: true }])
})
