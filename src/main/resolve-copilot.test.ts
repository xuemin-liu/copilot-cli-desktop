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
  }), 'linux')
  assert.equal(resolution.kind, 'direct')
  assert.equal(resolution.command, 'copilot')
  assert.deepEqual(resolution.prefixArgs, [])
  assert.equal(resolution.version, '0.9.1')
  assert.equal(resolution.error, null)
})

test('resolveCopilotBinary returns the absolute copilot executable path on Windows', async () => {
  const copilotPath = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe'
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'where.exe copilot': { stdout: `${copilotPath}\r\n` },
    [`${copilotPath} --version`]: { stdout: 'GitHub Copilot CLI 0.9.1\n' },
  }), 'win32')
  assert.equal(resolution.kind, 'direct')
  assert.equal(resolution.command, copilotPath)
  assert.equal(resolution.resolvedPath, copilotPath)
  assert.equal(resolution.version, '0.9.1')
})

test('resolveCopilotBinary launches an npm-installed Windows command shim through cmd.exe', async () => {
  const copilotPath = 'C:\\Program Files\\nodejs\\copilot.cmd'
  const commandShell = 'C:\\Windows\\System32\\cmd.exe'
  const resolution = await resolveCopilotBinary({ ComSpec: commandShell }, fakeExecFile({
    'where.exe copilot': { stdout: `${copilotPath}\r\n` },
    [`${commandShell} /d /s /c call ${copilotPath} --version`]: { stdout: 'GitHub Copilot CLI 1.0.80\n' },
  }), 'win32')
  assert.equal(resolution.kind, 'direct')
  assert.equal(resolution.command, commandShell)
  assert.deepEqual(resolution.prefixArgs, ['/d', '/s', '/c', 'call', copilotPath])
  assert.equal(resolution.resolvedPath, copilotPath)
  assert.equal(resolution.version, '1.0.80')
})

test('resolveCopilotBinary falls back to gh copilot when copilot is not on PATH', async () => {
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'copilot --version': new Error('ENOENT'),
    'gh copilot -- --version': { stdout: '0.9.1\n' },
  }), 'linux')
  assert.equal(resolution.kind, 'gh-wrapped')
  assert.equal(resolution.command, 'gh')
  assert.deepEqual(resolution.prefixArgs, ['copilot', '--'])
  assert.equal(resolution.version, '0.9.1')
})

test('resolveCopilotBinary reports a diagnostic error when nothing resolves', async () => {
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'copilot --version': new Error('ENOENT'),
    'gh copilot -- --version': new Error('ENOENT'),
  }), 'linux')
  assert.equal(resolution.version, null)
  assert.match(resolution.error ?? '', /was not found/i)
  assert.match(resolution.error ?? '', /copilot --version/)
  assert.match(resolution.error ?? '', /gh copilot -- --version/)
})
