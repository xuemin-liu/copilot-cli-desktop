import assert from 'node:assert/strict'
import test from 'node:test'
import { START_OPTION_FLAGS, findWorkspaceArgument, flagValue } from './start-arguments.js'

test('start argument helpers share value flags without mistaking values for the workspace', () => {
  const args = ['--preset', 'full-auto', '--resume-mode', 'continue', 'D:\\work\\project', '--session-id', 'abc']
  assert.equal(findWorkspaceArgument(args), 'D:\\work\\project')
  assert.equal(flagValue(args, START_OPTION_FLAGS.preset), 'full-auto')
  assert.equal(flagValue(args, START_OPTION_FLAGS.resumeMode), 'continue')
  assert.equal(flagValue(args, START_OPTION_FLAGS.sessionId), 'abc')
})

test('findWorkspaceArgument returns undefined when only value flags are present', () => {
  assert.equal(findWorkspaceArgument(['--preset', 'default', '--session-id', 'abc']), undefined)
})
