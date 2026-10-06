// Element picker: the user clicks an element in Chromium's inspect overlay and gets filtered prompt text.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-pick')
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
  const timer = setTimeout(() => child.kill(), 90000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const site = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><title>Pick fixture</title><style>body{margin:0;font:16px sans-serif}
        #save{position:absolute;left:40px;top:40px;width:160px;height:40px;color:#fff;background:#0066cc}
        #pw{position:absolute;left:40px;top:120px;width:200px;height:30px}
        #note{position:absolute;left:40px;top:180px;width:420px;height:60px}
        #link{position:absolute;left:40px;top:260px;display:block;width:300px;height:30px}
        #box{position:absolute;left:40px;top:320px;width:420px;height:90px}</style>
        <button id="save" class="primary big" data-testid="save-button">Save changes</button>
        <input id="pw" type="password" value="private-password">
        <div id="note">Authorization: Bearer private-inline-token and ghp_abcdefghijklmnopqrstuvwxyz0123456789</div>
        <a id="link" href="/next?atl_token=private-link-token&page=2">Next page</a>
        <div id="box">Visible text <input type="text" value="private-username"> <span data-private>private-marked</span> tail</div>
        <script>window.clicks = 0; document.addEventListener('click', () => window.clicks++, true)</script>`)
    })
    await new Promise(resolve => site.listen(0, resolve))
    const window = new BrowserWindow({ show: false, width: 900, height: 700 })
    await window.loadURL('data:text/html,<title>Pick host</title>')
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: join(artifacts, 'control.json') })
    try {
      browser.setBounds({ x: 0, y: 0, width: 800, height: 600 }); window.showInactive()
      await browser.open(); await browser.navigate(`http://127.0.0.1:${site.address().port}/`)
      const contents = browser.view.webContents
      await until(async () => !contents.isLoading() && await contents.executeJavaScript('document.readyState') === 'complete', 'page loaded')
      const zoom = window.webContents.getZoomFactor()
      const mouse = async (x, y, types) => {
        for (const type of types) { contents.sendInputEvent({ type, x: Math.round(x * zoom), y: Math.round(y * zoom), button: 'left', clickCount: 1 }); await delay(60) }
      }
      const pick = async (x, y) => {
        const promise = browser.pickElement()
        await until(() => browser.picking, 'picker started')
        await delay(300)
        await mouse(x, y, ['mouseMove', 'mouseDown', 'mouseUp'])
        return promise
      }
      // A normal element: selector, text, allow-listed attributes, position and styles.
      const button = await pick(100, 60)
      assert.match(button, /^\[Browser element\] <button#save\.primary\.big> on http:\/\/127\.0\.0\.1:\d+\//)
      assert.match(button, /Selector: #save\b/)
      assert.match(button, /Text: "Save changes"/)
      assert.match(button, /data-testid="save-button"/)
      assert.match(button, /Position: x=40 y=40 width=160 height=40/)
      assert.match(button, /background=rgb\(0, 102, 204\)/)
      assert.equal(await contents.executeJavaScript('window.clicks'), 0, 'selecting must not click the page')
      assert.equal(browser.picking, false)
      // Credentials and form values never reach the prompt.
      const password = await pick(100, 135)
      assert.match(password, /Text: "\[redacted form control\]"/)
      assert.doesNotMatch(password, /private-password/)
      const note = await pick(100, 200)
      assert.doesNotMatch(note, /private-inline-token|ghp_abcdefghijklmnopqrstuvwxyz0123456789/)
      assert.match(note, /\[redacted\]/)
      const link = await pick(100, 275)
      assert.match(link, /Text: "Next page"/)
      assert.match(link, /href="[^"]*page=2/)
      assert.doesNotMatch(link, /private-link-token/)
      const box = await pick(430, 365)
      assert.match(box, /Text: "Visible text tail"/)
      assert.doesNotMatch(box, /private-username|private-marked/)
      // Esc and the cancel call end the selection without a result.
      let started = browser.pickElement()
      await until(() => browser.picking, 'second picker started')
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      assert.equal(await started, null)
      started = browser.pickElement()
      await until(() => browser.picking, 'third picker started')
      browser.cancelPick()
      assert.equal(await started, null)
      // Leaving the Page view cancels it, and a second request while one is running is rejected.
      started = browser.pickElement()
      await until(() => browser.picking, 'fourth picker started')
      await assert.rejects(browser.pickElement(), /in progress/)
      browser.action('view:console')
      assert.equal(await started, null)
      await assert.rejects(browser.pickElement(), /Page view/)
      browser.action('view:page')
      // The inspect overlay is gone afterwards: a real click reaches the page again.
      await mouse(100, 60, ['mouseMove', 'mouseDown', 'mouseUp'])
      await until(async () => await contents.executeJavaScript('window.clicks') === 1, 'click reaches the page after picking')
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, button, password, note, link, box }, null, 2))
    } finally { await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit() }
  }
}
