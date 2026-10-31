// Real CLI /resume in one PTY, isolated profile and loopback mock model. No paid model requests or live Desktop meetings.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCopilotBinary } from '../dist/src/main/resolve-copilot.js'
import { spawnNodePty } from '../dist/src/main/node-pty-backend.js'
import { PtySession } from '../dist/src/main/pty-session.js'
import { MeetingTurnReader } from '../dist/src/main/meeting-turns.js'
import { MeetingControlServer, prepareMeetingSessionEnvironment } from '../dist/src/main/meeting-session.js'
import { withoutSensitiveEnvironment } from '../dist/src/main/secure-credentials.js'
import { taskPasteSequence } from '../dist/src/main/session-task.js'
import { createCheckModelServer } from './check-model-server.mjs'

const directory = await mkdtemp(join(tmpdir(), 'meeting-binding-check-'))
const home = join(directory, 'copilot')
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222'
const reader = new MeetingTurnReader()
const accepted = []
let rejected = false
let session
let lastOutputAt = Date.now()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const model = createCheckModelServer({ reply(request) {
  const messages = request.messages ?? []
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  if (lastUser < 0 || !JSON.stringify(messages[lastUser].content).includes('binding-check-meeting')) return
  if (messages.slice(lastUser + 1).some(message => message.role === 'tool')) return
  const name = process.platform === 'win32' ? 'powershell' : 'bash'
  if (!request.tools?.some(tool => tool.function?.name === name)) return
  const command = process.platform === 'win32'
    ? '& "$env:COPILOT_DESKTOP_MEETING_HELPER" start -Topic "binding check" -File "$env:BINDING_CHECK_PROPOSAL"'
    : 'sh "$COPILOT_DESKTOP_MEETING_HELPER" start -Topic "binding check" -File "$BINDING_CHECK_PROPOSAL"'
  return { role: 'assistant', content: null, tool_calls: [{ id: `binding-${Date.now()}`, type: 'function', function: {
    name, arguments: JSON.stringify({ command, description: 'Verify isolated meeting authorization after a session switch' }),
  } }] }
} })
const control = new MeetingControlServer(async (_tab, command, request) => {
  if (command !== 'start') return { ok: false, message: 'Only the isolated start authorization is checked.' }
  await session.refreshSessionRecords(request.sessionId)
  const binding = session.bindingDiagnostic
  if (binding.kind !== 'bound' || binding.sessionId !== request.sessionId || !reader.answeringPerson) {
    rejected = true
    console.log(JSON.stringify({ rejected: request.sessionId, binding, ownership: session.bindingOwnershipDiagnostic, reader: reader.diagnostic }))
    return { ok: false, message: 'The isolated check could not verify a live person turn.' }
  }
  session.commitSessionBinding()
  accepted.push(request.sessionId)
  return { ok: true, message: 'Isolated binding check accepted.' }
})

async function until(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
async function send(text) {
  session.write(taskPasteSequence(text))
  await delay(300)
  session.write('\r')
}
async function ready() {
  await until(() => session.bracketedPaste && Date.now() - lastOutputAt >= 1800, 'the CLI prompt is ready')
}

try {
  await mkdir(home)
  await writeFile(join(home, 'config.json'), JSON.stringify({ trustedFolders: [directory] }))
  const proposal = join(directory, 'proposal.md')
  await writeFile(proposal, 'A disposable plan for the meeting binding regression check.\n')
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const resolution = await resolveCopilotBinary()
  assert.ok(resolution.version, 'Install Copilot CLI before running this check')
  console.log(`Checking in-process session switching with CLI ${resolution.version}`)
  const env = await prepareMeetingSessionEnvironment(join(directory, 'helper'), await control.register('isolated-tab'), {
    ...withoutSensitiveEnvironment(process.env), COPILOT_HOME: home, COPILOT_DISABLE_KEYTAR: '1', COPILOT_OFFLINE: 'true',
    COPILOT_AUTO_UPDATE: 'false', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
    COPILOT_MODEL: 'ui-check-model', OPENAI_API_KEY: 'local-binding-check-only', BINDING_CHECK_PROPOSAL: proposal,
  })
  delete env.ELECTRON_RUN_AS_NODE
  for (const id of [a, b]) {
    const child = spawn(resolution.command, [...resolution.prefixArgs, '--no-auto-update', `--session-id=${id}`, '--name=Binding check', '-p', 'Save this disposable session.'],
      { cwd: directory, env, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => child.kill(), 60_000)
    try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
    finally { clearTimeout(timer) }
  }
  session = new PtySession({ file: resolution.command, args: [...resolution.prefixArgs, '--no-auto-update', `--resume=${a}`, '--allow-all-tools'],
    cwd: directory, env, sessionId: a, monitorSessionPermissions: true, spawnPty: spawnNodePty })
  session.on('log', () => { lastOutputAt = Date.now() })
  session.on('session-record-reset', reason => reader.reset(reason))
  session.on('session-record', (line, live) => reader.consume(line, live))
  session.on('activity', activity => { if (activity === 'idle') reader.finish() })
  await session.start()
  const processId = session.processId
  await ready()
  for (const [index, id] of [a, b, b, a].entries()) {
    if (index === 1 || index === 3) {
      await send(`/resume ${id}`)
      await delay(2000)
      await ready()
    }
    await send(`Please start a binding-check-meeting, request ${index + 1}.`)
    await until(() => accepted.length === index + 1 || rejected, `the helper request in session ${id}`)
    assert.equal(rejected, false, 'the helper request was rejected; see the metadata-only diagnostic above')
    assert.equal(accepted[index], id)
    assert.equal(session.lastSessionId, id)
    assert.equal(session.processId, processId, 'the same PTY must survive each switch')
    console.log(`Accepted request ${index + 1} from ${id}`)
    await ready()
  }
  assert.deepEqual(accepted, [a, b, b, a])
  console.log('PASS: verified CLI-owned origin routing and live person-turn authorization across A → B → B → A in one PTY.')
} finally {
  await session?.stop()
  await control.close()
  model.closeAllConnections()
  await new Promise(resolve => model.close(resolve))
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
// node-pty may retain ConPTY helper handles after taskkill. All check-owned sessions, servers and files are closed above.
process.exit(0)
