import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LogAppender } from './log-appender.js'

test('a log folder is created once, not before every chunk, and the chunks land in order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'log-appender-'))
  try {
    const made: string[] = []
    const real = await import('node:fs/promises')
    const appender = new LogAppender({ mkdir: async (path, options) => { made.push(path); return real.mkdir(path, options) }, appendFile: real.appendFile })
    const first = join(directory, 'sessions', 'launch', 'tab-1.log'), second = join(directory, 'sessions', 'launch', 'tab-2.log')
    for (const chunk of ['one ', 'two ', 'three']) await appender.append(first, chunk)
    await appender.append(second, 'other')
    assert.deepEqual(made, [join(directory, 'sessions', 'launch')], 'one folder, made once for both files')
    assert.equal(await readFile(first, 'utf8'), 'one two three')
    assert.equal(await readFile(second, 'utf8'), 'other')
    await appender.append(join(directory, 'elsewhere', 'app.log'), 'x')
    assert.equal(made.length, 2, 'another folder is made too')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a log folder removed while the app runs is made again, and the chunk is not lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'log-appender-'))
  try {
    const appender = new LogAppender()
    const file = join(directory, 'sessions', 'tab-1.log')
    await appender.append(file, 'before ')
    await rm(join(directory, 'sessions'), { recursive: true })
    await appender.append(file, 'after')
    assert.equal(await readFile(file, 'utf8'), 'after')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a failure that is not a missing folder is reported, without a second attempt', async () => {
  let attempts = 0
  const appender = new LogAppender({
    mkdir: async () => undefined,
    appendFile: async () => { attempts++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) },
  })
  await assert.rejects(async () => appender.append(join('logs', 'tab-1.log'), 'x'), /disk full/)
  assert.equal(attempts, 1)
})
