// Real Electron/IPC/PTY/CLI check of session names, using the isolated harness (node scripts/electron-side-chat-check.mjs
// --session-name). Copilot keeps a session's name in <COPILOT_HOME>/session-state/<id>/workspace.yaml; this reads it there.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(action, label, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    last = await action()
    if (last) return last
    await delay(200)
  }
  throw new Error(`Timed out: ${label}`)
}

export async function runSessionNameCheck() {
  await app.whenReady()
  const window = await until(() => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/index.html')), 'renderer')
  const ui = (code) => window.webContents.executeJavaScript(code)
  const state = () => ui('window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  const screenshot = async (name) => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  const sessionState = join(process.env.COPILOT_HOME, 'session-state')
  const copilotName = async (sessionId) => {
    try {
      const text = await readFile(join(sessionState, sessionId, 'workspace.yaml'), 'utf8')
      const line = (key) => text.split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`))?.slice(key.length + 1).trim()
      const name = line('name')?.replace(/^'(.*)'$/, '$1').replace(/''/g, "'") ?? null
      return { name, userNamed: line('user_named') === 'true' }
    } catch { return { name: null, userNamed: false } }
  }
  const ready = (id) => until(async () => {
    const text = await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(id)})`)
    return typeof text === 'string' && text.includes('open sidebar')
  }, 'CLI prompt ready')
  const write = (id, text) => ui(`window.copilotDesktop.writeTab(${JSON.stringify(id)}, ${JSON.stringify(text)})`)
  const tab = async (id) => (await state()).tabs.find((candidate) => candidate.id === id)
  const modelRequests = async () => { try { return await readFile(join(artifacts, 'model-requests.jsonl'), 'utf8') } catch { return '' } }
  const results = {}
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))

    // 1. A tab saved by an older release, titled "Main UI test" while its Copilot session has another name: nothing is
    // typed into it unasked; only a rename made in the desktop reaches Copilot.
    const restored = await until(async () => (await state()).tabs.find((candidate) => candidate.status === 'running'), 'restored session')
    await ready(restored.id)
    const original = (await copilotName(restored.lastSessionId)).name
    assert.notEqual(original, 'Main UI test', 'the Copilot session starts with another name')
    await delay(7_000)
    assert.equal((await copilotName(restored.lastSessionId)).name, original, 'an older tab is left alone')
    assert.ok(!(await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(restored.id)})`)).includes('/rename'), 'nothing was typed')
    results.olderTabLeftAlone = true

    // 2. A new session nobody named: no --name, so Copilot names it from the first prompt, and the tab follows.
    await ui('window.copilotDesktop.createTab()')
    const fresh = await until(async () => (await state()).tabs.find((candidate) => candidate.id !== restored.id && candidate.status === 'running' && candidate.lastSessionId), 'new session')
    assert.equal(fresh.title, 'Isolated Electron test', 'the project name shows until Copilot names it')
    assert.equal(fresh.autoTitle, true)
    await ready(fresh.id)
    await write(fresh.id, 'Plan the login race fix')
    await delay(200)
    await write(fresh.id, '\r')
    const generated = await until(async () => (await copilotName(fresh.lastSessionId)).name, 'Copilot named the new session')
    assert.notEqual(generated, 'Isolated Electron test')
    await until(async () => (await tab(fresh.id))?.title === generated, 'the tab took the name Copilot gave the session')
    assert.equal((await copilotName(fresh.lastSessionId)).userNamed, false)
    await screenshot('01-copilot-named')
    results.copilotNamed = generated

    // 3. Renaming the tab in the desktop renames the Copilot session.
    await until(async () => (await tab(fresh.id))?.activity === 'idle', 'turn finished')
    await ui(`window.copilotDesktop.renameTab(${JSON.stringify(fresh.id)}, 'Login race fix')`)
    const renamed = await until(async () => { const name = await copilotName(fresh.lastSessionId); return name.name === 'Login race fix' ? name : null }, 'rename reached Copilot')
    assert.equal(renamed.userNamed, true)
    assert.equal((await tab(fresh.id)).autoTitle, false)
    results.renameReachesCopilot = true

    // 3b. Keys pressed while the desktop is typing /rename wait for its Enter instead of becoming part of the name.
    await delay(2_500)
    await ui(`window.copilotDesktop.renameTab(${JSON.stringify(fresh.id)}, 'Race rename')`)
    await until(async () => (await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(fresh.id)})`)).includes('/rename Race rename'), 'command echoed', 10_000)
    await write(fresh.id, ' UNSENT_DRAFT')
    await until(async () => (await copilotName(fresh.lastSessionId)).name === 'Race rename', 'rename reached Copilot')
    await delay(2_000)
    assert.equal((await copilotName(fresh.lastSessionId)).name, 'Race rename', 'the keys did not join the name')
    await write(fresh.id, '\x03')
    results.keysDuringRename = true

    // 4. A rename while a draft sits in the prompt waits; closing the tab clears the draft and renames before stopping.
    // The draft never reaches the model.
    const before = await modelRequests()
    await write(fresh.id, 'unsent draft words')
    await ui(`window.copilotDesktop.renameTab(${JSON.stringify(fresh.id)}, 'Closed with this name')`)
    await delay(4_000)
    assert.equal((await copilotName(fresh.lastSessionId)).name, 'Race rename', 'a draft holds the rename back')
    await screenshot('02-draft-waiting')
    await ui(`window.copilotDesktop.closeTab(${JSON.stringify(fresh.id)})`)
    await until(async () => !(await tab(fresh.id)), 'tab closed')
    assert.equal((await copilotName(fresh.lastSessionId)).name, 'Closed with this name', 'the closed session keeps the tab name')
    const after = await modelRequests()
    assert.ok(!after.slice(before.length).includes('unsent draft words'), 'the draft was never sent to the model')
    results.renameOnClose = true

    // 5. An unnamed session restarted before its first prompt: Copilot never stored it, so it starts again under the
    // same id instead of failing to resume.
    const ids = new Set((await state()).tabs.map((candidate) => candidate.id))
    await ui('window.copilotDesktop.createTab()')
    const idle = await until(async () => (await state()).tabs.find((candidate) => !ids.has(candidate.id) && candidate.status === 'running' && candidate.lastSessionId), 'unused session')
    await ready(idle.id)
    await ui(`window.copilotDesktop.restartTab(${JSON.stringify(idle.id)})`)
    await delay(1_000)
    await ready(idle.id)
    const restarted = await tab(idle.id)
    assert.equal(restarted.status, 'running', 'the restarted session is running')
    assert.equal(restarted.lastSessionId, idle.lastSessionId, 'it keeps its id')
    await write(idle.id, 'First prompt after restart')
    await delay(200)
    await write(idle.id, '\r')
    await until(async () => (await copilotName(idle.lastSessionId)).name === 'First prompt after restart', 'the session is stored under that id and named')
    results.unusedRestart = true

    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: restored.lastSessionId, cli: (await state()).resolution.version, ...results }, null, 2))
    console.log(`[session-name] PASS: older tab left alone, Copilot-named tab ("${generated}"), rename while open, rename on close`)
  } catch (error) {
    await screenshot('failure').catch(() => {})
    console.error('[session-name] state', JSON.stringify((await state()).tabs))
    throw error
  } finally {
    app.quit()
  }
}
