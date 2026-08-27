import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLogicalLine,
  scanLineForLinks,
  type BufferLineLike,
} from '../renderer/terminal-links.js'

test('scanLineForLinks finds a bare https URL and trims trailing punctuation', () => {
  const links = scanLineForLinks('See https://github.com/github/copilot-cli/issues/42.')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.type, 'url')
  assert.equal(links[0]?.text, 'https://github.com/github/copilot-cli/issues/42')
})

test('scanLineForLinks preserves a URL whose path legitimately ends with a balanced paren', () => {
  const links = scanLineForLinks('https://en.wikipedia.org/wiki/Function_(mathematics)')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.text, 'https://en.wikipedia.org/wiki/Function_(mathematics)')
})

test('scanLineForLinks strips only the wrapping sentence parenthesis, not the URL\'s own', () => {
  const links = scanLineForLinks('(see https://en.wikipedia.org/wiki/Function_(mathematics))')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.text, 'https://en.wikipedia.org/wiki/Function_(mathematics)')
})

test('scanLineForLinks preserves an IPv6 host bracket', () => {
  const links = scanLineForLinks('Listening on https://[::1]:8443/health')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.text, 'https://[::1]:8443/health')
})

test('scanLineForLinks treats a quoted path with spaces as one link', () => {
  const links = scanLineForLinks(String.raw`Running "C:\Program Files\Git\bin\git.exe" --version`)
  assert.equal(links.length, 1)
  assert.equal(links[0]?.type, 'path')
  assert.equal(links[0]?.text, String.raw`C:\Program Files\Git\bin\git.exe`)
})

test('scanLineForLinks strips a trailing line:column location suffix from a path', () => {
  const links = scanLineForLinks(String.raw`C:\repo\src\main.ts:42:7 - error TS2322`)
  assert.equal(links.length, 1)
  assert.equal(links[0]?.text, String.raw`C:\repo\src\main.ts`)
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

function asciiLine(text: string, isWrapped = false): BufferLineLike {
  return {
    isWrapped,
    getCell: (column) => column < text.length ? { getChars: () => text[column]!, getWidth: () => 1 } : undefined,
  }
}

test('buildLogicalLine maps a wide character before a link to the correct cells', () => {
  const cells = [
    { chars: '界', width: 2 },
    { chars: '', width: 0 },
    { chars: ' ', width: 1 },
    ...'https://example.test'.split('').map((char) => ({ chars: char, width: 1 })),
  ]
  const line: BufferLineLike = {
    isWrapped: false,
    getCell: (column) => cells[column] ? { getChars: () => cells[column]!.chars, getWidth: () => cells[column]!.width } : undefined,
  }
  const logical = buildLogicalLine((row) => (row === 0 ? line : undefined), 40, 0)
  assert.equal(logical.text, '界 https://example.test')

  const link = scanLineForLinks(logical.text)[0]
  assert.equal(link?.text, 'https://example.test')
  assert.deepEqual(logical.cells[link!.start], { row: 0, column: 3, width: 1 })
  assert.deepEqual(logical.cells[link!.end - 1], { row: 0, column: 22, width: 1 })
})

test('buildLogicalLine reassembles and maps a URL across a soft wrap', () => {
  const rowOne = asciiLine('See https://example.c', false)
  const rowTwo = asciiLine('om/very/long/path', true)
  const getLine = (row: number): BufferLineLike | undefined => (row === 0 ? rowOne : row === 1 ? rowTwo : undefined)

  const logicalFromRowOne = buildLogicalLine(getLine, 22, 0)
  const logicalFromRowTwo = buildLogicalLine(getLine, 22, 1)
  assert.equal(logicalFromRowOne.text, 'See https://example.com/very/long/path')
  assert.equal(logicalFromRowTwo.text, logicalFromRowOne.text)

  const link = scanLineForLinks(logicalFromRowTwo.text)[0]
  assert.equal(link?.text, 'https://example.com/very/long/path')
  assert.deepEqual(logicalFromRowTwo.cells[link!.start], { row: 0, column: 4, width: 1 })
  assert.deepEqual(logicalFromRowTwo.cells[link!.end - 1], { row: 1, column: 16, width: 1 })
})

test('buildLogicalLine maps a wide character inside a link to its full display width', () => {
  const cells = [
    { chars: 'C', width: 1 },
    { chars: ':', width: 1 },
    { chars: '\\', width: 1 },
    { chars: '界', width: 2 },
    { chars: '', width: 0 },
    { chars: '\\', width: 1 },
    ...'file.txt'.split('').map((char) => ({ chars: char, width: 1 })),
  ]
  const line: BufferLineLike = {
    isWrapped: false,
    getCell: (column) => cells[column] ? { getChars: () => cells[column]!.chars, getWidth: () => cells[column]!.width } : undefined,
  }
  const logical = buildLogicalLine((row) => (row === 0 ? line : undefined), 20, 0)
  assert.equal(logical.text, String.raw`C:\界\file.txt`)

  const link = scanLineForLinks(logical.text)[0]
  assert.equal(link?.text, String.raw`C:\界\file.txt`)
  assert.deepEqual(logical.cells[link!.start], { row: 0, column: 0, width: 1 })
  assert.deepEqual(logical.cells[link!.end - 1], { row: 0, column: 13, width: 1 })
  assert.deepEqual(logical.cells[3], { row: 0, column: 3, width: 2 })
})
