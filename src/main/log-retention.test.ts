import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendBoundedLog, pruneSessionLogDirectories } from './log-retention.js'

test('appendBoundedLog rotates an oversized log and keeps a bounded active file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-log-'))
  try {
    const filename = join(root, 'app.log')
    await writeFile(filename, '12345')
    await appendBoundedLog(filename, '6789', 8)
    assert.equal(await readFile(`${filename}.1`, 'utf8'), '12345')
    assert.equal(await readFile(filename, 'utf8'), '6789')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pruneSessionLogDirectories removes old and excess launch directories only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-sessions-'))
  try {
    for (const [name, age] of [['new', 10], ['older', 20], ['expired', 200]] as const) {
      const path = join(root, name)
      await mkdir(path)
      const timestamp = new Date(1_000 - age)
      await utimes(path, timestamp, timestamp)
    }
    await writeFile(join(root, 'keep.txt'), 'x')
    assert.equal(await pruneSessionLogDirectories(root, { now: 1_000, maxAgeMs: 100, maxDirectories: 1 }), 2)
    assert.deepEqual((await readdir(root)).sort(), ['keep.txt', 'new'])
    assert.ok((await stat(join(root, 'new'))).isDirectory())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
