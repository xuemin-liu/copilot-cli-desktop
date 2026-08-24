import assert from 'node:assert/strict'
import test from 'node:test'
import { buildResumeArgs, isResumeMode } from './resume-args.js'

test('buildResumeArgs: new starts a plain session with no resume flags', () => {
  assert.deepEqual(buildResumeArgs({ mode: 'new', lastSessionId: null }), [])
  assert.deepEqual(buildResumeArgs({ mode: 'new', lastSessionId: 'abc123' }), [])
})

test('buildResumeArgs: continue always uses --continue regardless of a known id', () => {
  assert.deepEqual(buildResumeArgs({ mode: 'continue', lastSessionId: null }), ['--continue'])
  assert.deepEqual(buildResumeArgs({ mode: 'continue', lastSessionId: 'abc123' }), ['--continue'])
})

test('buildResumeArgs: picker opens the interactive --resume session picker with no id', () => {
  assert.deepEqual(buildResumeArgs({ mode: 'picker', lastSessionId: null }), ['--resume'])
  assert.deepEqual(buildResumeArgs({ mode: 'picker', lastSessionId: 'abc123' }), ['--resume'])
})

test('buildResumeArgs: auto-resume targets a known session id', () => {
  assert.deepEqual(
    buildResumeArgs({ mode: 'auto-resume', lastSessionId: 'abc123' }),
    ['--resume', 'abc123'],
  )
})

test('buildResumeArgs: auto-resume falls back to a new session with no known id', () => {
  assert.deepEqual(buildResumeArgs({ mode: 'auto-resume', lastSessionId: null }), [])
})

test('isResumeMode narrows valid modes and rejects everything else', () => {
  assert.equal(isResumeMode('new'), true)
  assert.equal(isResumeMode('auto-resume'), true)
  assert.equal(isResumeMode('continue'), true)
  assert.equal(isResumeMode('picker'), true)
  assert.equal(isResumeMode('resume-latest'), false)
  assert.equal(isResumeMode(7), false)
})
