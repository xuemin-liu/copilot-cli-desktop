import assert from 'node:assert/strict'
import test from 'node:test'
import { isLocalFilesystemPath, isPathWithinRoot, isSessionTabId, parseSafeHttpUrl } from './external-targets.js'

test('isLocalFilesystemPath rejects UNC and device paths without rejecting local drives', () => {
  for (const candidate of ['\\\\server\\share\\file.txt', '//server/share/file.txt', '\\\\?\\C:\\secret', '\\??\\C:\\secret']) {
    assert.equal(isLocalFilesystemPath(candidate), false, candidate)
  }
  assert.equal(isLocalFilesystemPath('C:\\work\\file.txt'), true)
  assert.equal(isLocalFilesystemPath('relative\\file.txt'), true)
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
  assert.equal(isPathWithinRoot('C:\\work\\repo', 'C:\\work\\repo\\src\\file.ts'), true)
  assert.equal(isPathWithinRoot('C:\\work\\repo', 'C:\\work\\repo'), true)
  assert.equal(isPathWithinRoot('C:\\work\\repo', 'C:\\work\\outside.txt'), false)
  assert.equal(isPathWithinRoot('C:\\work\\repo', 'D:\\outside.txt'), false)
})
