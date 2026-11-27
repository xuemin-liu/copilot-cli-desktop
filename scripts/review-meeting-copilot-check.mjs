// A hidden Copilot reviewer in a review meeting, in the real Electron app with the real Copilot CLI
// (docs/review-meeting-plan.md, phase 2). A loopback mock model answers for it, so no paid request is made.
//
// Covered: the seat is started interactively in its own checkout, given a first prompt, and joined by the desktop once
// it can take messages; the first round waits for it; its review and its vote count; a message that cannot be typed
// into it takes the seat out of the meeting with the reason, instead of holding the round; nothing is left behind.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/review-meeting-copilot')
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms))
const REVIEW_MARK = 'copilot-seat-review-4242'

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

/** The mock model: READY to the seat's first prompt, a review to a round, AGREE to a vote. */
function seatModelReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = [...messages].reverse().find((message) => message?.role === 'user')
  const content = last?.content
  const prompt = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => typeof part?.text === 'string' ? part.text : '').join('') : ''
  const say = (text) => ({ role: 'assistant', content: text })
  if (/Reply now with the single word READY/.test(prompt)) return say('READY')
  if (/Start your reply with AGREE/.test(prompt)) return say('AGREE')
  if (/\[meeting [0-9A-Z]{4} · round \d+/.test(prompt)) return say(`Copilot review ${REVIEW_MARK}: the plan holds.`)
  return say('ok')
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const { resolveCopilotBinary } = await import('../dist/src/main/resolve-copilot.js')
  const { createCheckModelServer } = await import('./check-model-server.mjs')
  const resolution = await resolveCopilotBinary()
  if (!resolution.version) {
    console.log('Copilot CLI is not installed: the hidden Copilot reviewer check was skipped.')
    process.exit(0)
  }
  const directory = await mkdtemp(join(process.env.CHECK_TMP ?? tmpdir(), 'review-meeting-copilot-'))
  const modelServer = createCheckModelServer({ reply: seatModelReply })
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
      COPILOT_HOME: join(directory, 'copilot-home'),
      COPILOT_DISABLE_KEYTAR: '1',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: baseUrl,
      COPILOT_MODEL: 'ui-check-model',
      OPENAI_API_KEY: 'local-ui-check-only',
      COPILOT_OFFLINE: 'true',
      COPILOT_DESKTOP_MEETING_MCP_PORT: '0',
      COPILOT_DESKTOP_MEETING_SEAT_JOIN_MS: '150000',
      // Short, so the case of a message that cannot be typed does not take minutes.
      COPILOT_DESKTOP_MEETING_SEAT_DELIVERY_MS: '6000',
    }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    timer = setTimeout(() => child.kill(), 420_000)
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'hidden Copilot reviewer Electron check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
    console.log('Hidden Copilot meeting reviewer verified end to end: start, first prompt, join, review, vote, undeliverable message, teardown.')
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
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })

  void run().catch(async (error) => {
    console.error(error)
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
    git('add', '.')
    git('commit', '-q', '-m', 'initial')
    await writeFile(join(repo, 'service.ts'), 'export const version = 2 // not committed\n')

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const project = createWorkspaceProfile(repo, 'read-only')
    project.defaultResumeMode = 'new'
    await writeDesktopConfig(join(userData, 'desktop.json'), {
      ...DEFAULT_DESKTOP_CONFIG, profiles: [project], activeProfileId: project.id, reviewerClis: ['copilot'], reviewerAllowAll: true, reviewerStartPrompt: true,
      meetingRoundTimeoutMinutes: 2, closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false,
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
    const meetingIdOf = (text) => /Meeting ([0-9A-Z]{4}) is open/.exec(text)?.[1]
    const reviewerBase = join(directory, 'desktop-pr-reviewers')
    const leftovers = async () => (await readdir(reviewerBase).catch(() => [])).length
    const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length
    const nextMessage = async (call, ms = 60_000) => until('a meeting message', async () => { const got = await call('meeting_next', { wait_seconds: 1 }); return /^Nothing yet/.test(got.text) ? null : got.text }, ms)
    const start = async (call, topic) => until('the desktop to answer a start', async () => {
      const answer = await call('meeting_start', { topic, post: `Plan for ${topic}.`, folder: repo, reviewers: true })
      return /The desktop is starting/.test(answer.text) ? null : answer
    }, 60_000)

    // 1. The seat starts, is primed, and is joined by the desktop; the first round waits for it.
    const host = await client('claude-code')
    const started = await start(host, 'copilot seat')
    assert.equal(started.isError, false, started.text)
    const meetingA = meetingIdOf(started.text)
    assert.match(started.text, /Hidden reviewer sessions for meeting [0-9A-Z]{4}: Copilot CLI\./)
    const outsider = await client('codex-cli')
    await outsider('meeting_join', { meeting: meetingA })
    assert.match((await outsider('meeting_next', { wait_seconds: 1 })).text, /^Nothing yet/, 'the round is held while the Copilot seat is still starting')
    const live = await until('the Copilot seat to be in the meeting', async () => { const group = await groupOf(meetingA); return group?.stage === 'active' && group.seats[0].verdict === 'reviewing' ? group : null }, 170_000)
    assert.equal(live.seats[0].cli, 'copilot')
    const seatTab = (await getState()).tabs.find((tab) => tab.id === live.seats[0].tabId)
    assert.equal(seatTab.tempReviewer.meetingId, meetingA)
    assert.equal(seatTab.cli ?? null, null, 'a Copilot session')
    assert.equal(seatTab.sessionPermissionPreset, 'full-access', 'allow-all gives the hidden seat full access whatever the workspace preset')
    assert.ok(resolve(seatTab.sessionCwd ?? '').startsWith(resolve(reviewerBase)), `the seat works in its own checkout, not ${seatTab.sessionCwd}`)
    assert.equal(await readFile(join(seatTab.sessionCwd, 'service.ts'), 'utf8'), 'export const version = 1\n', 'the checkout is the commit, without the uncommitted work')
    assert.equal(worktrees(), 2)
    assert.match(await nextMessage(outsider), /round 1/)
    await outsider('meeting_reply', { text: 'Outside review: fine.' })
    const digest = await nextMessage(host, 120_000)
    assert.match(digest, new RegExp(REVIEW_MARK), 'the Copilot seat reviewed the round')
    assert.match(digest, /Outside review: fine\./)
    assert.match((await host('meeting_status')).text, /- Copilot CLI: in the meeting/)

    // 2. Its vote counts: with the outside agent it closes the meeting, and the seat goes with it.
    await host('meeting_propose_close', { items: '- the plan as posted' })
    assert.match(await nextMessage(outsider), /Start your reply with AGREE/)
    await outsider('meeting_reply', { text: 'AGREE' })
    const closing = await nextMessage(host, 120_000)
    assert.match(closing, /closed|agreed/i)
    const ended = await until('the run to end', async () => { const group = await groupOf(meetingA); return group?.stage === 'ended' ? group : null })
    assert.equal(ended.outcome, 'closed')
    await until('the hidden tab and its checkout to go', async () => !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0, 60_000)

    // 3. A message that cannot be typed into the seat takes it out of the meeting; the round does not wait for it.
    const hostB = await client('claude-code')
    const meetingB = meetingIdOf((await start(hostB, 'undeliverable')).text)
    const outsiderB = await client('codex-cli')
    await outsiderB('meeting_join', { meeting: meetingB })
    const liveB = await until('the second Copilot seat to be in the meeting', async () => { const group = await groupOf(meetingB); return group?.stage === 'active' && group.seats[0].verdict === 'reviewing' ? group : null }, 170_000)
    await nextMessage(outsiderB)
    await outsiderB('meeting_reply', { text: 'Round 1 fine.' })
    await nextMessage(hostB, 120_000)
    // Text left in its prompt box: the desktop does not type over what may be someone's words.
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(liveB.seats[0].tabId)}, "half a thought")`)
    await delay(500)
    await hostB('meeting_round', { post: 'Plan v2.' })
    await nextMessage(outsiderB)
    const lost = await until('the seat to be taken out', async () => { const group = await groupOf(meetingB); return group?.seats[0].verdict === 'incomplete' ? group : null }, 60_000)
    assert.match(lost.seats[0].error, /did not reach it for/)
    assert.match(lost.seats[0].error, /prompt box may hold text/)
    assert.equal(lost.seats[0].needsAttention, true)
    assert.ok(lost.seats[0].tabId, 'its tab stays for the person to look at')
    await outsiderB('meeting_reply', { text: 'Round 2 fine.' })
    const second = await nextMessage(hostB, 60_000)
    assert.match(second, /Round 2 fine\./, 'the round finished without the seat that left')
    await hostB('meeting_end')
    await until('everything to be closed', async () => (await groupOf(meetingB))?.stage === 'ended' && !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0, 60_000)

    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, meetings: [meetingA, meetingB] }, null, 2))
    app.exit(0)
  }
}
