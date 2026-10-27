import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { absolutePathEntries, desktopPosixPath, readLoginShellPath } from './posix-executables.js'

/** PATH handling here is the macOS and Linux kind: `:` between folders, `/` paths. */
const posixOnly = { skip: process.platform === 'win32' ? 'macOS and Linux' : false }

test('only the text between the markers counts, and only its absolute folders', posixOnly, async () => {
  const run = async () => 'Welcome!\n__COPILOT_DESKTOP_PATH__/opt/homebrew/bin:relative:/usr/bin__COPILOT_DESKTOP_PATH__motd'
  assert.equal(await readLoginShellPath({ SHELL: '/bin/zsh' }, run), '/opt/homebrew/bin:/usr/bin')
  assert.equal(await readLoginShellPath({ SHELL: 'zsh' }, run), null, 'a relative SHELL is not run')
  assert.equal(await readLoginShellPath({ SHELL: '/bin/zsh' }, async () => 'no markers'), null)
  assert.equal(await readLoginShellPath({ SHELL: '/bin/zsh' }, async () => { throw new Error('timed out') }), null)
  assert.deepEqual(absolutePathEntries(':/a::b:/a:/c'), ['/a', '/c'])
})

test('the desktop PATH puts the shell\'s folders first, then the current ones, then package-manager folders that exist', posixOnly, async () => {
  const path = await desktopPosixPath({ SHELL: '/bin/bash', PATH: '/usr/bin:/bin' }, {
    platform: 'linux', home: '/home/me',
    run: async () => '__COPILOT_DESKTOP_PATH__/home/me/.nvm/bin:/usr/bin__COPILOT_DESKTOP_PATH__',
    directoryExists: async (folder) => folder === '/home/me/.local/bin',
  })
  assert.equal(path, '/home/me/.nvm/bin:/usr/bin:/bin:/home/me/.local/bin')
  assert.equal(await desktopPosixPath({ PATH: 'C:\\x' }, { platform: 'win32' }), 'C:\\x', 'Windows is left alone')
})

test('a login shell that ignores SIGTERM and never answers is killed, and startup goes on', posixOnly, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'login-shell-'))
  try {
    const shell = join(folder, 'stuck-shell')
    // Like an interactive shell stopped on the terminal: it ignores SIGTERM and never prints the PATH.
    await writeFile(shell, '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n')
    await chmod(shell, 0o755)
    const started = Date.now()
    assert.equal(await readLoginShellPath({ SHELL: shell, PATH: '/usr/bin:/bin' }), null)
    assert.ok(Date.now() - started < 10_000, `gave up after ${Date.now() - started} ms`)
  } finally { await rm(folder, { recursive: true, force: true }) }
})
