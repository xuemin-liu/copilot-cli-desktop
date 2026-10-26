// A review meeting in the real app: a host session (full auto, with uncommitted changes) starts a meeting through its helper,
// a read-only session in another project joins it because the person typed "join meeting <id>", the desktop delivers the
// plan and the patch, collects the review, hands it to the host, runs the vote, and closes the meeting when everyone agrees.
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
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const initial = await until(async () => { const current = await state(); return current.profiles.length === 2 ? current : null }, 'both projects')
    const hostProfile = initial.profiles.find(profile => profile.name === 'Meeting host')
    const reviewerProfile = initial.profiles.find(profile => profile.name === 'Meeting reviewer')
    const opened = async (profileId, title) => {
      const before = new Set((await state()).tabs.map(tab => tab.id))
      await ui(`window.copilotDesktop.createTab("new", ${JSON.stringify(profileId)}, ${JSON.stringify(title)})`)
      const tab = await until(async () => (await state()).tabs.find(tab => !before.has(tab.id)), `${title} tab`)
      await until(async () => (await backlog(tab.id)).includes('open sidebar'), `${title} prompt`, 90_000)
      return tab
    }
    const host = await opened(hostProfile.id, 'meeting host')
    const reviewer = await opened(reviewerProfile.id, 'meeting reviewer')
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(host.id)})`)

    // The person asks the host; its model runs the helper, which opens the meeting with the plan and the patch.
    await type(host.id, 'Start a meeting to review the plan in plan.md')
    const opening = await until(async () => (await state()).meetings?.find(meeting => meeting.hostTabId === host.id), 'meeting opened by the host', 90_000)
    assert.match(opening.id, /^[2-9A-HJ-NP-Z]{4}$/)
    const folder = opening.folder
    assert.equal((await readFile(join(folder, 'round-1', 'post.md'), 'utf8')).replace(/\r\n/g, '\n'), '# Plan\n\n1. Retry the login.\n2. Clear the token on logout.\n')
    assert.match(await readFile(join(folder, 'round-1', 'changes.patch'), 'utf8'), /\+retry = 3/, 'the host\'s uncommitted change is attached')

    // The person asks the reviewer, in another project, to join; the desktop does the rest.
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(reviewer.id)})`)
    await type(reviewer.id, `join meeting ${opening.id}`)
    await until(async () => (await state()).meetings?.find(meeting => meeting.id === opening.id)?.participants.some(participant => participant.tabId === reviewer.id), 'reviewer joined')
    await until(() => ui('/Meeting [A-Z0-9]{4}/.test(document.querySelector(".meeting-bar")?.innerText || "")'), 'meeting bar shown')
    await screenshot('01-joined').catch(cause => console.error('[meeting] no screenshot:', cause))
    await until(async () => (await backlog(reviewer.id)).includes('Added directory to allowed list'), 'the meeting folder added to the reviewer', 90_000)

    const closed = await until(async () => {
      const meeting = (await state()).meetings?.find(candidate => candidate.id === opening.id)
      return meeting?.stage === 'closed' ? meeting : null
    }, 'meeting closed by agreement', 150_000)
    assert.equal(closed.outcome, 'agreed', JSON.stringify(closed))
    assert.equal(closed.round, 2, 'one review round, then the vote')
    const transcript = await readFile(join(folder, 'transcript.md'), 'utf8')
    assert.match(transcript, new RegExp(MEETING_REVIEW_MARK), 'the review reached the transcript')
    assert.match(transcript, /the host proposes to close/)
    assert.match(transcript, /AGREE: the lock is now in the plan/)
    assert.match(await readFile(join(folder, 'round-1', 'replies.md'), 'utf8'), new RegExp(MEETING_REVIEW_MARK))
    assert.match((await readFile(join(folder, 'round-2', 'post.md'), 'utf8')).replace(/\r\n/g, '\n'), /Take the lock on logout too/)
    // The host was told, and its turn after the meeting ran.
    await until(async () => (await backlog(host.id)).includes('Everyone agreed; here is the outcome.'), 'host told the meeting agreed', 60_000)
    const reviewerScreen = await backlog(reviewer.id)
    assert.ok(reviewerScreen.includes('AGREE: the lock is now in the plan.'), 'the reviewer voted')
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(host.id)})`)
    await until(() => ui('/everyone agreed/i.test(document.querySelector(".meeting-bar")?.innerText || "")'), 'closed meeting shown on the host')
    await screenshot('02-agreed').catch(cause => console.error('[meeting] no screenshot:', cause))
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, meeting: opening.id, cli: (await state()).resolution.version,
      checks: ['host helper starts a meeting with plan and patch', 'join by typed request from a read-only session in another project', '/add-dir typed into the reviewer', 'review collected and delivered to the host', 'host proposes to close', 'reviewer agrees and the meeting closes', 'host told'] }, null, 2))
    console.log(`[meeting] PASS: meeting ${opening.id} ran one review round and a vote, and closed by agreement`)
  } catch (error) {
    console.error('[meeting] failed:', error)
    await screenshot('failure').catch(cause => console.error('[meeting] no failure screenshot:', cause))
    const current = await state().catch(() => null)
    console.error('[meeting] meetings', JSON.stringify(current?.meetings ?? null))
    for (const tab of current?.tabs ?? []) console.error(`[meeting] ${tab.title} screen:\n` + (await backlog(tab.id).catch(() => '')).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(-2500))
    throw error
  } finally { app.quit() }
}
