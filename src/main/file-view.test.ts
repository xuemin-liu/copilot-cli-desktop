import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canOpenWithDefaultApp, classifyFile, decodeText, FILE_IMAGE_LIMIT, FILE_TEXT_LIMIT, fileTabKey, FileWatchers, locateInRoots, normalizeRelativePath,
  readFileAsset, readFileView, resolveInRoot,
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
    assert.equal(locateInRoots([root], root), null, 'the root itself is not a file')
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

test('reading a file gives its view, and nothing when it has not changed', async () => {
  const { base, root } = await fixture()
  try {
    const text = await readFileView(root, 'app.ts')
    assert.ok(text.status === 'ok' && text.kind === 'text')
    assert.equal(text.text, 'export const answer = 42\n')
    assert.equal(text.language, 'typescript')
    assert.equal(text.path, join(root, 'app.ts'))
    assert.equal(text.openable, true)
    assert.deepEqual(await readFileView(root, 'app.ts', { mtimeMs: text.mtimeMs, size: text.size }), { status: 'unchanged' })
    assert.equal((await readFileView(root, 'app.ts', { mtimeMs: text.mtimeMs, size: text.size + 1 })).status, 'ok')

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
    watchers.watch('tab', file)
    await new Promise(done => setTimeout(done, 100))
    assert.deepEqual(seen, [], 'watching alone reports nothing')

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
