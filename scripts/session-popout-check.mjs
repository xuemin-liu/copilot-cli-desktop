// Production Electron + live CLI, isolated data and loopback mock model.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label) {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) { const result = await action(); if (result) { console.log(`[popout] ${label}`); return result }; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
export async function runPopoutCheck() {
  await app.whenReady()
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'main window')
  const ui = (window, code) => Promise.race([
    window.webContents.executeJavaScript(code),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Renderer timeout: ${code}`)), 15_000); timer.unref() }),
  ])
  const state = (window = main) => ui(window, 'window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async (window, name) => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  const popoutFor = async id => until(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window === main || !window.webContents.getURL().endsWith('/index.html')) continue
      if ((await state(window)).windowSessionId === id) return window
    }
  }, 'session window')
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const source = await until(async () => (await state()).tabs.find(tab => tab.status === 'running' && tab.activity === 'idle'), 'resumed session idle')
    const id = JSON.stringify(source.id)
    const eventsPath = join(process.env.COPILOT_HOME, 'session-state', source.lastSessionId, 'events.jsonl')
    const assistantCount = async () => (await readFile(eventsPath, 'utf8')).split('\n').filter(line => {
      try { return JSON.parse(line).type === 'assistant.message' } catch { return false }
    }).length
    const initialReplies = await assistantCount()
    await until(async () => (await ui(main, `window.copilotDesktop.getTabBacklog(${id})`)).includes('open sidebar'), 'CLI input prompt ready')
    await until(() => ui(main, `document.querySelector('.session-pane-visible .xterm-screen')` + ' !== null'), 'terminal')
    await ui(main, `document.querySelector('.session-pane-visible button[title="Open in new window"]').click()`)
    const popout = await popoutFor(source.id)
    await until(() => ui(popout, `document.querySelector('.session-window .xterm-screen') !== null`), 'popout terminal')
    assert.equal(popout.getTitle(), `${source.title} — Copilot CLI Desktop`, 'idle page load retains the session title')
    await ui(popout, `document.title = 'Generic page title'; true`)
    await delay(100)
    assert.equal(popout.getTitle(), `${source.title} — Copilot CLI Desktop`, 'page-title updates cannot overwrite session title')
    await until(() => ui(main, `document.querySelector('.session-pane-visible .xterm-screen') === null`), 'main terminal released')
    const getSource = async () => (await state()).tabs.find(tab => tab.id === source.id)
    assert.equal((await getSource()).processId, source.processId)
    await ui(main, `window.copilotDesktop.popOutTab(${id})`)
    assert.equal(BrowserWindow.getAllWindows().filter(window => window !== main).length, 1, 'duplicate pop-out must focus existing window')
    await ui(main, `window.copilotDesktop.activateTab(${id})`)
    assert.ok(popout.isFocused(), 'main session selection focuses pop-out')
    await ui(main, `window.copilotDesktop.renameTab(${id}, 'Renamed UI session')`)
    assert.equal(popout.getTitle(), 'Renamed UI session — Copilot CLI Desktop')
    if (process.platform !== 'darwin') assert.equal(popout.isMenuBarVisible(), false, 'focus and rename menu refreshes leave pop-outs menu-free')
    popout.setSize(820, 650)
    await delay(400)
    popout.setSize(1100, 800)
    await delay(400)
    // Dispatch browser input events through the production xterm handlers.
    await ui(popout, `document.querySelector('.xterm-helper-textarea').focus()`)
    await ui(popout, `(() => {
      const data = new DataTransfer(); data.setData('text/plain', 'Reply with the saved marker.');
      document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`)
    await delay(200)
    await ui(popout, `document.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))`)
    await until(async () => (await readFile(eventsPath, 'utf8')).includes('Reply with the saved marker.'), 'typed prompt recorded')
    await until(async () => await assistantCount() > initialReplies, 'new reply recorded in conversation')
    await until(async () => (await getSource()).activity === 'idle', 'completed reply idle')
    await until(() => ui(popout, `document.querySelector('.xterm-rows')?.textContent.includes('The saved marker is desktop-side-chat-42.')`), 'reply rendered in popout')
    await screenshot(popout, '01-session-window')
    await screenshot(main, '02-main-window')
    await ui(popout, `setTimeout(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Return to main window').click(), 50); true`)
    await until(() => popout.isDestroyed(), 'return button')
    await until(() => ui(main, `document.querySelector('.session-pane-visible .xterm-screen') !== null`), 'returned terminal')
    await until(() => ui(main, `document.querySelector('.session-pane-visible .xterm-rows')?.textContent.includes('desktop-side-chat-42')`), 'docked terminal renders conversation history')
    assert.equal((await getSource()).processId, source.processId)
    await ui(main, `window.copilotDesktop.popOutTab(${id})`)
    const reopened = await popoutFor(source.id)
    // A second independent CLI can be visible beside the first.
    const secondState = await ui(main, 'window.copilotDesktop.createTab()')
    const secondId = secondState.activeTabId
    await ui(main, `window.copilotDesktop.popOutTab(${JSON.stringify(secondId)})`)
    const second = await popoutFor(secondId)
    assert.equal((await state()).poppedOutTabIds.length, 2)
    reopened.close()
    await until(async () => !(await state()).poppedOutTabIds.includes(source.id), 'native close docks')
    assert.equal((await getSource()).processId, source.processId)
    assert.equal(second.isDestroyed(), false)
    await ui(main, `window.copilotDesktop.popOutTab(${id})`)
    const keyboardWindow = await popoutFor(source.id)
    await until(() => ui(keyboardWindow, `document.querySelector('.xterm-helper-textarea') !== null`), 'keyboard return target')
    await ui(keyboardWindow, `setTimeout(() => document.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true })), 50); true`)
    await until(() => keyboardWindow.isDestroyed(), 'Ctrl+W returns session')
    assert.equal((await getSource()).processId, source.processId)
    await ui(main, `window.copilotDesktop.closeTab(${JSON.stringify(secondId)})`)
    await until(() => second.isDestroyed(), 'closing session disposes its window')
    await screenshot(main, '03-returned')
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: source.lastSessionId, checks: ['same CLI process', 'single terminal owner', 'duplicate focuses existing window', 'selection focuses popout', 'resizing', 'xterm paste/Enter events and model reply', 'return button and terminal history', 'two independent popouts', 'native close docks', 'Ctrl+W docks', 'session close disposes popout'] }, null, 2))
    console.log('[popout] PASS: live terminal interaction and window lifecycle, same CLI process')
  } catch (error) {
    for (const [index, window] of BrowserWindow.getAllWindows().entries()) await screenshot(window, `failure-${index}`).catch(() => {})
    throw error
  } finally { app.quit() }
}
