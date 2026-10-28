import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { folderChanges } from './meeting-folder-changes.js'

test('a folder\'s changes: tracked edits and new files as one patch, no changes said so, and no repository refused', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'meeting-folder-'))
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(folder, '.no-global-gitconfig'),
    GIT_AUTHOR_NAME: 'Check', GIT_AUTHOR_EMAIL: 'check@example.com', GIT_COMMITTER_NAME: 'Check', GIT_COMMITTER_EMAIL: 'check@example.com',
  }
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: folder, env, encoding: 'utf8' })
  try {
    await assert.rejects(folderChanges(folder), /is not a Git repository/)
    git('init', '-q')
    await writeFile(join(folder, '.gitignore'), '.no-global-gitconfig\n')
    await writeFile(join(folder, 'login.cfg'), 'retry = 1\n')
    git('add', '.gitignore', 'login.cfg')
    git('commit', '-q', '-m', 'init')
    assert.equal(await folderChanges(folder), '# No uncommitted changes.')
    await writeFile(join(folder, 'login.cfg'), 'retry = 3\n')
    await writeFile(join(folder, 'plan.md'), '# Plan\n')
    const patch = await folderChanges(folder)
    assert.match(patch, /^diff --git a\/login\.cfg b\/login\.cfg$/m)
    assert.match(patch, /^\+retry = 3$/m)
    assert.match(patch, /^\+\+\+ b\/plan\.md$/m, 'a new file is included as added')
    assert.match(patch, /^\+# Plan$/m)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
