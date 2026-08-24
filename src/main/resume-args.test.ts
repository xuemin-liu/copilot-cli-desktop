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

test('buildResumeArgs: auto-resume targets a known session id as a single argv token', () => {
  assert.deepEqual(
    buildResumeArgs({ mode: 'auto-resume', lastSessionId: 'abc123' }),
    ['--resume=abc123'],
  )
})

test('buildResumeArgs: auto-resume falls back to a new session with no known id', () => {
  assert.deepEqual(buildResumeArgs({ mode: 'auto-resume', lastSessionId: null }), [])
})

test('buildResumeArgs: auto-resume rejects an option-looking session id instead of injecting a flag', () => {
  assert.deepEqual(buildResumeArgs({ mode: 'auto-resume', lastSessionId: '--allow-all-tools' }), [])
  assert.deepEqual(buildResumeArgs({ mode: 'auto-resume', lastSessionId: '-x' }), [])
})

test('buildResumeArgs: auto-resume rejects ids outside the safe identifier grammar', () => {
  assert.deepEqual(buildResumeArgs({ mode: 'auto-resume', lastSessionId: 'has a space' }), [])
  assert.deepEqual(buildResumeArgs({ mode: 'auto-resume', lastSessionId: '' }), [])
  assert.deepEqual(buildResumeArgs({ mode: 'auto-resume', lastSessionId: 'a'.repeat(65) }), [])
})

test('isResumeMode narrows valid modes and rejects everything else', () => {
  assert.equal(isResumeMode('new'), true)
  assert.equal(isResumeMode('auto-resume'), true)
  assert.equal(isResumeMode('continue'), true)
  assert.equal(isResumeMode('picker'), true)
  assert.equal(isResumeMode('resume-latest'), false)
  assert.equal(isResumeMode(7), false)
})
