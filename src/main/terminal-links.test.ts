import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOGICAL_LINE_ROWS,
  buildLogicalLine,
  parseTerminalHyperlink,
  scanLineForLinks,
  type BufferLineLike,
} from '../renderer/terminal-links.js'

test('OSC 8 file destinations resolve as paths with optional source locations', () => {
  assert.deepEqual(parseTerminalHyperlink('README.md'), { type: 'path', text: 'README.md' })
  assert.deepEqual(parseTerminalHyperlink('src/app.ts#L42-L44'), { type: 'path', text: 'src/app.ts', line: 42 })
  assert.deepEqual(parseTerminalHyperlink('docs/My%20Guide%23draft.md:12:3'), {
    type: 'path', text: 'docs/My Guide#draft.md', line: 12, column: 3,
  })
  assert.deepEqual(parseTerminalHyperlink(String.raw`D:\repo\app.ts`), { type: 'path', text: String.raw`D:\repo\app.ts` })
})

test('OSC 8 URLs keep their destination and unsupported protocols stay outside the link handlers', () => {
  const url = 'https://example.com/docs?q=1#L42'
  assert.deepEqual(parseTerminalHyperlink(url), { type: 'url', text: url })
  for (const uri of ['#heading', 'javascript:alert(1)', 'data:text/html,test', 'file://server/share',
    '//server/share', '%5C%5Cserver%5Cshare', 'src/%00file.ts']) {
    assert.equal(parseTerminalHyperlink(uri), null, uri)
  }
})

test('scanLineForLinks finds absolute macOS and Linux paths, without their location or a lone folder', () => {
  const texts = (line: string): string[] => scanLineForLinks(line).map((link) => link.text)
  assert.deepEqual(texts('error at /home/me/app/src/main.ts:12:4'), ['/home/me/app/src/main.ts'])
  assert.deepEqual(texts('see /usr/bin/git.'), ['/usr/bin/git'])
  assert.deepEqual(texts('and/or /tmp only'), [], 'neither "and/or" nor a single name')
  assert.deepEqual(texts('`/Users/me/My Project/file.ts`'), ['/Users/me/My Project/file.ts'])
  assert.deepEqual(texts('https://example.com/a/b'), ['https://example.com/a/b'], 'a URL stays one link')
})

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

test('scanLineForLinks preserves spaces in backtick-delimited file links', () => {
  const path = String.raw`C:\repo\folder with spaces\file.txt`
  const line = 'See `' + path + ':42:7` for details'
  const links = scanLineForLinks(line)
  assert.deepEqual(links, [{ type: 'path', text: path, start: 4, end: line.indexOf(' for details'), line: 42, column: 7 }])
  assert.deepEqual(scanLineForLinks('`./folder with spaces/file.txt`').map(link => link.text), ['./folder with spaces/file.txt'])
})

test('a path link keeps the line and column it points at', () => {
  const where = (line: string): unknown => scanLineForLinks(line).map(({ text, line, column }) => ({ text, line, column }))
  assert.deepEqual(where('src/app.ts:42:7 - error TS2322'), [{ text: 'src/app.ts', line: 42, column: 7 }], 'a bare relative path')
  assert.deepEqual(where('at src/app.ts:42.'), [{ text: 'src/app.ts', line: 42, column: undefined }])
  assert.deepEqual(where('src/app.ts(12,5): error TS1005'), [{ text: 'src/app.ts', line: 12, column: 5 }], 'the compiler form')
  assert.deepEqual(where(String.raw`"C:\My Repo\src\app.ts:9:3" failed`), [{ text: String.raw`C:\My Repo\src\app.ts`, line: 9, column: 3 }], 'a quoted Windows path with spaces')
  assert.deepEqual(where(String.raw`C:\repo\src\main.ts:42:7`), [{ text: String.raw`C:\repo\src\main.ts`, line: 42, column: 7 }])
  assert.deepEqual(where('/home/me/app/src/main.ts:12:4'), [{ text: '/home/me/app/src/main.ts', line: 12, column: 4 }])
  assert.deepEqual(where('see src/app.ts for details'), [{ text: 'src/app.ts', line: undefined, column: undefined }])
  const bare = scanLineForLinks('src/app.ts:42:7')[0]!
  assert.equal(bare.end - bare.start, 'src/app.ts'.length, 'the underline covers the path, not its location')
})

test('scanLineForLinks keeps a backtick-delimited URL on the URL handler', () => {
  assert.deepEqual(scanLineForLinks('See `https://example.com/path`').map(({ type, text }) => ({ type, text })), [
    { type: 'url', text: 'https://example.com/path' },
  ])
})

test('inline-code commands retain their embedded file links', () => {
  for (const command of ['node dist/src/cli/cli.js', 'cat ./src/main.ts', 'git diff src/main.ts']) {
    const expected = command.slice(command.lastIndexOf(' ') + 1)
    assert.deepEqual(scanLineForLinks('Run `' + command + '` first').map(link => link.text), [expected])
  }
  assert.deepEqual(scanLineForLinks('`node "./folder name/app.js"`').map(link => link.text), ['./folder name/app.js'])
})

test('inline-code globs, branch names and fractions do not become file links', () => {
  for (const text of ['src/**/*.ts', 'git push origin/main', '1/2']) {
    assert.deepEqual(scanLineForLinks('`' + text + '`'), [], text)
  }
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

test('ratios, versions and dates written with slashes are not paths; a path with numbers in it still is', () => {
  const texts = (line: string): string[] => scanLineForLinks(line).map((link) => link.text)
  for (const line of ['score 3.5/4.0 done', 'from v1.2/3.4 up', 'due 10/11/2026.5', 'ratio 16/9.0', '1.0/2.0/3.0']) assert.deepEqual(texts(line), [], line)
  assert.deepEqual(texts('see 2024/report.txt'), ['2024/report.txt'])
  assert.deepEqual(texts('lib/libfoo.so.1 loaded'), ['lib/libfoo.so.1'])
  assert.deepEqual(texts('build/1.2/app.js:3'), ['build/1.2/app.js'])
  assert.deepEqual(texts('./3.5/4.0'), ['./3.5/4.0'], 'an explicit relative path is a path whatever its names')
  // The same in inline code.
  for (const line of ['use `3.5/4.0` here', 'from `v1.2/3.4`', '`10/11/2026.5`']) assert.deepEqual(texts(line), [], line)
  assert.deepEqual(texts('`./3.5/4.0`'), ['./3.5/4.0'])
  assert.deepEqual(texts('`build/1.2/app.js`'), ['build/1.2/app.js'])
  assert.deepEqual(texts('C:\\1\\2.0'), ['C:\\1\\2.0'])
})

test('a bare path is still found after punctuation, and not from the middle of a name', () => {
  const texts = (line: string): string[] => scanLineForLinks(line).map((link) => link.text)
  assert.deepEqual(texts('--config=dist/app.js'), ['dist/app.js'])
  assert.deepEqual(texts('(src/main/main.ts:12)'), ['src/main/main.ts'])
  assert.deepEqual(texts('error in src\\renderer\\App.tsx(4,2): bad'), ['src\\renderer\\App.tsx'])
  assert.deepEqual(texts('@scope/pkg/index.js'), ['scope/pkg/index.js'])
  assert.deepEqual(texts('see /usr/bin/git and C:\\Windows\\notepad.exe'), ['/usr/bin/git', 'C:\\Windows\\notepad.exe'])
  assert.deepEqual(texts('a/b/c/app.js'), ['a/b/c/app.js'], 'one link from the start of the path, not one from each folder')
})

test('scanning a long line with no separators, or a link followed by many brackets, stays fast', () => {
  const timed = (line: string): number => { const started = performance.now(); scanLineForLinks(line); return performance.now() - started }
  // 200,000 characters: about a quarter of a minute before, when every character restarted a scan to the end of the run.
  // The last two have separators and no file extension: every separator was a place to start again.
  for (const run of ['a'.repeat(200_000), 'A1b2C3d4'.repeat(25_000), `${'f'.repeat(100_000)} ${'0'.repeat(100_000)}`,
    'a/'.repeat(100_000), `${'A'.repeat(63)}/`.repeat(3_125), 'ab\\'.repeat(60_000)]) {
    const elapsed = Math.min(timed(run), timed(run))
    assert.ok(elapsed < 500, `${run.slice(0, 8)}… took ${Math.round(elapsed)} ms`)
  }
  const brackets = `https://example.com/a${')'.repeat(100_000)}`
  const elapsed = Math.min(timed(brackets), timed(brackets))
  assert.ok(elapsed < 500, `brackets took ${Math.round(elapsed)} ms`)
  assert.equal(scanLineForLinks(brackets)[0]?.text, 'https://example.com/a')
  assert.equal(scanLineForLinks('https://en.wikipedia.org/wiki/Function_(mathematics)).')[0]?.text, 'https://en.wikipedia.org/wiki/Function_(mathematics)')
})

test('on a line wrapped over more rows than are read, the rows around the one asked about are the ones read', () => {
  const cols = 10
  const rows = 500
  // Row r holds its own number, so the text shows which rows were read. Every row but the first continues the line.
  const getLine = (row: number): BufferLineLike | undefined => row < 0 || row >= rows ? undefined : {
    isWrapped: row > 0,
    getCell: (column) => ({ getChars: () => String(row).padStart(cols, '0')[column]!, getWidth: () => 1 }),
  }
  const near = buildLogicalLine(getLine, cols, 3)
  assert.equal(near.cells[0]?.row, 0)
  assert.equal(near.cells.at(-1)?.row, LOGICAL_LINE_ROWS - 1)
  const far = buildLogicalLine(getLine, cols, 350)
  assert.equal(far.cells.length, LOGICAL_LINE_ROWS * cols)
  assert.equal(far.cells[0]?.row, 350 - LOGICAL_LINE_ROWS / 2)
  assert.ok(far.cells.some((cell) => cell.row === 350), 'the row asked about is read')
  assert.equal(far.cells.at(-1)?.row, 350 + LOGICAL_LINE_ROWS / 2 - 1)
})
