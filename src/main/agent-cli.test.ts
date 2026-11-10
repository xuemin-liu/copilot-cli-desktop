import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexSessionDiscovery, buildAgentCliArgs, claudeSessionStored, resolveAgentCli } from './agent-cli.js'
import { newSessionOptions } from './session-name.js'
import { createTab, EMPTY_TABS_STATE } from './session-tab-machine.js'

const ID = '01a1c5e3-4f84-70f1-88f0-9544f1e7e546'
const OTHER_ID = '11111111-2222-4333-8444-555555555555'

test('buildAgentCliArgs names a new Claude Code session and resumes a stored one', () => {
  assert.deepEqual(buildAgentCliArgs('claude', { id: ID, stored: false }), ['--session-id', ID])
  assert.deepEqual(buildAgentCliArgs('claude', { id: ID, stored: true }), ['--resume', ID])
  assert.deepEqual(buildAgentCliArgs('claude', { id: null, stored: false }), [])
})

test('buildAgentCliArgs starts Codex bare and resumes only a stored session', () => {
  assert.deepEqual(buildAgentCliArgs('codex', { id: null, stored: false }), [])
  assert.deepEqual(buildAgentCliArgs('codex', { id: ID, stored: false }), [])
  assert.deepEqual(buildAgentCliArgs('codex', { id: ID, stored: true }), ['resume', ID])
})

test('buildAgentCliArgs refuses an id that is not a UUID, so nothing else can become an argument', () => {
  assert.throws(() => buildAgentCliArgs('claude', { id: '--dangerously-skip-permissions', stored: true }), /Invalid session id/)
  assert.throws(() => buildAgentCliArgs('codex', { id: 'exec', stored: true }), /Invalid session id/)
})

test('resolveAgentCli runs the executable an npm shim declares, never the shim', async () => {
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'
  const exe = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  const files: Record<string, string> = {
    [shim]: '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\package.json': JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'bin/claude.exe' } }),
  }
  const calls: string[] = []
  const found = await resolveAgentCli('claude', {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    pathExists: (path) => path === exe || path in files,
    readTextFile: async (path) => { if (path in files) return files[path]!; throw new Error('missing') },
    execFile: async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`)
      if (file.toLowerCase().endsWith('where.exe')) return { stdout: `C:\\Users\\me\\AppData\\Roaming\\npm\\claude\r\n${shim}\r\n`, stderr: '' }
      if (file === exe) return { stdout: '2.1.206 (Claude Code)\n', stderr: '' }
      throw new Error(`unexpected ${file}`)
    },
  })
  assert.equal(found.error, null)
  assert.equal(found.command, exe)
  assert.deepEqual(found.prefixArgs, [])
  assert.equal(found.version, '2.1.206')
  assert.ok(!calls.some((call) => call.startsWith(shim)))
})

test('resolveAgentCli runs a script shim with node and its script', async () => {
  const shim = 'C:\\npm\\codex.cmd'
  const script = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
  const node = 'C:\\npm\\node.exe'
  const files: Record<string, string> = {
    [shim]: '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    'C:\\npm\\node_modules\\@openai\\codex\\package.json': JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }),
  }
  const found = await resolveAgentCli('codex', {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows' },
    pathExists: (path) => path === script || path === node || path in files,
    readTextFile: async (path) => { if (path in files) return files[path]!; throw new Error('missing') },
    execFile: async (file, args) => {
      if (file.toLowerCase().endsWith('where.exe')) return { stdout: `${shim}\r\n`, stderr: '' }
      if (file === node && args[0] === script) return { stdout: 'codex-cli 0.167.0\n', stderr: '' }
      throw new Error(`unexpected ${file}`)
    },
  })
  assert.equal(found.command, node)
  assert.deepEqual(found.prefixArgs, [script])
  assert.equal(found.version, '0.167.0')
  assert.deepEqual(found.pathAdditions, ['C:\\npm'])
})

test('resolveAgentCli refuses a shim that points outside its package, and says how to install', async () => {
  const shim = 'C:\\npm\\codex.cmd'
  const found = await resolveAgentCli('codex', {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    pathExists: () => true,
    readTextFile: async () => '"%dp0%\\evil\\run.exe" %*',
    execFile: async (file) => {
      if (file.toLowerCase().endsWith('where.exe')) return { stdout: `${shim}\r\n`, stderr: '' }
      throw new Error('must not run')
    },
  })
  assert.equal(found.version, null)
  assert.match(found.error ?? '', /Codex CLI was not found/)
  assert.match(found.error ?? '', /npm install -g @openai\/codex/)
})

test('resolveAgentCli finds the program on PATH outside Windows', async () => {
  const found = await resolveAgentCli('claude', {
    platform: 'linux',
    env: { PATH: '/usr/local/bin' },
    findExecutable: async (name) => name === 'claude' ? '/usr/local/bin/claude' : null,
    execFile: async (file) => {
      assert.equal(file, '/usr/local/bin/claude')
      return { stdout: '2.1.206 (Claude Code)\n', stderr: '' }
    },
  })
  assert.equal(found.command, '/usr/local/bin/claude')
  assert.equal(found.version, '2.1.206')
})

test('claudeSessionStored finds a session only once Claude Code has written it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cli-claude-'))
  try {
    const env = { CLAUDE_CONFIG_DIR: root }
    assert.equal(await claudeSessionStored(ID, env), false)
    await mkdir(join(root, 'projects', 'D--work-project'), { recursive: true })
    assert.equal(await claudeSessionStored(ID, env), false)
    await writeFile(join(root, 'projects', 'D--work-project', `${ID}.jsonl`), '{}\n')
    assert.equal(await claudeSessionStored(ID, env), true)
    assert.equal(await claudeSessionStored('../../etc/passwd', env), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

function dayFolder(root: string, time: number): string {
  const day = new Date(time)
  return join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
}

function rollout(id: string, cwd: string): string {
  return `${JSON.stringify({ timestamp: 'now', type: 'session_meta', payload: { id, cwd, base_instructions: 'x'.repeat(20_000) } })}\n`
}

test('CodexSessionDiscovery takes the new session in the tab folder and nothing else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cli-codex-'))
  try {
    const now = Date.now()
    const folder = dayFolder(root, now)
    const cwd = join(root, 'project')
    await mkdir(folder, { recursive: true })
    // There before the tab started: someone else's, even though it ran in the same folder.
    await writeFile(join(folder, `rollout-2026-01-01T00-00-00-${OTHER_ID}.jsonl`), rollout(OTHER_ID, cwd))
    let polls = 0
    const claimed: string[] = []
    const discovery = new CodexSessionDiscovery({
      root, cwd, now: () => now,
      claim: (id) => { claimed.push(id); return true },
      sleep: async () => {
        polls += 1
        if (polls === 1) {
          // Started meanwhile in another folder, and one whose first record is not written yet.
          await writeFile(join(folder, 'rollout-2026-01-01T00-00-01-22222222-2222-4333-8444-555555555555.jsonl'), rollout('22222222-2222-4333-8444-555555555555', join(root, 'elsewhere')))
          await writeFile(join(folder, `rollout-2026-01-01T00-00-02-${ID}.jsonl`), '')
        }
        if (polls === 2) await writeFile(join(folder, `rollout-2026-01-01T00-00-02-${ID}.jsonl`), rollout(ID, cwd))
        if (polls > 5) throw new Error('not found')
      },
    })
    await discovery.ready()
    assert.equal(await discovery.find(), ID)
    assert.deepEqual(claimed, [ID])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CodexSessionDiscovery leaves a session another tab already has, and stops when cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cli-codex-'))
  try {
    const now = Date.now()
    const folder = dayFolder(root, now)
    const cwd = join(root, 'project')
    await mkdir(folder, { recursive: true })
    let polls = 0
    const discovery: CodexSessionDiscovery = new CodexSessionDiscovery({
      root, cwd, now: () => now,
      claim: () => false,
      sleep: async () => {
        polls += 1
        if (polls === 1) await writeFile(join(folder, `rollout-2026-01-01T00-00-02-${ID}.jsonl`), rollout(ID, cwd))
        if (polls === 3) discovery.cancel()
      },
    })
    assert.equal(await discovery.find(), null)
    assert.equal(polls, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('newSessionOptions carries another CLI and refuses a new worktree for it', () => {
  assert.deepEqual(newSessionOptions({ cli: 'claude' }), { cli: 'claude' })
  assert.deepEqual(newSessionOptions({ cli: 'codex', worktreePath: 'D:\\repo.worktrees\\a' }), { cli: 'codex', worktreePath: 'D:\\repo.worktrees\\a' })
  assert.deepEqual(newSessionOptions({ cli: 'copilot', worktree: true }), { worktree: true })
  assert.throws(() => newSessionOptions({ cli: 'bash' }), /Invalid session options/)
  assert.throws(() => newSessionOptions({ cli: 'claude', worktree: true }), /Invalid session options/)
})

test('a tab keeps the CLI it runs', () => {
  const state = createTab(EMPTY_TABS_STATE, { id: 'tab-1', title: 'Claude Code', cli: 'claude', workspaceProfileId: 'p', cliVersion: '2.1.206',
    sessionPermissionPreset: null, permissionWarning: null, remote: false })
  assert.equal(state.tabs[0]?.cli, 'claude')
  const copilot = createTab(EMPTY_TABS_STATE, { id: 'tab-1', title: 'x', workspaceProfileId: 'p', cliVersion: null, sessionPermissionPreset: null, permissionWarning: null, remote: false })
  assert.equal('cli' in copilot.tabs[0]!, false)
})
