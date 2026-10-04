// Isolated real Electron/Chromium check; no model or external website requests.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-debug')
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (read, label) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
const capture = async (contents, label) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await contents.capturePage() }
    catch (error) {
      if (attempt === 2) throw new Error(`Could not capture ${label}`, { cause: error })
      await delay(300)
    }
  }
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const { build } = await import('esbuild')
  await build({ stdin: { contents: `
    import { createRoot } from 'react-dom/client';
    import { useState } from 'react';
    import { BrowserWorkspace } from './src/renderer/components/BrowserWorkspace';
    import './src/renderer/styles.css';
    window.unhandled = [];
    window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason)));
    function Fixture() {
      const [obscured, setObscured] = useState(false);
      window.setObscured = setObscured;
      return <BrowserWorkspace obscured={obscured}><div data-terminal>Terminal fixture</div></BrowserWorkspace>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(artifacts, 'fixture.js'), platform: 'browser', jsx: 'automatic' })
  await writeFile(join(artifacts, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root" style="display:flex;height:100vh"><script src="fixture.js"></script></div></body></html>')
  const env = { ...process.env, COPILOT_DESKTOP_BROWSER_STATE: join(artifacts, 'control.json') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 90000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Browser debug check failed')
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  // Background test windows still need compositor surfaces for screenshot QA.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserCommand } = await import('../dist/src/cli/browser-control.js')
    let slowSeen = false
    const site = createServer((request, response) => {
      if (request.url === '/slow') { slowSeen = true; return }
      if (request.url.startsWith('/secret?')) {
        response.writeHead(200, { 'X-Auth-Token': 'response-secret', location: '/callback?code=location-secret',
          link: '</next?token=link-secret>; rel="next"', 'content-type': 'application/json' })
        response.end('{}'); return
      }
      if (request.url === '/redirect-secret') { response.writeHead(302, { location: '/landing?code=redirect-secret#fragment-secret' }); response.end(); return }
      if (request.url === '/api.json') { response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'test-secret=1' }); response.end('{"version":"server"}'); return }
      if (request.url === '/fail') { response.writeHead(500); response.end('fixture failure'); return }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><h1>Browser debug fixture</h1><script>console.log("fixture console"); fetch("/api.json"); fetch("/fail"); setTimeout(() => { throw new Error("fixture exception") }, 50)</script>')
    })
    await new Promise(accept => site.listen(0, '127.0.0.1', accept))
    const url = `http://127.0.0.1:${site.address().port}/`
    const window = new BrowserWindow({ width: 1400, height: 960, show: false, webPreferences: {
      preload: resolve('src/preload/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    } })
    const browser = new BrowserDebug(window, join(artifacts, 'settings.json'))
    const trusted = event => { assert.equal(event.sender.id, window.webContents.id) }
    ipcMain.handle('desktop:browser-open', event => { trusted(event); return browser.open() })
    ipcMain.handle('desktop:browser-state', event => { trusted(event); return browser.snapshot })
    ipcMain.handle('desktop:browser-navigate', (event, value) => { trusted(event); return browser.navigate(value) })
    ipcMain.handle('desktop:browser-action', (event, action) => { trusted(event); return browser.action(action) })
    ipcMain.handle('desktop:browser-bounds', (event, bounds) => { trusted(event); browser.setBounds(bounds) })
    const ui = code => window.webContents.executeJavaScript(code)
    try {
      window.showInactive()
      await window.loadFile(join(artifacts, 'index.html'))
      await until(() => ui('document.querySelector(".browser-workspace-toolbar button")'), 'open button')
      await ui('document.querySelector(".browser-workspace-toolbar button").click()')
      await until(() => ui('Boolean(document.querySelector(".browser-panel"))'), 'browser pane')
      await ui(`window.copilotDesktop.browserNavigate(${JSON.stringify(url)})`)
      await until(() => browser.snapshot.console.some(entry => entry.message.includes('fixture exception')), 'exception capture')
      await until(() => browser.snapshot.network.some(entry => entry.url.endsWith('/fail') && entry.status === 500 && entry.durationMs !== null), 'failed API request')
      assert.equal(await browser.view.webContents.executeJavaScript('typeof window.copilotDesktop'), 'undefined')
      assert.equal(await browser.view.webContents.executeJavaScript('typeof require'), 'undefined')
      await assert.rejects(browser.navigate('file:///C:/Windows/win.ini'), /HTTP or HTTPS/)
      const network = await browserCommand(['network'])
      const api = network.find(entry => entry.url.endsWith('/api.json'))
      assert.ok(api)
      assert.deepEqual(api.responseHeaders['Set-Cookie'] ?? api.responseHeaders['set-cookie'], ['[redacted]'])
      assert.equal((await browserCommand(['request', api.id])).id, api.id)
      assert.ok((await browserCommand(['console'])).some(entry => entry.message.includes('fixture console')))
      await assert.rejects(browserCommand(['request', 'invalid']), /Usage/)
      const endpoint = JSON.parse(await readFile(process.env.COPILOT_DESKTOP_BROWSER_STATE, 'utf8'))
      const apiUrl = `http://127.0.0.1:${endpoint.port}/status`
      assert.equal((await fetch(apiUrl)).status, 401)
      assert.equal((await fetch(apiUrl, { headers: { authorization: `Bearer ${endpoint.token}`, origin: url } })).status, 403)
      assert.equal((await fetch(apiUrl, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` } })).status, 405)
      const cli = spawn('node', [resolve('dist/src/cli/cli.js'), 'browser', 'status'], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; let errors = ''
      cli.stdout.on('data', chunk => { output += chunk }); cli.stderr.on('data', chunk => { errors += chunk })
      assert.equal(await new Promise((accept, reject) => { cli.once('error', reject); cli.once('exit', accept) }), 0, errors)
      assert.equal(JSON.parse(output).url, url)
      // Exercise the actual capture -> loopback -> CLI paths, with distinct
      // credential sentinels and legitimate request/console controls above.
      await browser.view.webContents.executeJavaScript(`(async () => {
        console.log('x-api-key=console-secret', ${JSON.stringify(`${url}?token=console-url-secret`)});
        await fetch('/secret?access_token=network-secret', {headers: {'X-API-Key': 'request-secret'}});
        await fetch('/redirect-secret');
      })()`)
      await until(() => browser.snapshot.network.some(entry => entry.redirects.length), 'redirect capture')
      const telemetry = JSON.stringify([await browserCommand(['console']), await browserCommand(['network'])])
      for (const secret of ['console-secret', 'console-url-secret', 'network-secret', 'request-secret',
        'response-secret', 'location-secret', 'link-secret', 'redirect-secret', 'fragment-secret']) {
        // The route name /redirect-secret remains ordinary diagnostic routing.
        if (secret === 'redirect-secret') assert.ok(!telemetry.includes('code=redirect-secret'))
        else assert.ok(!telemetry.includes(secret), secret)
      }
      const secretRequest = (await browserCommand(['network'])).find(entry => entry.url.includes('/secret?'))
      assert.ok(!JSON.stringify(await browserCommand(['request', secretRequest.id])).includes('network-secret'))
      await browser.navigate(`${url}?q=ordinary`)
      await until(async () => JSON.parse(await readFile(join(artifacts, 'settings.json'), 'utf8')).url === url, 'query-free persisted URL')
      await browser.navigate(`${url}callback?code=status-secret&state=state-secret#hash-secret`)
      assert.equal(browser.snapshot.url, `${url}callback?code=status-secret&state=state-secret#hash-secret`, 'address field keeps the real URL')
      const status = JSON.stringify(await browserCommand(['status']))
      for (const secret of ['status-secret', 'state-secret', 'hash-secret']) assert.ok(!status.includes(secret))
      assert.ok(!(await browserCommand(['console'])).some(entry => entry.source.includes('status-secret')))
      await browser.view.webContents.executeJavaScript('history.pushState({}, "", "/spa?token=spa-secret")')
      await delay(100)
      assert.equal(JSON.parse(await readFile(join(artifacts, 'settings.json'), 'utf8')).url, url)
      const interrupted = browser.navigate(`${url}slow`)
      await until(() => slowSeen, 'slow navigation')
      await browser.navigate(url)
      await interrupted
      assert.equal(browser.snapshot.error, null)
      await until(() => ui(`document.querySelector('[aria-label="Web app URL"]').value === ${JSON.stringify(url)}`), 'address poll')
      await ui(`(() => {
        const input = document.querySelector('[aria-label="Web app URL"]'); input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'http://localhost:3000/typing');
        input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`)
      await browser.view.webContents.executeJavaScript('history.pushState({}, "", "/new-route")')
      await delay(1200)
      assert.equal(await ui('document.querySelector("[aria-label=\\"Web app URL\\"]").value'), 'http://localhost:3000/typing')
      await ui('document.querySelector("[aria-label=\\"Web app URL\\"]").blur()')
      await browser.navigate(url)
      await ui('document.querySelector(".browser-tools-toggle").click()')
      const tools = await until(() => browser.view.webContents.devToolsWebContents, 'embedded DevTools')
      await until(() => tools.executeJavaScript('Boolean(globalThis.DevToolsAPI)'), 'DevTools frontend')
      // Register a disposable native filesystem, then mark the frontend event as
      // overrides. Production uses Chromium's Sources > Overrides folder picker.
      const overrideRoot = join(artifacts, `overrides-${Date.now()}`)
      const hostFolder = `127.0.0.1%3A${site.address().port}`
      await mkdir(join(overrideRoot, hostFolder), { recursive: true })
      await writeFile(join(overrideRoot, hostFolder, 'api.json'), '{"version":"local-override"}')
      await tools.executeJavaScript(`(() => {
        const original = DevToolsAPI.fileSystemAdded.bind(DevToolsAPI);
        DevToolsAPI.fileSystemAdded = (error, fileSystem) => original(error, { ...fileSystem, type: 'overrides' });
      })()`)
      browser.view.webContents.addWorkSpace(overrideRoot)
      await tools.executeJavaScript(`(async () => {
        const Common = await import('devtools://devtools/bundled/core/common/common.js');
        Common.Settings.Settings.instance().moduleSetting('persistence-network-overrides-enabled').set(true);
      })()`)
      await until(async () => await browser.view.webContents.executeJavaScript('fetch("/api.json").then(r => r.json()).then(r => r.version)') === 'local-override', 'native local override')
      await browser.view.webContents.executeJavaScript('console.log("capture with DevTools open")')
      assert.ok((await browserCommand(['console'])).some(entry => entry.message.includes('capture with DevTools open')))
      await writeFile(join(overrideRoot, hostFolder, 'api.json'), '{"version":"edited-override"}')
      await until(async () => await browser.view.webContents.executeJavaScript('fetch("/api.json").then(r => r.json()).then(r => r.version)') === 'edited-override', 'edited local file refresh')
      const picture = await capture(window.webContents, 'main renderer')
      await writeFile(join(artifacts, 'browser.png'), picture.toPNG())
      // Main-renderer capture excludes child WebContentsViews; capture each
      // native surface separately as well for visual verification.
      assert.ok(browser.tools.getVisible(), 'DevTools view must be visible for capture')
      assert.ok(browser.tools.getBounds().height > 0, JSON.stringify(browser.tools.getBounds()))
      await writeFile(join(artifacts, 'page.png'), (await capture(browser.view.webContents, 'browser page')).toPNG())
      await writeFile(join(artifacts, 'devtools.png'), (await capture(tools, 'DevTools')).toPNG())
      assert.equal(browser.snapshot.devtools, true)
      browser.action('devtools')
      await until(() => browser.snapshot.devtools === false, 'DevTools hidden')
      browser.action('devtools')
      await until(() => browser.snapshot.devtools === true, 'DevTools visible again')
      assert.equal(await browser.view.webContents.executeJavaScript('fetch("/api.json").then(r => r.json()).then(r => r.version)'), 'edited-override')
      await ui('window.setObscured(true)')
      await delay(300)
      assert.equal(browser.view.getVisible(), false)
      await ui('window.setObscured(false)')
      await delay(300)
      assert.equal(browser.view.getVisible(), true)
      await ui('Array.from(document.querySelectorAll(".browser-tabs [role=tab]")).find(button => button.textContent.startsWith("Console")).click()')
      await delay(1100)
      assert.equal(browser.view.getVisible(), false)
      assert.ok(await ui('document.querySelector(".browser-activity").textContent.includes("capture with DevTools open")'))
      await writeFile(join(artifacts, 'console.png'), (await capture(window.webContents, 'console view')).toPNG())
      await browser.view.webContents.executeJavaScript('for(let i=0;i<320;i++) console.log("bounded-" + i)')
      assert.equal(browser.snapshot.console.length, 300)
      await ui('document.querySelector(".browser-workspace-toolbar button").click()')
      await delay(300)
      assert.equal(browser.view.getVisible(), false)
      assert.deepEqual(await ui('window.unhandled'), [])
      await browser.dispose()
      await assert.rejects(readFile(process.env.COPILOT_DESKTOP_BROWSER_STATE, 'utf8'), { code: 'ENOENT' })
      const legacyPath = join(artifacts, 'legacy-settings.json')
      await writeFile(legacyPath, JSON.stringify({ url: `${url}callback?code=legacy-secret` }))
      const legacy = new BrowserDebug(window, legacyPath)
      try {
        await legacy.open()
        assert.equal(legacy.view.webContents.getURL(), '', 'legacy auth callbacks must not be replayed')
        await assert.rejects(readFile(legacyPath, 'utf8'), { code: 'ENOENT' })
      } finally { await legacy.dispose() }
      for (const legacyUrl of [`${url}callback?code=old-secret`, `http://user:password-secret@127.0.0.1:${site.address().port}/`]) {
        await writeFile(legacyPath, JSON.stringify({ url: legacyUrl }))
        const manuallyNavigated = new BrowserDebug(window, legacyPath)
        try {
          await manuallyNavigated.navigate(`${url}callback?token=new-secret`)
          await manuallyNavigated.open()
          assert.ok(manuallyNavigated.snapshot.url.includes('token=new-secret'), 'manual navigation wins restore')
          await assert.rejects(readFile(legacyPath, 'utf8'), { code: 'ENOENT' })
        } finally { await manuallyNavigated.dispose() }
      }
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, nativeOverrides: true, cli: true }, null, 2))
      console.log('Browser debug check passed: native overrides, live file changes, CLI telemetry, isolation, and layout.')
    } finally {
      await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit()
    }
  }
}
