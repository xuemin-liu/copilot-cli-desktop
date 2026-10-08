import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createGitFixture, findGitForTests, shellPath } from './fixtures/git-fixture.js'
import { GitRunner, gitSucceeded, resolveGitExecutable } from './git-runner.js'
import { statusArgs } from './git-commands.js'
import { parseStatusV2 } from './git-parse.js'
import { spawn } from 'node:child_process'

const git = await findGitForTests()
const skip = git ? false : 'git is not installed'

test('resolveGitExecutable returns an absolute .exe and never searches the working folder', async () => {
  const probed: string[] = []
  const found = await resolveGitExecutable({
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    findExecutable: async () => 'C:\\tools\\git\\git.exe',
    probeVersion: async (path) => { probed.push(path); return { major: 2, minor: 40, patch: 1, text: 'git version 2.40.1' } },
  })
  assert.equal(found?.path, 'C:\\tools\\git\\git.exe')
  assert.equal(found?.supported, true)
  assert.deepEqual(probed, ['C:\\tools\\git\\git.exe'])
})

test('resolveGitExecutable falls back to Program Files, skips relative and non-exe results, and reports old versions', async () => {
  const probed: string[] = []
  const found = await resolveGitExecutable({
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    findExecutable: async () => 'git.exe',
    probeVersion: async (path) => { probed.push(path); return { major: 2, minor: 10, patch: 0, text: 'git version 2.10.0' } },
  })
  assert.deepEqual(probed, ['C:\\Program Files\\Git\\cmd\\git.exe'])
  assert.equal(found?.supported, false)
  const none = await resolveGitExecutable({ env: { SystemRoot: 'C:\\Windows' }, findExecutable: async () => null, probeVersion: async () => null })
  assert.equal(none, null)
})

test('the runner refuses a relative git path and a non-local working folder', async () => {
  assert.throws(() => new GitRunner({ gitPath: 'git', hooksDirectory: 'C:\\h' }), /absolute/)
  const runner = new GitRunner({ gitPath: 'C:\\git.exe', hooksDirectory: 'C:\\h', trackProcess: null })
  await assert.rejects(runner.run({ cwd: '\\\\server\\share', args: ['status'] }), /local, absolute/)
  await assert.rejects(runner.run({ cwd: 'relative', args: ['status'] }), /local, absolute/)
  await assert.rejects(runner.run({ cwd: 'C:\\work', args: ['status\0'] }), /NUL/)
})

test('a planted git.exe in the working folder never runs', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const planted = join(fixture.root, 'planted')
  mkdirSync(planted)
  // node.exe answers --version with "v24..." while git answers "git version ...", so the output says who ran.
  copyFileSync(process.execPath, join(planted, 'git.exe'))
  const bare = await new Promise<string>(resolve => {
    const child = spawn('git', ['--version'], { cwd: planted, env: fixture.env, windowsHide: true })
    let out = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.on('close', () => resolve(out))
    child.on('error', () => resolve('error'))
  })
  if (!/^v\d+\./.test(bare.trim())) t.diagnostic(`control did not reproduce on this platform (got ${JSON.stringify(bare.trim())}); the runner assertion below still applies`)
  const result = await fixture.runner.run({ cwd: planted, args: ['--version'] })
  assert.match(result.stdout.toString(), /^git version \d/)
})

test('reads return exit codes, stdout and stderr without throwing on failure', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('plain')
  const ok = await fixture.runner.run({ cwd: repo, args: statusArgs() })
  assert.equal(gitSucceeded(ok), true)
  assert.equal(parseStatusV2(ok.stdout.toString()).branch.head, 'main')
  const failed = await fixture.runner.run({ cwd: repo, args: ['rev-parse', '--verify', 'no-such-ref'] })
  assert.notEqual(failed.exitCode, 0)
  assert.equal(gitSucceeded(failed), false)
  assert.ok(failed.stderr.length > 0)
})

test('arguments are literal: pathspec magic and shell metacharacters do not expand', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('literal')
  // Names that git would treat as globs. `*`, `?` and `:` cannot be file names on Windows, so brackets stand in.
  for (const name of ['a.ts', 'b.ts', '[a].ts']) writeFileSync(join(repo, name), 'x\n')
  const added = await fixture.runner.run({ cwd: repo, kind: 'write', args: ['add', '--', '[a].ts'] })
  assert.equal(added.exitCode, 0, added.stderr)
  assert.deepEqual(fixture.plain(repo, 'diff', '--cached', '--name-only').trim().split(/\r?\n/), ['[a].ts'], 'only the file literally named [a].ts was staged, not a.ts')
  const glob = await fixture.runner.run({ cwd: repo, kind: 'write', args: ['add', '--', '*.ts'] })
  assert.notEqual(glob.exitCode, 0, 'a glob matches nothing in literal mode')
  assert.equal(fixture.plain(repo, 'diff', '--cached', '--name-only').trim().split(/\r?\n/).length, 1)
  const marker = join(repo, 'pwned.txt')
  const odd = await fixture.runner.run({ cwd: repo, args: ['rev-parse', '--verify', `& echo x > ${shellPath(marker)} &`] })
  assert.notEqual(odd.exitCode, 0)
  assert.equal(existsSync(marker), false)
})

test('stdin round-trips text that starts with a dash and contains non-ASCII characters', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('stdin')
  const body = '-leading dash\n名前 — café\n'
  const result = await fixture.runner.run({ cwd: repo, args: ['hash-object', '--stdin'], stdin: body })
  const data = Buffer.from(body, 'utf8')
  const expected = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest('hex')
  assert.equal(result.stdout.toString().trim(), expected)
})

test('a commit message goes through stdin and keeps its text', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('commit')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  await fixture.runner.run({ cwd: repo, kind: 'write', args: ['add', '--', 'b.txt'] })
  const message = '-feat: dash first\n\nBody with 名前 and "quotes" & $(echo no)\n'
  const result = await fixture.runner.run({ cwd: repo, kind: 'write', args: ['commit', '-F', '-'], stdin: message })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(fixture.plain(repo, 'log', '-1', '--format=%B').trim(), message.trim())
})

test('stdout past the cap is truncated, not buffered, and the process is stopped', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('cap')
  writeFileSync(join(repo, 'big.txt'), 'line of text\n'.repeat(60_000))
  const result = await fixture.runner.run({ cwd: repo, args: ['diff', '--no-index', '--', 'a.txt', 'big.txt'], maxStdoutBytes: 50_000 })
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.stdout.length, 50_000)
  assert.equal(gitSucceeded(result), false)
})

test('a timeout kills the whole tree, including a hook that is still running', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const marker = join(fixture.root, 'hook-finished.txt')
  const repo = fixture.repo('timeout', (directory) => {
    writeFileSync(join(directory, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nsleep 3\necho done > "${shellPath(marker)}"\n`)
  })
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  await fixture.runner.run({ cwd: repo, kind: 'write', args: ['add', '--', 'b.txt'] })
  const started = Date.now()
  const result = await fixture.runner.run({ cwd: repo, kind: 'write', args: ['commit', '-m', 'slow'], timeoutMs: 600 })
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 2_500, `returned in ${Date.now() - started} ms`)
  await new Promise(resolve => setTimeout(resolve, 3_500))
  assert.equal(existsSync(marker), false, 'the hook child survived the timeout')
})

test('an AbortSignal cancels a running command', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const repo = fixture.repo('abort', (directory) => {
    writeFileSync(join(directory, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 3\n')
  })
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  await fixture.runner.run({ cwd: repo, kind: 'write', args: ['add', '--', 'b.txt'] })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const result = await fixture.runner.run({ cwd: repo, kind: 'write', args: ['commit', '-m', 'slow'], signal: controller.signal })
  assert.equal(result.cancelled, true)
  assert.equal((await fixture.runner.run({ cwd: repo, args: ['status'], signal: controller.signal })).cancelled, true, 'an already-aborted signal never starts git')
})

test('the process is tracked by the watchdog and released when it ends', { skip }, async (t) => {
  const fixture = (await createGitFixture())!
  t.after(() => fixture.cleanup())
  const events: string[] = []
  const runner = new GitRunner({
    gitPath: fixture.git.path, hooksDirectory: join(fixture.root, 'no-hooks'), baseEnvironment: fixture.env,
    trackProcess: (pid) => { events.push(`track:${pid > 0}`); return { release: () => { events.push('release') } } },
  })
  await runner.run({ cwd: fixture.root, args: ['--version'] })
  assert.deepEqual(events, ['track:true', 'release'])
})

test('a missing git executable surfaces as GitUnavailableError', async () => {
  const runner = new GitRunner({ gitPath: 'C:\\definitely\\not\\here\\git.exe', hooksDirectory: join(process.env.TEMP ?? 'C:\\Windows\\Temp', 'git-runner-no-git'), trackProcess: null })
  await assert.rejects(runner.run({ cwd: process.env.TEMP ?? 'C:\\Windows\\Temp', args: ['--version'] }), { name: 'GitUnavailableError' })
})
