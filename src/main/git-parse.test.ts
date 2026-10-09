import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boundText, groupStatusEntries, isSupportedGitVersion, parseGitVersion, parseLog, parseNumstat, parseStagedRaw, parseStatusV2, splitNul,
} from './git-parse.js'

const rec = (...parts: string[]): string => parts.join('\0') + '\0'
const H = '0'.repeat(40)
const T = '1'.repeat(40)

test('parseGitVersion reads Git for Windows and plain versions', () => {
  assert.deepEqual(parseGitVersion('git version 2.55.0.windows.5\n'), { major: 2, minor: 55, patch: 0, text: 'git version 2.55.0.windows.5' })
  assert.equal(parseGitVersion('git version 2.30.0')?.minor, 30)
  assert.equal(parseGitVersion('not git'), null)
  assert.equal(isSupportedGitVersion({ major: 2, minor: 30, patch: 0 }), true)
  assert.equal(isSupportedGitVersion({ major: 2, minor: 29, patch: 9 }), false)
  assert.equal(isSupportedGitVersion({ major: 3, minor: 0, patch: 0 }), true)
  assert.equal(isSupportedGitVersion({ major: 1, minor: 99, patch: 0 }), false)
})

test('splitNul drops only the trailing terminator', () => {
  assert.deepEqual(splitNul('a\0b\0'), ['a', 'b'])
  assert.deepEqual(splitNul('a\0\0b'), ['a', '', 'b'])
  assert.deepEqual(splitNul(''), [])
})

test('parseStatusV2 reads branch headers, upstream and ahead/behind', () => {
  const status = parseStatusV2(rec('# branch.oid ' + T, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1'))
  assert.deepEqual(status.branch, { oid: T, head: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 1 })
  assert.equal(status.entries.length, 0)
})

test('parseStatusV2 handles an initial commit, a detached head and no upstream', () => {
  const initial = parseStatusV2(rec('# branch.oid (initial)', '# branch.head main'))
  assert.equal(initial.branch.oid, null)
  assert.equal(initial.branch.upstream, null)
  assert.equal(initial.branch.ahead, null)
  const detached = parseStatusV2(rec('# branch.oid ' + T, '# branch.head (detached)'))
  assert.equal(detached.branch.detached, true)
  assert.equal(detached.branch.head, null)
})

test('parseStatusV2 parses ordinary, renamed, unmerged, untracked and ignored entries', () => {
  const output = rec(
    '# branch.oid ' + T, '# branch.head main',
    `1 .M N... 100644 100644 100644 ${H} ${H} src/app.ts`,
    `1 A. N... 000000 100644 100644 ${H} ${T} new file.txt`,
    `2 R. N... 100644 100644 100644 ${H} ${T} R100 renamed to.txt`, 'old name.txt',
    `u UU N... 100644 100644 100644 100644 ${H} ${H} ${T} conflict.txt`,
    '? untracked dir/', '? docs/new.md', '! ignored.log',
  )
  const status = parseStatusV2(output)
  assert.equal(status.malformed, 0)
  assert.deepEqual(status.entries.map(entry => [entry.kind, entry.path, entry.index, entry.worktree]), [
    ['changed', 'src/app.ts', '.', 'M'],
    ['changed', 'new file.txt', 'A', '.'],
    ['renamed', 'renamed to.txt', 'R', '.'],
    ['unmerged', 'conflict.txt', 'U', 'U'],
    ['untracked', 'untracked dir/', '.', '?'],
    ['untracked', 'docs/new.md', '.', '?'],
    ['ignored', 'ignored.log', '.', '!'],
  ])
  assert.equal(status.entries[2]?.originalPath, 'old name.txt')
  assert.equal(status.entries[4]?.isDirectory, true)
  assert.equal(status.entries[5]?.isDirectory, false)
})

test('parseStatusV2 keeps paths with spaces, unicode and newlines intact', () => {
  const output = rec(`1 .M N... 100644 100644 100644 ${H} ${H} dir/名前 with  spaces.txt`, `1 .M N... 100644 100644 100644 ${H} ${H} odd\nname.txt`)
  assert.deepEqual(parseStatusV2(output).entries.map(entry => entry.path), ['dir/名前 with  spaces.txt', 'odd\nname.txt'])
})

test('parseStatusV2 flags submodule entries and lossy decoding', () => {
  const status = parseStatusV2(rec(`1 .M S.M. 160000 160000 160000 ${H} ${H} vendor/lib`, `? bad�name`))
  assert.equal(status.entries[0]?.submodule, true)
  assert.equal(status.lossyPaths, true)
})

test('parseStatusV2 counts malformed records instead of throwing', () => {
  const status = parseStatusV2(rec('1 .M too short', '2 R. N... 1 2 3 a b R100 only-path-no-original'.slice(0, 20), 'x unknown record', '? '))
  assert.equal(status.entries.length, 0)
  assert.ok(status.malformed >= 3)
})

test('parseStatusV2 caps entries but keeps counting', () => {
  const output = rec(...Array.from({ length: 10 }, (_item, index) => `? file${index}.txt`))
  const status = parseStatusV2(output, 4)
  assert.equal(status.entries.length, 4)
  assert.equal(status.totalEntries, 10)
  assert.equal(status.truncated, true)
})

test('groupStatusEntries puts a staged-and-modified file in both groups', () => {
  const status = parseStatusV2(rec(
    `1 MM N... 100644 100644 100644 ${H} ${T} both.ts`,
    `1 M. N... 100644 100644 100644 ${H} ${T} staged.ts`,
    `1 .D N... 100644 100644 000000 ${H} ${H} gone.ts`,
    `u AA N... 000000 100644 100644 100644 ${H} ${H} ${T} merge.ts`,
    '? new.ts', '! ignored.ts',
  ))
  const groups = groupStatusEntries(status.entries)
  assert.deepEqual(groups.staged.map(entry => entry.path), ['both.ts', 'staged.ts'])
  assert.deepEqual(groups.unstaged.map(entry => entry.path), ['both.ts', 'gone.ts'])
  assert.deepEqual(groups.untracked.map(entry => entry.path), ['new.ts'])
  assert.deepEqual(groups.conflicted.map(entry => entry.path), ['merge.ts'])
})

test('parseNumstat reads counts, binary files and renames', () => {
  const output = '3\t1\tsrc/a.ts\0-\t-\timage.png\0' + '0\t0\t\0old.txt\0new.txt\0'
  assert.deepEqual(parseNumstat(output), [
    { path: 'src/a.ts', originalPath: null, added: 3, deleted: 1, binary: false },
    { path: 'image.png', originalPath: null, added: null, deleted: null, binary: true },
    { path: 'new.txt', originalPath: 'old.txt', added: 0, deleted: 0, binary: false },
  ])
})

test('boundText cuts at a line break and never inside a UTF-8 character', () => {
  assert.deepEqual(boundText(Buffer.from('abc\n'), 100), { text: 'abc\n', truncated: false, totalBytes: 4 })
  const lines = boundText(Buffer.from('one\ntwo\nthree\n'), 9)
  assert.equal(lines.text, 'one\ntwo\n')
  assert.equal(lines.truncated, true)
  const wide = Buffer.from('名'.repeat(10))
  const cut = boundText(wide, 7)
  assert.equal(cut.text, '名名')
  assert.equal(cut.text.includes('�'), false)
})

test('parseLog reads fields, refs and merge parents', () => {
  const f = '\x1f'
  const output = `${T}${f}${H} ${'2'.repeat(40)}${f}Ada${f}2026-10-08T10:00:00+00:00${f}Fix: thing${f}HEAD -> main, origin/main\0`
    + `\n${H}${f}${f}Bob${f}2026-10-07T09:00:00+00:00${f}Initial${f}\0`
  const entries = parseLog(output)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0]?.parents, [H, '2'.repeat(40)])
  assert.deepEqual(entries[0]?.refs, ['HEAD -> main', 'origin/main'])
  assert.equal(entries[1]?.subject, 'Initial')
  assert.deepEqual(entries[1]?.parents, [])
  assert.deepEqual(parseLog('garbage\0'), [])
})

test('staged entries carry the object id of the staged version, so restaging different content is a different list', () => {
  const idA = 'a'.repeat(40)
  const idB = 'b'.repeat(40)
  const status = parseStatusV2(rec(
    `1 M. N... 100644 100644 100644 ${H} ${idA} staged.ts`,
    `1 .M N... 100644 100644 100644 ${H} ${idB} edited.ts`,
    `2 R. N... 100644 100644 100644 ${H} ${idB} R100 to.txt`, 'from.txt',
    '? new.ts',
    `u UU N... 100644 100644 100644 100644 ${H} ${H} ${T} merge.ts`,
  ))
  assert.deepEqual(status.entries.map(entry => entry.indexOid), [idA, null, idB, null, null], 'only entries with something staged have one')
  const restaged = parseStatusV2(rec(`1 M. N... 100644 100644 100644 ${H} ${idB} staged.ts`))
  assert.notDeepEqual(restaged.entries[0], status.entries[0], 'the same name with different staged content is a different entry')
})

test('parseStagedRaw reads modes and paths, including a submodule entry and a path with spaces', () => {
  const oid = 'a'.repeat(40)
  const output = `:100644 100644 ${oid} ${oid} M\0a.txt\0:160000 160000 ${oid} ${oid} M\0sub\0:000000 100644 ${'0'.repeat(40)} ${oid} A\0dir/with space.txt\0`
  assert.deepEqual(parseStagedRaw(output), [
    { path: 'a.txt', oldMode: '100644', newMode: '100644' },
    { path: 'sub', oldMode: '160000', newMode: '160000' },
    { path: 'dir/with space.txt', oldMode: '000000', newMode: '100644' },
  ])
  assert.deepEqual(parseStagedRaw(''), [])
})
