import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserHistory } from './browser-history.js'

test('browser history is shared newest-first, deduplicated, stripped of queries and kept across launches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-history-'))
  try {
    const file = join(root, 'browser-history.json')
    const history = new BrowserHistory(file)
    history.record('https://example.com/a?q=1')
    history.record('http://localhost:3000/')
    history.record('https://example.com/a')
    history.record('https://example.com/b#token')
    history.record('file:///C:/secret.html')
    assert.deepEqual(history.list(), ['https://example.com/a', 'http://localhost:3000/'])
    await history.flush()
    assert.deepEqual(new BrowserHistory(file).list(), ['https://example.com/a', 'http://localhost:3000/'])

    await writeFile(file, JSON.stringify(['https://example.com/x', 7, 'javascript:alert(1)', 'https://example.com/x']))
    assert.deepEqual(new BrowserHistory(file, () => {}).list(), ['https://example.com/x'])
    const errors: string[] = []
    await writeFile(file, '{not json')
    assert.deepEqual(new BrowserHistory(file, message => errors.push(message)).list(), [])
    assert.equal(errors.length, 1)
    assert.equal(await readFile(file, 'utf8'), '{not json')
    assert.deepEqual(new BrowserHistory(join(root, 'missing.json'), message => errors.push(message)).list(), [])
    assert.equal(errors.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('clearing browsing history empties it for every session and on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-history-'))
  try {
    const file = join(root, 'browser-history.json')
    const history = new BrowserHistory(file)
    history.record('https://example.com/a')
    history.clear()
    assert.deepEqual(history.list(), [])
    await history.flush()
    assert.deepEqual(new BrowserHistory(file).list(), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
