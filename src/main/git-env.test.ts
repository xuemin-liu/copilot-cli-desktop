import assert from 'node:assert/strict'
import test from 'node:test'
import { diffArgs, logArgs, statusArgs } from './git-commands.js'
import { assertGitArgument, buildGitEnvironment, ceilingDirectories, gitArgsPrefix } from './git-env.js'

test('the environment is an allowlist: repository-steering GIT_* variables and loader hooks are dropped', () => {
  const env = buildGitEnvironment({
    Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a',
    GIT_DIR: 'C:\\evil', GIT_WORK_TREE: 'C:\\evil', GIT_INDEX_FILE: 'x', GIT_EXTERNAL_DIFF: 'evil', GIT_PAGER: 'evil', GIT_EDITOR: 'evil',
    GIT_ASKPASS: 'evil', SSH_ASKPASS: 'evil', NODE_OPTIONS: '--require x', ELECTRON_RUN_AS_NODE: '1', GIT_CEILING_DIRECTORIES: 'C:\\x',
    SECRET_TOKEN: 'abc', GIT_SSH_COMMAND: 'ssh -i key',
  })
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EXTERNAL_DIFF', 'GIT_ASKPASS', 'SSH_ASKPASS', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'GIT_CEILING_DIRECTORIES', 'SECRET_TOKEN']) {
    assert.equal(env[name], undefined, name)
  }
  assert.equal(env.Path, 'C:\\Windows')
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i key', 'the user\'s own ssh choice is kept')
  assert.equal(env.GIT_PAGER, 'cat')
  assert.equal(env.GIT_EDITOR, 'true')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'never')
  assert.equal(env.LC_ALL, 'C')
})

test('variable names match case-insensitively, as on Windows', () => {
  const env = buildGitEnvironment({ PATH: 'a', userprofile: 'b', git_dir: 'evil' })
  assert.equal(env.PATH, 'a')
  assert.equal(env.userprofile, 'b')
  assert.equal(env.git_dir, undefined)
})

test('ssh batch mode applies only when the user has no ssh override', () => {
  assert.equal(buildGitEnvironment({}, { sshBatchMode: true }).GIT_SSH_COMMAND, 'ssh -o BatchMode=yes')
  assert.equal(buildGitEnvironment({ GIT_SSH_COMMAND: 'mine' }, { sshBatchMode: true }).GIT_SSH_COMMAND, 'mine')
  assert.equal(buildGitEnvironment({ GIT_SSH: 'plink' }, { sshBatchMode: true }).GIT_SSH_COMMAND, undefined)
  assert.equal(buildGitEnvironment({}).GIT_SSH_COMMAND, undefined)
})

test('extra variables are applied last', () => {
  assert.equal(buildGitEnvironment({}, { extra: { GIT_CEILING_DIRECTORIES: 'C:\\p', GIT_PAGER: 'less' } }).GIT_CEILING_DIRECTORIES, 'C:\\p')
})

test('reads redirect hooks and disable fsmonitor; writes keep the user\'s hooks', () => {
  const read = gitArgsPrefix('read', 'C:\\empty')
  assert.ok(read.includes('--literal-pathspecs'))
  assert.ok(read.includes('--no-optional-locks'))
  assert.ok(read.includes('core.fsmonitor=false'))
  assert.ok(read.includes('core.hooksPath=C:\\empty'))
  const write = gitArgsPrefix('write', 'C:\\empty')
  assert.ok(write.includes('--literal-pathspecs'))
  assert.ok(write.includes('core.fsmonitor=false'))
  assert.ok(write.includes('gc.auto=0'))
  assert.equal(write.some(arg => arg.startsWith('core.hooksPath')), false)
})

test('arguments cannot contain NUL', () => {
  assert.throws(() => assertGitArgument('a\0b'), /NUL/)
  assert.doesNotThrow(() => assertGitArgument('*.ts'))
})

test('the ceiling is the parent of the project, and absent at a drive root', () => {
  assert.equal(ceilingDirectories('C:\\work\\repo'), 'C:\\work')
  assert.equal(ceilingDirectories('C:\\'), null)
})

test('status, diff and log arguments carry the read-safety flags', () => {
  assert.ok(statusArgs().includes('--ignore-submodules=all'))
  assert.ok(statusArgs().includes('-z'))
  assert.ok(statusArgs('no').includes('--untracked-files=no'))
  const diff = diffArgs({ staged: true, path: '-weird *.ts' })
  assert.ok(diff.includes('--no-ext-diff') && diff.includes('--no-textconv') && diff.includes('--cached'))
  assert.deepEqual(diff.slice(-2), ['--', '-weird *.ts'], 'paths follow the separator')
  const log = logArgs({ limit: 20, skip: 40 })
  assert.ok(log.includes('--no-show-signature') && log.includes('--max-count=20') && log.includes('--skip=40'))
  assert.throws(() => logArgs({ limit: -1 }), /out of range/)
  assert.throws(() => logArgs({ limit: 10, skip: 1.5 }), /out of range/)
  assert.throws(() => diffArgs({ staged: false, path: 'a\0b' }), /NUL/)
})
