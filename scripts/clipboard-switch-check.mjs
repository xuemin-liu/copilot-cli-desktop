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
  const multiClick = process.env.DESKTOP_UI_COPY_MULTI_CLICK === '1'
  const statusCheck = process.env.DESKTOP_UI_COPY_STATUS === '1'
  let copyStatusComparison
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
    if (multiClick) {
      // Copilot still owns a selection after these clicks, but the desktop
      // used to forget it and silently reject the Ctrl+C clipboard response.
      for (const clickCount of [1, 2]) {
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount, x: selection.x + 100, y: selection.y })
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount, x: selection.x + 100, y: selection.y })
        await delay(60)
      }
    }
    await delay(300)
    await screenshot('01-selected')
    // Exercise a physical modifier sequence, not just C with a modifier bit.
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' })
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' })
    copied = await until(() => clipboard.readText() !== originalClipboard && clipboard.readText().includes('desktop-side-chat-42') && clipboard.readText(), 'native selection copied via OSC 52')
    const readCopyStatus = () => ui(`(() => {
      const pane = document.querySelector(${JSON.stringify(selector)});
      const overlay = pane.querySelector('.terminal-copy-status-visible');
      const row = Array.from(pane.querySelectorAll('.xterm-rows > div')).find(row => row.textContent.trim().startsWith('copied to clipboard'));
      const element = overlay || row;
      if (!element) return null;
      const text = overlay || Array.from(row.querySelectorAll('span')).find(span => span.textContent.includes('copied')) || row;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(text);
      return {overlay: !!overlay, top: rect.top, left: rect.left, width: rect.width, height: rect.height, color: style.color, fontSize: style.fontSize, lineHeight: style.lineHeight};
    })()`)
    if (statusCheck) {
      const first = await until(readCopyStatus, 'first copy status visible')
      await writeFile(join(artifacts, 'copy-status.json'), JSON.stringify({first}, null, 2))
      await screenshot('02-first-copy-status')
      await delay(2300)
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: selection.x, y: selection.y })
      for (let step = 1; step <= 12; step++) {
        window.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: Math.round(selection.x + (selection.endX - selection.x) * step / 12), y: selection.y })
        await delay(20)
      }
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: selection.endX, y: selection.y })
      await delay(300)
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, x: selection.x + 100, y: selection.y })
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, x: selection.x + 100, y: selection.y })
      const second = await until(readCopyStatus, 'second copy status visible')
      await screenshot('02-second-copy-status')
      copyStatusComparison = {first, second}
      await writeFile(join(artifacts, 'copy-status.json'), JSON.stringify(copyStatusComparison, null, 2))
      console.log('[clipboard-status]', JSON.stringify(copyStatusComparison))
      assert.equal(first.color, second.color, 'First-copy confirmation color differs from native status')
      assert.equal(first.fontSize, second.fontSize, 'First-copy confirmation font size differs from native status')
      assert.ok(Math.abs(first.top - second.top) <= 1, 'First-copy confirmation is not aligned to the native row')
      assert.ok(Math.abs(first.left - second.left) <= 1, 'First-copy confirmation is not aligned horizontally')
      assert.ok(Math.abs(first.width - second.width) <= 1, 'First-copy confirmation does not cover the native row width')
      assert.ok(Math.abs(first.height - second.height) <= 1, 'First-copy confirmation does not cover the full native row')
    }
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
      selectionGesture: multiClick ? 'drag-then-double-click' : 'drag',
      copiedMarker: copied.includes('desktop-side-chat-42'),
      ...(copyStatusComparison ? {copyStatusComparison} : {}),
      beforeSwitchRetained: afterCopy.includes('desktop-side-chat-42'),
      afterReturnRetained: afterReturn.includes('desktop-side-chat-42'),
      independentSessionIds: source.lastSessionId !== side.lastSessionId,
      parentStillRunning: finalState.tabs.find((tab) => tab.id === source.id)?.status === 'running',
      otherStillRunning: finalState.tabs.find((tab) => tab.id === other.id)?.status === 'running',
      activeTabIsSide: finalState.activeTabId === side.id,
    }
    result.passed = result.copiedMarker && result.beforeSwitchRetained && result.afterReturnRetained && result.parentStillRunning && result.otherStillRunning && result.independentSessionIds && result.activeTabIsSide
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
