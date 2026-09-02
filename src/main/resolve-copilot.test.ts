import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import test from 'node:test'
import {
  resolveCopilotBinary,
  windowsSystemExecutable,
  withCopilotPathAdditions,
  type ExecFileFn,
} from './resolve-copilot.js'

function fakeExecFile(handlers: Record<string, { stdout: string } | Error>): ExecFileFn {
  return async (file, args) => {
    const key = `${file} ${args.join(' ')}`
    const handler = handlers[key]
    if (!handler) throw new Error(`unexpected command: ${key}`)
    if (handler instanceof Error) throw handler
    return { stdout: handler.stdout, stderr: '' }
  }
}

const WHERE = 'C:\\Windows\\System32\\where.exe'

test('resolveCopilotBinary prefers copilot directly on PATH', async () => {
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'copilot --version': { stdout: 'GitHub Copilot CLI 0.9.1\n' },
  }), 'linux')
  assert.equal(resolution.kind, 'direct')
  assert.equal(resolution.command, 'copilot')
  assert.deepEqual(resolution.prefixArgs, [])
  assert.equal(resolution.version, '0.9.1')
})

test('resolveCopilotBinary returns the absolute Copilot executable path on Windows', async () => {
  const copilotPath = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe'
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    [`${WHERE} copilot`]: { stdout: `${copilotPath}\r\n` },
    [`${copilotPath} --version`]: { stdout: 'GitHub Copilot CLI 0.9.1\n' },
  }), 'win32')
  assert.equal(resolution.command, copilotPath)
  assert.deepEqual(resolution.prefixArgs, [])
  assert.equal(resolution.resolvedPath, copilotPath)
})

test('resolveCopilotBinary unwraps an npm shim to trusted node and package entry without cmd.exe', async () => {
  const shim = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\copilot.cmd'
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const entry = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\index.js'
  const manifest = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\package.json'
  const existing = new Set([shim, node, entry])
  const resolution = await resolveCopilotBinary({
    APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
    ProgramFiles: 'C:\\Program Files',
  }, fakeExecFile({
    [`${WHERE} copilot`]: { stdout: `${shim}\r\n` },
    [`${node} ${entry} --version`]: { stdout: 'GitHub Copilot CLI 1.0.82\n' },
  }), 'win32', (path) => existing.has(path), async (path) => {
    if (path === shim) return '@"%dp0%\\node_modules\\@github\\copilot\\index.js" %*'
    assert.equal(path, manifest)
    return JSON.stringify({ name: '@github/copilot', bin: { copilot: 'index.js' } })
  })
  assert.equal(resolution.command, node)
  assert.deepEqual(resolution.prefixArgs, [entry])
  assert.equal(resolution.resolvedPath, shim)
  assert.ok(!resolution.command.toLowerCase().endsWith('cmd.exe'))
})

test('resolveCopilotBinary refuses an unverifiable command shim instead of invoking a shell', async () => {
  const shim = 'C:\\tools\\copilot.cmd'
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    [`${WHERE} copilot`]: { stdout: `${shim}\r\n` },
    [`${WHERE} gh`]: new Error('not found'),
  }), 'win32', (path) => path === shim, async (path) => path === shim
    ? '@"%dp0%\\node_modules\\@github\\copilot\\..\\outside.js" %*'
    : JSON.stringify({ name: '@github/copilot', bin: { copilot: '..\\outside.js' } }))
  assert.equal(resolution.version, null)
  assert.match(resolution.error ?? '', /unsupported or failed direct launch/)
})

test('resolveCopilotBinary checks standard npm location when Electron PATH is incomplete', async () => {
  const shim = 'C:\\Program Files\\nodejs\\copilot.cmd'
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const entry = 'C:\\Program Files\\nodejs\\node_modules\\@github\\copilot\\index.js'
  const existing = new Set([shim, node, entry])
  const resolution = await resolveCopilotBinary({ ProgramFiles: 'C:\\Program Files' }, fakeExecFile({
    [`${WHERE} copilot`]: new Error('not found'),
    [`${node} ${entry} --version`]: { stdout: '1.0.82\n' },
  }), 'win32', (path) => existing.has(path), async (path) => path === shim
    ? '@"%dp0%\\node_modules\\@github\\copilot\\index.js" %*'
    : JSON.stringify({ name: '@github/copilot', bin: 'index.js' }))
  assert.equal(resolution.command, node)
  assert.deepEqual(resolution.pathAdditions, ['C:\\Program Files\\nodejs'])
})

test('resolveCopilotBinary follows a verified pnpm shim target', async () => {
  const shim = 'C:\\Users\\tester\\AppData\\Local\\pnpm\\copilot.cmd'
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const packageDirectory = 'C:\\Users\\tester\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@github+copilot@1.0.82\\node_modules\\@github\\copilot'
  const entry = `${packageDirectory}\\index.js`
  const manifest = `${packageDirectory}\\package.json`
  const existing = new Set([shim, node, entry])
  const resolution = await resolveCopilotBinary({ ProgramFiles: 'C:\\Program Files' }, fakeExecFile({
    [`${WHERE} copilot`]: { stdout: `${shim}\r\n` },
    [`${node} ${entry} --version`]: { stdout: '1.0.82\n' },
  }), 'win32', (path) => existing.has(path), async (path) => {
    if (path === shim) return '@"%dp0%\\global\\5\\.pnpm\\@github+copilot@1.0.82\\node_modules\\@github\\copilot\\index.js" %*'
    assert.equal(path, manifest)
    return JSON.stringify({ name: '@github/copilot', bin: { copilot: 'index.js' } })
  })
  assert.equal(resolution.command, node)
  assert.deepEqual(resolution.prefixArgs, [entry])
})

test('withCopilotPathAdditions uses the platform delimiter without mutating the source', () => {
  const source = { PATH: 'existing', TOKEN: 'preserved' }
  const result = withCopilotPathAdditions(source, ['first', 'second'])
  assert.equal(result.PATH, ['first', 'second', 'existing'].join(delimiter))
  assert.equal(result.TOKEN, 'preserved')
  assert.equal(source.PATH, 'existing')
})

test('windowsSystemExecutable never depends on the current directory', () => {
  assert.equal(windowsSystemExecutable('taskkill.exe', { SystemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\taskkill.exe')
})

test('resolveCopilotBinary falls back to gh copilot when Copilot is not on PATH', async () => {
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'copilot --version': new Error('ENOENT'),
    'gh copilot -- --version': { stdout: '0.9.1\n' },
  }), 'linux')
  assert.equal(resolution.kind, 'gh-wrapped')
  assert.equal(resolution.command, 'gh')
  assert.deepEqual(resolution.prefixArgs, ['copilot', '--'])
})

test('resolveCopilotBinary reports diagnostics when nothing resolves', async () => {
  const resolution = await resolveCopilotBinary({}, fakeExecFile({
    'copilot --version': new Error('ENOENT'),
    'gh copilot -- --version': new Error('ENOENT'),
  }), 'linux')
  assert.equal(resolution.version, null)
  assert.match(resolution.error ?? '', /was not found/i)
  assert.match(resolution.error ?? '', /copilot --version/)
})
