import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { isLocalFilesystemPath, isPathWithinRoot, isSessionTabId, parseSafeHttpUrl } from './external-targets.js'

test('isLocalFilesystemPath rejects UNC and device paths without rejecting local drives', () => {
  for (const candidate of ['\\\\server\\share\\file.txt', '//server/share/file.txt', '\\\\?\\C:\\secret', '\\??\\C:\\secret']) {
    assert.equal(isLocalFilesystemPath(candidate, 'win32'), false, candidate)
  }
  assert.equal(isLocalFilesystemPath('C:\\work\\file.txt', 'win32'), true)
  assert.equal(isLocalFilesystemPath('relative\\file.txt', 'win32'), true)
  // Elsewhere a network mount is an ordinary folder: only an empty path or a NUL is refused.
  assert.equal(isLocalFilesystemPath('/home/me/work', 'linux'), true)
  assert.equal(isLocalFilesystemPath('', 'darwin'), false)
  assert.equal(isLocalFilesystemPath('/tmp/a\0b', 'darwin'), false)
})

test('parseSafeHttpUrl rejects non-web schemes and embedded credentials', () => {
  assert.equal(parseSafeHttpUrl('https://example.com/path').href, 'https://example.com/path')
  assert.throws(() => parseSafeHttpUrl('https://trusted.example@evil.example'), /embedded credentials/)
  assert.throws(() => parseSafeHttpUrl('file:///secret'), /HTTP or HTTPS/)
})

test('session tab IDs cannot traverse log directories', () => {
  assert.equal(isSessionTabId('tab-42'), true)
  assert.equal(isSessionTabId('..\\..\\outside'), false)
  assert.equal(isSessionTabId('tab-0'), false)
})

test('revealed paths must remain inside their owning workspace', () => {
  const root = resolve('/work/repo')
  assert.equal(isPathWithinRoot(root, join(root, 'src', 'file.ts')), true)
  assert.equal(isPathWithinRoot(root, root), true)
  assert.equal(isPathWithinRoot(root, join(root, '..', 'outside.txt')), false)
  assert.equal(isPathWithinRoot(root, `${root}-sibling`), false)
  if (process.platform === 'win32') assert.equal(isPathWithinRoot('C:\\work\\repo', 'D:\\outside.txt'), false)
})
