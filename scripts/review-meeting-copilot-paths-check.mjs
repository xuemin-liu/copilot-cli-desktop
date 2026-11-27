// Paths of a hidden Copilot reviewer that the first check (review-meeting-copilot-check.mjs) does not reach, in the real
// Electron app with the real Copilot CLI and a loopback mock model (no paid request). Agreed in review meeting 3N9F.
//
// Covered: a Copilot session hosts with `start -Reviewers` on the meeting helper (consent, the hidden seat, its review
// delivered to the host, the helper's `status` listing the seats, `end`); a joined seat whose tab changes to another
// conversation leaves the meeting with that reason; a seat that takes a message and never answers is taken out after
// two rounds without a reply. Not covered: a conversation change while the first prompt's recipient is being verified.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/review-meeting-copilot-paths')
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms))
const REVIEW_MARK = 'copilot-seat-review-5353'
const HELPER = '& "$env:COPILOT_DESKTOP_MEETING_HELPER"'

function mcpPost(urlStr, body, sessionId) {
  const parsed = new URL(urlStr)
  return new Promise((resolveReq, rejectReq) => {
    const payload = JSON.stringify(body)
    const req = request({
      host: parsed.hostname, port: Number(parsed.port), path: `${parsed.pathname}${parsed.search}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveReq({ status: res.statusCode ?? 0, sessionId: res.headers['mcp-session-id'] ?? null, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', rejectReq)
    req.end(payload)
  })
}

function text(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((part) => typeof part?.text === 'string' ? part.text : '').join('') : ''
}

/**
 * The mock model. As the host: it runs the helper to start the meeting with reviewers, and on the replies it asks for the
 * status and then ends the meeting. As the seat: READY to its first prompt, a review to a round, and no answer at all to
 * a round of the meeting about a silent seat.
 */
function modelReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastUser = messages.map((message) => message?.role).lastIndexOf('user')
  if (lastUser < 0) return undefined
  const prompt = text(messages[lastUser].content)
  const toolsAnswered = messages.slice(lastUser + 1).filter((message) => message?.role === 'tool').length
  const offersShell = Array.isArray(body.tools) && body.tools.some((tool) => tool?.function?.name === 'powershell')
  const shell = (command) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call_paths_${Date.now()}`, type: 'function', function: { name: 'powershell', arguments: JSON.stringify({ command, description: 'Meeting helper' }) } }] })
  const say = (content) => ({ role: 'assistant', content })
  if (/Start a review meeting with hidden reviewers/.test(prompt)) {
    if (offersShell && toolsAnswered === 0) return shell(`${HELPER} start -Topic "host run" -File plan.md -Reviewers`)
    return say('The meeting is open.')
  }
  if (/\[meeting [0-9A-Z]{4} · round \d+ · replies/.test(prompt)) {
    if (offersShell && toolsAnswered === 0) return shell(`${HELPER} status`)
    if (offersShell && toolsAnswered === 1) return shell(`${HELPER} end`)
    return say('I read the status and closed the meeting.')
  }
  if (/Reply now with the single word READY/.test(prompt)) return say('READY')
  if (/\[meeting [0-9A-Z]{4} · round \d+/.test(prompt)) {
    if (/silent seat/.test(prompt)) return { hang: true }
    return say(`Copilot review ${REVIEW_MARK}: the plan holds.`)
  }
  return say('ok')
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  if (process.platform !== 'win32') {
    console.log('The hidden Copilot reviewer paths check drives the PowerShell meeting helper and runs on Windows only: skipped.')
    process.exit(0)
  }
  const { resolveCopilotBinary } = await import('../dist/src/main/resolve-copilot.js')
  const { createCheckModelServer } = await import('./check-model-server.mjs')
  const resolution = await resolveCopilotBinary()
  if (!resolution.version) {
    console.log('Copilot CLI is not installed: the hidden Copilot reviewer paths check was skipped.')
    process.exit(0)
  }
  const directory = await mkdtemp(join(process.env.CHECK_TMP ?? tmpdir(), 'review-meeting-paths-'))
  const recording = join(directory, 'model-requests.jsonl')
  const modelServer = createCheckModelServer({ reply: modelReply, recordingPath: recording })
  let timer
  try {
    for (const name of ['copilot-home', 'desktop']) await mkdir(join(directory, name), { recursive: true })
    await new Promise((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
    const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`
    // Trust only this disposable folder: the project and the reviewer checkouts are both inside it.
    await writeFile(join(directory, 'copilot-home', 'config.json'), JSON.stringify({ trustedFolders: [directory] }))
    const env = {
      ...process.env,
      E2E_DIR: directory,
      E2E_ARTIFACTS: artifacts,
      E2E_MODEL_URL: baseUrl,
      E2E_RECORDING: recording,
      E2E_OTHER_SESSION: randomUUID(),
      COPILOT_HOME: join(directory, 'copilot-home'),
      COPILOT_DISABLE_KEYTAR: '1',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: baseUrl,
      COPILOT_MODEL: 'ui-check-model',
      OPENAI_API_KEY: 'local-ui-check-only',
      COPILOT_OFFLINE: 'true',
      COPILOT_DESKTOP_MEETING_MCP_PORT: '0',
      COPILOT_DESKTOP_MEETING_SEAT_JOIN_MS: '150000',
      // Short, so a message that can no longer be delivered takes its seat out within the check.
      COPILOT_DESKTOP_MEETING_SEAT_DELIVERY_MS: '8000',
    }
    delete env.ELECTRON_RUN_AS_NODE
    // Another conversation in Copilot's store, for the seat's tab to be switched to.
    const stored = spawn(resolution.command, [...resolution.prefixArgs, '--no-auto-update', `--session-id=${env.E2E_OTHER_SESSION}`, '--name=Another conversation', '-p', 'Save this disposable session.'],
      { cwd: directory, env, windowsHide: true, stdio: 'ignore' })
    const storedTimer = setTimeout(() => stored.kill(), 60_000)
    try { assert.equal(await new Promise((accept, reject) => { stored.once('error', reject); stored.once('exit', accept) }), 0, 'the other conversation was stored') }
    finally { clearTimeout(storedTimer) }
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    timer = setTimeout(() => child.kill(), 660_000)
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'hidden Copilot reviewer paths Electron check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
    console.log('Hidden Copilot meeting reviewer paths verified end to end: Copilot host with start -Reviewers, conversation switch, silent seat, teardown.')
  } finally {
    clearTimeout(timer)
    modelServer.closeAllConnections()
    await new Promise((resolveClose) => modelServer.close(() => resolveClose()))
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow, dialog } = await import('electron')
  const directory = process.env.E2E_DIR
  const out = process.env.E2E_ARTIFACTS
  const userData = join(directory, 'desktop')
  app.setPath('userData', userData)
  let consents = 0
  dialog.showMessageBox = async () => { consents++; return { response: 1, checkboxChecked: false } }

  void run().catch(async (error) => {
    console.error(error)
    // What each session's terminal showed last, and where the runs stood: a failure here is rarely explained by its message.
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
    const current = await window?.webContents.executeJavaScript('window.copilotDesktop.getState()').catch(() => null)
    console.error('[paths] runs', JSON.stringify(current?.tempReviewerGroups ?? null))
    for (const tab of current?.tabs ?? []) {
      const screen = await window.webContents.executeJavaScript(`window.copilotDesktop.getTabBacklog(${JSON.stringify(tab.id)})`).catch(() => '')
      const lines = String(screen).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
      console.error(`[paths] ${tab.title} (${tab.status}, session ${tab.lastSessionId}) screen:\n` + lines.slice(-25).join('\n'))
    }
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error?.stack ?? error) })).catch(() => {})
    app.exit(1)
  })

  async function run() {
    await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = E2E Check\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
    const repo = join(directory, 'project')
    await mkdir(repo, { recursive: true })
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', '-q')
    await writeFile(join(repo, 'service.ts'), 'export const version = 1\n')
    await writeFile(join(repo, 'plan.md'), '# Plan\n\nShip the service.\n')
    git('add', '.')
    git('commit', '-q', '-m', 'initial')

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    // Full access: the host's model runs the meeting helper in its shell, and nobody answers an approval here.
    const project = createWorkspaceProfile(repo, 'full-access')
    project.defaultResumeMode = 'new'
    await writeDesktopConfig(join(userData, 'desktop.json'), {
      ...DEFAULT_DESKTOP_CONFIG, profiles: [project], activeProfileId: project.id, reviewerClis: ['copilot'], reviewerAllowAll: true,
      meetingRoundTimeoutMinutes: 1, closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false,
      provider: { type: 'openai', baseUrl: process.env.E2E_MODEL_URL, model: 'ui-check-model', offline: true },
    })

    await import('../dist/src/main/main.js')
    await app.whenReady()
    let main
    for (let attempt = 0; attempt < 150 && !main; attempt++) {
      main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
      if (!main) await delay(100)
    }
    assert.ok(main, 'main window loaded')
    const ui = (code) => main.webContents.executeJavaScript(code)
    for (let i = 0; i < 150; i++) { if (await ui('typeof window.copilotDesktop?.getState === "function"').catch(() => false)) break; await delay(100) }
    const getState = () => ui('window.copilotDesktop.getState()')
    let state = await getState()
    for (let i = 0; i < 100 && !state?.meetingToolsUrl; i++) { await delay(100); state = await getState() }
    const mcpUrl = state.meetingToolsUrl
    assert.match(mcpUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

    const client = async (name) => {
      const init = await mcpPost(mcpUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } } })
      let id = 2
      return async (tool, args = {}) => {
        const res = await mcpPost(mcpUrl, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: tool, arguments: args } }, init.sessionId)
        return { text: res.json.result.content.map((part) => part.text).join('\n'), isError: res.json.result.isError === true }
      }
    }
    const until = async (what, probe, ms = 30_000) => {
      const end = Date.now() + ms
      for (;;) {
        const value = await probe()
        if (value) return value
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
        await delay(200)
      }
    }
    const groupOf = async (meetingId) => (await getState()).tempReviewerGroups?.find((group) => group.meetingId === meetingId) ?? null
    const meetingIdOf = (answer) => /Meeting ([0-9A-Z]{4}) is open/.exec(answer)?.[1]
    const reviewerBase = join(directory, 'desktop-pr-reviewers')
    const leftovers = async () => (await readdir(reviewerBase).catch(() => [])).length
    const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length
    const nextMessage = async (call, ms = 60_000) => until('a meeting message', async () => { const got = await call('meeting_next', { wait_seconds: 1 }); return /^Nothing yet/.test(got.text) ? null : got.text }, ms)
    const start = async (call, topic) => until('the desktop to answer a start', async () => {
      const answer = await call('meeting_start', { topic, post: `Plan for ${topic}.`, folder: repo, reviewers: true })
      return /The desktop is starting/.test(answer.text) ? null : answer
    }, 60_000)
    const backlog = (tabId) => ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(tabId)})`)
    const type = async (tabId, line) => {
      await ui(`window.copilotDesktop.writeTab(${JSON.stringify(tabId)}, ${JSON.stringify(line)})`)
      await delay(400)
      await ui(`window.copilotDesktop.writeTab(${JSON.stringify(tabId)}, "\\r")`)
    }
    const seatIn = (meetingId, label) => until(label, async () => { const group = await groupOf(meetingId); return group?.stage === 'active' && group.seats[0].verdict === 'reviewing' ? group : null }, 170_000)
    const allClosed = (label) => until(label, async () => !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0, 60_000)
    /** What the mock model was sent, to read a tool's answer or a prompt as the session saw it. */
    const modelSaw = async (pattern) => {
      const lines = (await readFile(process.env.E2E_RECORDING, 'utf8').catch(() => '')).split('\n').filter(Boolean)
      for (const line of lines) {
        const messages = JSON.parse(line).messages ?? []
        for (const message of messages) { const body = text(message.content); if (pattern.test(body)) return body }
      }
      return null
    }

    // E2E_ONLY=2 (or 1,3) runs only those cases, for working on one of them.
    const only = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(',')) : null
    const wanted = (number) => !only || only.has(String(number))
    const meetings = []
    if (wanted(1)) await copilotHost()
    if (wanted(2)) await conversationSwitch()
    if (wanted(3)) await silentSeat()
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, meetings }, null, 2))
    app.exit(0)

    async function copilotHost() {
    // 1. A Copilot session hosts: its model runs `start -Reviewers` on the helper, and the desktop starts the seat.
    const before = new Set((await getState()).tabs.map((tab) => tab.id))
    await ui(`window.copilotDesktop.createTab("new", ${JSON.stringify(project.id)}, "meeting host")`)
    const hostTab = await until('the host tab', async () => (await getState()).tabs.find((tab) => !before.has(tab.id) && tab.title === 'meeting host'))
    await until('the host prompt', async () => (await backlog(hostTab.id)).includes('open sidebar'), 90_000)
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(hostTab.id)})`)
    await type(hostTab.id, 'Start a review meeting with hidden reviewers for plan.md')
    const hosted = await until('the meeting opened by the Copilot host', async () => (await getState()).meetings?.find((meeting) => meeting.hostTabId === hostTab.id), 90_000)
    const hostRun = await until('the reviewer run of the Copilot host', async () => groupOf(hosted.id), 30_000)
    assert.equal(hostRun.hostTabId, hostTab.id, 'the run belongs to the host tab')
    assert.equal(hostRun.seats[0].cli, 'copilot')
    const startAnswer = await until('the helper\'s answer to the start', async () => modelSaw(/Hidden reviewer sessions for meeting [0-9A-Z]{4}: Copilot CLI\./), 60_000)
    assert.match(startAnswer, /the helper's status command shows the seats/, 'a Copilot host is pointed at the helper, not at a tool it does not have')
    // The start answers before the question is put: the run asks once its commit is known.
    await until('the person to be asked', async () => consents === 1, 30_000)
    // The seat reviews, its review is typed into the host, and the host's model asks for the status and ends the meeting.
    const digest = await until('the seat\'s review delivered to the host', async () => modelSaw(new RegExp(`round 1 · replies[\\s\\S]*${REVIEW_MARK}`)), 240_000)
    assert.match(digest, new RegExp(REVIEW_MARK))
    const status = await until('the helper\'s status', async () => modelSaw(/Hidden reviewers[^\n]*:\s*\n?[\s\S]*- Copilot CLI: /), 90_000)
    assert.match(status, /- Copilot CLI: in the meeting/, 'the helper\'s status lists the hidden seat')
    const hostEnded = await until('the host\'s run to end', async () => { const group = await groupOf(hosted.id); return group?.stage === 'ended' ? group : null }, 90_000)
    assert.equal(hostEnded.outcome, 'closed')
    await allClosed('the host\'s hidden tab and checkout to go')
    meetings.push(hosted.id)
    }

    async function conversationSwitch() {
    // 2. A joined seat whose tab changes to another conversation leaves the meeting, and says why.
    const hostB = await client('claude-code')
    const meetingB = meetingIdOf((await start(hostB, 'conversation switch')).text)
    const outsiderB = await client('codex-cli')
    await outsiderB('meeting_join', { meeting: meetingB })
    const liveB = await seatIn(meetingB, 'the second Copilot seat to be in the meeting')
    await nextMessage(outsiderB)
    await outsiderB('meeting_reply', { text: 'Round 1 fine.' })
    assert.match(await nextMessage(hostB, 120_000), new RegExp(REVIEW_MARK), 'the seat reviewed before its tab was switched')
    const seatTabB = liveB.seats[0].tabId
        await type(seatTabB, `/resume ${process.env.E2E_OTHER_SESSION}`)
    await until('the other conversation on the seat\'s screen', async () => (await backlog(seatTabB)).includes('Save this disposable session.'), 60_000)
    // The next round must not be typed into that conversation. The desktop may learn of the change at once (the seat
    // leaves with that reason) or only find that it can no longer prove the recipient (the delivery deadline takes the
    // seat out); either way the seat is out and the round is not held to its timeout.
    await hostB('meeting_round', { post: 'Plan v2 after the switch.' })
    await nextMessage(outsiderB)
    const switched = await until('the switched seat to leave', async () => { const group = await groupOf(meetingB); return group?.seats[0].verdict === 'incomplete' ? group : null }, 50_000)
    assert.match(switched.seats[0].error, /changed to another conversation, so it left the meeting|did not reach it for/)
    assert.ok(switched.seats[0].tabId, 'its tab stays for the person to look at')
    console.log('[paths] the switched seat left with: ' + switched.seats[0].error)
    assert.match((await hostB('meeting_status')).text, /- Copilot CLI: left/)
    await outsiderB('meeting_reply', { text: 'Round 2 fine.' })
    assert.match(await nextMessage(hostB, 30_000), /Round 2 fine\./, 'the round finished without the seat that left, before its timeout')
    assert.equal(await modelSaw(/Plan v2 after the switch\./), null, 'no conversation was given the round after the switch')
    await hostB('meeting_end')
    await until('the second run to end', async () => (await groupOf(meetingB))?.stage === 'ended')
    await allClosed('the switched seat\'s tab and checkout to go')
    meetings.push(meetingB)
    }

    async function silentSeat() {
    // 3. A seat that takes its message and never answers is taken out after two rounds without a reply.
    const hostC = await client('claude-code')
    const meetingC = meetingIdOf((await start(hostC, 'silent seat')).text)
    const outsiderC = await client('codex-cli')
    await outsiderC('meeting_join', { meeting: meetingC })
    await seatIn(meetingC, 'the third Copilot seat to be in the meeting')
    await nextMessage(outsiderC)
    await outsiderC('meeting_reply', { text: 'Round 1 fine.' })
    // The round ends at its timeout (one minute here), without the seat.
    const first = await nextMessage(hostC, 150_000)
    assert.match(first, /Round 1 fine\./)
    assert.doesNotMatch(first, new RegExp(REVIEW_MARK))
    assert.equal((await groupOf(meetingC)).seats[0].verdict, 'reviewing', 'one silent round does not take it out')
    await hostC('meeting_round', { post: 'Plan v2 for the silent seat.' })
    await nextMessage(outsiderC)
    await outsiderC('meeting_reply', { text: 'Round 2 fine.' })
    assert.match(await nextMessage(hostC, 150_000), /Round 2 fine\./)
    const silent = await until('the silent seat to be taken out', async () => { const group = await groupOf(meetingC); return group?.seats[0].verdict === 'incomplete' ? group : null }, 30_000)
    assert.match(silent.seats[0].error, /took it out after two rounds without a reply/)
    assert.ok(silent.seats[0].tabId, 'its tab stays for the person to look at')
    assert.match((await hostC('meeting_status')).text, /- Copilot CLI: left/)
    await hostC('meeting_end')
    await until('the third run to end', async () => (await groupOf(meetingC))?.stage === 'ended')
    await allClosed('the silent seat\'s tab and checkout to go')
    meetings.push(meetingC)
    }
  }
}
