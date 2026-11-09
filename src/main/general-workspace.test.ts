import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { createGeneralWorkspaceFolder, generalWorkspaceFolderName, MAX_GENERAL_WORKSPACE_NAME_CHARS } from './general-workspace.js'

test('a workspace name becomes one safe folder name', () => {
  assert.equal(generalWorkspaceFolderName('  PC performance  '), 'PC performance')
  assert.equal(generalWorkspaceFolderName('disk: C/D\\E?'), 'disk C D E')
  assert.equal(generalWorkspaceFolderName('..\\..\\outside'), 'outside')
  assert.equal(generalWorkspaceFolderName('notes.'), 'notes')
  assert.equal(generalWorkspaceFolderName('x'.repeat(200)).length, MAX_GENERAL_WORKSPACE_NAME_CHARS)
})

test('a name Windows reserves is not used as it stands', () => {
  for (const name of ['CON', 'nul', 'com1', 'LPT9', 'aux.txt']) assert.equal(generalWorkspaceFolderName(name), `General ${name}`)
  assert.equal(generalWorkspaceFolderName('console'), 'console')
})

test('a name with nothing usable in it is refused', () => {
  for (const name of ['', '   ', '...', '<>:"/\\|?*']) assert.throws(() => generalWorkspaceFolderName(name), /at least one letter or number/)
})

test('each workspace gets its own new folder, and a taken name gets a number', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'general-workspace-'))
  try {
    const root = join(parent, 'not', 'made', 'yet')
    const first = await createGeneralWorkspaceFolder(root, 'PC performance')
    const second = await createGeneralWorkspaceFolder(root, 'PC performance')
    assert.equal(basename(first), 'PC performance')
    assert.equal(basename(second), 'PC performance 2')
    assert.equal(dirname(second), root)
    assert.ok((await stat(second)).isDirectory())
    assert.deepEqual((await readdir(first)), [], 'the folder starts empty')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('a file already using the name is left alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'general-workspace-'))
  try {
    await writeFile(join(root, 'notes'), 'keep me')
    assert.equal(basename(await createGeneralWorkspaceFolder(root, 'notes')), 'notes 2')
    assert.ok((await stat(join(root, 'notes'))).isFile())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
