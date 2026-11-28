import assert from 'node:assert/strict'
import test from 'node:test'
import { START_OPTION_FLAGS, findWorkspaceArgument, flagValue, parseStartArguments } from './start-arguments.js'

test('start argument helpers share value flags without mistaking values for the workspace', () => {
  const args = ['--preset', 'full-auto', '--resume-mode', 'continue', 'D:\\work\\project', '--session-id', 'abc']
  assert.equal(findWorkspaceArgument(args), 'D:\\work\\project')
  assert.equal(flagValue(args, START_OPTION_FLAGS.preset), 'full-auto')
  assert.equal(flagValue(args, START_OPTION_FLAGS.resumeMode), 'continue')
  assert.equal(flagValue(args, START_OPTION_FLAGS.sessionId), 'abc')
  const parsed = parseStartArguments(args)
  assert.equal(parsed.workspace, 'D:\\work\\project')
  assert.equal(parsed.preset, 'full-auto')
  assert.equal(parsed.resumeMode, 'continue')
  assert.equal(parsed.sessionId, 'abc')
  assert.deepEqual(parsed.normalizedOptionArgs, [
    '--preset', 'full-auto',
    '--resume-mode', 'continue',
    '--session-id', 'abc',
  ])
})

test('parseStartArguments supports --flag=value syntax and defaults when flags are omitted', () => {
  const parsed = parseStartArguments([
    '--preset=read-only',
    'D:\\work\\repo',
    '--resume-mode=auto-resume',
    '--session-id=session_01.ok-id',
  ])
  assert.equal(parsed.workspace, 'D:\\work\\repo')
  assert.equal(parsed.preset, 'read-only')
  assert.equal(parsed.resumeMode, 'auto-resume')
  assert.equal(parsed.sessionId, 'session_01.ok-id')
  assert.equal(flagValue(['--preset=trusted-directory'], START_OPTION_FLAGS.preset), 'trusted-directory')

  const defaults = parseStartArguments([])
  assert.equal(defaults.workspace, undefined)
  assert.equal(defaults.preset, 'default')
  assert.equal(defaults.resumeMode, 'new')
  assert.equal(defaults.sessionId, null)
  assert.deepEqual(defaults.normalizedOptionArgs, ['--preset', 'default', '--resume-mode', 'new'])
})

test('findWorkspaceArgument returns undefined when only value flags are present', () => {
  assert.equal(findWorkspaceArgument(['--preset', 'default', '--session-id', 'abc']), undefined)
})

test('parseStartArguments rejects unknown flags, missing values, extra positionals, and invalid values', () => {
  assert.throws(() => parseStartArguments(['--unknown']), /Unknown start option: --unknown/)
  assert.throws(() => parseStartArguments(['-x']), /Unknown start option: -x/)
  assert.throws(() => parseStartArguments(['--preset']), /--preset requires a value/)
  assert.throws(() => parseStartArguments(['--preset=']), /--preset requires a value/)
  assert.throws(() => parseStartArguments(['--resume-mode']), /--resume-mode requires a value/)
  assert.throws(() => parseStartArguments(['--session-id']), /--session-id requires a value/)
  assert.throws(() => parseStartArguments(['--preset', 'bogus']), /Invalid --preset value: bogus/)
  assert.throws(() => parseStartArguments(['--preset=bogus']), /Invalid --preset value: bogus/)
  assert.throws(() => parseStartArguments(['--resume-mode', 'bogus']), /Invalid --resume-mode value: bogus/)
  assert.throws(() => parseStartArguments(['--resume-mode=bogus']), /Invalid --resume-mode value: bogus/)
  assert.throws(() => parseStartArguments(['--session-id', '--allow-all']), /Invalid --session-id value/)
  assert.throws(() => parseStartArguments(['--session-id=-bad']), /Invalid --session-id value/)
  assert.throws(() => parseStartArguments(['dir-one', 'dir-two']), /Unexpected start argument: dir-two/)
  assert.throws(() => parseStartArguments(['extra-dir'], { allowWorkspace: false }), /Unexpected start argument: extra-dir/)
})
