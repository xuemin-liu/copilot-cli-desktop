import assert from 'node:assert/strict'
import test from 'node:test'
import { redactDiagnosticText } from './desktop-diagnostics.js'
import { fastForwardArgs, fetchArgs, fetchRefspecsArgs, pushArgs, remoteUrlArgs } from './git-commands.js'
import { ALLOWED_PROTOCOLS, checkFetchRefspecs, checkRemoteUrl, describeSyncFailure } from './git-sync.js'
import type { GitRunResult } from './git-runner.js'

const failed = (stderr: string): GitRunResult => ({ exitCode: 128, stdout: Buffer.alloc(0), stderr, stdoutTruncated: false, timedOut: false, cancelled: false, durationMs: 1 })

test('addresses the panel will contact', () => {
  for (const address of [
    'https://github.com/owner/repo.git', 'http://127.0.0.1:8080/r.git', 'ssh://git@github.com/owner/repo.git', 'git@github.com:owner/repo.git',
    'git://example.org/r.git', 'file:///C:/work/remote.git', 'file://localhost/C:/work/remote.git', 'C:\\work\\remote.git', '../remote.git', 'D:/work/remote.git',
    'https://user:token@example.org/r.git',
  ]) assert.deepEqual(checkRemoteUrl(address), { ok: true }, address)
})

test('addresses the panel will not contact, and why', () => {
  const refused: Array<[string, RegExp]> = [
    ['', /no address/],
    ['\\\\server\\share\\repo.git', /network share/],
    ['//server/share/repo.git', /network share/],
    ['file://server/share/repo.git', /network share/],
    ['file:////server/share/repo.git', /network share/],
    ['ext::sh -c "touch x"', /custom transport/],
    ['fd::17/foo', /custom transport/],
    ['testgit::anything', /custom transport/],
    ['ftp://example.org/r.git', /"ftp" protocol/],
    ['-oProxyCommand=calc', /starts with "-"/],
    ['ssh://-oProxyCommand=calc/x', /host that starts with "-"/],
    ['ssh://user@-oProxyCommand=calc/x', /host that starts with "-"/],
    ['-oProxyCommand=calc@host:path', /starts with "-"/],
    ['user@-host:path', /host that starts with "-"/],
  ]
  for (const [address, reason] of refused) {
    const verdict = checkRemoteUrl(address)
    assert.equal(verdict.ok, false, address)
    if (!verdict.ok) assert.match(verdict.reason, reason, address)
  }
})

test('the transports a network command may use leave out the ones that run programs', () => {
  const allowed = ALLOWED_PROTOCOLS.split(':')
  assert.deepEqual(allowed.sort(), ['file', 'git', 'http', 'https', 'ssh'])
  assert.equal(allowed.includes('ext'), false)
  assert.equal(allowed.includes('fd'), false)
})

test('failures are told apart: credentials, a refused push, a pull that cannot fast-forward, anything else', () => {
  const cases: Array<[string, 'fetch' | 'pull' | 'push', string]> = [
    ['fatal: could not read Username for \'https://example.org\': terminal prompts disabled', 'fetch', 'auth-required'],
    ['remote: Invalid username or password.\nfatal: Authentication failed for \'https://example.org/r.git/\'', 'push', 'auth-required'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'fetch', 'auth-required'],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'pull', 'auth-required'],
    ['fatal: unable to access \'https://example.org/r.git/\': The requested URL returned error: 403', 'fetch', 'auth-required'],
    [' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'x\'', 'push', 'rejected'],
    [' ! [rejected]        main -> main (non-fast-forward)', 'push', 'rejected'],
    ['fatal: Not possible to fast-forward, aborting.', 'pull', 'diverged'],
    ['fatal: unable to access \'https://example.org/r.git/\': Could not resolve host: example.org', 'fetch', 'failed'],
    ['error: Your local changes to the following files would be overwritten by merge:\n\ta.txt', 'pull', 'failed'],
  ]
  for (const [stderr, operation, reason] of cases) assert.equal(describeSyncFailure(failed(stderr), operation).reason, reason, stderr)
  // A rejected push is only a rejection when pushing, and a diverged pull only when pulling.
  assert.equal(describeSyncFailure(failed('Not possible to fast-forward, aborting.'), 'push').reason, 'failed')
  assert.equal(describeSyncFailure(failed(' ! [rejected] main -> main (fetch first)'), 'fetch').reason, 'failed')
})

test('a failure message shows the first useful line without the address\'s credentials', () => {
  const failure = describeSyncFailure(failed('hint: something\nfatal: unable to access \'https://user:hunter2secret@example.org/r.git/\': Could not resolve host: example.org'), 'fetch')
  assert.equal(failure.reason, 'failed')
  assert.match(failure.message, /Could not resolve host/)
  assert.equal(failure.message.includes('hunter2secret'), false)
})

test('credentials inside an address are removed whatever the scheme', () => {
  assert.equal(redactDiagnosticText('To https://user:hunter2@example.org/r.git'), 'To https://[REDACTED]@example.org/r.git')
  assert.equal(redactDiagnosticText('To ssh://deploy:hunter2@example.org:22/r.git'), 'To ssh://[REDACTED]@example.org:22/r.git')
  assert.equal(redactDiagnosticText('From git://alice:hunter2@example.org/r'), 'From git://[REDACTED]@example.org/r')
  assert.equal(redactDiagnosticText('To ssh://git@github.com/owner/repo.git'), 'To ssh://git@github.com/owner/repo.git', 'a user name alone is not a secret')
})

test('no network command forces anything, prunes, recurses into submodules or reads its target as an option', () => {
  assert.deepEqual(fetchArgs('origin'), ['fetch', '--no-recurse-submodules', '--no-prune', '--no-prune-tags', '--no-tags', '--', 'origin'])
  const push = pushArgs('origin', 'main', 'main', false)
  assert.deepEqual(push, ['push', '--no-recurse-submodules', '--no-follow-tags', '--signed=no', '--', 'origin', 'refs/heads/main:refs/heads/main'])
  assert.ok(pushArgs('origin', 'main', 'main', true).includes('--set-upstream'))
  for (const args of [fetchArgs('origin'), push, fastForwardArgs()]) {
    assert.equal(args.some(arg => /force|^\+|^--prune|--mirror|--delete/.test(arg)), false, args.join(' '))
  }
  assert.ok(fastForwardArgs().includes('--ff-only'))
  // A refspec is never forced: its source does not start with `+`.
  assert.equal(push.at(-1)!.startsWith('+'), false)
  assert.deepEqual(remoteUrlArgs('origin', true), ['remote', 'get-url', '--push', '--all', '--', 'origin'])
  assert.deepEqual(remoteUrlArgs('origin', false), ['remote', 'get-url', '--all', '--', 'origin'])
  assert.throws(() => fetchArgs('a\0b'), /NUL/)
})

test('fetch settings that stay inside the remote\'s own tracking branches are accepted, anything else is refused', () => {
  for (const specs of [
    [], [''], ['+refs/heads/*:refs/remotes/origin/*'], ['refs/heads/*:refs/remotes/origin/*'], ['+refs/heads/main:refs/remotes/origin/main'],
    ['+refs/heads/*:refs/remotes/origin/*', '+refs/pull/*/head:refs/remotes/origin/pr/*'], ['refs/heads/main'], ['^refs/heads/secret', '+refs/heads/*:refs/remotes/origin/*'],
  ]) assert.deepEqual(checkFetchRefspecs('origin', specs), { ok: true }, JSON.stringify(specs))
  for (const spec of [
    '+refs/heads/main:refs/heads/backup', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', '+refs/heads/*:refs/remotes/fork/*', '+refs/heads/*:refs/remotes/origin2/*',
    '+refs/heads/main:refs/remotes/origin/../../heads/x', ':refs/heads/x', '+refs/heads/*:refs/remotes/origin/*:refs/heads/y', 'refs/heads/x:refs/remotes/origin' + String.fromCharCode(92) + 'x', '+refs/heads/*:HEAD',
  ]) {
    const verdict = checkFetchRefspecs('origin', ['+refs/heads/*:refs/remotes/origin/*', spec])
    assert.equal(verdict.ok, false, spec)
    if (!verdict.ok) assert.match(verdict.reason, /writes outside its remote-tracking branches/)
  }
})

test('a fetch overrides pruning and tags, and its refspec lookup is a plain config read', () => {
  const args = fetchArgs('origin')
  for (const flag of ['--no-recurse-submodules', '--no-prune', '--no-prune-tags', '--no-tags']) assert.ok(args.includes(flag), flag)
  assert.deepEqual(fetchRefspecsArgs('origin'), ['config', '--get-all', 'remote.origin.fetch'])
})
