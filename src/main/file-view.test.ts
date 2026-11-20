import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { appendFile, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canOpenWithDefaultApp, classifyFile, decodeText, FILE_ASSET_LIMIT, FILE_IMAGE_LIMIT, FILE_TEXT_LIMIT, fileOpenable, fileTabKey, FileWatchers, isInsideFolder, locateInRoots,
  normalizeRelativePath, openInRoot, readFileAsset, readFileView, readOpened, resolveInRoot,
} from './file-view.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

async function fixture(): Promise<{ base: string; root: string; outside: string }> {
  // realpath: the temp folder is itself reached through a short name or a link on some machines.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'file-view-')))
  const root = join(base, 'workspace'), outside = join(base, 'outside')
  await mkdir(join(root, 'docs', 'img'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(root, 'docs', 'readme.md'), '# Title\n\n![logo](img/logo.png)\n')
  await writeFile(join(root, 'docs', 'img', 'logo.png'), PNG)
  await writeFile(join(root, 'app.ts'), 'export const answer = 42\n')
  await writeFile(join(outside, 'secret.txt'), 'outside the workspace\n')
  await writeFile(join(outside, 'secret.png'), PNG)
  return { base, root, outside }
}

test('the view is chosen from the name and then from the first bytes', () => {
  assert.deepEqual(classifyFile('notes.md', bytes('# hi')), { kind: 'markdown', language: 'markdown', mime: null })
  assert.deepEqual(classifyFile('app.tsx', bytes('const a = 1')), { kind: 'text', language: 'typescript', mime: null })
  assert.deepEqual(classifyFile('Dockerfile', bytes('FROM node')), { kind: 'text', language: 'dockerfile', mime: null })
  assert.deepEqual(classifyFile('LICENSE', bytes('MIT')), { kind: 'text', language: null, mime: null })
  assert.equal(classifyFile('photo.png', PNG).kind, 'image')
  assert.equal(classifyFile('renamed.txt', PNG).mime, 'image/png', 'a picture is known by its bytes whatever it is called')
  assert.deepEqual(classifyFile('logo.svg', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')), { kind: 'image', language: 'xml', mime: 'image/svg+xml' })
  assert.equal(classifyFile('notes.md', new Uint8Array([35, 0, 1, 2])).reason, 'binary', 'a .md holding binary data is not shown as text')
  assert.equal(classifyFile('tool.exe', new Uint8Array([0x4d, 0x5a, 0x90, 0])).kind, 'other')
  assert.equal(classifyFile('script.ps1', new Uint8Array([0xff, 0xfe, 0x61, 0x00])).kind, 'text', 'UTF-16 with a byte order mark is text')
})

test('text is decoded as UTF-8 or as UTF-16 by its byte order mark, without the mark', () => {
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi')
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), 'hi')
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])), 'hi')
})

test('a saved path is kept only when it stays under its root', () => {
  assert.equal(normalizeRelativePath('src\\app.ts'), 'src/app.ts')
  assert.equal(normalizeRelativePath('./src//app.ts'), 'src/app.ts')
  for (const unsafe of ['../app.ts', 'src/../../app.ts', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:/x', '\\\\server\\share\\x', '', '.', 'a\0b', 7, null]) {
    assert.equal(normalizeRelativePath(unsafe), null, String(unsafe))
  }
})

test('programs and scripts are never offered Open with default app', () => {
  for (const name of ['tool.exe', 'setup.MSI', 'run.bat', 'go.ps1', 'x.lnk', 'page.html', 'logo.svg', 'a.jar', 'build.sh', 'app.py', 'Makefile', 'runme']) assert.equal(canOpenWithDefaultApp(name), false, name)
  for (const name of ['report.pdf', 'notes.docx', 'photo.png', 'data.csv', 'readme.md', 'archive.zip']) assert.equal(canOpenWithDefaultApp(name), true, name)
})

test('one key per file, whatever the spelling of its root', () => {
  assert.equal(fileTabKey(join('C:', 'repo'), 'src/app.ts'), fileTabKey(join('C:', 'repo', '.'), 'src/app.ts'))
  assert.notEqual(fileTabKey(join('C:', 'repo'), 'src/app.ts'), fileTabKey(join('C:', 'repo-worktree'), 'src/app.ts'), 'the same path in two worktrees is two files')
})

test('a clicked path belongs to the first root that holds it', async () => {
  const { base, root, outside } = await fixture()
  try {
    assert.deepEqual(locateInRoots([root], join(root, 'docs', 'readme.md')), { root, path: 'docs/readme.md' })
    assert.equal(locateInRoots([root], join(outside, 'secret.txt')), null)
    assert.deepEqual(locateInRoots([root], root), { root, path: '' }, 'the root itself is found, with no path: it can be revealed')
    assert.deepEqual(locateInRoots([root], join(root, 'docs', '..')), { root, path: '' })
    assert.equal(locateInRoots([root], `${root}-other${join('/', 'a.txt')}`), null, 'a folder whose name only starts like the root is outside it')
    const nested = join(root, 'docs')
    assert.deepEqual(locateInRoots([nested, root], join(root, 'docs', 'readme.md')), { root: nested, path: 'readme.md' })
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('a file is read only when it is really inside its root', async () => {
  const { base, root, outside } = await fixture()
  try {
    assert.deepEqual(await resolveInRoot(root, 'app.ts'), { ok: true, absolute: join(root, 'app.ts') })
    assert.deepEqual(await resolveInRoot(root, '../outside/secret.txt'), { ok: false, reason: 'outside' })
    assert.deepEqual(await resolveInRoot(root, 'nope.txt'), { ok: false, reason: 'missing' })
    assert.deepEqual(await resolveInRoot(join(base, 'gone'), 'app.ts'), { ok: false, reason: 'root-missing' })
    // A link inside the root that leads out of it: the path looks inside, the file is not.
    await symlink(outside, join(root, 'escape'), 'junction')
    assert.deepEqual(await resolveInRoot(root, 'escape/secret.txt'), { ok: false, reason: 'outside' })
    assert.deepEqual(await readFileView(root, 'escape/secret.txt'), { status: 'outside' })
    assert.equal(await readFileAsset(root, 'docs/readme.md', '../escape/secret.png'), null)
    // A root that is itself reached through a link still works.
    await symlink(root, join(base, 'linked-root'), 'junction')
    assert.deepEqual(await resolveInRoot(join(base, 'linked-root'), 'app.ts'), { ok: true, absolute: join(base, 'linked-root', 'app.ts') })
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('a link swapped while the file is being opened cannot get a file outside the root read', async () => {
  const { base, root, outside } = await fixture()
  try {
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'note.txt'), 'inside the workspace\n')
    await writeFile(join(outside, 'note.txt'), 'outside the workspace\n')
    const link = join(root, 'swap')
    const point = async (target: string): Promise<void> => { await rm(link, { recursive: true, force: true }); await symlink(target, link, 'junction') }
    await point(join(root, 'real'))
    const still = await readFileView(root, 'swap/note.txt')
    assert.ok(still.status === 'ok' && still.kind === 'text' && still.text === 'inside the workspace\n', 'a link that stays inside the root is read')

    // The path is inside the root when it is checked, outside when it is opened, and inside again when it is checked
    // once more. Only the open file can tell: it is not the file the path now names.
    const swapped = await readFileView(root, 'swap/note.txt', null, { beforeOpen: () => point(outside), afterOpen: () => point(join(root, 'real')) })
    assert.deepEqual(swapped, { status: 'outside' })
    // Outside when opened and still outside afterwards.
    await point(join(root, 'real'))
    assert.deepEqual(await readFileView(root, 'swap/note.txt', null, { beforeOpen: () => point(outside) }), { status: 'outside' })
    // Inside when opened, outside afterwards. The open file is still the one inside the root. Linux can see that from
    // the open file itself and reads it; elsewhere the path no longer leads to the open file, so nothing is read.
    // Either way no byte from outside the root is returned.
    await point(join(root, 'real'))
    const late = await readFileView(root, 'swap/note.txt', null, { afterOpen: () => point(outside) })
    if (process.platform === 'linux') assert.ok(late.status === 'ok' && late.kind === 'text' && late.text === 'inside the workspace\n')
    else assert.deepEqual(late, { status: 'outside' })
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('a folder is inside another by what it is, not by how its name is spelled', async () => {
  const { base, root, outside } = await fixture()
  try {
    assert.equal(await isInsideFolder(join(root, 'docs', 'img', 'logo.png'), root), true)
    assert.equal(await isInsideFolder(join(root, 'app.ts'), root), true)
    assert.equal(await isInsideFolder(join(outside, 'secret.txt'), root), false)
    assert.equal(await isInsideFolder(root, root), false, 'a folder is not inside itself')
    assert.equal(await isInsideFolder(join(root, 'app.ts'), join(base, 'gone')), false)
    await mkdir(`${root}-other`)
    await writeFile(join(`${root}-other`, 'a.txt'), 'x')
    assert.equal(await isInsideFolder(join(`${root}-other`, 'a.txt'), root), false)
    // Where the file system tells names apart by case, "Workspace" is another folder than "workspace", even on a
    // platform (macOS) where names are usually compared without case.
    await mkdir(join(base, 'Workspace')).catch(() => undefined)
    if ((await readdir(base)).includes('Workspace')) {
      await writeFile(join(base, 'Workspace', 'app.ts'), 'the other folder\n')
      assert.equal(await isInsideFolder(join(base, 'Workspace', 'app.ts'), root), false)
      assert.deepEqual(await resolveInRoot(root, '../Workspace/app.ts'), { ok: false, reason: 'outside' })
    }
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('a named pipe where the file was does not leave the read waiting', { skip: process.platform === 'win32' }, async () => {
  const { base, root } = await fixture()
  try {
    execFileSync('mkfifo', [join(root, 'pipe.txt')])
    const result = await Promise.race([readFileView(root, 'pipe.txt'), new Promise<'waiting'>(done => setTimeout(() => done('waiting'), 3_000).unref())])
    assert.deepEqual(result, { status: 'missing' })
    assert.equal(await Promise.race([readFileAsset(root, 'docs/readme.md', '../pipe.txt'), new Promise<'waiting'>(done => setTimeout(() => done('waiting'), 3_000).unref())]), null)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('a read takes memory for the file, not for the limit, and still sees a file that grew', async () => {
  const { base, root } = await fixture()
  try {
    await writeFile(join(root, 'icon.png'), Buffer.concat([PNG, Buffer.alloc(200_000)]))
    const opened = await openInRoot(root, 'icon.png')
    assert.ok(opened.ok)
    try {
      const bytes = await readOpened(opened.file, FILE_ASSET_LIMIT)
      assert.equal(bytes.length, PNG.length + 200_000)
      assert.ok(bytes.buffer.byteLength <= bytes.length + 1, `a ${bytes.length}-byte file was read into a ${bytes.buffer.byteLength}-byte buffer`)
    } finally { await opened.file.handle.close() }

    await writeFile(join(root, 'grows.log'), 'a'.repeat(10_000))
    const growing = await openInRoot(root, 'grows.log')
    assert.ok(growing.ok)
    try {
      await appendFile(join(root, 'grows.log'), 'b'.repeat(50_000))
      assert.equal((await readOpened(growing.file, 1_000_000)).length, 60_000, 'bytes written after the size was taken are read too')
      assert.equal((await readOpened(growing.file, 20_000)).length, 20_001, 'and never more than one byte past the limit')
    } finally { await growing.file.handle.close() }
    assert.deepEqual(await openInRoot(root, 'docs'), { ok: false, reason: 'directory' })
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('reading a file gives its view, and nothing when it has not changed', async () => {
  const { base, root } = await fixture()
  try {
    const text = await readFileView(root, 'app.ts')
    assert.ok(text.status === 'ok' && text.kind === 'text')
    assert.equal(text.text, 'export const answer = 42\n')
    assert.equal(text.language, 'typescript')
    assert.equal(text.path, join(root, 'app.ts'))
    assert.equal(text.openable, true)
    assert.deepEqual(await readFileView(root, 'app.ts', text.revision), { status: 'unchanged' })
    assert.equal((await readFileView(root, 'app.ts', 'another revision')).status, 'ok')
    // Two versions of the same size saved inside one millisecond are still two versions.
    await writeFile(join(root, 'quick.txt'), 'one')
    await utimes(join(root, 'quick.txt'), 1_700_000_000.0002, 1_700_000_000.0002)
    const one = await readFileView(root, 'quick.txt')
    assert.ok(one.status === 'ok' && one.kind === 'text')
    await writeFile(join(root, 'quick.txt'), 'two')
    await utimes(join(root, 'quick.txt'), 1_700_000_000.0008, 1_700_000_000.0008)
    const two = await readFileView(root, 'quick.txt', one.revision)
    assert.ok(two.status === 'ok' && two.kind === 'text' && two.text === 'two', 'the second version is read, not taken for the first')
    assert.equal(Math.trunc(one.mtimeMs), Math.trunc(two.mtimeMs), 'the two times differ by less than a millisecond')

    const markdown = await readFileView(root, 'docs/readme.md')
    assert.ok(markdown.status === 'ok' && markdown.kind === 'markdown')
    const image = await readFileView(root, 'docs/img/logo.png')
    assert.ok(image.status === 'ok' && image.kind === 'image')
    assert.equal(image.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`)

    assert.deepEqual(await readFileView(root, 'docs'), { status: 'directory' })
    assert.deepEqual(await readFileView(root, 'missing.txt'), { status: 'missing' })

    await writeFile(join(root, 'data.bin'), Buffer.from([1, 2, 0, 3]))
    const binary = await readFileView(root, 'data.bin')
    assert.ok(binary.status === 'ok' && binary.kind === 'other' && binary.reason === 'binary')
    // A file with no viewer is only ever revealed, whatever its name says, on the card and in the main process alike.
    await writeFile(join(root, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))
    const archive = await readFileView(root, 'archive.zip')
    assert.ok(archive.status === 'ok' && archive.kind === 'other' && archive.openable === false)
    assert.equal(binary.openable, false)
    assert.equal(await fileOpenable(root, 'archive.zip'), null)
    assert.equal(await fileOpenable(root, 'app.ts'), join(root, 'app.ts'))
    assert.equal(await fileOpenable(root, 'docs/img/logo.png'), join(root, 'docs', 'img', 'logo.png'))
    assert.equal(await fileOpenable(root, 'missing.txt'), null)

    await writeFile(join(root, 'big.log'), 'x')
    await truncate(join(root, 'big.log'), FILE_TEXT_LIMIT)
    await writeFile(join(root, 'big.log'), 'y'.repeat(FILE_TEXT_LIMIT))
    assert.equal((await readFileView(root, 'big.log')).status, 'ok')
    await writeFile(join(root, 'big.log'), 'y'.repeat(FILE_TEXT_LIMIT + 1))
    const large = await readFileView(root, 'big.log')
    assert.ok(large.status === 'ok' && large.kind === 'other' && large.reason === 'too-large', 'one byte over the limit is not read')
    await writeFile(join(root, 'huge.png'), PNG)
    await truncate(join(root, 'huge.png'), FILE_IMAGE_LIMIT + 1)
    const huge = await readFileView(root, 'huge.png')
    assert.ok(huge.status === 'ok' && huge.kind === 'other' && huge.reason === 'too-large')

    await writeFile(join(root, 'run.ps1'), 'Write-Host hi\n')
    const script = await readFileView(root, 'run.ps1')
    assert.ok(script.status === 'ok' && script.kind === 'text' && script.openable === false)
    assert.equal(await fileOpenable(root, 'run.ps1'), null, 'a script is shown as text but never started')
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('a Markdown picture is served only when it is a local picture under the same root', async () => {
  const { base, root } = await fixture()
  try {
    const expected = `data:image/png;base64,${PNG.toString('base64')}`
    assert.equal(await readFileAsset(root, 'docs/readme.md', 'img/logo.png'), expected)
    assert.equal(await readFileAsset(root, 'docs/readme.md', './img/logo.png?raw=true#x'), expected)
    assert.equal(await readFileAsset(root, 'docs/readme.md', '/docs/img/logo.png'), expected, 'a leading slash starts at the root')
    assert.equal(await readFileAsset(root, 'docs/readme.md', 'img%2Flogo.png'), expected)
    assert.equal(await readFileAsset(root, 'docs/readme.md', '../app.ts'), null, 'not a picture')
    assert.equal(await readFileAsset(root, 'docs/readme.md', '../../outside/secret.png'), null, 'outside the root')
    for (const href of ['https://example.com/a.png', '//example.com/a.png', 'file:///C:/Windows/x.png', 'data:image/png;base64,AAAA', 'C:\\Windows\\x.png', 'img/missing.png', '%E0%A4%A', '']) {
      assert.equal(await readFileAsset(root, 'docs/readme.md', href), null, href)
    }
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('a watched file reports edits, a save by rename, and coming back after its folder was removed', async () => {
  const { base, root } = await fixture()
  const seen: string[] = []
  const watchers = new FileWatchers(id => seen.push(id), 40, 60)
  const settle = async (count: number, label: string): Promise<void> => {
    for (let waited = 0; waited < 5_000 && seen.length < count; waited += 20) await new Promise(done => setTimeout(done, 20))
    assert.ok(seen.length >= count, label)
    // Let the burst of events one save makes finish, so the next step starts clean.
    await new Promise(done => setTimeout(done, 150))
    seen.length = 0
  }
  try {
    await mkdir(join(root, 'notes'))
    const file = join(root, 'notes', 'plan.md')
    await writeFile(file, 'one\n')
    // Some systems report changes made just before the watch began; let those pass before counting.
    await new Promise(done => setTimeout(done, 1_200))
    watchers.watch('tab', file)
    await new Promise(done => setTimeout(done, 400))
    seen.length = 0

    await writeFile(file, 'two\n')
    await settle(1, 'an edit in place')

    await writeFile(join(root, 'notes', 'other.md'), 'unrelated\n')
    await new Promise(done => setTimeout(done, 200))
    assert.deepEqual(seen, [], 'another file in the folder is not this file')

    await writeFile(`${file}.tmp`, 'three\n')
    await rename(`${file}.tmp`, file)
    await settle(1, 'a save that replaces the file')
    await writeFile(file, 'four\n')
    await settle(1, 'still watched after the file was replaced')

    await rm(join(root, 'notes'), { recursive: true, force: true })
    await settle(1, 'the folder was removed')
    await new Promise(done => setTimeout(done, 300))
    assert.deepEqual(seen, [], 'a missing folder is reported once, not again on every retry')
    await mkdir(join(root, 'notes'))
    await writeFile(file, 'five\n')
    await settle(1, 'the folder came back')

    watchers.unwatch('tab')
    assert.equal(watchers.has('tab'), false)
    await writeFile(file, 'six\n')
    await new Promise(done => setTimeout(done, 200))
    assert.deepEqual(seen, [], 'nothing is reported after the tab stops watching')
  } finally { watchers.stop(); await rm(base, { recursive: true, force: true }) }
})
