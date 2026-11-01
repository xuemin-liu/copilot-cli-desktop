// Everyday browser behavior: zoom keys, find in page, F12, address suggestions, the right-click menu and popup windows.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-basics')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// Longer than the 5 s a click lets a page open a popup window.
const ACTIVATION_WAIT = 5200
const until = async (read, name) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100) }
  throw new Error(`Timed out: ${name}`)
}
if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), '{"passed":false}')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 120000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BaseWindow, BrowserWindow, clipboard, screen, webContents } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const site = createServer((request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><title>${request.url}</title><style>body{margin:0;font:16px sans-serif}
        #link{position:absolute;left:20px;top:20px;width:260px;height:30px;display:block}
        #text{position:absolute;left:20px;top:80px;width:400px}
        #field{position:absolute;left:20px;top:140px;width:300px;height:30px}</style>
        <a id="link" href="/linked">Linked page</a>
        <p id="text">hello world, hello again</p><input id="field" value="editable">`)
    })
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${site.address().port}`
    const window = new BrowserWindow({ show: false, width: 900, height: 700 })
    await window.loadURL('data:text/html,<title>Basics host</title>')
    const endpoint = join(artifacts, 'control.json')
    const notices = []
    const menus = []
    const menuWindows = []
    const leaveAnswers = []
    const leaveWindows = []
    const appShortcuts = []
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint,
      notify: name => notices.push(name), onAppShortcut: name => appShortcuts.push(name), showMenu: (menu, owner) => { menus.push(menu); menuWindows.push(owner) },
      confirmLeave: async owner => { leaveWindows.push(owner); return leaveAnswers.shift() ?? false } })
    try {
      browser.setBounds({ x: 0, y: 0, width: 800, height: 600 }); window.showInactive()
      await browser.open()
      await browser.navigate(`${base}/start?token=private-token`)
      const contents = browser.view.webContents
      const loaded = async () => until(async () => !contents.isLoading() && await contents.executeJavaScript('document.readyState') === 'complete', 'page loaded')
      await loaded()
      const key = (keyCode, modifiers = []) => { contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }) }
      const zoom = () => Math.round(contents.getZoomFactor() * 100)

      // Zoom keys work although the page has no application menu.
      assert.equal(zoom(), 100)
      key('=', ['control']); await until(() => zoom() === 110, 'zoom in')
      key('=', ['control']); await until(() => zoom() === 125, 'zoom in again')
      key('-', ['control']); await until(() => zoom() === 110, 'zoom out')
      key('0', ['control']); await until(() => zoom() === 100, 'zoom reset')
      browser.action('zoom-in'); assert.equal(zoom(), 110)
      browser.action('zoom-reset'); assert.equal(zoom(), 100)

      // Find: counts matches, steps through them in both directions, and Esc closes it.
      key('f', ['control']); await until(() => notices.includes('find'), 'Ctrl+F asks the pane to open find')
      browser.find('hello')
      let found = await until(() => browser.snapshot.find?.matches === 2 && browser.snapshot.find, 'two matches')
      assert.deepEqual([found.query, found.matches, found.active], ['hello', 2, 1])
      browser.find('hello', true, true)
      await until(() => browser.snapshot.find?.active === 2, 'next match')
      browser.find('hello', false, true)
      await until(() => browser.snapshot.find?.active === 1, 'previous match')
      key('F3'); await until(() => browser.snapshot.find?.active === 2, 'F3 steps to the next match')
      browser.find('absent')
      found = await until(() => browser.snapshot.find?.query === 'absent' && browser.snapshot.find, 'new query')
      await delay(300)
      assert.equal(browser.snapshot.find.matches, 0)
      browser.find('hello')
      await until(() => browser.snapshot.find?.matches === 2, 'matches again')
      // Ctrl+Shift+G belongs to the app even while a search is open: it toggles the Git panel and leaves the search alone.
      // (Find-next is Ctrl+G and F3; find-previous is Shift+F3.)
      appShortcuts.length = 0
      const activeBefore = browser.snapshot.find.active
      key('g', ['control', 'shift']); await until(() => appShortcuts.length === 1, 'Ctrl+Shift+G asks the app to toggle the Git panel during a search')
      assert.equal(browser.snapshot.find.active, activeBefore, 'the search did not move')
      appShortcuts.length = 0
      notices.length = 0
      key('Escape'); await until(() => browser.snapshot.find === undefined, 'Esc closes find')
      assert.ok(notices.includes('find-close'))
      // And with no search open.
      key('g', ['control', 'shift']); await until(() => appShortcuts.length === 1, 'Ctrl+Shift+G asks the app to toggle the Git panel')
      assert.deepEqual(appShortcuts, ['git-toggle'])
      browser.find('hello'); await until(() => browser.snapshot.find?.matches === 2, 'find before navigating')
      await browser.navigate(`${base}/second`); await loaded()
      assert.equal(browser.snapshot.find, undefined, 'navigating ends the search')

      // A search belongs to the page it was run on: switching, opening or closing pages ends it.
      browser.find('hello'); await until(() => browser.snapshot.find?.matches === 2, 'find before switching')
      notices.length = 0
      browser.action('new-page')
      assert.equal(browser.snapshot.find, undefined, 'opening a page ends the search')
      assert.ok(notices.includes('find-close'))
      const first = browser.snapshot.pages[0].id
      browser.action(`select-page:${first}`); await delay(200)
      assert.equal(browser.snapshot.find, undefined)
      browser.find('hello'); await until(() => browser.snapshot.find?.matches === 2, 'find on the first page')
      browser.action(`select-page:${browser.snapshot.pages[1].id}`)
      assert.equal(browser.snapshot.find, undefined, 'selecting another page ends the search')
      browser.find('anything')
      browser.action(`close-page:${browser.snapshot.pages[1].id}`)
      await until(() => browser.snapshot.pages.length === 1, 'second page closed')
      assert.equal(browser.snapshot.find, undefined, 'closing the searched page ends the search')
      assert.equal(browser.snapshot.activePageId, first)

      // F12 and Ctrl+Shift+I toggle DevTools.
      key('F12'); await until(() => browser.snapshot.view === 'devtools', 'F12 opens DevTools')
      key('F12'); await until(() => browser.snapshot.view === 'page', 'F12 closes DevTools')
      key('i', ['control', 'shift']); await until(() => browser.snapshot.view === 'devtools', 'Ctrl+Shift+I opens DevTools')
      browser.action('view:page')

      // Address suggestions: newest first, no duplicates, nothing with a query secret or fragment.
      await browser.navigate(`${base}/third?page=2`); await loaded()
      await browser.navigate(`${base}/second`); await loaded()
      await browser.navigate(`${base}/secret?access_token=private-token`); await loaded()
      await browser.navigate(`${base}/fragment#section`); await loaded()
      await browser.navigate(`${base}/second`); await loaded()
      const history = browser.snapshot.history
      assert.equal(history[0], `${base}/second`)
      assert.deepEqual(history.filter(address => address === `${base}/second`).length, 1)
      assert.ok(history.includes(`${base}/third`) && history.includes(`${base}/start`) === false, history.join(' '))
      assert.ok(!history.some(address => /private-token|secret|fragment|section|page=2/.test(address)), history.join(' '))
      const control = JSON.parse(await readFile(endpoint, 'utf8'))
      const status = await (await fetch(`http://127.0.0.1:${control.port}/status`, { headers: { authorization: `Bearer ${control.token}` } })).json()
      assert.ok(!('history' in status) && !('find' in status), 'the control server does not expose history or the search text')

      // Right-click menu: what it offers depends on what was clicked, and its entries work.
      const rightClick = async (x, y, target = contents) => {
        menus.length = 0; menuWindows.length = 0
        target.sendInputEvent({ type: 'mouseMove', x, y }); await delay(80)
        target.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
        target.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
        return until(() => menus[0], 'context menu')
      }
      const labels = menu => menu.items.filter(item => item.type !== 'separator').map(item => item.label)
      const choose = (menu, label) => menu.items.find(item => item.label === label).click()
      await browser.navigate(`${base}/menu`); await loaded()
      let menu = await rightClick(60, 35)
      assert.deepEqual(labels(menu).slice(0, 2), ['Open link in new page', 'Copy link address'])
      await clipboard.writeText('before')
      choose(menu, 'Copy link address')
      await until(async () => await clipboard.readText() === `${base}/linked`, 'link address copied')
      choose(menu, 'Open link in new page')
      await until(() => browser.snapshot.pages.length === 2 && browser.snapshot.pages.at(-1).url === `${base}/linked`, 'link opened in a new page')
      assert.equal(browser.snapshot.activePageId, browser.snapshot.pages.at(-1).id)
      browser.action(`close-page:${browser.snapshot.activePageId}`)
      await until(() => browser.snapshot.pages.length === 1, 'new page closed')
      menu = await rightClick(60, 100)
      assert.deepEqual(labels(menu), ['Back', 'Forward', 'Reload', 'Hard reload (bypass cache)', 'Select all', 'Inspect element'])
      assert.equal(menu.items.find(item => item.label === 'Back').enabled, true)
      assert.equal(menu.items.find(item => item.label === 'Forward').enabled, false)
      choose(menu, 'Back'); await until(() => browser.snapshot.url.endsWith('/fragment') || browser.snapshot.url.includes('/second'), 'Back navigates')
      await browser.navigate(`${base}/menu`); await loaded()
      menu = await rightClick(60, 155)
      assert.deepEqual(labels(menu).slice(0, 4), ['Cut', 'Copy', 'Paste', 'Select all'])
      menu = await rightClick(60, 100)
      // Inspect element reaches the page both when DevTools opens for the first time and when it is reused from the Page view.
      const inspected = []
      const original = contents.inspectElement.bind(contents)
      contents.inspectElement = (x, y) => { inspected.push([x, y]); return original(x, y) }
      choose(menu, 'Inspect element')
      await until(() => browser.snapshot.view === 'devtools', 'Inspect element opens DevTools')
      await until(() => inspected.length === 1, 'first Inspect element reaches the page')
      browser.action('view:page')
      menu = await rightClick(60, 100)
      choose(menu, 'Inspect element')
      await until(() => browser.snapshot.view === 'devtools', 'Inspect element reopens DevTools')
      await until(() => inspected.length === 2, 'Inspect element works when the DevTools view is reused')
      browser.action('devtools')
      menu = await rightClick(60, 100)
      choose(menu, 'Inspect element')
      await until(() => inspected.length === 3, 'Inspect element works while DevTools is already showing')
      browser.action('view:page')

      // A sized window.open opens a popup window, as in Chrome, while the browser keeps showing the page that opened it.
      await browser.navigate(`${base}/opener`); await loaded()
      const opener = browser.snapshot.activePageId
      const popupWindows = () => BaseWindow.getAllWindows().filter(owner => owner !== window && !owner.isDestroyed())
      // A click on an empty part of the opener: only input in the page lets it open a popup window.
      const click = async (target = contents) => {
        target.sendInputEvent({ type: 'mouseDown', x: 500, y: 300, button: 'left', clickCount: 1 })
        target.sendInputEvent({ type: 'mouseUp', x: 500, y: 300, button: 'left', clickCount: 1 })
        await delay(100)
      }
      const openPopup = async (path, features = 'width=420,height=360') => {
        await click()
        await contents.executeJavaScript(`window.popup = window.open(${JSON.stringify(path)}, 'popup', ${JSON.stringify(features)}); void 0`)
        const entry = await until(() => browser.snapshot.pages.find(page => page.window), 'popup window page')
        const popup = webContents.fromId(entry.id)
        await until(async () => !popup.isLoading() && await popup.executeJavaScript('document.readyState') === 'complete', 'popup loaded')
        return { entry, popup, owner: await until(() => popupWindows()[0], 'popup window') }
      }
      let { entry, popup, owner } = await openPopup('/popup')
      assert.equal(browser.snapshot.activePageId, opener, 'the browser keeps showing the opener')
      assert.ok(contents.getURL().endsWith('/opener') && browser.view.getVisible(), 'the opener stays visible in the browser')
      assert.equal(popup.getURL(), `${base}/popup`)
      assert.equal(BrowserWindow.getAllWindows().includes(owner), false, 'a popup window is not an app window')
      const [popupWidth, popupHeight] = owner.getContentSize()
      const viewport = await popup.executeJavaScript("[innerWidth, innerHeight]")
      assert.ok(Math.abs(viewport[0] - 420) <= 2 && Math.abs(viewport[1] - 360) <= 2, `popup viewport sized as asked: ${viewport} (window content ${popupWidth}x${popupHeight})`)
      assert.ok(owner.contentView.children[0].getVisible())
      await until(() => owner.getTitle() === '/popup', 'popup window follows its page title')
      assert.equal(await contents.executeJavaScript('Boolean(window.popup && !window.popup.closed)'), true, 'the opener keeps its popup reference')
      // The last tab stays even while a popup window is open.
      browser.action(`close-page:${opener}`); await delay(200)
      assert.equal(browser.snapshot.pages.length, 2)
      // Selecting the popup shows its toolbar state and DevTools in the browser; the page itself stays in its window.
      browser.action(`select-page:${entry.id}`)
      assert.ok(browser.snapshot.url.endsWith('/popup'))
      assert.equal(browser.pages.get(opener).view.getVisible(), false, 'the opener tab hides while the popup is selected')
      assert.ok(owner.contentView.children[0].getVisible(), 'the popup page stays in its window')
      browser.action('view:devtools')
      await until(() => popup.devToolsWebContents, 'popup DevTools')
      browser.action('view:page')
      // The right-click menu shows in the popup window and acts on the popup even when the browser shows another page.
      browser.action(`select-page:${opener}`)
      menu = await rightClick(60, 100, popup)
      assert.equal(menuWindows[0], owner, 'the menu opens in the popup window')
      // Closing a selected popup selects its opener again.
      browser.action(`select-page:${entry.id}`)
      owner.close()
      await until(() => popup.isDestroyed() && browser.snapshot.pages.length === 1, 'closing the window closes its page')
      assert.equal(browser.snapshot.activePageId, opener)
      // window.close() from the opener, and Ctrl+W in the popup, close the window.
      ;({ popup, owner } = await openPopup('/scripted'))
      await contents.executeJavaScript('window.popup.close()')
      await until(() => owner.isDestroyed() && browser.snapshot.pages.length === 1, 'window.close closes the popup window')
      ;({ popup, owner } = await openPopup('/keyed'))
      popup.sendInputEvent({ type: 'keyDown', keyCode: 'w', modifiers: ['control'] })
      await until(() => owner.isDestroyed() && browser.snapshot.pages.length === 1, 'Ctrl+W closes the popup window')
      // A popup with unsaved edits can keep its window: closing it asks the page first, and the answer decides.
      ;({ popup, owner } = await openPopup('/guarded'))
      popup.sendInputEvent({ type: 'mouseDown', x: 60, y: 155, button: 'left', clickCount: 1 })
      popup.sendInputEvent({ type: 'mouseUp', x: 60, y: 155, button: 'left', clickCount: 1 })
      popup.sendInputEvent({ type: 'char', keyCode: 'x' })
      await popup.executeJavaScript(`window.unloads = 0; addEventListener('beforeunload', event => { window.unloads++; event.preventDefault(); event.returnValue = '' }); void 0`)
      const guarded = async (close, name) => {
        const asked = leaveWindows.length
        close()
        await until(() => leaveWindows.length === asked + 1, `${name} asks whether to leave`)
        assert.equal(leaveWindows.at(-1), owner, `${name}: the question is asked on the popup window`)
        await delay(300)
        assert.ok(!owner.isDestroyed() && !popup.isDestroyed(), `${name}: Cancel keeps the popup window`)
      }
      await guarded(() => owner.close(), 'closing the window')
      await guarded(() => popup.sendInputEvent({ type: 'keyDown', keyCode: 'w', modifiers: ['control'] }), 'Ctrl+W')
      assert.equal(await popup.executeJavaScript('window.unloads'), 2, 'each close ran the page guard')
      leaveAnswers.push(true)
      owner.close()
      await until(() => owner.isDestroyed() && popup.isDestroyed() && browser.snapshot.pages.length === 1, 'Leave closes the popup window')
      // Without a click or key press, a page asking for windows gets tabs, as Chrome's popup blocker would not open them.
      await delay(ACTIVATION_WAIT)
      await contents.executeJavaScript(`for (let i = 0; i < 3; i++) window.open('/unasked?' + i, 'unasked' + i, 'width=300,height=200'); void 0`)
      await until(() => browser.snapshot.pages.length === 4, 'unasked popups open')
      assert.equal(browser.snapshot.pages.filter(page => page.window).length, 0, 'no click, no popup window')
      assert.equal(popupWindows().length, 0)
      for (const page of browser.snapshot.pages.slice(1)) browser.action(`close-page:${page.id}`)
      await until(() => browser.snapshot.pages.length === 1, 'unasked tabs closed')
      browser.action(`select-page:${opener}`)
      // One click buys one window.
      await click()
      await contents.executeJavaScript(`window.open('/first', 'first', 'width=300,height=200'); window.open('/second', 'second', 'width=300,height=200'); void 0`)
      await until(() => browser.snapshot.pages.length === 3, 'two popups from one click')
      assert.equal(browser.snapshot.pages.filter(page => page.window).length, 1, 'one click opens one popup window')
      for (const page of browser.snapshot.pages.filter(page => page.id !== opener)) browser.action(`close-page:${page.id}`)
      await until(() => browser.snapshot.pages.length === 1 && popupWindows().length === 0, 'popups from one click closed')
      browser.action(`select-page:${opener}`)
      // A window asked for far off-screen stays whole in the work area of the opener's display.
      ;({ popup, owner } = await openPopup('/far', 'width=300,height=200,left=-20000,top=-20000'))
      const area = screen.getDisplayMatching(window.getBounds()).workArea
      const far = owner.getBounds()
      assert.ok(far.x >= area.x && far.y >= area.y && far.x + far.width <= area.x + area.width && far.y + far.height <= area.y + area.height,
        `off-screen request kept on screen: ${JSON.stringify(far)} in ${JSON.stringify(area)}`)
      owner.close()
      await until(() => owner.isDestroyed() && browser.snapshot.pages.length === 1, 'far popup closed')
      // Closing the browser closes its popup windows.
      ;({ popup, owner } = await openPopup('/left-open'))
      const popupStatus = await (await fetch(`http://127.0.0.1:${control.port}/status`, { headers: { authorization: `Bearer ${control.token}` } })).json()
      assert.ok(popupStatus.pages.some(page => page.window), 'the CLI sees which page is in its own window')
      await browser.dispose()
      await until(() => owner.isDestroyed(), 'disposing the browser closes its popup windows')
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, history }, null, 2))
    } finally { await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit() }
  }
}
