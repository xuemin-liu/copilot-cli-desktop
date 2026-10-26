// Spike for the session meeting plan: can the desktop type `/add-dir <folder>` into a running session, and can a
// restricted (read-only allowlist) session then read a file there without asking? Real CLI in a PTY, isolated
// COPILOT_HOME, and the loopback mock model, which asks for one `view` of the meeting file (no paid requests).
// Flags: --no-add-dir (the control: the session asks), --space (a folder name with spaces, like the app's data folder),
// --quote (type the path in quotes; the CLI refuses it).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import pty from 'node-pty'
import { createCheckModelServer } from './check-model-server.mjs'

const { resolveCopilotBinary } = await import('../dist/src/main/resolve-copilot.js')
const resolution = await resolveCopilotBinary()
assert.ok(resolution.version, 'Install Copilot CLI first')
const directory = await mkdtemp(join(tmpdir(), 'copilot-meeting-spike-'))
const project = join(directory, 'project')
// Outside the temp folder: Copilot lets every session read the system temp folder, which would hide the answer.
const meetingsRoot = await mkdtemp(join(homedir(), process.argv.includes('--space') ? '.copilot meeting spike-' : '.copilot-meeting-spike-'))
const meeting = join(meetingsRoot, 'K7QF')
const copilotHome = join(directory, 'copilot')
const marker = 'meeting-file-marker-913'
const modelServer = createCheckModelServer({ toolCall: { name: 'view', arguments: { path: join(meeting, 'post.md') } } })
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
let child
try {
  await Promise.all([project, meeting, copilotHome].map((path) => mkdir(path, { recursive: true })))
  await writeFile(join(meeting, 'post.md'), `# Plan\n\n${marker}\n`)
  await new Promise((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
  const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`
  await writeFile(join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [project] }))
  const env = { ...process.env, COPILOT_HOME: copilotHome, COPILOT_DISABLE_KEYTAR: '1', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: baseUrl, COPILOT_MODEL: 'ui-check-model', OPENAI_API_KEY: 'local-ui-check-only', COPILOT_OFFLINE: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  const withAddDir = process.argv.includes('--no-add-dir') === false
  child = pty.spawn(resolution.command, [...resolution.prefixArgs, '--available-tools=view,glob,grep,ask_user'], { cwd: project, env, cols: 140, rows: 40 })
  let screen = ''
  child.onData((data) => { screen += data })
  const plain = () => screen.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '')
  const waitFor = async (test, label, ms = 60_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { if (test(plain())) return; await delay(250) }
    console.log(plain().slice(-3000))
    throw new Error(`timed out waiting for ${label}`)
  }
  await waitFor((text) => /open sidebar|Type @|Enter to send|›|❯/.test(text), 'the prompt')
  await delay(1500)
  if (withAddDir) {
    const before = screen.length
    child.write(process.argv.includes('--quote') ? `/add-dir "${meeting}"` : `/add-dir ${meeting}`)
    await delay(500)
    child.write('\r')
    await delay(3000)
    console.log('[spike] after /add-dir:\n' + screen.slice(before).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-12).join('\n'))
  }
  const before = screen.length
  child.write('Read the meeting post.')
  await delay(500)
  child.write('\r')
  const sessionId = async () => (await readdir(join(copilotHome, 'session-state')).catch(() => [])).find((name) => /^[0-9a-f-]{36}$/.test(name))
  const events = async () => {
    const id = await sessionId()
    if (!id) return []
    return (await readFile(join(copilotHome, 'session-state', id, 'events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  }
  const deadline = Date.now() + 60_000
  let outcome = 'timeout'
  while (Date.now() < deadline) {
    const records = await events()
    if (records.some((record) => record.type === 'assistant.turn_end')) { outcome = 'turn ended'; break }
    if (/allow|permission|approve|Do you want/i.test(screen.slice(before).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ''))) { outcome = 'asked'; break }
    await delay(500)
  }
  const records = await events()
  const complete = records.filter((record) => record.type === 'tool.execution_complete')
  console.log(`[spike] add-dir=${withAddDir} outcome=${outcome}`)
  console.log('[spike] tool results: ' + JSON.stringify(complete.map((record) => ({ success: record.data?.success, result: JSON.stringify(record.data?.result ?? record.data?.error ?? '').slice(0, 160) }))))
  console.log('[spike] screen tail:\n' + plain().split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-14).join('\n'))
  const read = complete.some((record) => JSON.stringify(record.data ?? {}).includes(marker))
  console.log(`[spike] file read without asking: ${read && outcome === 'turn ended'}`)
} finally {
  try { child?.kill() } catch { /* already gone */ }
  modelServer.closeAllConnections()
  await new Promise((resolveClose) => modelServer.close(() => resolveClose()))
  await delay(500)
  await rm(directory, { recursive: true, force: true }).catch(() => {})
  await rm(meetingsRoot, { recursive: true, force: true }).catch(() => {})
}
