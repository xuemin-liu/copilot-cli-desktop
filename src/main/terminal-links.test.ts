import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLogicalLine,
  cellIndexAt,
  findTextRow,
  isWithinScreenBounds,
  linkAtColumn,
  scanLineForLinks,
  segmentsForLink,
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

test('linkAtColumn only matches within the link range', () => {
  const line = 'open https://example.test now'
  const link = linkAtColumn(line, 6)
  assert.equal(link?.text, 'https://example.test')
  assert.equal(linkAtColumn(line, 0), null)
  assert.equal(linkAtColumn(line, line.length - 1), null)
})

function asciiLine(text: string, isWrapped = false): BufferLineLike {
  return {
    isWrapped,
    getCell: (column) => column < text.length ? { getChars: () => text[column]!, getWidth: () => 1 } : undefined,
  }
}

test('buildLogicalLine maps a wide character to one string offset spanning two cells', () => {
  // "界" renders as one BMP code unit occupying two terminal cells: the real
  // cell at column 0, and a width-0 continuation cell at column 1.
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

  // Column 2 is the space cell; clicking it must not resolve inside the URL.
  const spaceIndex = cellIndexAt(logical.cells, 0, 2)
  assert.equal(linkAtColumn(logical.text, spaceIndex), null)

  // Column 3 is the URL's first character.
  const urlStartIndex = cellIndexAt(logical.cells, 0, 3)
  assert.equal(linkAtColumn(logical.text, urlStartIndex)?.text, 'https://example.test')
})

test('buildLogicalLine reassembles a URL that wraps across the terminal edge', () => {
  const rowOne = asciiLine('See https://example.c', false)
  const rowTwo = asciiLine('om/very/long/path', true)
  const getLine = (row: number): BufferLineLike | undefined => (row === 0 ? rowOne : row === 1 ? rowTwo : undefined)

  const logicalFromRowOne = buildLogicalLine(getLine, 22, 0)
  const logicalFromRowTwo = buildLogicalLine(getLine, 22, 1)
  assert.equal(logicalFromRowOne.text, 'See https://example.com/very/long/path')
  assert.equal(logicalFromRowTwo.text, logicalFromRowOne.text)

  const clickIndex = cellIndexAt(logicalFromRowTwo.cells, 1, 5)
  const link = linkAtColumn(logicalFromRowTwo.text, clickIndex)
  assert.equal(link?.text, 'https://example.com/very/long/path')

  const segments = segmentsForLink(logicalFromRowTwo.cells, link!)
  assert.deepEqual(segments, [
    { row: 0, startColumn: 4, endColumn: 21 },
    { row: 1, startColumn: 0, endColumn: 17 },
  ])
})

test('a wide character inside a link is fully clickable and covered with no gap', () => {
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

  const link = linkAtColumn(logical.text, 0)
  assert.equal(link?.text, String.raw`C:\界\file.txt`)

  // The underline/hit-test range must span both display columns of "界"
  // (3 and 4) as one continuous run, not stop one column short.
  const segments = segmentsForLink(logical.cells, link!)
  assert.deepEqual(segments, [{ row: 0, startColumn: 0, endColumn: 14 }])

  // Clicking the wide character's continuation cell (column 4, the second
  // half of "界") must resolve to the same link as clicking its start (3).
  const continuationIndex = cellIndexAt(logical.cells, 0, 4)
  assert.notEqual(continuationIndex, -1)
  assert.equal(linkAtColumn(logical.text, continuationIndex)?.text, String.raw`C:\界\file.txt`)
})

function textRows(rows: string[]): (row: number) => BufferLineLike | undefined {
  return (row) => (rows[row] === undefined ? undefined : asciiLine(rows[row]!))
}

test('findTextRow relocates text that scrolled to a different row within the viewport', () => {
  const getLine = textRows(['header', 'first line of interest', 'other content', 'irrelevant'])
  const match = findTextRow(getLine, 40, 'line of interest', 1, 0, 4)
  assert.deepEqual(match, { row: 1, column: 6, length: 16 })
})

test('findTextRow prefers the closest matching row when the text appears more than once', () => {
  const getLine = textRows(['target text here', 'noise', 'target text here', 'noise', 'target text here'])
  const match = findTextRow(getLine, 40, 'target text here', 3, 0, 5)
  assert.equal(match?.row, 2)
})

test('findTextRow returns null when the text is not visible anywhere in the viewport', () => {
  const getLine = textRows(['nothing', 'matches', 'here'])
  assert.equal(findTextRow(getLine, 40, 'missing text', 0, 0, 3), null)
})

test('findTextRow only searches rows within the given viewport window', () => {
  const getLine = textRows(['target', 'noise', 'noise'])
  assert.equal(findTextRow(getLine, 40, 'target', 1, 1, 2), null)
})

test('findTextRow refuses a multi-row (embedded newline) selection', () => {
  const getLine = textRows(['target'])
  assert.equal(findTextRow(getLine, 40, 'line one\nline two', 0, 0, 5), null)
})

test('findTextRow accounts for a wide character before the match when locating it', () => {
  // "界" occupies two display columns (0 and 1), so "target" starts at
  // buffer column 2 — one past where a plain UTF-16 string index (1, since
  // "界" is a single code unit) would place it.
  const cells = [
    { chars: '界', width: 2 },
    { chars: '', width: 0 },
    ...'target'.split('').map((char) => ({ chars: char, width: 1 })),
  ]
  const line: BufferLineLike = {
    isWrapped: false,
    getCell: (column) => cells[column] ? { getChars: () => cells[column]!.chars, getWidth: () => cells[column]!.width } : undefined,
  }
  const match = findTextRow((row) => (row === 0 ? line : undefined), 20, 'target', 0, 0, 1)
  assert.deepEqual(match, { row: 0, column: 2, length: 6 })
})

test('findTextRow reports a wide character inside the match as two display columns', () => {
  const cells = [
    ...'see '.split('').map((char) => ({ chars: char, width: 1 })),
    { chars: '界', width: 2 },
    { chars: '', width: 0 },
    ...'!'.split('').map((char) => ({ chars: char, width: 1 })),
  ]
  const line: BufferLineLike = {
    isWrapped: false,
    getCell: (column) => cells[column] ? { getChars: () => cells[column]!.chars, getWidth: () => cells[column]!.width } : undefined,
  }
  // The string "界!" has length 2, but spans 3 display columns (2 + 1).
  const match = findTextRow((row) => (row === 0 ? line : undefined), 20, '界!', 0, 0, 1)
  assert.deepEqual(match, { row: 0, column: 4, length: 3 })
})

test('findTextRow finds a match that only exists once physical rows are joined across a soft wrap', () => {
  const rowOne = asciiLine('please see the ', false)
  const rowTwo = asciiLine('interesting result below', true)
  const getLine = (row: number): BufferLineLike | undefined => (row === 0 ? rowOne : row === 1 ? rowTwo : undefined)
  // Neither physical row alone contains "the interesting" — it only exists
  // in the reassembled logical line spanning the wrap boundary.
  const match = findTextRow(getLine, 15, 'the interesting', 0, 0, 2)
  assert.deepEqual(match, { row: 0, column: 11, length: 15 })
})

test('findTextRow picks the occurrence within the viewport over an earlier one that scrolled above it', () => {
  const rowOne = asciiLine('target one', false)
  const rowTwo = asciiLine('target two', true)
  const getLine = (row: number): BufferLineLike | undefined => (row === 0 ? rowOne : row === 1 ? rowTwo : undefined)
  // buildLogicalLine reassembles the full two-row wrap group regardless of
  // which physical row is passed in, so a naive first-occurrence search
  // would return row 0's "target" even though only row 1 is on screen.
  const match = findTextRow(getLine, 10, 'target', 1, 1, 1)
  assert.deepEqual(match, { row: 1, column: 0, length: 6 })
})

test('isWithinScreenBounds rejects a point in the terminal padding/gutter around the screen', () => {
  const bounds = { left: 10, top: 10, right: 110, bottom: 210 }
  assert.equal(isWithinScreenBounds(50, 50, bounds), true)
  assert.equal(isWithinScreenBounds(10, 50, bounds), true, 'left edge is inclusive')
  assert.equal(isWithinScreenBounds(109, 209, bounds), true, 'just inside the right/bottom edge')
  assert.equal(isWithinScreenBounds(5, 50, bounds), false, 'left padding')
  assert.equal(isWithinScreenBounds(110, 50, bounds), false, 'right edge is exclusive')
  assert.equal(isWithinScreenBounds(50, 5, bounds), false, 'top padding')
  assert.equal(isWithinScreenBounds(50, 210, bounds), false, 'bottom edge is exclusive')
})
