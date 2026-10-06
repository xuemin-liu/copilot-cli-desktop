// "Attach screenshot to the prompt": the masked viewport screenshot is placed on the clipboard as an image.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-context')
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
  const { app, BrowserWindow, clipboard, nativeImage } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const site = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><title>Context fixture</title><style>body{margin:0;background:#fff}
        #shape{position:absolute;left:20px;top:20px;width:200px;height:80px;background:rgb(255,0,0)}
        #pw{position:absolute;left:20px;top:140px;width:300px;height:40px;background:rgb(0,0,255);color:rgb(0,0,255)}</style>
        <div id="shape"></div><input id="pw" type="password" value="private-password">`)
    })
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
    const window = new BrowserWindow({ show: false, width: 900, height: 700 })
    await window.loadURL('data:text/html,<title>Context host</title>')
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: join(artifacts, 'control.json') })
    const saved = await clipboard.readText()
    try {
      // Nothing to capture before a page is shown.
      await assert.rejects(browser.screenshotToClipboard(), /./)
      browser.setBounds({ x: 0, y: 0, width: 800, height: 600 }); window.showInactive()
      await browser.open(); await browser.navigate(`http://127.0.0.1:${site.address().port}/`)
      const contents = browser.view.webContents
      await until(async () => !contents.isLoading() && await contents.executeJavaScript('document.readyState') === 'complete', 'page loaded')
      await delay(500)
      await clipboard.writeText('before the screenshot')
      const result = await until(async () => { try { return await browser.screenshotToClipboard() } catch { return null } }, 'screenshot captured')
      assert.equal(result.redacted, true, 'the password field is masked')
      const items = await clipboard.read()
      const image = items.find(item => item.types.includes('image/png'))
      assert.ok(image, 'the clipboard holds a PNG image')
      const png = Buffer.from(await (await image.getType('image/png')).arrayBuffer())
      const picture = nativeImage.createFromBuffer(png)
      assert.ok(!picture.isEmpty() && picture.getSize().width > 100, 'the image has content')
      const { width, height } = picture.getSize()
      const bitmap = picture.toBitmap()
      const at = (x, y) => { const scale = width / 800; const i = (Math.round(y * scale) * width + Math.round(x * scale)) * 4; return [bitmap[i + 2], bitmap[i + 1], bitmap[i]] }
      assert.deepEqual(at(60, 60), [255, 0, 0], 'ordinary page content is captured')
      const field = at(100, 160)
      assert.ok(!(field[2] > 200 && field[0] < 50), `the password field is not captured as drawn (${field})`)
      assert.ok(height > 100)
      // A hidden surface cannot be captured safely.
      browser.action('view:console')
      await assert.rejects(browser.screenshotToClipboard(), /Page view/)
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, size: [width, height], field }, null, 2))
    } finally {
      try { await clipboard.writeText(saved) } catch { /* the clipboard may be busy */ }
      await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit()
    }
  }
}
