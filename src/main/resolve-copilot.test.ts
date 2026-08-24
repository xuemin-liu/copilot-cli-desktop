import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCopilotBinary, type ExecFileFn } from './resolve-copilot.js'

function fakeExecFile(handlers: Record<string, { stdout: string } | Error>): ExecFileFn {
  return async (file, args) => {
    const key = `${file} ${args.join(' ')}`
    const handler = handlers[key]
    if (!handler) throw new Error(`unexpected command: ${key}`)
    if (handler instanceof Error) throw handler
    return { stdout: handler.stdout, stderr: '' }
  }
}

test('resolveCopilotBinary prefers copilot directly on PATH', async () => {
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'copilot --version': { stdout: 'GitHub Copilot CLI 0.9.1\n' },
  }))
  assert.equal(resolution.kind, 'direct')
  assert.equal(resolution.command, 'copilot')
  assert.deepEqual(resolution.prefixArgs, [])
  assert.equal(resolution.version, '0.9.1')
  assert.equal(resolution.error, null)
})

test('resolveCopilotBinary falls back to gh copilot when copilot is not on PATH', async () => {
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'copilot --version': new Error('ENOENT'),
    'gh copilot -- --version': { stdout: '0.9.1\n' },
  }))
  assert.equal(resolution.kind, 'gh-wrapped')
  assert.equal(resolution.command, 'gh')
  assert.deepEqual(resolution.prefixArgs, ['copilot', '--'])
  assert.equal(resolution.version, '0.9.1')
})

test('resolveCopilotBinary reports a diagnostic error when nothing resolves', async () => {
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'copilot --version': new Error('ENOENT'),
    'gh copilot -- --version': new Error('ENOENT'),
  }))
  assert.equal(resolution.version, null)
  assert.match(resolution.error ?? '', /was not found/i)
  assert.match(resolution.error ?? '', /copilot --version/)
  assert.match(resolution.error ?? '', /gh copilot -- --version/)
})
