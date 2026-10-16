import assert from 'node:assert/strict'
import test from 'node:test'
import { newSessionTitle, worktreeNamePrefix } from './session-name.js'
import { worktreeNameFor } from './session-store-discovery.js'

test('an empty or missing new-session name means the default, and a typed one is trimmed and bounded', () => {
  assert.equal(newSessionTitle(undefined), null)
  assert.equal(newSessionTitle(null), null)
  assert.equal(newSessionTitle(''), null)
  assert.equal(newSessionTitle('   '), null)
  assert.equal(newSessionTitle('  Fix login  '), 'Fix login')
  assert.equal(newSessionTitle('x'.repeat(200)), 'x'.repeat(120))
  assert.throws(() => newSessionTitle(42), /Invalid session title/)
  assert.throws(() => newSessionTitle('x'.repeat(1001)), /Invalid session title/)
})

test('the dialog previews the same worktree name a launch uses, minus its random suffix', () => {
  assert.equal(worktreeNamePrefix('project'), 'desktop-project')
  assert.equal(worktreeNamePrefix('Fix login race'), 'desktop-fix-login-race')
  assert.equal(worktreeNamePrefix('!!'), 'desktop-session')
  for (const title of ['project', 'Fix login race', '  --Weird__Title!! (v2) ', 'a'.repeat(100)]) {
    assert.equal(worktreeNameFor(title, () => 'abc123'), `${worktreeNamePrefix(title)}-abc123`)
  }
})
