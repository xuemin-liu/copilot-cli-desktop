// Hidden reviewers for a review meeting, in the real Electron app (docs/review-meeting-plan.md, phase 1). The reviewer
// CLI is a stub `agy` that does what a real one is told to: it reads its brief, joins with the seat credential in it
// over the desktop's meeting tools, and answers until the meeting closes. An outside agent (this script, as a second
// MCP client) joins by id beside it, which is what shows whether the first round really waits.
//
// Covered: the consent and its default, the held first round, a seat that joins / never joins / exits before joining /
// exits during a vote, Retry, a declined consent, a close while a seat is starting, and that nothing is left behind.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/review-meeting-e2e')
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms))

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

// The stub reviewer. `--print <prompt>` names its brief; the brief holds the seat credential.
const STUB = String.raw`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('agy 2.0.99-e2e'); process.exit(0) }
if (args.includes('--help')) {
  console.log('Usage: agy [options]\n  --dangerously-skip-permissions\n  --add-dir <dir>\n  --prompt-interactive <prompt>\n  --print <prompt>\n  --conversation <id>\n  --mode <mode>\n  --model <model>')
  process.exit(0)
}
const pid = process.env.E2E_WRAPPER_PID || String(process.pid)
const dumpDir = process.env.E2E_STUB_DUMP_DIR
let behavior = { mode: 'review' }
try { behavior = JSON.parse(readFileSync(process.env.E2E_STUB_BEHAVIOR_FILE, 'utf8')) } catch {}
const prompt = args[args.indexOf('--print') + 1] ?? ''
const dump = (extra) => { mkdirSync(dumpDir, { recursive: true }); writeFileSync(join(dumpDir, 'agy-' + pid + '.json'), JSON.stringify({ pid: Number(pid), cwd: process.cwd(), args, mode: behavior.mode, ...extra }, null, 2)) }
dump({ stage: 'started' })
if (!args.includes('--print')) { setInterval(() => {}, 10_000) }
else {
  const briefPath = /"([^"]+meeting-reviewer\.md)"/.exec(prompt)?.[1]
  const brief = briefPath ? readFileSync(briefPath, 'utf8') : ''
  const token = /invitation: "([0-9a-f]{64})"/.exec(brief)?.[1]
  const config = JSON.parse(readFileSync(join(process.env.ANTIGRAVITY_GEMINI_DIR, 'config', 'mcp_config.json'), 'utf8'))
  const url = config.mcpServers['copilot-meeting'].serverUrl
  let session = null
  let next = 1
  const call = async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }) })
    session = res.headers.get('mcp-session-id') ?? session
    return res.json()
  }
  const tool = async (name, input) => (await call('tools/call', { name, arguments: input })).result.content.map((part) => part.text).join('\n')
  const run = async () => {
    if (behavior.holdMs) await new Promise((done) => setTimeout(done, behavior.holdMs))
    if (behavior.mode === 'exit-before-join') return
    if (behavior.mode === 'never-join') { await new Promise((done) => setTimeout(done, 120_000)); return }
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'antigravity', version: '2.0' } })
    const joined = await tool('meeting_join', { invitation: token })
    const seen = []
    const info = { joined, hasBriefCommit: /detached checkout of the host's project at commit [0-9a-f]{40}/.test(brief), seen }
    dump({ stage: 'joined', ...info })
    for (;;) {
      const message = await tool('meeting_next', { wait_seconds: 2 })
      if (/^Nothing yet/.test(message)) continue
      seen.push(message.slice(0, 160))
      dump({ stage: 'in-meeting', ...info })
      if (/meeting is closed|closed ·|You were taken out|This reviewer|The person (removed|stopped)/i.test(message) && !/round \d+ · from the desktop/.test(message)) return
      const vote = /Start your reply with AGREE/.test(message)
      if (vote && behavior.mode === 'exit-on-vote') return
      await tool('meeting_reply', { text: vote ? 'AGREE' : (behavior.reply ?? 'Stub review: looks fine.') })
      // An agent that leaves the meeting and goes on running: its seat is gone, its process is not.
      if (behavior.mode === 'leave-after-reply') { await tool('meeting_leave', {}); dump({ stage: 'left', ...info }); await new Promise((done) => setTimeout(done, 120_000)); return }
    }
  }
  run().then(() => dump({ stage: 'done' }), (error) => { dump({ stage: 'error', error: String(error && error.stack || error) }); process.exitCode = 1 })
}
`

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const base = process.env.CHECK_TMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, 'review-meeting-e2e-'))
  let timer
  try {
    const bin = join(directory, 'bin')
    await mkdir(bin, { recursive: true })
    const stubScript = join(directory, 'agy-stub.mjs')
    await writeFile(stubScript, STUB, 'utf8')
    if (process.platform === 'win32') {
      const csc = [join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')]
      let compiler = null
      for (const candidate of csc) if (await stat(candidate).then(() => true, () => false)) { compiler = candidate; break }
      if (compiler) {
        const csFile = join(directory, 'AgyStub.cs')
        await writeFile(csFile, `using System;
using System.Diagnostics;
using System.Text;
class AgyStub {
  static int Main(string[] args) {
    var psi = new ProcessStartInfo(${JSON.stringify(process.execPath)});
    var sb = new StringBuilder();
    sb.Append("\\"").Append(${JSON.stringify(stubScript)}.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"")).Append("\\"");
    foreach (var a in args) {
      sb.Append(" \\"").Append(a.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"")).Append("\\"");
    }
    psi.Arguments = sb.ToString();
    psi.UseShellExecute = false;
    psi.EnvironmentVariables["E2E_WRAPPER_PID"] = Process.GetCurrentProcess().Id.ToString();
    var p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}
`, 'utf8')
        execFileSync(compiler, ['/nologo', `/out:${join(bin, 'agy.exe')}`, csFile], { stdio: 'pipe', windowsHide: true })
      } else {
        await copyFile(process.execPath, join(bin, 'agy.exe'))
      }
    } else {
      await writeFile(join(bin, 'agy'), `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`, { mode: 0o755 })
    }
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const env = {
      ...process.env,
      E2E_DIR: directory,
      E2E_ARTIFACTS: artifacts,
      E2E_STUB_DUMP_DIR: join(directory, 'stub-dumps'),
      E2E_STUB_BEHAVIOR_FILE: join(directory, 'stub-behavior.json'),
      COPILOT_DESKTOP_MEETING_MCP_PORT: '0',
      // A seat that has not joined after this long has failed: short, so the cases that wait for it stay quick.
      COPILOT_DESKTOP_MEETING_SEAT_JOIN_MS: '7000',
      ANTIGRAVITY_GEMINI_DIR: join(directory, 'gemini-home'),
      [pathKey]: [bin, process.env[pathKey]].filter(Boolean).join(delimiter),
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.SHELL
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    timer = setTimeout(() => child.kill(), 300_000)
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'review meeting Electron check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
    console.log('Hidden meeting reviewers verified end to end: consent, held first round, seat failures, vote roster, Retry, teardown.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow, dialog } = await import('electron')
  const directory = process.env.E2E_DIR
  const out = process.env.E2E_ARTIFACTS
  const dumpDir = process.env.E2E_STUB_DUMP_DIR
  const behaviorFile = process.env.E2E_STUB_BEHAVIOR_FILE
  const userData = join(directory, 'userdata')
  app.setPath('userData', userData)

  // The person's answer to the consent, and what they were asked.
  let consentAnswer = 1
  const consents = []
  dialog.showMessageBox = async (...params) => {
    const options = params.at(-1)
    consents.push(options)
    return { response: consentAnswer, checkboxChecked: false }
  }

  void run().catch(async (error) => {
    console.error(error)
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error?.stack ?? error) })).catch(() => {})
    app.exit(1)
  })

  async function run() {
    for (const name of ['copilot-home', 'claude-home', 'codex-home', 'gemini-home', 'userdata', 'stub-dumps']) await mkdir(join(directory, name), { recursive: true })
    await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = E2E Check\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude-home')
    process.env.CODEX_HOME = join(directory, 'codex-home')
    await writeFile(join(directory, 'copilot-home', 'config.json'), JSON.stringify({ trustedFolders: [directory] }))

    const repo = join(directory, 'project')
    await mkdir(repo, { recursive: true })
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', '-q')
    await writeFile(join(repo, 'service.ts'), 'export const version = 1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'initial')
    const head = git('rev-parse', 'HEAD')
    // Uncommitted work the reviewers' checkouts must not contain.
    await writeFile(join(repo, 'service.ts'), 'export const version = 2 // not committed\n')

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const project = createWorkspaceProfile(repo)
    project.defaultResumeMode = 'new'
    await writeDesktopConfig(join(userData, 'desktop.json'), {
      ...DEFAULT_DESKTOP_CONFIG, profiles: [project], activeProfileId: project.id, reviewerClis: ['antigravity'], reviewerAllowAll: true,
      meetingRoundTimeoutMinutes: 1, closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false,
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

    // An MCP client: the host, or an outside agent that joins by id.
    const client = async (name) => {
      const init = await mcpPost(mcpUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } } })
      let id = 2
      return async (tool, args = {}) => {
        const res = await mcpPost(mcpUrl, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: tool, arguments: args } }, init.sessionId)
        return { text: res.json.result.content.map((part) => part.text).join('\n'), isError: res.json.result.isError === true }
      }
    }
    const until = async (what, probe, ms = 20_000) => {
      const end = Date.now() + ms
      for (;;) {
        const value = await probe()
        if (value) return value
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
        await delay(150)
      }
    }
    const groupOf = async (meetingId) => (await getState()).tempReviewerGroups?.find((group) => group.meetingId === meetingId) ?? null
    const meetingIdOf = (text) => /Meeting ([0-9A-Z]{4}) is open/.exec(text)?.[1]
    const reviewerBase = join(directory, 'userdata-pr-reviewers')
    const leftovers = async () => (await readdir(reviewerBase).catch(() => [])).length
    const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length
    const dumps = async () => Promise.all((await readdir(dumpDir)).map(async (name) => JSON.parse(await readFile(join(dumpDir, name), 'utf8'))))
    const nextMessage = async (call, ms = 20_000) => until('a meeting message', async () => { const got = await call('meeting_next', { wait_seconds: 1 }); return /^Nothing yet/.test(got.text) ? null : got.text }, ms)

    // 1. Start with reviewers. The first round waits for the hidden seat, also for someone who joined by id meanwhile.
    await writeFile(behaviorFile, JSON.stringify({ mode: 'review', holdMs: 2500, reply: 'Stub review: the plan holds.' }))
    const host = await client('claude-code')
    // Meetings saved earlier are restored first; until then a start is asked to come back.
    const started = await until('the desktop to answer a start', async () => {
      const answer = await host('meeting_start', { topic: 'gate', post: 'Plan v1: lock around logout.', folder: repo, reviewers: true })
      return /The desktop is starting/.test(answer.text) ? null : answer
    }, 60_000)
    assert.equal(started.isError, false, started.text)
    const meetingA = meetingIdOf(started.text)
    assert.ok(meetingA, started.text)
    assert.match(started.text, /Hidden reviewer sessions for meeting [0-9A-Z]{4}: Antigravity CLI\./)
    assert.match(started.text, /Round 1 opens when each has joined or failed/)
    const outsider = await client('codex-cli')
    const joined = await outsider('meeting_join', { meeting: meetingA })
    assert.equal(joined.isError, false, joined.text)
    assert.match((await outsider('meeting_next', { wait_seconds: 1 })).text, /^Nothing yet/, 'the round is held while the hidden reviewer is still starting')
    const groupA = await until('the run to appear', () => groupOf(meetingA))
    assert.equal(groupA.prLabel, `Meeting ${meetingA}`)
    assert.equal(consents.length, 1)
    assert.equal(consents[0].defaultId, 0, 'the default answer is to decline')
    assert.equal(consents[0].buttons[0], 'Cancel')
    assert.match(consents[0].detail, /Reviewers: Antigravity CLI\./)
    assert.match(consents[0].detail, new RegExp(`at commit ${head.slice(0, 12)}`))
    assert.match(consents[0].detail, /not a sandbox/)
    assert.match((await host('meeting_status')).text, /Hidden reviewers are starting; round 1 opens when each has joined or failed/)
    // Both get round 1 together, once the seat has joined.
    const firstForOutsider = await nextMessage(outsider)
    assert.match(firstForOutsider, /round 1/)
    const live = await until('the seat to be in the meeting', async () => { const group = await groupOf(meetingA); return group?.stage === 'active' && group.seats[0].verdict === 'reviewing' ? group : null })
    const seatTab = (await getState()).tabs.find((tab) => tab.id === live.seats[0].tabId)
    assert.equal(seatTab.tempReviewer.meetingId, meetingA)
    const stub = (await dumps()).find((dump) => dump.stage !== 'started' && dump.joined)
    assert.ok(stub, 'the stub reviewer joined with the credential in its brief')
    assert.match(stub.joined, /^Joined meeting/)
    assert.equal(stub.hasBriefCommit, true)
    assert.ok(stub.args.includes('--print') && stub.args.includes('--dangerously-skip-permissions'))
    assert.ok(!stub.args.some((arg) => /[0-9a-f]{64}/.test(arg)), 'the seat credential is not on the command line')
    assert.ok(resolve(stub.cwd).startsWith(resolve(reviewerBase)), 'the reviewer runs in its own checkout')
    assert.equal(await readFile(join(stub.cwd, 'service.ts'), 'utf8'), 'export const version = 1\n', 'the checkout is the commit, without the uncommitted work')
    assert.equal(worktrees(), 2)
    await outsider('meeting_reply', { text: 'Outside review: fine.' })
    const digest = await nextMessage(host)
    assert.match(digest, /Stub review: the plan holds\./)
    assert.match(digest, /Outside review: fine\./)
    assert.match((await host('meeting_status')).text, /- Antigravity CLI: in the meeting/)

    // 2. A hidden voter whose session ends during the vote: the others cannot agree for it.
    await writeFile(behaviorFile, JSON.stringify({ mode: 'exit-on-vote' }))
    // The running stub read its behaviour at launch, so Retry gives the seat one that leaves at the vote.
    await ui(`window.copilotDesktop.tempReviewerAction(${JSON.stringify(groupA.id)}, 'retry', 'antigravity')`)
    await until('the retried seat to join', async () => { const group = await groupOf(meetingA); return group?.seats[0].verdict === 'reviewing' && group.seats[0].tabId !== live.seats[0].tabId })
    assert.equal(worktrees(), 2, 'the first launch\'s checkout is gone, the new one is there')
    assert.match((await host('meeting_round', { post: 'Plan v2.' })).text, /Sent round 2 to 2 reviewers/)
    await nextMessage(outsider)
    await outsider('meeting_reply', { text: 'Round 2 fine.' })
    await nextMessage(host)
    await host('meeting_propose_close', { items: '- lock around logout' })
    assert.match(await nextMessage(outsider), /Start your reply with AGREE/)
    await outsider('meeting_reply', { text: 'AGREE' })
    const back = await nextMessage(host)
    assert.match(back, /Not everyone agreed/, 'one voter left without voting, so the vote did not pass')
    assert.doesNotMatch(back, /is closed/)
    const afterVote = await until('the seat to show as left', async () => { const group = await groupOf(meetingA); return group?.seats[0].verdict === 'incomplete' ? group : null })
    assert.equal(afterVote.seats[0].needsAttention, true)
    assert.match((await host('meeting_status')).text, /- Antigravity CLI: left/)

    // 3. The host ends the meeting: the hidden tab, the checkout and the reservation go with it.
    await host('meeting_end')
    const ended = await until('the run to end', async () => { const group = await groupOf(meetingA); return group?.stage === 'ended' ? group : null })
    assert.equal(ended.outcome, 'closed')
    await until('the hidden tabs to close', async () => !(await getState()).tabs.some((tab) => tab.tempReviewer))
    await until('the checkouts to go', async () => worktrees() === 1 && await leftovers() === 0)
    await ui(`window.copilotDesktop.tempReviewerAction(${JSON.stringify(groupA.id)}, 'dismiss-ended')`)
    assert.equal(await groupOf(meetingA), null)

    // 4. A seat that never joins fails after the bound, with its reason, and the round opens for who is there.
    await writeFile(behaviorFile, JSON.stringify({ mode: 'never-join' }))
    const hostB = await client('claude-code')
    const meetingB = meetingIdOf((await hostB('meeting_start', { topic: 'never', post: 'Plan B.', folder: repo, reviewers: true })).text)
    const outsiderB = await client('codex-cli')
    await outsiderB('meeting_join', { meeting: meetingB })
    assert.match((await outsiderB('meeting_next', { wait_seconds: 1 })).text, /^Nothing yet/)
    const failed = await until('the seat to fail', async () => { const group = await groupOf(meetingB); return group?.seats[0].verdict === 'failed' ? group : null }, 30_000)
    assert.match(failed.seats[0].error, /did not join the meeting within/)
    assert.equal(failed.stage, 'active')
    assert.match(await nextMessage(outsiderB), /round 1/, 'the held round opened for the reviewer who was there')
    // Dismissing the failed seat closes its tab; the meeting goes on.
    await ui(`window.copilotDesktop.tempReviewerAction(${JSON.stringify(failed.id)}, 'dismiss', 'antigravity')`)
    await until('the failed seat\'s tab and checkout to go', async () => !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0)
    await hostB('meeting_end')
    await until('run B to end', async () => (await groupOf(meetingB))?.stage === 'ended')

    // 5. A seat whose session ends before it joined is a failed seat, and nobody joined: the host is told what to do.
    await writeFile(behaviorFile, JSON.stringify({ mode: 'exit-before-join' }))
    const hostC = await client('claude-code')
    const meetingC = meetingIdOf((await hostC('meeting_start', { topic: 'exit', post: 'Plan C.', folder: repo, reviewers: true })).text)
    const none = await until('the seat to fail', async () => { const group = await groupOf(meetingC); return group?.seats[0].verdict === 'failed' && group.stage === 'active' ? group : null }, 30_000)
    assert.match(none.seats[0].error, /before it joined the meeting/)
    assert.match(none.notice, new RegExp(`No hidden reviewer joined meeting ${meetingC}`))
    assert.match((await hostC('meeting_status')).text, /No hidden reviewer joined/)
    await hostC('meeting_end')
    await until('run C to end and leave nothing', async () => (await groupOf(meetingC))?.stage === 'ended' && !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0)

    // 6. The person declines: no session starts, and the meeting is open for manual joins at once.
    consentAnswer = 0
    const before = (await readdir(dumpDir)).length
    const hostD = await client('claude-code')
    const meetingD = meetingIdOf((await hostD('meeting_start', { topic: 'declined', post: 'Plan D.', folder: repo, reviewers: true })).text)
    const declined = await until('the declined run to end', async () => { const group = await groupOf(meetingD); return group?.stage === 'ended' ? group : null })
    assert.equal(declined.outcome, 'stopped')
    assert.match(declined.notice, /You declined hidden reviewers/)
    const outsiderD = await client('codex-cli')
    await outsiderD('meeting_join', { meeting: meetingD })
    assert.match(await nextMessage(outsiderD), /round 1/, 'a declined run does not leave the round held')
    assert.equal((await readdir(dumpDir)).length, before, 'no reviewer was started')
    assert.equal(await leftovers(), 0)
    await hostD('meeting_end')
    consentAnswer = 1

    // 7. The meeting closes while its seat is still starting: the start is cancelled and nothing is left.
    await writeFile(behaviorFile, JSON.stringify({ mode: 'review', holdMs: 4000 }))
    const hostE = await client('claude-code')
    const meetingE = meetingIdOf((await hostE('meeting_start', { topic: 'early close', post: 'Plan E.', folder: repo, reviewers: true })).text)
    await until('run E to appear', () => groupOf(meetingE))
    await hostE('meeting_end')
    await until('run E to end and leave nothing', async () => (await groupOf(meetingE))?.stage === 'ended' && !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0, 30_000)

    // 8. One run per workspace: a second meeting's reviewers are refused while a run is live, and the meeting still opens.
    await writeFile(behaviorFile, JSON.stringify({ mode: 'review' }))
    const hostF = await client('claude-code')
    const meetingF = meetingIdOf((await hostF('meeting_start', { topic: 'first', post: 'Plan F.', folder: repo, reviewers: true })).text)
    await until('run F to appear', () => groupOf(meetingF))
    const hostG = await client('claude-code')
    const second = await hostG('meeting_start', { topic: 'second', post: 'Plan G.', folder: repo, reviewers: true })
    assert.equal(second.isError, false)
    assert.match(second.text, /Hidden reviewers were not started: This workspace is already running hidden reviewers for meeting/)
    assert.match(second.text, /Meeting [0-9A-Z]{4} is open/)
    await hostG('meeting_end')
    await hostF('meeting_end')
    await until('everything to be closed', async () => !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0, 30_000)

    // 9. A hidden reviewer that leaves the meeting while its process runs on: the run says so and offers Retry.
    await writeFile(behaviorFile, JSON.stringify({ mode: 'leave-after-reply' }))
    const hostH = await client('claude-code')
    const meetingH = meetingIdOf((await hostH('meeting_start', { topic: 'leaves', post: 'Plan H.', folder: repo, reviewers: true })).text)
    const gone = await until('the seat to show as left', async () => { const group = await groupOf(meetingH); return group?.seats[0].verdict === 'incomplete' ? group : null }, 30_000)
    assert.match(gone.seats[0].error, /It left the meeting/)
    assert.ok(gone.seats[0].tabId, 'its tab stays, since its session is still running')
    assert.match((await hostH('meeting_status')).text, /- Antigravity CLI: left/)
    assert.match(await nextMessage(hostH), /Stub review: looks fine\./, 'its one review reached the host')
    await writeFile(behaviorFile, JSON.stringify({ mode: 'review' }))
    await ui(`window.copilotDesktop.tempReviewerAction(${JSON.stringify(gone.id)}, 'retry', 'antigravity')`)
    await until('the retried seat to be in the meeting', async () => (await groupOf(meetingH))?.seats[0].verdict === 'reviewing')
    await hostH('meeting_end')
    await until('everything to be closed', async () => !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0, 30_000)

    // 10. Stop while the seat is still starting: the held round opens for the reviewer who joined by id, the hidden
    // seat is never in it, and its session and checkout are gone.
    await writeFile(behaviorFile, JSON.stringify({ mode: 'review', holdMs: 5000 }))
    const hostI = await client('claude-code')
    const meetingI = meetingIdOf((await hostI('meeting_start', { topic: 'stopped', post: 'Plan I.', folder: repo, reviewers: true })).text)
    const outsiderI = await client('codex-cli')
    await outsiderI('meeting_join', { meeting: meetingI })
    const starting = await until('run I to be starting', async () => { const group = await groupOf(meetingI); return group?.stage === 'starting' && group.seats[0].tabId ? group : null })
    await ui(`window.copilotDesktop.tempReviewerAction(${JSON.stringify(starting.id)}, 'stop')`)
    const stopped = await groupOf(meetingI)
    assert.equal(stopped.stage, 'ended')
    assert.equal(stopped.outcome, 'stopped')
    assert.match(await nextMessage(outsiderI), /round 1/, 'the meeting goes on for who is there')
    await outsiderI('meeting_reply', { text: 'Only me.' })
    const alone = await nextMessage(hostI)
    assert.match(alone, /Only me\./)
    assert.doesNotMatch(alone, /Stub review/, 'the stopped seat took no part')
    await hostI('meeting_end')
    await until('everything to be closed', async () => !(await getState()).tabs.some((tab) => tab.tempReviewer) && worktrees() === 1 && await leftovers() === 0, 30_000)

    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, meetings: [meetingA, meetingB, meetingC, meetingD, meetingE, meetingF, meetingH, meetingI] }, null, 2))
    app.exit(0)
  }
}
