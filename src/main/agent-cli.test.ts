import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  AntigravitySessionDiscovery,
  CodexSessionDiscovery,
  agentCliHelp,
  antigravityDataRoot,
  antigravitySessionStored,
  buildAgentCliArgs,
  claudeProjectTrusted,
  claudeSessionStored,
  codexAcceptsMcpOverride,
  resolveAgentCli,
} from './agent-cli.js'
import { OTHER_CLI_CACHE_MS } from './agent-cli-cache.js'
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

test('buildAgentCliArgs starts Antigravity bare and resumes only a stored conversation', () => {
  assert.deepEqual(buildAgentCliArgs('antigravity', { id: null, stored: false }), [])
  assert.deepEqual(buildAgentCliArgs('antigravity', { id: ID, stored: false }), [])
  assert.deepEqual(buildAgentCliArgs('antigravity', { id: ID, stored: true }), ['--conversation', ID])
})

test('buildAgentCliArgs refuses an id that is not a UUID, so nothing else can become an argument', () => {
  assert.throws(() => buildAgentCliArgs('claude', { id: '--dangerously-skip-permissions', stored: true }), /Invalid session id/)
  assert.throws(() => buildAgentCliArgs('codex', { id: 'exec', stored: true }), /Invalid session id/)
  assert.throws(() => buildAgentCliArgs('antigravity', { id: '--dangerously-skip-permissions', stored: true }), /Invalid session id/)
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

test('resolveAgentCli falls back to the Windows Codex Store app when codex is not on PATH or npm', async () => {
  const installLocation = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1120.6357.0_x64__2p2nqsd0c76g0'
  const appExe = `${installLocation}\\app\\resources\\codex.exe`
  const calls: Array<{ file: string; args: string[]; cwd: string | undefined }> = []
  const found = await resolveAgentCli('codex', {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    pathExists: (path) => path === appExe,
    execFile: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd })
      if (file.toLowerCase().endsWith('where.exe')) throw new Error('INFO: Could not find files')
      if (file.toLowerCase().endsWith('powershell.exe')) {
        assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
        assert.equal(options.cwd, 'C:\\Windows\\System32')
        return { stdout: `relative\\ignored\r\n${installLocation}\r\n`, stderr: '' }
      }
      assert.equal(file, appExe)
      assert.deepEqual(args, ['--version'])
      return { stdout: 'codex-cli 0.171.0-alpha.13.2\n', stderr: '' }
    },
  })
  assert.equal(found.error, null)
  assert.equal(found.command, appExe)
  assert.equal(found.resolvedPath, appExe)
  assert.deepEqual(found.prefixArgs, [])
  assert.equal(found.version, '0.171.0-alpha.13.2')
  assert.equal(calls.length, 3)
})

test('resolveAgentCli prefers codex on Windows PATH and falls back to the Store app only if PATH fails', async () => {
  const pathExe = 'C:\\Tools\\codex.exe'
  const installLocation = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1'
  const appExe = `${installLocation}\\app\\resources\\codex.exe`

  // When PATH succeeds, PowerShell is never invoked.
  const fromPath = await resolveAgentCli('codex', {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    pathExists: (path) => path === appExe,
    execFile: async (file, args) => {
      if (file.toLowerCase().endsWith('where.exe')) return { stdout: `${pathExe}\r\n`, stderr: '' }
      if (file.toLowerCase().endsWith('powershell.exe')) assert.fail('must not query Windows Store when PATH succeeds')
      assert.equal(file, pathExe)
      assert.deepEqual(args, ['--version'])
      return { stdout: 'codex-cli 0.170.0\n', stderr: '' }
    },
  })
  assert.equal(fromPath.command, pathExe)
  assert.equal(fromPath.version, '0.170.0')

  // When PATH fails its version probe, fall back to the Store app.
  const fromApp = await resolveAgentCli('codex', {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    pathExists: (path) => path === appExe,
    execFile: async (file) => {
      if (file.toLowerCase().endsWith('where.exe')) return { stdout: `${pathExe}\r\n`, stderr: '' }
      if (file === pathExe) throw new Error('broken executable')
      if (file.toLowerCase().endsWith('powershell.exe')) return { stdout: `${installLocation}\r\n`, stderr: '' }
      if (file === appExe) return { stdout: 'codex-cli 0.171.0-alpha.13.2\n', stderr: '' }
      throw new Error(`unexpected ${file}`)
    },
  })
  assert.equal(fromApp.error, null)
  assert.equal(fromApp.command, appExe)
  assert.equal(fromApp.version, '0.171.0-alpha.13.2')
})

test('resolveAgentCli memoizes Windows Codex Store lookups across routine misses until expiry or fresh launch', async () => {
  const installLocation = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_2'
  const appExe = `${installLocation}\\app\\resources\\codex.exe`
  let clock = 1_000
  let storeInstalled = false
  let powershellCalls = 0
  let releaseFirstLookup!: () => void
  const firstLookupGate = new Promise<void>((resolve) => { releaseFirstLookup = resolve })
  const execFile = async (file: string) => {
    if (file.toLowerCase().endsWith('where.exe')) throw new Error('INFO: Could not find files')
    if (file.toLowerCase().endsWith('powershell.exe')) {
      powershellCalls += 1
      if (powershellCalls === 1) await firstLookupGate
      return { stdout: storeInstalled ? `${installLocation}\r\n` : '', stderr: '' }
    }
    if (file === appExe) return { stdout: 'codex-cli 0.172.0\n', stderr: '' }
    throw new Error(`unexpected ${file}`)
  }
  const deps = () => ({
    platform: 'win32' as const,
    env: { SystemRoot: 'C:\\Windows' },
    pathExists: (path: string) => storeInstalled && path === appExe,
    execFile,
    now: () => clock,
  })

  // Concurrent routine misses share the same in-flight PowerShell lookup.
  const firstPending = resolveAgentCli('codex', deps())
  const secondPending = resolveAgentCli('codex', deps())
  releaseFirstLookup()
  const [first, second] = await Promise.all([firstPending, secondPending])
  assert.equal(first.version, null)
  assert.equal(second.version, null)
  assert.equal(powershellCalls, 1)

  // Another routine miss within OTHER_CLI_CACHE_MS reuses the memoized empty result without running PowerShell.
  clock += OTHER_CLI_CACHE_MS - 1
  assert.equal((await resolveAgentCli('codex', deps())).version, null)
  assert.equal(powershellCalls, 1)

  // A fresh launch bypasses the memo, finds the newly installed Store app, and refreshes the memo for routine checks.
  storeInstalled = true
  const freshFound = await resolveAgentCli('codex', { ...deps(), fresh: true })
  assert.equal(freshFound.error, null)
  assert.equal(freshFound.command, appExe)
  assert.equal(freshFound.version, '0.172.0')
  assert.equal(powershellCalls, 2)

  // A routine check immediately after reuses the refreshed Store location without running PowerShell again.
  const routineFound = await resolveAgentCli('codex', deps())
  assert.equal(routineFound.command, appExe)
  assert.equal(powershellCalls, 2)

  // Once OTHER_CLI_CACHE_MS passes, a routine check queries PowerShell again.
  clock += OTHER_CLI_CACHE_MS
  const afterExpiry = await resolveAgentCli('codex', deps())
  assert.equal(afterExpiry.command, appExe)
  assert.equal(powershellCalls, 3)
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

test('resolveAgentCli prefers agy.exe on Windows PATH and falls back to Google’s install location', async () => {
  const pathExe = 'C:\\Tools\\Antigravity\\agy.exe'
  const localAppData = 'C:\\Users\\me\\AppData\\Local'
  const installedExe = `${localAppData}\\agy\\bin\\agy.exe`
  for (const expected of [pathExe, installedExe]) {
    const found = await resolveAgentCli('antigravity', {
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
      pathExists: (path) => path === installedExe,
      readTextFile: async () => assert.fail('Antigravity uses a native binary'),
      execFile: async (file, args) => {
        if (file.toLowerCase().endsWith('where.exe')) {
          assert.deepEqual(args, ['agy'])
          const paths = ['C:\\Tools\\agy.cmd', ...(expected === pathExe ? [pathExe] : [])]
          return { stdout: paths.join('\r\n'), stderr: '' }
        }
        assert.equal(file, expected)
        assert.deepEqual(args, ['--version'])
        return { stdout: 'agy version 1.5.0\n', stderr: '' }
      },
    })
    assert.equal(found.command, expected)
    assert.equal(found.version, '1.5.0')
    assert.deepEqual(found.prefixArgs, [])
  }
})

test('resolveAgentCli checks the Antigravity installer bin folder on POSIX', async () => {
  const home = join(tmpdir(), 'agy-home')
  const bin = join(home, '.local', 'bin')
  const executable = join(bin, 'agy')
  const found = await resolveAgentCli('antigravity', {
    platform: 'linux',
    env: { HOME: home, PATH: '/usr/local/bin' },
    findExecutable: async (name, env) => {
      assert.equal(name, 'agy')
      assert.deepEqual(env.PATH?.split(delimiter), ['/usr/local/bin', bin])
      return executable
    },
    execFile: async (file, args) => {
      assert.equal(file, executable)
      assert.deepEqual(args, ['--version'])
      return { stdout: 'agy version 1.5.0\n', stderr: '' }
    },
  })
  assert.equal(found.command, executable)
  assert.equal(found.version, '1.5.0')
})

test('a missing Antigravity CLI points to the official download', async () => {
  const found = await resolveAgentCli('antigravity', { platform: 'linux', findExecutable: async () => null })
  assert.equal(found.version, null)
  assert.match(found.error ?? '', /Antigravity CLI was not found.*https:\/\/antigravity\.google\/download/)
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
  assert.deepEqual(newSessionOptions({ cli: 'antigravity', worktreePath: 'D:\\repo.worktrees\\a' }), { cli: 'antigravity', worktreePath: 'D:\\repo.worktrees\\a' })
  assert.deepEqual(newSessionOptions({ cli: 'copilot', worktree: true }), { worktree: true })
  assert.throws(() => newSessionOptions({ cli: 'bash' }), /Invalid session options/)
  assert.throws(() => newSessionOptions({ cli: 'claude', worktree: true }), /Invalid session options/)
  assert.throws(() => newSessionOptions({ cli: 'antigravity', worktree: true }), /Invalid session options/)
})

test('a tab keeps the CLI it runs', () => {
  const state = createTab(EMPTY_TABS_STATE, { id: 'tab-1', title: 'Claude Code', cli: 'claude', workspaceProfileId: 'p', cliVersion: '2.1.206',
    sessionPermissionPreset: null, permissionWarning: null, remote: false })
  assert.equal(state.tabs[0]?.cli, 'claude')
  const copilot = createTab(EMPTY_TABS_STATE, { id: 'tab-1', title: 'x', workspaceProfileId: 'p', cliVersion: null, sessionPermissionPreset: null, permissionWarning: null, remote: false })
  assert.equal('cli' in copilot.tabs[0]!, false)
})

test('agentCliHelp reads the resolved executable help, including output from a non-zero exit', async () => {
  const calls: string[][] = []
  const launch = { command: 'C:\tools\node.exe', prefixArgs: ['C:\pkg\cli.js'], pathAdditions: [] }
  const ok = await agentCliHelp(launch, { env: {}, execFile: async (file, args) => { calls.push([file, ...args]); return { stdout: 'Options:\n  --model <m>', stderr: '' } } })
  assert.equal(ok, 'Options:\n  --model <m>')
  assert.deepEqual(calls, [['C:\tools\node.exe', 'C:\pkg\cli.js', '--help']])
  const failedWithOutput = await agentCliHelp(launch, { env: {}, execFile: async () => { throw Object.assign(new Error('exit 1'), { stdout: '', stderr: 'Usage: x --sandbox' }) } })
  assert.equal(failedWithOutput, 'Usage: x --sandbox')
  assert.equal(await agentCliHelp(launch, { env: {}, execFile: async () => { throw new Error('ENOENT') } }), null)
})

test('codexAcceptsMcpOverride asks Codex itself, in the tab folder, whether the override still loads', async () => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const launch = { command: 'C:/codex/codex.exe', prefixArgs: [], pathAdditions: [] }
  const override = ['-c', 'mcp_servers.copilot-meeting.url=http://127.0.0.1:1/mcp?tab=x']
  const loads = await codexAcceptsMcpOverride(launch, override, 'copilot-meeting', 'D:/repo', { env: {}, execFile: async (file, args, options) => { calls.push({ argv: [file, ...args], cwd: options.cwd }); return { stdout: 'copilot-meeting', stderr: '' } } })
  assert.equal(loads, true)
  assert.deepEqual(calls, [{ argv: ['C:/codex/codex.exe', ...override, 'mcp', 'get', 'copilot-meeting'], cwd: 'D:/repo' }])
  // A stdio entry of the person's own plus a url: "failed to load bootstrap configuration", so the tab keeps that entry.
  assert.equal(await codexAcceptsMcpOverride(launch, override, 'copilot-meeting', 'D:/repo', { env: {}, execFile: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'url is not supported for stdio' }) } }), false)
})

function writeAntigravitySummary(
  root: string,
  row: { id: string; workspaces: string[]; parentId?: string; nestingDepth?: number },
): void {
  const db = new DatabaseSync(join(root, 'conversation_summaries.db'))
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      workspace_uris TEXT NOT NULL,
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0
    )`)
    db.prepare(`INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, parent_conversation_id, nesting_depth)
      VALUES (?, ?, ?, ?)`).run(
      row.id,
      JSON.stringify(row.workspaces.map((folder) => pathToFileURL(folder).href)),
      row.parentId ?? '',
      row.nestingDepth ?? 0,
    )
  } finally { db.close() }
}

test('antigravitySessionStored checks stored conversation files and summaries safely', async () => {
  const gemini = await mkdtemp(join(tmpdir(), 'agent-cli-agy-stored-'))
  try {
    const env = { ANTIGRAVITY_GEMINI_DIR: gemini }
    const root = antigravityDataRoot(env)
    assert.equal(root, join(gemini, 'antigravity-cli'))
    assert.equal(await antigravitySessionStored(ID, env), false)
    assert.equal(await antigravitySessionStored('../../etc/passwd', env), false)
    await mkdir(join(root, 'conversations'), { recursive: true })
    await writeFile(join(root, 'conversations', `${ID}.db`), '')
    assert.equal(await antigravitySessionStored(ID, env), true)
    assert.equal(await antigravitySessionStored(OTHER_ID, env), false)
    writeAntigravitySummary(root, { id: OTHER_ID, workspaces: [join(gemini, 'project')] })
    assert.equal(await antigravitySessionStored(OTHER_ID, env), true)
  } finally { await rm(gemini, { recursive: true, force: true }) }
})

test('AntigravitySessionDiscovery claims the new top-level conversation for the tab folder and ignores others', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cli-agy-discover-'))
  try {
    const now = Date.now()
    const cwd = join(root, 'my project')
    const elsewhere = join(root, 'elsewhere')
    await mkdir(cwd, { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    // Existed before the tab started: must never be claimed even though it shares the folder.
    writeAntigravitySummary(root, { id: OTHER_ID, workspaces: [cwd] })
    const subagentId = '22222222-2222-4333-8444-555555555555'
    const otherFolderId = '33333333-3333-4333-8444-555555555555'
    let polls = 0
    const claimed: string[] = []
    const discovery = new AntigravitySessionDiscovery({
      root, cwd, now: () => now,
      claim: (id) => { claimed.push(id); return true },
      sleep: async () => {
        polls += 1
        if (polls === 1) {
          // Subagent in same folder, unrelated folder, and target conversation before workspace_uris is populated.
          writeAntigravitySummary(root, { id: subagentId, workspaces: [cwd], parentId: OTHER_ID, nestingDepth: 1 })
          writeAntigravitySummary(root, { id: otherFolderId, workspaces: [elsewhere] })
          writeAntigravitySummary(root, { id: ID, workspaces: [] })
        }
        if (polls === 2) writeAntigravitySummary(root, { id: ID, workspaces: [cwd] })
        if (polls > 5) throw new Error('not found')
      },
    })
    await discovery.ready()
    assert.equal(await discovery.find(), ID)
    assert.deepEqual(claimed, [ID])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('AntigravitySessionDiscovery falls back to history.jsonl and supports immediate check()', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cli-agy-history-'))
  try {
    const cwd = join(root, 'repo')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(root, 'history.jsonl'), `${JSON.stringify({ workspace: cwd, conversationId: OTHER_ID })}\n`)
    const discovery = new AntigravitySessionDiscovery({ root, cwd, claim: () => true })
    await discovery.ready()
    assert.equal(await discovery.check(), null)
    await writeFile(
      join(root, 'history.jsonl'),
      `${JSON.stringify({ workspace: cwd, conversationId: OTHER_ID })}\n${JSON.stringify({ workspace: cwd, conversationId: ID })}\n`,
    )
    assert.equal(await discovery.check(), ID)
    // Repeated check returns the already-claimed id without claiming again.
    assert.equal(await discovery.check(), ID)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('AntigravitySessionDiscovery skips a conversation another tab claimed and stops on cancel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cli-agy-cancel-'))
  try {
    const cwd = join(root, 'repo')
    await mkdir(cwd, { recursive: true })
    let polls = 0
    const discovery = new AntigravitySessionDiscovery({
      root, cwd,
      claim: () => false,
      sleep: async () => {
        polls += 1
        if (polls === 1) writeAntigravitySummary(root, { id: ID, workspaces: [cwd] })
        if (polls === 3) discovery.cancel()
      },
    })
    assert.equal(await discovery.find(), null)
    assert.equal(polls, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('claudeProjectTrusted reads trust for a project folder from Claude Code\'s own record, by either path spelling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-trust-'))
  try {
    const env = { CLAUDE_CONFIG_DIR: dir }
    const project = join(dir, 'Work', 'project')
    // No record yet: not trusted.
    assert.equal(await claudeProjectTrusted([project], env), false)
    await writeFile(join(dir, '.claude.json'), JSON.stringify({ projects: {
      [project.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true },
      [join(dir, 'declined')]: { hasTrustDialogAccepted: false },
      [join(dir, 'odd')]: { hasTrustDialogAccepted: 'true' },
    } }))
    assert.equal(await claudeProjectTrusted([project], env), true)
    assert.equal(await claudeProjectTrusted([`${project}${process.platform === 'win32' ? '\\' : '/'}`], env), true, 'a trailing separator is the same folder')
    // A worktree is trusted through its main repository's folder, given beside it.
    assert.equal(await claudeProjectTrusted([join(dir, 'worktree'), null, project], env), true)
    assert.equal(await claudeProjectTrusted([join(dir, 'declined')], env), false)
    // A linked worktree with its own trust record, and none for its main repository: asked about the main folder
    // alone (as the reviewer launch does), it is not trusted.
    await writeFile(join(dir, '.claude.json'), JSON.stringify({ projects: { [join(dir, 'feature-wt')]: { hasTrustDialogAccepted: true } } }))
    assert.equal(await claudeProjectTrusted([join(dir, 'main')], env), false)
    assert.equal(await claudeProjectTrusted([join(dir, 'feature-wt')], env), true)
    await writeFile(join(dir, '.claude.json'), JSON.stringify({ projects: { [project.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true }, [join(dir, 'declined')]: { hasTrustDialogAccepted: false }, [join(dir, 'odd')]: { hasTrustDialogAccepted: 'true' } } }))
    assert.equal(await claudeProjectTrusted([join(dir, 'odd')], env), false)
    assert.equal(await claudeProjectTrusted([join(dir, 'Work')], env), false, 'a parent folder is not the project')
    assert.equal(await claudeProjectTrusted([null, undefined, ''], env), false)
    // An unreadable record counts as not trusted.
    await writeFile(join(dir, '.claude.json'), '{ not json')
    assert.equal(await claudeProjectTrusted([project], env), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
