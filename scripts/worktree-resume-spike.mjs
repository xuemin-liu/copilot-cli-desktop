// Spike for the agent workbench plan, phase 3a: where does a session started with --worktree run, and where does it run
// again when the desktop resumes it from the project folder? Real CLI, isolated COPILOT_HOME, a throwaway git repository,
// and the loopback mock model (no paid requests). Prints the cwd of every session.start / session.resume record.
//
// The mock server lives in this process, so the CLI is spawned asynchronously and its exit awaited: a synchronous spawn
// would block the event loop and starve the very server the CLI is waiting on. A launch that times out or exits
// non-zero fails the spike.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckModelServer } from './check-model-server.mjs'

const { resolveCopilotBinary } = await import('../dist/src/main/resolve-copilot.js')
const resolution = await resolveCopilotBinary()
assert.ok(resolution.version, 'Install Copilot CLI first')
const directory = await mkdtemp(join(tmpdir(), 'copilot-worktree-spike-'))
const repo = join(directory, 'repo')
const copilotHome = join(directory, 'copilot')
const modelServer = createCheckModelServer({})
try {
  await Promise.all([repo, copilotHome].map((path) => mkdir(path)))
  await new Promise((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
  const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'gitconfig') }
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv })
  await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = Spike\n\temail = spike@example.com\n[init]\n\tdefaultBranch = main\n')
  git('init', '-q')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  // Copilot asks to trust the worktree folder; it is created beside the repository, inside the disposable directory.
  await writeFile(join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [repo, directory] }))
  const env = { ...gitEnv, COPILOT_HOME: copilotHome, COPILOT_DISABLE_KEYTAR: '1', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: baseUrl, COPILOT_MODEL: 'ui-check-model', OPENAI_API_KEY: 'local-ui-check-only', COPILOT_OFFLINE: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  const run = async (label, args) => {
    const child = spawn(resolution.command, [...resolution.prefixArgs, ...args], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => child.kill(), 90_000)
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
    clearTimeout(timer)
    console.log(`[spike] ${label}: exit ${code}`)
    if (code !== 0) console.log(output.trim().split('\n').slice(-15).join('\n'))
    assert.equal(code, 0, `${label} did not exit cleanly`)
    return output
  }
  // The CLI refuses --worktree together with --session-id, so the id is read back from the session store afterwards.
  // The worktree name is chosen here, as the desktop does, so the session can be told apart from any other by its cwd.
  const worktreeName = `desktop-spike-${Date.now().toString(16)}`
  await run('fresh --worktree', [`--worktree=${worktreeName}`, '--name=worktree-spike', '--allow-all-tools', '-p', 'Reply with the saved marker.'])
  const [sessionId] = (await readdir(join(copilotHome, 'session-state'))).filter((name) => /^[0-9a-f-]{36}$/.test(name))
  assert.ok(sessionId, 'no session was recorded')
  console.log('[spike] session id from the store: ' + sessionId)
  const events = join(copilotHome, 'session-state', sessionId, 'events.jsonl')
  const cwds = async () => (await readFile(events, 'utf8')).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((record) => record && (record.type === 'session.start' || record.type === 'session.resume'))
    .map((record) => `${record.type} ${record.data?.context?.cwd}`)
  const afterStart = await cwds()
  console.log('[spike] after fresh start:\n  ' + afterStart.join('\n  '))
  assert.ok(afterStart[0]?.toLowerCase().endsWith(`\\${worktreeName}`), 'the session runs in the worktree named by the launcher')
  await run('resume from the project folder', [`--resume=${sessionId}`, '--allow-all-tools', '-p', 'Reply with the saved marker again.'])
  const afterResume = await cwds()
  console.log('[spike] after resume:\n  ' + afterResume.join('\n  '))
  assert.ok(afterResume.some((line) => line.startsWith('session.resume') && line.toLowerCase().endsWith(`\\${worktreeName}`)), 'a resumed session goes back to its worktree')
  console.log('[spike] worktrees now:\n' + git('worktree', 'list', '--porcelain'))
  console.log('[spike] PASS')
} finally {
  modelServer.closeAllConnections()
  await new Promise((resolveClose) => modelServer.close(() => resolveClose()))
  await rm(directory, { recursive: true, force: true }).catch(() => {})
}
