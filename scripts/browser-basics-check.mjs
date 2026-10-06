// Everyday browser behavior: zoom keys, find in page, F12, address suggestions and the right-click menu.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-basics')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
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
  const { app, BrowserWindow, clipboard } = await import('electron')
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
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint,
      notify: name => notices.push(name), showMenu: menu => menus.push(menu) })
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
      notices.length = 0
      key('Escape'); await until(() => browser.snapshot.find === undefined, 'Esc closes find')
      assert.ok(notices.includes('find-close'))
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
      const rightClick = async (x, y) => {
        menus.length = 0
        contents.sendInputEvent({ type: 'mouseMove', x, y }); await delay(80)
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
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
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, history }, null, 2))
    } finally { await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit() }
  }
}
