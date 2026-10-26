// A review meeting in the real app, across an app restart. Run 1: a host session (full auto, with uncommitted changes) starts
// a meeting through its helper, and the app quits with the meeting open. Run 2, on the same data: the meeting is restored and
// its host started again; a read-only session in another project joins it because the person typed "join meeting <id> as
// security reviewer"; the desktop delivers the plan and the patch, collects the review, hands it to the host (whose helper
// now talks to the new app), runs the vote, and closes the meeting when everyone agrees.
// Real CLI and real helper; the loopback mock model plays both sessions (no paid requests).
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { MEETING_REVIEW_MARK } from './meeting-check-model.mjs'

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
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, meeting: opening.id }))
    console.log(`[meeting] run 1: meeting ${opening.id} is open; quitting with it open`)
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

    // The person asks the reviewer, in another project, to join with a role; the desktop does the rest.
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(reviewer.id)})`)
    await ready(reviewer, 'restored reviewer')
    await type(reviewer.id, `join meeting ${id} as security reviewer`)
    const joined = await until(async () => (await state()).meetings?.find(meeting => meeting.id === id)?.participants.find(participant => participant.tabId === reviewer.id), 'reviewer joined')
    assert.equal(joined.role, 'security reviewer')
    await until(() => ui('/reviewers: meeting reviewer \\(security reviewer\\)[\\s\\S]*AI credits used/.test(document.querySelector(".meeting-bar")?.innerText || "")'), 'meeting bar shows the role and the cost')
    await screenshot('01-joined-after-restart').catch(cause => console.error('[meeting] no screenshot:', cause))
    await until(async () => (await backlog(reviewer.id)).includes('Added directory to allowed list'), 'the meeting folder added to the reviewer', 90_000)

    const closed = await until(async () => {
      const meeting = (await state()).meetings?.find(candidate => candidate.id === id)
      return meeting?.stage === 'closed' ? meeting : null
    }, 'meeting closed by agreement', 150_000)
    assert.equal(closed.outcome, 'agreed', JSON.stringify(closed))
    assert.equal(closed.round, 2, 'one review round, then the vote')
    const transcript = await readFile(join(folder, 'transcript.md'), 'utf8')
    assert.match(transcript, /"meeting reviewer" \([^)]*\), as security reviewer joined/)
    assert.match(transcript, new RegExp(MEETING_REVIEW_MARK), 'the review reached the transcript')
    assert.match(transcript, /the host proposes to close/)
    assert.match(transcript, /AGREE: the lock is now in the plan/)
    assert.match((await readFile(join(folder, 'round-2', 'post.md'), 'utf8')).replace(/\r\n/g, '\n'), /Take the lock on logout too/, 'the restored host\'s helper reached the new app')
    assert.equal(JSON.parse(await readFile(join(folder, 'meeting.json'), 'utf8')).stage, 'closed', 'saved as closed: it will not be restored again')
    await until(async () => (await backlog(host.id)).includes('Everyone agreed; here is the outcome.'), 'host told the meeting agreed', 60_000)
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(host.id)})`)
    await until(() => ui('/everyone agreed/i.test(document.querySelector(".meeting-bar")?.innerText || "")'), 'closed meeting shown on the host')
    await screenshot('02-agreed').catch(cause => console.error('[meeting] no screenshot:', cause))
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, meeting: id, cli: (await state()).resolution.version,
      checks: ['host helper starts a meeting with plan and patch', 'meeting saved with session ids and restored after the app restarts', 'restored host started and given the folder again',
        'join with a role by typed request from a read-only session in another project', 'role and cost in the meeting bar', 'review collected and delivered to the host',
        'restored host proposes to close through the new endpoint', 'reviewer agrees and the meeting closes, saved as closed', 'host told'] }, null, 2))
    console.log(`[meeting] PASS: meeting ${id} survived a restart, took a reviewer with a role, and closed by agreement`)
  }
}
