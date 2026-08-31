// Real Electron + CLI regression, invoked by electron-side-chat-check.mjs.
// Only the model and session/config directories are fixtures. UI, IPC, mouse
// selection, OSC 52, terminal rendering, and tab lifecycles are production code.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard } from 'electron'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(action, label, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await action()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

export async function runClipboardSwitchCheck() {
  await app.whenReady()
  const window = await until(() => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/index.html')), 'main renderer')
  const ui = (code) => window.webContents.executeJavaScript(code)
  const state = () => ui('window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async (name) => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  const originalClipboard = clipboard.readText()
  let copied = ''
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    await until(async () => (await state()).tabs.some((tab) => tab.status === 'running' && tab.lastSessionId), 'running source')
    const source = (await state()).tabs[0]
    await ui(`window.copilotDesktop.forkSideChat(${JSON.stringify(source.id)}, ${JSON.stringify(source.lastSessionId)}, 'Clipboard side test')`)
    const side = await until(async () => (await state()).tabs.find((tab) => tab.sideChat && tab.status === 'running'), 'running side chat')
    const selector = '.session-pane[aria-label="Side chat: Clipboard side test"]'
    const text = () => ui(`Array.from(document.querySelectorAll(${JSON.stringify(selector + ' .xterm-rows > div')}), row => row.textContent).join(${JSON.stringify('\n')})`)
    await until(async () => (await text()).includes('desktop-side-chat-42'), 'forked conversation on screen')
    await until(async () => {
      const visible = await text()
      return visible.includes('Disabled tools:') && visible.includes('open sidebar') && !visible.includes('Loading:')
    }, 'CLI finished startup')
    await delay(1000)
    window.show()
    window.focus()
    await screenshot('01-before-copy')
    const selection = await ui(`(() => {
      const row = Array.from(document.querySelectorAll(${JSON.stringify(selector + ' .xterm-rows > div')})).find(row => row.textContent.includes('saved marker'));
      if (!row) throw new Error('No assistant marker row to select');
      const rect = row.getBoundingClientRect();
      return {x: Math.round(rect.left + 3), y: Math.round(rect.top + rect.height / 2), endX: Math.round(rect.left + Math.min(rect.width - 10, 390))};
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: selection.x, y: selection.y })
    for (let step = 1; step <= 12; step++) {
      window.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: Math.round(selection.x + (selection.endX - selection.x) * step / 12), y: selection.y })
      await delay(20)
    }
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: selection.endX, y: selection.y })
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] })
    copied = await until(() => clipboard.readText().includes('desktop-side-chat-42') && clipboard.readText(), 'native selection copied via OSC 52')
    await delay(2300)
    await screenshot('02-after-copy')
    const afterCopy = await text()
    await ui('window.copilotDesktop.createTab("new")')
    const other = await until(async () => (await state()).tabs.find((tab) => tab.id !== source.id && tab.id !== side.id && tab.status === 'running'), 'new session')
    await delay(1200)
    await screenshot('03-other-session')
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(side.id)})`)
    await delay(1800)
    const afterReturn = await text()
    await screenshot('04-return-to-side')
    const finalState = await state()
    const result = {
      sourceSessionId: source.lastSessionId,
      cli: finalState.resolution.version,
      copiedMarker: copied.includes('desktop-side-chat-42'),
      beforeSwitchRetained: afterCopy.includes('desktop-side-chat-42'),
      afterReturnRetained: afterReturn.includes('desktop-side-chat-42'),
      independentSessionIds: source.lastSessionId !== side.lastSessionId,
      parentStillRunning: finalState.tabs.find((tab) => tab.id === source.id)?.status === 'running',
      otherStillRunning: finalState.tabs.find((tab) => tab.id === other.id)?.status === 'running',
      activeTabIsSide: finalState.activeTabId === side.id,
    }
    result.passed = result.beforeSwitchRetained && result.afterReturnRetained && result.parentStillRunning && result.otherStillRunning && result.independentSessionIds && result.activeTabIsSide
    await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
    console.log('[clipboard-switch]', JSON.stringify(result))
    assert.ok(result.beforeSwitchRetained, 'Conversation disappeared immediately after copy')
    assert.ok(result.afterReturnRetained, 'Copy -> new session -> return lost the side conversation')
    assert.ok(result.parentStillRunning && result.otherStillRunning && result.independentSessionIds)
    console.log('[clipboard-switch] PASS: real native copy, new session, return; conversation preserved')
  } catch (error) {
    await screenshot('failure')
    throw error
  } finally {
    if (copied && clipboard.readText() === copied) clipboard.writeText(originalClipboard)
  }
  app.quit()
}
