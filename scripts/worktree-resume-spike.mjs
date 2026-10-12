// Spike for the agent workbench plan, phase 3a: where does a session started with --worktree run, and where does it run
// again when the desktop resumes it from the project folder? Real CLI, isolated COPILOT_HOME, a throwaway git repository,
// and the loopback mock model (no paid requests). Prints the cwd of every session.start / session.resume record.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'gitconfig') } })
  await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = Spike\n\temail = spike@example.com\n[init]\n\tdefaultBranch = main\n')
  git('init', '-q')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  await writeFile(join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [repo, directory, join(process.env.USERPROFILE ?? '', 'source', 'repos', 'copilot-worktrees')] }))
  const env = { ...process.env, COPILOT_HOME: copilotHome, COPILOT_DISABLE_KEYTAR: '1', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: baseUrl, COPILOT_MODEL: 'ui-check-model', OPENAI_API_KEY: 'local-ui-check-only', COPILOT_OFFLINE: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  const run = (label, args) => {
    const result = spawnSync(resolution.command, [...resolution.prefixArgs, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 90_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(`[spike] ${label}: exit ${result.status}${result.error ? ' ' + result.error.code : ''}`)
    if (result.status !== 0) console.log(((result.stdout ?? '') + '\n' + (result.stderr ?? '')).trim().split('\n').slice(-15).join('\n'))
    return result
  }
  // The CLI refuses --worktree together with --session-id, so the id is read back from the session store afterwards.
  run('fresh --worktree', ['--worktree', '--name=worktree-spike', '--allow-all-tools', '-p', 'Reply with the saved marker.'])
  const { readdir } = await import('node:fs/promises')
  const [sessionId] = (await readdir(join(copilotHome, 'session-state'))).filter((name) => /^[0-9a-f-]{36}$/.test(name))
  assert.ok(sessionId, 'no session was recorded')
  console.log('[spike] session id from the store: ' + sessionId)
  const events = join(copilotHome, 'session-state', sessionId, 'events.jsonl')
  const cwds = async () => (await readFile(events, 'utf8')).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((record) => record && (record.type === 'session.start' || record.type === 'session.resume'))
    .map((record) => `${record.type} ${record.data?.context?.cwd}`)
  console.log('[spike] after fresh start:\n  ' + (await cwds()).join('\n  '))
  run('resume from the project folder', [`--resume=${sessionId}`, '--allow-all-tools', '-p', 'Reply with the saved marker again.'])
  console.log('[spike] after resume:\n  ' + (await cwds()).join('\n  '))
  console.log('[spike] worktrees now:\n' + git('worktree', 'list', '--porcelain'))
} finally {
  modelServer.closeAllConnections()
  await new Promise((resolveClose) => modelServer.close(() => resolveClose()))
  // Copilot's worktree lives outside the temp folder; prune it so the spike leaves nothing behind.
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repo }) } catch { /* the repo is going away anyway */ }
  await rm(directory, { recursive: true, force: true }).catch(() => {})
}
