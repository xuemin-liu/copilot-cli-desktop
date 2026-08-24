import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { quarantineCorruptFile, writeFileAtomic } from './atomic-file.js'

test('writeFileAtomic creates and replaces a file without leaving temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-atomic-'))
  try {
    const filename = join(directory, 'state.json')
    await writeFileAtomic(filename, 'first')
    await writeFileAtomic(filename, 'second')
    assert.equal(await readFile(filename, 'utf8'), 'second')
    assert.deepEqual(await readdir(directory), ['state.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('quarantineCorruptFile moves a corrupt file aside and tolerates a missing file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-quarantine-'))
  try {
    const filename = join(directory, 'state.json')
    await writeFile(filename, 'bad')
    await quarantineCorruptFile(filename)
    assert.match((await readdir(directory))[0] ?? '', /^state\.json\.corrupt-/)
    await quarantineCorruptFile(filename)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
