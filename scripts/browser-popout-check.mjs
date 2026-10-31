// Production Electron + live CLI: a session's browser alone moves to its own window and back, with the same pages.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { ui } from './check-helpers.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label) {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) { const result = await action(); if (result) { console.log(`[browser-popout] ${label}`); return result }; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
export async function runBrowserPopoutCheck() {
  await app.whenReady()
  const page = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Popout page</title><h1>browser-popout-page</h1>')
  })
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve))
  const pageUrl = `http://127.0.0.1:${page.address().port}/popout`
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'main window')
  const state = (window = main) => ui(window, 'window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async (window, name) => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  const windowFor = async (id, key) => until(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window === main || window.isDestroyed() || !window.webContents.getURL().endsWith('/index.html')) continue
      if ((await state(window))[key] === id) return window
    }
  }, key)
  const click = (window, selector) => ui(window, `setTimeout(() => document.querySelector(${JSON.stringify(selector)}).click(), 50); true`)
  const mainBrowserShown = () => ui(main, `document.querySelector('.session-pane-visible .browser-panel') !== null`)
  const pageViews = window => window.contentView.children.length
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const source = await until(async () => (await state()).tabs.find(tab => tab.status === 'running' && tab.activity === 'idle'), 'session idle')
    const id = JSON.stringify(source.id)
    await until(async () => (await ui(main, `window.copilotDesktop.getTabBacklog(${id})`)).includes('open sidebar'), 'CLI input prompt ready')
    await click(main, '.session-pane-visible .session-browser-toggle')
    await until(mainBrowserShown, 'browser beside terminal')
    await ui(main, `window.copilotDesktop.browserNavigate(${id}, ${JSON.stringify(pageUrl)})`)
    await until(async () => (await ui(main, `window.copilotDesktop.browserState(${id})`)).url === pageUrl, 'page loaded')
    const mainViewsDocked = pageViews(main)
    assert.ok(mainViewsDocked >= 1, 'the page view is in the main window')
    const terminalWidth = () => ui(main, `document.querySelector('.session-pane-visible .browser-terminal-workspace').getBoundingClientRect().width`)
    const splitWidth = await terminalWidth()

    const popOut = async how => {
      if (how === 'button') await click(main, '.session-pane-visible button[title="Open browser in new window"]')
      else await ui(main, `window.copilotDesktop.popOutBrowser(${id})`)
      const window = await windowFor(source.id, 'windowBrowserId')
      await until(() => ui(window, `document.querySelector('.browser-only-window .browser-panel') !== null`), 'browser window panel')
      await until(async () => !(await mainBrowserShown()), 'main pane gives the browser up')
      return window
    }
    const returned = async (window, label) => {
      await until(() => window.isDestroyed(), label)
      await until(mainBrowserShown, `${label}: browser beside terminal again`)
      assert.equal(pageViews(main), mainViewsDocked, `${label}: page view back in the main window`)
      assert.equal((await ui(main, `window.copilotDesktop.browserState(${id})`)).url, pageUrl, `${label}: same page`)
      assert.deepEqual((await state()).browserPoppedOutTabIds, [])
    }

    const popout = await popOut('button')
    assert.equal(popout.getTitle(), `${source.title} — Browser — Copilot CLI Desktop`)
    assert.deepEqual((await state()).browserPoppedOutTabIds, [source.id])
    assert.ok(pageViews(popout) >= 1, 'page view moved to the browser window')
    assert.ok(pageViews(main) < mainViewsDocked, 'page view left the main window')
    assert.equal((await ui(popout, `window.copilotDesktop.browserState(${id})`)).url, pageUrl, 'same page in the browser window')
    await assert.rejects(ui(main, `window.copilotDesktop.browserState(${id})`), /owning session window/, 'only the browser window drives the browser')
    await until(async () => await terminalWidth() > splitWidth + 100, 'terminal takes the full width')
    assert.ok(await ui(main, `document.querySelector('.session-pane-visible .xterm-screen') !== null`), 'terminal stays in the main window')
    // Duplicate requests focus the same window.
    await ui(main, `window.copilotDesktop.popOutBrowser(${id})`)
    assert.equal(BrowserWindow.getAllWindows().filter(window => window !== main && !window.isDestroyed()).length, 1)
    // Add to prompt from the browser window lands in the terminal in the main window; other windows cannot use this path.
    assert.equal(await ui(popout, `window.copilotDesktop.browserInsertPrompt(${id}, { text: 'browser-popout-marker' })`), true)
    await until(() => ui(main, `document.querySelector('.session-pane-visible .xterm-rows')?.textContent.includes('browser-popout-marker')`), 'prompt insert relayed to the terminal')
    assert.equal(await ui(main, `window.copilotDesktop.browserInsertPrompt(${id}, { text: 'not allowed' })`), false)
    await ui(main, `window.copilotDesktop.writeTab(${id}, '\\u0015')`)
    await screenshot(popout, '01-browser-window')
    await screenshot(main, '02-main-full-terminal')

    await click(popout, '.browser-only-window .session-pane-header button')
    await returned(popout, 'return button in browser window')

    const second = await popOut('api')
    await click(main, '.session-pane-visible button[title="Bring browser back to this window"]')
    await returned(second, 'bring-back button in session')

    const third = await popOut('api')
    third.close()
    await returned(third, 'native close')

    const fourth = await popOut('api')
    const modifier = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'
    await ui(fourth, `setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ${modifier}: true, bubbles: true, cancelable: true })), 50); true`)
    await returned(fourth, 'Ctrl+W')

    // Popping out the whole session leaves a popped-out browser where it is; the browser then returns to the session window.
    const fifth = await popOut('api')
    await ui(main, `window.copilotDesktop.popOutTab(${id})`)
    const sessionWindow = await windowFor(source.id, 'windowSessionId')
    await until(() => ui(sessionWindow, `document.querySelector('.session-window .xterm-screen') !== null`), 'session window terminal')
    assert.ok(pageViews(fifth) >= 1, 'browser stays in its own window')
    assert.equal(await ui(sessionWindow, `document.querySelector('.session-window .browser-panel') === null`), true)
    await click(sessionWindow, '.session-window button[title="Bring browser back to this window"]')
    await until(() => fifth.isDestroyed(), 'browser returns to the session window')
    await until(() => ui(sessionWindow, `document.querySelector('.session-window .browser-panel') !== null`), 'browser beside the session window terminal')
    assert.equal((await ui(sessionWindow, `window.copilotDesktop.browserState(${id})`)).url, pageUrl)
    await screenshot(sessionWindow, '03-session-window-returned')
    await ui(sessionWindow, `setTimeout(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Return to main window').click(), 50); true`)
    await until(() => sessionWindow.isDestroyed(), 'session returned')
    await until(mainBrowserShown, 'browser beside the main terminal after the session returns')

    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: source.lastSessionId, checks: ['page view moves window', 'same page', 'single owner', 'full-width terminal', 'duplicate focuses', 'prompt insert relay', 'return button', 'bring-back button', 'native close', 'Ctrl+W', 'session pop-out keeps browser window'] }, null, 2))
    console.log('[browser-popout] PASS: browser moves to its own window and back, same pages')
  } catch (error) {
    for (const [index, window] of BrowserWindow.getAllWindows().entries()) await screenshot(window, `failure-${index}`).catch(() => {})
    throw error
  } finally { page.close(); app.quit() }
}
