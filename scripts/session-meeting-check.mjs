// A review meeting in the real app, across an app restart. Run 1: a host session (full auto, with uncommitted changes) starts
// a meeting through its helper, the person invites an outside agent, and the app quits with the meeting open. Run 2, on the
// same data: the meeting is restored and its host started again; the outside agent (the guest helper, run as another harness
// would run it) joins with its first `next`; a second outside agent is invited and joins through the meeting tools over MCP;
// a read-only session in another project joins because the person typed "join meeting <id> as security reviewer"; the
// desktop delivers the plan and the patch to all three, collects their reviews, hands them to the host (whose helper now
// talks to the new app), runs the vote, and closes the meeting when everyone agrees.
// Real CLI and real helpers; the loopback mock model plays both sessions (no paid requests).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, clipboard } from 'electron'
import { MEETING_REVIEW_MARK } from './meeting-check-model.mjs'

const GUEST_REVIEW_MARK = 'guest-review-mark-5150'
const TOOL_REVIEW_MARK = 'tool-review-mark-6261'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await delay(250) }
  throw new Error(`Timed out: ${label}`)
}

export async function runMeetingCheck() {
  await app.whenReady()
  const phase = process.env.DESKTOP_UI_MEETING_PHASE ?? '1'
  const window = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'renderer')
  const ui = code => window.webContents.executeJavaScript(code)
  const state = () => ui('window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async name => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  const backlog = tabId => ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(tabId)})`)
  const type = async (tabId, line) => {
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(tabId)}, ${JSON.stringify(line)})`)
    await delay(400)
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(tabId)}, "\\r")`)
  }
  const ready = (tab, label) => until(async () => (await backlog(tab.id)).includes('open sidebar'), `${label} prompt`, 90_000)
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const initial = await until(async () => { const current = await state(); return current.profiles.length === 2 ? current : null }, 'both projects')
    if (phase === '1') await firstRun(initial)
    else await secondRun()
  } catch (error) {
    console.error(`[meeting] run ${phase} failed:`, error)
    await screenshot(`failure-${phase}`).catch(cause => console.error('[meeting] no failure screenshot:', cause))
    const current = await state().catch(() => null)
    console.error('[meeting] meetings', JSON.stringify(current?.meetings ?? null))
    for (const tab of current?.tabs ?? []) {
      const lines = (await backlog(tab.id).catch(() => '')).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '').split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean)
      console.error(`[meeting] ${tab.title} (${tab.status}, session ${tab.lastSessionId}) screen:\n` + lines.slice(-30).join('\n'))
    }
    const appLog = (await readFile(join(app.getPath('userData'), 'logs', 'app.log'), 'utf8').catch(() => '')).split('\n')
    console.error('[meeting] app log tail:\n' + appLog.slice(-25).join('\n'))
    console.error('[meeting] diagnostics:\n' + appLog.filter(line => line.includes('DEBUG')).slice(0, 60).join('\n'))
    throw error
  } finally { app.quit() }

  async function firstRun(initial) {
    const hostProfile = initial.profiles.find(profile => profile.name === 'Meeting host')
    const reviewerProfile = initial.profiles.find(profile => profile.name === 'Meeting reviewer')
    const opened = async (profileId, title) => {
      const before = new Set((await state()).tabs.map(tab => tab.id))
      await ui(`window.copilotDesktop.createTab("new", ${JSON.stringify(profileId)}, ${JSON.stringify(title)})`)
      const tab = await until(async () => (await state()).tabs.find(tab => !before.has(tab.id)), `${title} tab`)
      await ready(tab, title)
      return tab
    }
    const host = await opened(hostProfile.id, 'meeting host')
    const reviewer = await opened(reviewerProfile.id, 'meeting reviewer')
    // The reviewer's session exists in Copilot's store once it has a turn, so the next run can resume it.
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(reviewer.id)})`)
    await type(reviewer.id, 'Hello')
    await until(async () => (await backlog(reviewer.id)).includes('The saved marker is desktop-side-chat-42.'), 'reviewer answered once')
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(host.id)})`)

    // The person asks the host; its model runs the helper, which opens the meeting with the plan and the patch.
    await type(host.id, 'Start a meeting to review the plan in plan.md')
    const opening = await until(async () => (await state()).meetings?.find(meeting => meeting.hostTabId === host.id), 'meeting opened by the host', 90_000)
    assert.match(opening.id, /^[2-9A-HJ-NP-Z]{4}$/)
    const folder = opening.folder
    assert.equal((await readFile(join(folder, 'round-1', 'post.md'), 'utf8')).replace(/\r\n/g, '\n'), '# Plan\n\n1. Retry the login.\n2. Clear the token on logout.\n')
    assert.match(await readFile(join(folder, 'round-1', 'changes.patch'), 'utf8'), /\+retry = 3/, 'the host\'s uncommitted change is attached')
    await until(async () => (await backlog(host.id)).includes('Added directory to allowed list'), 'the meeting folder added to the host', 90_000)
    const saved = await until(async () => {
      const value = JSON.parse(await readFile(join(folder, 'meeting.json'), 'utf8').catch(() => 'null'))
      return value?.stage === 'waiting' && value.host.sessionId ? value : null
    }, 'meeting saved with its host\'s session id')
    assert.equal(saved.host.sessionId, (await state()).tabs.find(tab => tab.id === host.id).lastSessionId)

    // The person invites an outside agent; it is used only after the restart, so the seat must survive it.
    const savedClipboard = await clipboard.readText()
    const invitation = await ui(`window.copilotDesktop.meetingInvite(${JSON.stringify(opening.id)}, 'Script agent', 'performance reviewer')`)
    // Windows hands text back from the clipboard with CRLF line ends.
    const copied = (await clipboard.readText()).replace(/\r\n/g, '\n')
    clipboard.writeText(savedClipboard)
    assert.equal(copied, invitation, 'the invitation is on the clipboard')
    assert.match(invitation, new RegExp(`review meeting ${opening.id} in Copilot CLI Desktop as performance reviewer`))
    const token = /next -Token ([a-f0-9]{64})/.exec(invitation)?.[1]
    assert.ok(token, 'the invitation carries the guest token')
    const guestRoot = join(app.getPath('userData'), 'meeting-guest')
    assert.ok(JSON.parse(await readFile(join(guestRoot, 'endpoint.json'), 'utf8')).port > 0, 'the endpoint file names the port')
    const seats = await until(async () => { const text = await readFile(join(guestRoot, 'seats.json'), 'utf8').catch(() => ''); return text.includes('Script agent') ? text : null }, 'guest seat saved')
    assert.ok(!seats.includes(token), 'no token on disk')
    await until(() => ui('/Script agent \\(performance reviewer\\) · invited, not connected yet/.test(document.querySelector(".meeting-bar")?.innerText || "")'), 'meeting bar shows the invitation')
    await writeFile(join(artifacts, 'guest-invitation.txt'), invitation)
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, meeting: opening.id }))
    console.log(`[meeting] run 1: meeting ${opening.id} is open with an outside agent invited; quitting with it open`)
  }

  /** An outside agent with the meeting tools: a minimal MCP client, as a harness speaks to the desktop's endpoint. */
  function mcpClient(url) {
    let session = null
    let id = 0
    const post = async (body) => {
      const response = await fetch(url, { method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) } })
      session ??= response.headers.get('mcp-session-id')
      return response.status === 202 ? null : response.json()
    }
    return {
      async initialize() {
        await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'meeting-check', version: '1' } } })
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
      },
      async call(name, args) {
        const answer = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
        if (answer.result.isError) throw new Error(`${name}: ${answer.result.content[0].text}`)
        return answer.result.content[0].text
      },
    }
  }

  /** The outside agent: the helper from the invitation, run as another harness would run it. */
  function guestHelper(invitation) {
    const token = /next -Token ([a-f0-9]{64})/.exec(invitation)[1]
    const path = /(?:-File|sh) "([^"]+meeting-guest\.(?:ps1|sh))"/.exec(invitation)[1]
    const [shell, ...shellArgs] = process.platform === 'win32' ? ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] : ['sh']
    return (...args) => new Promise((resolveRun) => execFile(shell, [...shellArgs, path, ...args, '-Token', token], { encoding: 'utf8', timeout: 120_000 },
      (error, out, err) => resolveRun({ code: error ? Number(error.code ?? 1) : 0, out: out.trim(), err: err.trim() })))
  }

  async function secondRun() {
    const id = process.env.DESKTOP_UI_MEETING_ID
    assert.ok(id, 'the first run named its meeting')
    // Restored with the app: its host is the restored "meeting host" tab, started for the meeting, and gets the folder again.
    const restored = await until(async () => (await state()).meetings?.find(meeting => meeting.id === id), 'meeting restored', 90_000)
    assert.equal(restored.stage, 'waiting')
    const tabs = (await state()).tabs
    const host = tabs.find(tab => tab.title === 'meeting host')
    const reviewer = tabs.find(tab => tab.title === 'meeting reviewer')
    assert.equal(restored.hostTabId, host.id, 'the saved host session was found among the restored tabs')
    await until(async () => (await backlog(host.id)).includes('Added directory to allowed list'), 'the meeting folder added to the restored host', 90_000)
    const folder = restored.folder
    assert.match(await readFile(join(folder, 'transcript.md'), 'utf8'), /## Restored/)

    // The outside agent invited before the restart asks for its first message: that joins it, and round 1 opens for it.
    const guest = guestHelper(await readFile(join(artifacts, 'guest-invitation.txt'), 'utf8'))
    const post = await until(async () => { const next = await guest('next', '-Wait', '60'); return next.out.startsWith('[meeting ') ? next : null }, 'guest\'s first message', 90_000)
    assert.match(post.out, new RegExp(`^\\[meeting ${id} · round 1 · from the desktop\\]`))
    assert.match(post.out, /You review as: performance reviewer/)
    assert.match(post.out, /the output of: show -Name changes -Round 1/, 'a show command, not a path, for the patch')
    assert.ok(!post.out.split('\n-----\n')[0].includes(folder), 'no meeting folder path in what the guest reads')
    const replyPath = /To answer, write your whole reply to (.+?) and run the reply command/.exec(post.out)?.[1]
    assert.ok(replyPath?.includes('meeting-guest'), 'the reply file is in the app\'s guest folder, not in a project')
    assert.match((await guest('show', '-Name', 'changes', '-Round', '1')).out, /\+retry = 3[\s\S]*\[end\]$/)

    // A second outside agent uses the meeting tools over MCP: invited now, it joins the same round with its invitation.
    const toolsUrl = (await state()).meetingToolsUrl
    assert.match(toolsUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, 'the meeting tools are served')
    const savedClipboard = await clipboard.readText()
    const toolInvitation = await ui(`window.copilotDesktop.meetingInvite(${JSON.stringify(id)}, 'Tool agent', null)`)
    clipboard.writeText(savedClipboard)
    assert.match(toolInvitation, /If you have the copilot-meeting tools/, 'the invitation offers the tools first')
    const tools = mcpClient(toolsUrl)
    await tools.initialize()
    assert.match(await tools.call('meeting_join', { invitation: /meeting_join with invitation "([a-f0-9]{64})"/.exec(toolInvitation)[1] }), new RegExp(`^Joined meeting ${id}\\.`))
    const toolPost = await tools.call('meeting_next', { wait_seconds: 30 })
    assert.match(toolPost, new RegExp(`^\\[meeting ${id} · round 1 · from the desktop\\]`))
    assert.match(toolPost, /the result of meeting_show\(name: "changes", round: 1\)/, 'material named as a tool call')
    assert.ok(toolPost.endsWith('To answer, call meeting_reply with your whole reply.'), 'no reply file for an agent with the tools')
    assert.match(await tools.call('meeting_show', { name: 'changes', round: 1 }), /\+retry = 3[\s\S]*\[end\]$/)

    // The person asks the reviewer, in another project, to join with a role; the desktop does the rest. It joins the round
    // the guest is in, so the round waits for both.
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(reviewer.id)})`)
    await ready(reviewer, 'restored reviewer')
    await type(reviewer.id, `join meeting ${id} as security reviewer`)
    const joined = await until(async () => (await state()).meetings?.find(meeting => meeting.id === id)?.participants.find(participant => participant.tabId === reviewer.id), 'reviewer joined')
    assert.equal(joined.role, 'security reviewer')
    await until(() => ui('/reviewers: Script agent \\(guest\\) \\(performance reviewer\\), Tool agent \\(guest\\), meeting reviewer \\(security reviewer\\)[\\s\\S]*AI credits used \\(Copilot sessions only\\)/.test(document.querySelector(".meeting-bar")?.innerText || "")'), 'meeting bar shows the guests, the role and the cost')
    await screenshot('01-joined-after-restart').catch(cause => console.error('[meeting] no screenshot:', cause))
    await until(async () => (await backlog(reviewer.id)).includes('Added directory to allowed list'), 'the meeting folder added to the reviewer', 90_000)

    await mkdir(dirname(replyPath), { recursive: true })
    await writeFile(replyPath, `Guest review: three retries is fine. ${GUEST_REVIEW_MARK}\n`)
    assert.equal((await guest('reply', '-File', replyPath)).out, 'Reply sent. Run next for the next message.')
    assert.equal(await tools.call('meeting_reply', { text: `Tool review: the lock looks right. ${TOOL_REVIEW_MARK}` }), 'Reply sent. Call meeting_next for the next message.')
    // The vote: each guest polls until it comes, then agrees.
    const vote = await until(async () => { const next = await guest('next', '-Wait', '30'); return / · vote · from the desktop\]/.test(next.out) ? next : null }, 'vote reached the guest', 150_000)
    const votePath = /To answer, write your whole reply to (.+?) and run the reply command/.exec(vote.out)[1]
    await writeFile(votePath, 'AGREE: the guest agrees.\n')
    assert.equal((await guest('reply', '-File', votePath)).out, 'Reply sent. Run next for the next message.')
    await until(async () => / · vote · from the desktop\]/.test(await tools.call('meeting_next', { wait_seconds: 30 })), 'vote reached the tool agent', 150_000)
    await tools.call('meeting_reply', { text: 'AGREE: the tool agent agrees.' })

    const closed = await until(async () => {
      const meeting = (await state()).meetings?.find(candidate => candidate.id === id)
      return meeting?.stage === 'closed' ? meeting : null
    }, 'meeting closed by agreement', 150_000)
    assert.equal(closed.outcome, 'agreed', JSON.stringify(closed))
    assert.equal(closed.round, 2, 'one review round, then the vote')
    // The desktop writes the transcript in order but asynchronously: wait for the entry that closed the meeting.
    const transcript = await until(async () => { const text = await readFile(join(folder, 'transcript.md'), 'utf8'); return /## Closed/.test(text) ? text : null }, 'transcript written to the close')
    assert.match(transcript, /"meeting reviewer" \([^)]*\), as security reviewer joined/)
    assert.match(transcript, new RegExp(MEETING_REVIEW_MARK), 'the review reached the transcript')
    assert.match(transcript, /the host proposes to close/)
    assert.match(transcript, /AGREE: the lock is now in the plan/)
    assert.match(transcript, /"Script agent \(guest\)", as performance reviewer joined/)
    assert.match(transcript, new RegExp(GUEST_REVIEW_MARK), 'the guest\'s review reached the transcript')
    assert.match(transcript, /AGREE: the guest agrees/)
    assert.equal((await guest('next', '-Wait', '5')).out, 'The meeting is closed.', 'the guest hears that the meeting closed')
    assert.match(transcript, /"Tool agent \(guest\)" joined/)
    assert.match(transcript, new RegExp(TOOL_REVIEW_MARK), 'the tool agent\'s review reached the transcript')
    assert.match(transcript, /AGREE: the tool agent agrees/)
    assert.equal(await tools.call('meeting_next', { wait_seconds: 5 }), 'The meeting is closed.', 'the tool agent hears that the meeting closed')
    assert.match((await readFile(join(folder, 'round-2', 'post.md'), 'utf8')).replace(/\r\n/g, '\n'), /Take the lock on logout too/, 'the restored host\'s helper reached the new app')
    assert.equal(JSON.parse(await readFile(join(folder, 'meeting.json'), 'utf8')).stage, 'closed', 'saved as closed: it will not be restored again')
    await until(async () => (await backlog(host.id)).includes('Everyone agreed; here is the outcome.'), 'host told the meeting agreed', 60_000)
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(host.id)})`)
    await until(() => ui('/everyone agreed/i.test(document.querySelector(".meeting-bar")?.innerText || "")'), 'closed meeting shown on the host')
    await screenshot('02-agreed').catch(cause => console.error('[meeting] no screenshot:', cause))
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, meeting: id, cli: (await state()).resolution.version,
      checks: ['host helper starts a meeting with plan and patch', 'meeting saved with session ids and restored after the app restarts', 'restored host started and given the folder again',
        'join with a role by typed request from a read-only session in another project', 'role and cost in the meeting bar', 'review collected and delivered to the host',
        'restored host proposes to close through the new endpoint', 'reviewer agrees and the meeting closes, saved as closed', 'host told',
        'outside agent invited, its seat restored after the restart', 'guest reads show commands and pages the patch', 'guest review and vote counted', 'guest told the meeting closed',
        'second outside agent joins, reviews and votes through the meeting tools over MCP'] }, null, 2))
    console.log(`[meeting] PASS: meeting ${id} survived a restart, took a reviewer with a role and an outside agent, and closed by agreement`)
  }
}
