import assert from 'node:assert/strict'
import test from 'node:test'
import { linkAtColumn, scanLineForLinks } from '../renderer/terminal-links.js'

test('scanLineForLinks finds a bare https URL and trims trailing punctuation', () => {
  const links = scanLineForLinks('See https://github.com/github/copilot-cli/issues/42.')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.type, 'url')
  assert.equal(links[0]?.text, 'https://github.com/github/copilot-cli/issues/42')
})

test('scanLineForLinks finds an absolute Windows path', () => {
  const links = scanLineForLinks(String.raw`Wrote C:\Users\dev\project\build\icon.png`)
  assert.equal(links.length, 1)
  assert.equal(links[0]?.type, 'path')
  assert.equal(links[0]?.text, String.raw`C:\Users\dev\project\build\icon.png`)
})

test('scanLineForLinks finds a bare relative path with an extension', () => {
  const links = scanLineForLinks(String.raw`dist\src\renderer\app.js 1.6mb`)
  assert.equal(links.length, 1)
  assert.equal(links[0]?.text, String.raw`dist\src\renderer\app.js`)
})

test('scanLineForLinks does not match ordinary prose', () => {
  assert.deepEqual(scanLineForLinks('Do you trust the files in this folder?'), [])
})

test('scanLineForLinks does not double-count a path inside a URL', () => {
  const links = scanLineForLinks('https://example.test/a/b/c.txt for details')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.type, 'url')
})

test('linkAtColumn only matches within the link range', () => {
  const line = 'open https://example.test now'
  const link = linkAtColumn(line, 6)
  assert.equal(link?.text, 'https://example.test')
  assert.equal(linkAtColumn(line, 0), null)
  assert.equal(linkAtColumn(line, line.length - 1), null)
})
