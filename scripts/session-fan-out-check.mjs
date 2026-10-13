// Fan-out in the real app: the real CLI starts two worktree sessions one after another, the desktop finds their ids,
// the task lands in each prompt box, and nothing is sent. Isolated data, loopback mock model (no paid requests).
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await delay(250) }
  throw new Error(`Timed out: ${label}`)
}
export async function runFanOutCheck() {
  await app.whenReady()
  const window = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'renderer')
  const ui = code => window.webContents.executeJavaScript(code)
  const state = () => ui('window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async name => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const initial = await state()
    const profileId = initial.activeProfileId
    // Through the real dialog: open it from the sidebar, type the task, pick two sessions, submit.
    // The sidebar's Fan out action, once the renderer has its state and a workspace is active.
    const fanOutButton = '[aria-label="Fan out into several sessions"]'
    await until(() => ui(`!!document.querySelector(${JSON.stringify(fanOutButton)}) && !document.querySelector(${JSON.stringify(fanOutButton)}).disabled`), 'Fan out action available')
    await ui(`document.querySelector(${JSON.stringify(fanOutButton)}).click()`)
    await until(() => ui('!!document.querySelector("#fan-out-count")'), 'fan-out dialog')
    await ui('(() => { const input = document.querySelector("#input-dialog-value"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Reply with the saved marker."); input.dispatchEvent(new Event("input", { bubbles: true })) })()')
    await ui('(() => { const select = document.querySelector("#fan-out-count"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "2"); select.dispatchEvent(new Event("change", { bubbles: true })) })()')
    await ui('document.querySelector(".input-dialog button[type=submit]").click()')
    const before = new Set(initial.tabs.map(tab => tab.id))
    // Two sessions, one after the other: the second must not exist before the first has reported its folder.
    const first = await until(async () => (await state()).tabs.find(tab => !before.has(tab.id) && tab.fanOutLabel), 'first fan-out session', 60_000)
    const second = await until(async () => (await state()).tabs.find(tab => !before.has(tab.id) && tab.id !== first.id && tab.fanOutLabel), 'second fan-out session', 120_000)
    const firstThen = (await state()).tabs.find(tab => tab.id === first.id)
    assert.ok(firstThen.sessionCwd, 'the first had reported its folder before the second started')
    await until(() => ui('!document.querySelector(".input-dialog")'), 'dialog closed')
    await until(() => ui('/Started 2 of 2 sessions/.test(document.querySelector(".fan-out-notice")?.innerText || "")'), 'fan-out notice', 150_000)
    const done = await state()
    const started = done.tabs.filter(tab => [first.id, second.id].includes(tab.id))
    assert.equal(started.length, 2)
    assert.ok(started.every(tab => tab.worktree && tab.sessionCwd && tab.fanOutLabel === first.fanOutLabel), JSON.stringify(started.map(tab => [tab.title, tab.worktree?.name, tab.fanOutLabel])))
    assert.notEqual(started[0].worktree.path.toLowerCase(), started[1].worktree.path.toLowerCase(), 'two distinct worktrees')
    assert.match(first.fanOutLabel, /^fan-out · Reply with the saved marker\./)
    // The task is in each prompt box, and nothing was sent: no turn was recorded for either session.
    for (const tab of started) {
      await until(async () => (await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(tab.id)})`)).includes('Reply with the saved marker.'), `task pasted in ${tab.title}`, 120_000)
    }
    await delay(3_000)
    for (const tab of (await state()).tabs.filter(tab => [first.id, second.id].includes(tab.id))) {
      assert.notEqual(tab.activity, 'working', `${tab.title} must not be working: nothing was sent`)
      const backlog = await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(tab.id)})`)
      assert.ok(!backlog.includes('The saved marker is desktop-side-chat-42.'), `${tab.title} received no reply, so the prompt was not submitted`)
    }
    await screenshot('01-fan-out').catch(cause => console.error('[fan-out] no screenshot:', cause))
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sessions: started.map(tab => ({ title: tab.title, worktree: tab.worktree.name, sessionId: tab.lastSessionId })), cli: done.resolution.version,
      checks: ['dialog starts two sessions', 'sequential: second after the first reported', 'both in distinct worktrees with the shared label', 'task pasted in each prompt box', 'nothing submitted'] }, null, 2))
    console.log('[fan-out] PASS: two worktree sessions started in order, task pasted, nothing sent')
  } catch (error) {
    console.error('[fan-out] failed:', error)
    await screenshot('failure').catch(cause => console.error('[fan-out] no failure screenshot:', cause))
    console.error('[fan-out] state', JSON.stringify(await state().catch(() => null)))
    throw error
  } finally { app.quit() }
}
