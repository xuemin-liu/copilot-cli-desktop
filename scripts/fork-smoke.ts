// Opt-in local integration check: only a local mock model, no user sessions.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CopilotRpc } from '../src/main/copilot-rpc.js'
import { forkSessionSnapshot } from '../src/main/session-fork.js'
import { resolveCopilotBinary } from '../src/main/resolve-copilot.js'
import { PtySession } from '../src/main/pty-session.js'
import { spawnNodePty } from '../src/main/node-pty-backend.js'

const directory = await mkdtemp(join(tmpdir(), 'copilot-fork-smoke-'))
const env = { ...process.env, COPILOT_HOME: directory, COPILOT_DISABLE_KEYTAR: '1' }
const resolution = await resolveCopilotBinary()
assert.ok(resolution.version, 'Install Copilot CLI before running this smoke test')
const rpc = new CopilotRpc(resolution, directory, env)
const modelServer = createServer((request, response) => {
  request.resume()
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ id: 'smoke-response', object: 'chat.completion', created: 1, model: 'smoke-model', choices: [{ index: 0, message: { role: 'assistant', content: 'The marker is fork-context-42' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})
await new Promise<void>((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
const address = modelServer.address()
assert.ok(address && typeof address !== 'string')
Object.assign(env, { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`, COPILOT_MODEL: 'smoke-model', OPENAI_API_KEY: 'smoke-local-only', COPILOT_OFFLINE: 'true' })
let parent: PtySession | null = null
let child: PtySession | null = null
try {
  const sessionId = randomUUID()
  console.log('[fork-smoke] CLI', resolution.version)
  console.log('[fork-smoke] Create isolated persisted session')
  const created = await rpc.request('session.create', { sessionId, workingDirectory: directory, availableTools: [], model: 'smoke-model', provider: { type: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'smoke-local-only', wireApi: 'completions' } })
  assert.equal((created as { sessionId: string }).sessionId, sessionId)
  await rpc.request('session.send', { sessionId, prompt: 'Remember the smoke-test marker: fork-context-42' })
  let messages = ''
  for (let index = 0; index < 20; index++) {
    messages = JSON.stringify(await rpc.request('session.getMessages', { sessionId }))
    if (messages.includes('assistant.message')) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  assert.ok(messages.includes('assistant.message'), 'Local mock model did not finish')
  await rpc.request('session.destroy', { sessionId })
  const historyPath = join(directory, 'session-state', sessionId, 'events.jsonl')
  parent = new PtySession({ file: resolution.command, args: [...resolution.prefixArgs, `--resume=${sessionId}`, '--add-dir', directory, '--no-auto-update', '--available-tools=view,glob,grep,ask_user'], cwd: directory, env, cols: 120, rows: 40, spawnPty: spawnNodePty })
  await parent.start()
  let ready = false
  let trusted = false
  for (let index = 0; index < 30; index++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    if (!trusted && parent.recentOutputText.includes('Confirm folder trust')) { parent.write('\r'); trusted = true; continue }
    ready = parent.recentOutputText.includes('The marker is fork-context-42') && parent.processId !== null
    if (ready) break
  }
  assert.ok(ready, 'Parent CLI did not display the persisted test conversation')
  const parentPid = parent.processId
  const before = await readFile(historyPath, 'utf8')
  const forkId = await forkSessionSnapshot(resolution, directory, env, sessionId, 'Side smoke')
  assert.notEqual(forkId, sessionId)
  assert.equal(parent.processId, parentPid)
  const after = await readFile(historyPath, 'utf8')
  for (const line of before.trim().split('\n')) {
    const event = JSON.parse(line) as { id: string }
    assert.ok(after.includes(event.id), 'fork must preserve original history')
  }
  assert.ok((await readFile(join(directory, 'session-state', forkId, 'events.jsonl'), 'utf8')).includes('fork-context-42'))
  child = new PtySession({ file: resolution.command, args: [...resolution.prefixArgs, `--resume=${forkId}`, '--no-auto-update', '--mode=interactive', '--available-tools=view,glob,grep,ask_user'], cwd: directory, env, cols: 120, rows: 40, spawnPty: spawnNodePty })
  await child.start()
  let childTrusted = false
  for (let index = 0; index < 30 && !child.recentOutputText.includes('The marker is fork-context-42'); index++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    if (!childTrusted && child.recentOutputText.includes('Confirm folder trust')) { child.write('\r'); childTrusted = true }
  }
  assert.ok(child.recentOutputText.includes('The marker is fork-context-42'), `Child did not load the copied context: ${child.recentOutputText.slice(-1000)}`)
  assert.notEqual(parent.processId, child.processId)
  assert.ok(parent.processId)
  assert.ok(child.processId)
  await child.stop()
  assert.equal(parent.processId, parentPid, 'closing side chat must preserve original PTY')
  await rpc.request('session.resume', { sessionId: forkId, workingDirectory: directory, availableTools: [], model: 'smoke-model', provider: { type: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'smoke-local-only', wireApi: 'completions' } })
  assert.ok(JSON.stringify(await rpc.request('session.getMessages', { sessionId: forkId })).includes('The marker is fork-context-42'), 'copied session must remain resumable with full context')
  await rpc.request('session.destroy', { sessionId: forkId })
  console.log('[fork-smoke] Independent fork, preserved parent history, copied context, two live PTYs, safe side close: PASS')
} finally {
  await child?.stop()
  await parent?.stop()
  await rpc.stop()
  modelServer.closeAllConnections()
  await new Promise<void>((resolveClose) => modelServer.close(() => resolveClose()))
  await rm(directory, { recursive: true, force: true })
}
// Like smoke.ts, exit after cleanup: Windows node-pty helper handles can
// otherwise keep an already-completed standalone smoke test alive.
process.exit(0)
