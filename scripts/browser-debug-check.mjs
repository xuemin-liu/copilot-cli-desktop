// Isolated real Electron/Chromium check; --copilot-console additionally makes one real model request.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'

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
  await rm(join(artifacts, 'export-console.json'), { force: true })
  const { build } = await import('esbuild')
  await build({ stdin: { contents: `
    import { createRoot } from 'react-dom/client';
    import { useState } from 'react';
    import { SessionWorkspace } from './src/renderer/components/SessionWorkspace';
    import './src/renderer/styles.css';
    window.unhandled = [];
    window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason)));
    function Fixture() {
      const [obscured, setObscured] = useState(false);
      window.setObscured = setObscured;
      const [activeTabId, setActiveTabId] = useState('tab-1');
      window.setBrowserActive = active => setActiveTabId(active ? 'tab-1' : 'tab-2');
      const tabs = [{ id: 'tab-1', title: 'First session', status: 'running' }, { id: 'tab-2', title: 'Second session', status: 'running' }];
      return <SessionWorkspace tabs={tabs} activeTabId={activeTabId} obscured={obscured} canOpenTab={false}
        onActivate={setActiveTabId} onCreate={() => {}} onFork={() => {}} onClose={() => {}} onRestart={() => {}} />;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(artifacts, 'fixture.js'), platform: 'browser', jsx: 'automatic',
    plugins: [{ name: 'fixture-terminal', setup(build) {
      build.onResolve({ filter: /TerminalPane\.js$/ }, () => ({ path: 'terminal', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react"; export function TerminalPane({tabId}) { return <div data-terminal>{tabId} terminal fixture</div>; }', loader: 'jsx', resolveDir: process.cwd() }))
    } }],
  })
  await writeFile(join(artifacts, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root" style="display:flex;height:100vh"><script src="fixture.js"></script></div></body></html>')
  const env = { ...process.env, COPILOT_DESKTOP_BROWSER_STATE: join(artifacts, 'control.json') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), process.argv.includes('--copilot-console') ? 180000 : 90000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Browser debug check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true, 'All browser checks must complete before Electron exits')
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
    const { prepareBrowserSessionEnvironment } = await import('../dist/src/main/browser-session.js')
    // Installed-app helpers live outside the project, so test that boundary too.
    const sessionRoot = await mkdtemp(join(tmpdir(), 'desktop-browser-check-'))
    const firstEnv = await prepareBrowserSessionEnvironment(sessionRoot, 'tab-1', process.env)
    Object.assign(process.env, firstEnv)
    let slowSeen = false
    const site = createServer((request, response) => {
      if (request.url === '/slow') { slowSeen = true; return }
      if (request.url === '/second-session') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><h1>Second session</h1><script>console.error("second session fixture exception")</script>')
        return
      }
      if (request.url.startsWith('/secret?')) {
        response.writeHead(200, { 'X-Auth-Token': 'response-secret', location: '/callback?code=location-secret',
          link: '</next?token=link-secret>; rel="next"', 'content-type': 'application/json' })
        response.end('{}'); return
      }
      if (request.url === '/redirect-secret') { response.writeHead(302, { location: '/landing?code=redirect-secret#fragment-secret' }); response.end(); return }
      if (request.url === '/api.json') { response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'test-secret=1' }); response.end('{"version":"server"}'); return }
      if (request.url === '/fail') { response.writeHead(500); response.end('fixture failure'); return }
      if (request.url === '/child-page') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><title>Child page</title><script>console.error("child page exception"); window.opener?.postMessage("child-ready", location.origin)</script><h1>Child page</h1>')
        return
      }
      if (request.url === '/new-page-form') {
        let body = ''
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'text/html' })
          response.end(`<!doctype html><title>Form page</title><pre id="body">${request.method}:${body}</pre>`)
        })
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><h1>Browser debug fixture</h1><script>console.log("fixture console"); fetch("/api.json"); fetch("/fail"); setTimeout(() => { throw new Error("fixture exception") }, 50)</script>')
    })
    await new Promise(accept => site.listen(0, '127.0.0.1', accept))
    const url = `http://127.0.0.1:${site.address().port}/`
    const window = new BrowserWindow({ width: 1400, height: 960, show: false, webPreferences: {
      preload: resolve('src/preload/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    } })
    const browser = new BrowserDebug(window, join(artifacts, 'settings.json'))
    const secondEnv = await prepareBrowserSessionEnvironment(sessionRoot, 'tab-2', { ...process.env, COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '' })
    const second = new BrowserDebug(window, join(sessionRoot, 'tab-2', 'settings.json'), { endpointPath: secondEnv.COPILOT_DESKTOP_BROWSER_STATE })
    const browsers = new Map([['tab-1', browser], ['tab-2', second]])
    const trusted = event => { assert.equal(event.sender.id, window.webContents.id) }
    const forTab = tabId => { assert.ok(browsers.has(tabId), 'renderer must address a known session'); return browsers.get(tabId) }
    ipcMain.handle('desktop:browser-open', (event, tabId) => { trusted(event); return forTab(tabId).open() })
    ipcMain.handle('desktop:browser-state', (event, tabId) => { trusted(event); return forTab(tabId).snapshot })
    ipcMain.handle('desktop:browser-navigate', (event, tabId, value) => { trusted(event); return forTab(tabId).navigate(value) })
    ipcMain.handle('desktop:browser-action', (event, tabId, action) => { trusted(event); return forTab(tabId).action(action) })
    const copied = []
    ipcMain.handle('desktop:copy-text', (event, text) => { trusted(event); copied.push(text) })
    ipcMain.handle('desktop:browser-export', (event, tabId, kind) => { trusted(event); assert.ok(['console', 'network'].includes(kind)); return writeFile(join(artifacts, `export-${kind}.json`), JSON.stringify(forTab(tabId).snapshot[kind])) })
    ipcMain.handle('desktop:browser-bounds', (event, tabId, bounds) => { trusted(event); forTab(tabId).setBounds(bounds) })
    const ui = code => window.webContents.executeJavaScript(code)
    try {
      window.showInactive()
      await window.loadFile(join(artifacts, 'index.html'))
      await until(() => ui('document.querySelector(".session-pane-visible .session-browser-toggle")'), 'session header open button')
      assert.equal(await ui('document.querySelectorAll(".session-pane-header .session-browser-toggle").length'), 2)
      assert.equal(await ui('document.querySelectorAll(".browser-workspace-toolbar").length'), 0, 'no window-wide browser toolbar')
      await ui('document.querySelector(".session-pane-visible .session-browser-toggle").click()')
      await until(() => ui('Boolean(document.querySelector(".browser-panel"))'), 'browser pane')
      // Exercise the address bar's native validation and Go submission, not just IPC.
      await ui(`(() => {
        const input = document.querySelector('[aria-label="Web app URL"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'localhost.kmha.dev');
        input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`)
      assert.equal(await ui('document.querySelector(".browser-toolbar").checkValidity()'), true, 'bare hostname must pass form validation')
      await ui(`(() => {
        const input = document.querySelector('[aria-label="Web app URL"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url.replace('http://', ''))});
        input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`)
      await ui('document.querySelector(".browser-toolbar").requestSubmit()')
      await until(() => browser.snapshot.console.some(entry => entry.message.includes('fixture exception')), 'exception capture')
      assert.equal(browser.snapshot.url, url, 'bare loopback address navigates using HTTP')
      // Read Chromium's page zoom, independently of the narrower embedded viewport.
      assert.equal(browser.snapshot.zoomFactor, 1)
      browser.view.webContents.setZoomFactor(1.25)
      assert.equal(browser.snapshot.zoomFactor, 1.25)
      await until(() => ui('document.querySelector(".browser-zoom").textContent === "125%"'), 'actual page zoom in toolbar')
      browser.view.webContents.setZoomFactor(1)
      await until(() => ui('document.querySelector(".browser-zoom").textContent === "100%"'), 'reset page zoom in toolbar')
      // Separate live WebContents, cookies/storage, telemetry and helper endpoints.
      {
        await browser.view.webContents.executeJavaScript('document.cookie = "session-only=first; SameSite=Strict"; localStorage.setItem("session-only", "first")')
        await second.open()
        await second.navigate(`${url}second-session`)
        await until(() => second.snapshot.console.some(entry => entry.message.includes('second session fixture exception')), 'second session exception')
        assert.equal(await second.view.webContents.executeJavaScript('document.cookie.includes("session-only")'), false)
        assert.equal(await second.view.webContents.executeJavaScript('localStorage.getItem("session-only")'), null)
        assert.ok(!browser.snapshot.console.some(entry => entry.message.includes('second session fixture exception')))
        assert.ok(!second.snapshot.console.some(entry => entry.message.includes('fixture console')))
        const execute = promisify(execFile)
        const readConsole = async env => JSON.parse((await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', env.COPILOT_DESKTOP_BROWSER_HELPER, 'console'], { env, windowsHide: true, timeout: 15000 })).stdout)
        const firstConsole = await readConsole(firstEnv)
        const secondConsole = await readConsole(secondEnv)
        assert.ok(firstConsole.some(entry => entry.message.includes('fixture exception')))
        assert.ok(!firstConsole.some(entry => entry.message.includes('second session fixture exception')))
        assert.ok(secondConsole.some(entry => entry.message.includes('second session fixture exception')))
        // No model calls: verify the installed Copilot discovers the generated guidance.
        const discovered = await execute('powershell.exe', ['-NoProfile', '-Command', 'copilot instruction list --json'], { env: firstEnv, cwd: artifacts, windowsHide: true, timeout: 15000 })
        const instructionSources = JSON.parse(discovered.stdout)
        assert.ok(instructionSources.some(source => source.sourcePath?.toLowerCase().replaceAll('\\', '/') === join(sessionRoot, 'tab-1', '.github', 'instructions', 'browser.instructions.md').toLowerCase().replaceAll('\\', '/') && !source.defaultDisabled), 'Copilot must discover browser instructions')
        if (process.argv.includes('--copilot-console')) {
          const answer = await execute('powershell.exe', ['-NoProfile', '-Command', 'copilot -p "Find any exception from browser console. Read the live console and report the exception message, source, and line. Do not modify any files or browser state." --allow-all-tools --no-ask-user --silent'], { env: firstEnv, cwd: artifacts, windowsHide: true, timeout: 100000, maxBuffer: 1024 * 1024 })
          await writeFile(join(artifacts, 'copilot-console-answer.txt'), answer.stdout)
          assert.ok(answer.stdout.includes('fixture exception'), 'natural-language Copilot request must report the live exception')
          assert.ok(!answer.stdout.includes('second session fixture exception'), 'Copilot must read only its own browser')
          console.log('Copilot natural-language console check passed.')
        }
        await ui('window.setBrowserActive(false)')
        await delay(300)
        assert.equal(browser.view.getVisible(), false, 'inactive session hides its browser')
        await browser.view.webContents.executeJavaScript('console.error("inactive session exception")')
        assert.ok((await readConsole(firstEnv)).some(entry => entry.message.includes('inactive session exception')))
        await ui('document.querySelector(".session-pane-visible .session-browser-toggle").click()')
        await until(() => second.view.getVisible(), 'second session own browser')
        await until(() => ui(`document.querySelector('.session-pane-visible [aria-label="Web app URL"]').value === ${JSON.stringify(`${url}second-session`)}`), 'second session own address')
        await writeFile(join(artifacts, 'session-header.png'), (await capture(window.webContents, 'session header')).toPNG())
        await ui('window.setBrowserActive(true)')
        await until(() => browser.view.getVisible(), 'restored session browser')
        await until(() => !second.view.getVisible(), 'second browser hides on session switch')
        assert.equal(browser.snapshot.url, url)
      }
      await until(() => browser.snapshot.network.some(entry => entry.url.endsWith('/fail') && entry.status === 500 && entry.durationMs !== null), 'failed API request')
      assert.equal(await browser.view.webContents.executeJavaScript('typeof window.copilotDesktop'), 'undefined')
      assert.equal(await browser.view.webContents.executeJavaScript('typeof require'), 'undefined')
      // Exercise actual Chromium new-page creation, not a loadURL approximation.
      {
        console.log('New-page check: opening target blank link.')
        const source = browser.view
        const sourceId = source.webContents.id
        await source.webContents.executeJavaScript(`
          window.childReady = false;
          addEventListener('message', event => { if (event.data === 'child-ready') window.childReady = true });
          const link = document.createElement('a'); link.href = '/child-page'; link.target = '_blank';
          link.rel = 'opener'; document.body.append(link); link.click();
        `)
        await until(() => browser.snapshot.pages.length === 2 && browser.snapshot.url.endsWith('/child-page'), 'target blank child')
        const child = browser.view
        const childContents = child.webContents
        const childId = child.webContents.id
        assert.equal(source.webContents.getURL(), url, 'new-page link preserves its source')
        assert.equal(child.webContents.session, source.webContents.session, 'child retains this terminal login')
        assert.equal(await child.webContents.executeJavaScript('localStorage.getItem("session-only")'), 'first')
        await until(() => source.webContents.executeJavaScript('window.childReady'), 'opener postMessage callback')
        assert.equal(await child.webContents.executeJavaScript('typeof require'), 'undefined')
        assert.equal(await child.webContents.executeJavaScript('typeof window.copilotDesktop'), 'undefined')
        await until(() => browser.snapshot.console.some(entry => entry.message === 'child page exception'), 'child console capture')
        await until(() => browser.snapshot.network.some(entry => entry.url.endsWith('/child-page') && entry.status === 200), 'child network capture')
        assert.equal(browser.snapshot.console.find(entry => entry.message === 'child page exception').pageId, childId)
        assert.equal(browser.snapshot.network.find(entry => entry.url.endsWith('/child-page')).pageId, childId)
        assert.ok((await browserCommand(['console'])).some(entry => entry.message === 'child page exception'))
        assert.ok(!second.snapshot.console.some(entry => entry.message === 'child page exception'))
        await until(() => ui('document.querySelectorAll(".session-pane-visible .browser-pages [role=tab]").length === 2'), 'page strip')
        await until(() => child.getVisible() && !source.getVisible(), 'only selected page visible')
        await writeFile(join(artifacts, 'page-tabs.png'), (await capture(window.webContents, 'browser pages')).toPNG())
        browser.action('devtools')
        const childTools = await until(() => childContents.devToolsWebContents, 'child DevTools')
        await until(() => childTools.executeJavaScript('Boolean(globalThis.DevToolsAPI)'), 'child DevTools ready')
        console.log('New-page check: opener, storage, telemetry and page strip passed.')
        await ui('document.querySelector(".session-pane-visible .browser-pages [role=tab]").click()')
        await until(() => browser.view === source && source.getVisible() && !child.getVisible(), 'select source page')
        // A POST form targeting _blank must keep its body and method.
        await source.webContents.executeJavaScript(`
          const form = document.createElement('form'); form.method = 'POST'; form.action = '/new-page-form'; form.target = '_blank';
          const input = document.createElement('input'); input.name = 'fixture'; input.value = 'post-body';
          form.append(input); document.body.append(form); form.requestSubmit();
        `)
        await until(() => browser.snapshot.pages.length === 3 && browser.snapshot.url.endsWith('/new-page-form'), 'new-page POST form')
        const formPage = browser.view
        await until(() => formPage.webContents.executeJavaScript('document.getElementById("body")?.textContent === "POST:fixture=post-body"'), 'POST request preserved')
        console.log('New-page check: POST preserved; closing form page.')
        browser.action(`close-page:${formPage.webContents.id}`)
        await until(() => browser.snapshot.pages.length === 2, 'close form page')
        // about:blank -> document.write is used by report/print and popup workflows.
        browser.action(`select-page:${sourceId}`)
        await source.webContents.executeJavaScript(`window.blankChild = window.open('', '_blank'); blankChild.document.write('<title>Written page</title><h1>Written page</h1>'); blankChild.document.close()`)
        await until(() => browser.snapshot.pages.length === 3 && browser.snapshot.pages.some(page => page.title === 'Written page'), 'blank scripted child')
        const blank = browser.view
        const blankContents = blank.webContents
        console.log('New-page check: blank document written; testing window.close.')
        await source.webContents.executeJavaScript('blankChild.close()')
        await until(() => blankContents.isDestroyed() && browser.snapshot.pages.length === 2, 'window close removes its tab')
        browser.action(`select-page:${sourceId}`)
        const count = browser.snapshot.pages.length
        await source.webContents.executeJavaScript(`window.open('file:///C:/Windows/win.ini'); window.open('data:text/html,blocked'); window.open('https://user:secret@example.com')`)
        await delay(200)
        assert.equal(browser.snapshot.pages.length, count, 'unsafe child URLs are rejected')
        // Move/hide the complete page family along with its terminal.
        const pageBounds = browser.bounds
        const popupOwner = new BrowserWindow({ show: false })
        browser.setOwner(popupOwner)
        browser.setBounds({ x: 0, y: 0, width: 400, height: 300 })
        assert.equal(source.getVisible(), true)
        assert.equal(child.getVisible(), false)
        browser.setBounds(null)
        assert.equal(source.getVisible(), false)
        browser.setOwner(window)
        browser.setBounds(pageBounds)
        popupOwner.destroy()
        browser.action(`close-page:${childId}`)
        await until(() => browser.snapshot.pages.length === 1 && childContents.isDestroyed(), 'close child page')
        assert.equal(childTools.isDestroyed(), true, 'closing a page disposes its DevTools')
        assert.equal(window.isDestroyed(), false, 'closing a child leaves its terminal alive')
        await browser.navigate(url)
        await until(() => source.getVisible(), 'source restored in terminal')
        // Parent close keeps its child tab and promotes it; terminal disposal closes every page.
        await source.webContents.executeJavaScript(`window.featureChild = window.open('/child-page', '_blank', 'nodeIntegration=yes,contextIsolation=no,sandbox=no'); void 0`)
        await until(() => browser.snapshot.pages.length === 2 && browser.snapshot.url.endsWith('/child-page'), 'scripted child')
        const retained = browser.view.webContents
        const preferences = retained.getLastWebPreferences()
        assert.equal(preferences.nodeIntegration, false)
        assert.equal(preferences.contextIsolation, true)
        assert.equal(preferences.sandbox, true)
        browser.action(`close-page:${sourceId}`)
        await until(() => browser.snapshot.pages.length === 1 && !retained.isDestroyed(), 'child survives source close')
        await browser.navigate(url)
      }
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
      const largeConsoleStart = performance.now()
      await browser.view.webContents.executeJavaScript('console.log("performance-fixture-" + "password".repeat(25000)); console.log("token=\\"boundary-secret with spaces " + "x".repeat(200000))')
      await until(() => browser.snapshot.console.some(entry => entry.message.startsWith('performance-fixture-')), 'large console capture')
      assert.ok(performance.now() - largeConsoleStart < 4000, 'large console messages must not freeze the main process')
      const largeConsole = await browserCommand(['console'])
      assert.ok(largeConsole.every(entry => entry.message.length <= 8192))
      assert.ok(!JSON.stringify(largeConsole).includes('boundary-secret'))
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
      const selectedPanel = () => tools.executeJavaScript(`(async () => {
        const UI = await import('devtools://devtools/bundled/ui/legacy/legacy.js');
        const id = UI.InspectorView.InspectorView.instance().tabbedPane.selectedTabId;
        const widget = UI.ViewManager.ViewManager.instance().materializedWidget(id);
        return widget?.isShowing() && widget.element.getBoundingClientRect().height > 0 ? id : null;
      })()`)
      const fullPageBounds = browser.view.getBounds()
      const toolsSurface = window.contentView.children.find(view => view.webContents?.id === tools.id)
      assert.deepEqual(toolsSurface.getBounds(), fullPageBounds, 'DevTools fills the viewport')
      assert.equal(browser.view.getVisible(), false, 'tools replace the visible page')
      assert.ok(fullPageBounds.height > 400, 'page is not reduced to a bottom-docked split')
      await ui('Array.from(document.querySelectorAll(".browser-tabs [role=tab]")).find(button => button.textContent === "Console").click()')
      await until(async () => await selectedPanel() === 'console', 'native console selected')
      assert.deepEqual(browser.view.getBounds(), fullPageBounds, 'console keeps full page dimensions')
      const nativeEvaluation = await tools.executeJavaScript(`(async () => {
        const SDK = await import('devtools://devtools/bundled/core/sdk/sdk.js');
        const target = SDK.TargetManager.TargetManager.instance().primaryPageTarget();
        const context = target.model(SDK.RuntimeModel.RuntimeModel).executionContexts().find(context => context.isDefault);
        const result = await context.evaluate({expression: '({meaning: 42, page: location.href, bridge: typeof window.copilotDesktop})',
          objectGroup: 'console', includeCommandLineAPI: true, silent: false, returnByValue: true, generatePreview: false, userGesture: false, awaitPromise: true});
        return result.object?.value;
      })()`)
      assert.deepEqual(nativeEvaluation, { meaning: 42, page: url, bridge: 'undefined' }, 'native console evaluates in the inspected page')
      await writeFile(join(artifacts, 'native-console.png'), (await capture(tools, 'native console')).toPNG())
      await ui('Array.from(document.querySelectorAll(".browser-tabs [role=tab]")).find(button => button.textContent === "Network").click()')
      await until(async () => await selectedPanel() === 'network', 'native network selected')
      assert.deepEqual(browser.view.getBounds(), fullPageBounds, 'network keeps full page dimensions')
      assert.equal(browser.view.webContents.devToolsWebContents.id, tools.id, 'panel switches reuse the inspection session')
      await browser.view.webContents.executeJavaScript('fetch("/api.json?native-body").then(r => r.text())')
      await until(async () => await tools.executeJavaScript(`(async () => {
        const Logs = await import('devtools://devtools/bundled/models/logs/logs.js');
        const request = Logs.NetworkLog.NetworkLog.instance().requests().find(request => request.url().endsWith('/api.json?native-body'));
        if (!request?.finished) return false;
        const content = await request.requestContentData();
        return typeof content.text === 'string' && content.text.includes('Browser debug fixture');
      })()`), 'native network captures readable response body')
      await tools.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await writeFile(join(artifacts, 'native-network.png'), (await capture(tools, 'native network')).toPNG())
      await ui('document.querySelector(".browser-tools-toggle").click()')
      await until(async () => await selectedPanel() === 'sources', 'native sources selected')
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
      const pageId = browser.view.webContents.id
      const pageUrl = browser.snapshot.url
      const originalBounds = browser.view.getBounds()
      const viewportBounds = { ...originalBounds }
      const popout = new BrowserWindow({ width: 900, height: 800, show: false })
      try {
        browser.setOwner(popout)
        browser.setBounds({ x: 0, y: 0, width: 850, height: 750 })
        assert.equal(browser.view.webContents.id, pageId)
        assert.equal(browser.snapshot.url, pageUrl)
        assert.ok(popout.contentView.children.includes(browser.view))
        assert.ok(!window.contentView.children.includes(browser.view))
        assert.equal(await browser.view.webContents.executeJavaScript('fetch("/api.json").then(r => r.json()).then(r => r.version)'), 'local-override', 'overrides survive pop-out')
        browser.setOwner(window)
        browser.setBounds(viewportBounds)
        assert.equal(browser.view.webContents.id, pageId)
        assert.ok(window.contentView.children.includes(browser.view))
      } finally { browser.setOwner(window); popout.destroy() }
      await writeFile(join(overrideRoot, hostFolder, 'api.json'), '{"version":"edited-override"}')
      await until(async () => await browser.view.webContents.executeJavaScript('fetch("/api.json").then(r => r.json()).then(r => r.version)') === 'edited-override', 'edited local file refresh')
      const picture = await capture(window.webContents, 'main renderer')
      await writeFile(join(artifacts, 'browser.png'), picture.toPNG())
      // Main-renderer capture excludes child WebContentsViews; capture each
      // native surface separately as well for visual verification.
      const toolsView = window.contentView.children.find(view => view.webContents?.id === tools.id)
      assert.ok(toolsView?.getVisible(), 'DevTools view must be visible for capture')
      assert.ok(toolsView.getBounds().height > 0, JSON.stringify(toolsView.getBounds()))
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
      assert.equal(browser.view.getVisible(), false)
      assert.equal(toolsView.getVisible(), true, 'unobscured native tools restored')
      await ui('Array.from(document.querySelectorAll(".browser-tabs [role=tab]")).find(button => button.textContent.startsWith("Activity")).click()')
      await delay(1100)
      assert.equal(browser.view.getVisible(), false)
      assert.ok(await ui('document.querySelector(".browser-activity").textContent.includes("capture with DevTools open")'))
      await writeFile(join(artifacts, 'console.png'), (await capture(window.webContents, 'console view')).toPNG())
      await browser.view.webContents.executeJavaScript('for(let i=0;i<320;i++) console.log("bounded-" + i)')
      assert.equal(browser.snapshot.console.length, 300)
      const networkBeforeClear = browser.snapshot.network
      assert.ok(networkBeforeClear.length > 0)
      await ui('Array.from(document.querySelectorAll(".browser-activity button")).find(button => button.textContent === "Clear console").click()')
      await until(() => browser.snapshot.console.length === 0, 'clear console')
      assert.deepEqual(browser.snapshot.network, networkBeforeClear, 'clear console preserves network activity')
      assert.deepEqual(await browserCommand(['console']), [], 'CLI sees cleared console')
      await browser.view.webContents.executeJavaScript('console.error("console after clear")')
      await until(() => browser.snapshot.console.some(entry => entry.message.includes('console after clear')), 'console capture resumes')
      await ui(`(() => {
        const select = document.querySelector('[aria-label="Activity log"]');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'network');
        select.dispatchEvent(new Event('change', {bubbles:true}));
      })()`)
      await until(() => ui('Boolean(document.querySelector(".browser-network tbody button"))'), 'network view')
      await ui('document.querySelector(".browser-network tbody button").click()')
      assert.ok(await ui('Boolean(document.querySelector(".browser-request-detail"))'))
      const consoleBeforeClear = browser.snapshot.console
      await ui('Array.from(document.querySelectorAll(".browser-activity button")).find(button => button.textContent === "Clear network").click()')
      await until(() => browser.snapshot.network.length === 0, 'clear network')
      assert.deepEqual(browser.snapshot.console, consoleBeforeClear, 'clear network preserves console activity')
      assert.deepEqual(await browserCommand(['network']), [], 'CLI sees cleared network')
      assert.equal(await ui('Boolean(document.querySelector(".browser-request-detail"))'), false, 'clear network removes selected request details')
      await browser.view.webContents.executeJavaScript('fetch("/api.json").then(r => r.text())')
      await until(() => browser.snapshot.network.some(entry => entry.url.endsWith('/api.json') && entry.durationMs !== null), 'network capture resumes')
      const setSelect = (label, value) => ui(`(() => {
        const select = document.querySelector('[aria-label=${JSON.stringify(label)}]');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)});
        select.dispatchEvent(new Event('change', {bubbles:true}));
      })()`)
      await setSelect('Activity log', 'console')
      await until(() => ui('document.querySelector(".browser-activity").textContent.includes("Clear console")'), 'console activity controls')
      await browser.view.webContents.executeJavaScript('console.info("filter info sentinel"); console.error("filter error sentinel"); console.error("filter error sentinel")')
      await until(() => ui('document.querySelector(".browser-activity-list").textContent.includes("filter error sentinel")'), 'live console activity')
      await setSelect('Console level', 'error')
      await ui(`(() => {
        const input = document.querySelector('[aria-label="Filter activity"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'filter');
        input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`)
      await until(() => ui('document.querySelectorAll(".browser-console-entry").length === 1'), 'console level and text filtering with repeat grouping')
      assert.ok(!(await ui('document.querySelector(".browser-activity-list").textContent')).includes('filter info sentinel'))
      assert.ok((await ui('document.querySelector(".browser-activity-list").textContent')).includes('×2'))
      await ui('Array.from(document.querySelectorAll(".browser-activity button")).find(button => button.textContent === "Copy visible log").click()')
      await until(() => copied.length > 0, 'copy filtered activity')
      assert.equal(JSON.parse(copied.at(-1)).length, 2)
      assert.equal(JSON.parse(copied.at(-1))[0].pageId, browser.view.webContents.id)
      await ui('Array.from(document.querySelectorAll(".browser-activity button")).find(button => button.textContent === "Save log…").click()')
      await until(async () => (JSON.parse(await readFile(join(artifacts, 'export-console.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error }))).some(entry => entry.message === 'filter error sentinel'), 'export captured console')
      await ui('Array.from(document.querySelectorAll(".browser-activity button")).find(button => button.textContent === "Pause capture").click()')
      await until(() => browser.snapshot.recordingConsole === false, 'pause console recording')
      await browser.view.webContents.executeJavaScript('console.error("paused console sentinel")')
      assert.ok(!browser.snapshot.console.some(entry => entry.message === 'paused console sentinel'))
      await ui('Array.from(document.querySelectorAll(".browser-activity button")).find(button => button.textContent === "Resume capture").click()')
      await until(() => browser.snapshot.recordingConsole === true, 'resume console recording')
      await browser.view.webContents.executeJavaScript('console.error("resumed console sentinel")')
      assert.ok(browser.snapshot.console.some(entry => entry.message === 'resumed console sentinel'))
      browser.action('record-network:off')
      await browser.view.webContents.executeJavaScript('fetch("/network-paused").then(r => r.text())')
      assert.ok(!browser.snapshot.network.some(entry => entry.url.endsWith('/network-paused')))
      browser.action('record-network:on')
      await browser.view.webContents.executeJavaScript('fetch("/network-resumed").then(r => r.text())')
      assert.ok(browser.snapshot.network.some(entry => entry.url.endsWith('/network-resumed')))
      browser.action('preserve-console:off')
      browser.action('preserve-network:off')
      await browser.navigate(`${url}after-preserve-off`)
      await until(() => browser.snapshot.console.some(entry => entry.message.includes('fixture exception')), 'capture after navigation without preserve')
      assert.ok(!browser.snapshot.console.some(entry => entry.message === 'resumed console sentinel'))
      assert.ok(!browser.snapshot.network.some(entry => entry.url.endsWith('/network-resumed')))
      browser.action('preserve-console:on')
      browser.action('preserve-network:on')
      await browser.view.webContents.executeJavaScript('console.error("preserved console sentinel")')
      await browser.navigate(url)
      assert.ok(browser.snapshot.console.some(entry => entry.message === 'preserved console sentinel'))
      await setSelect('Activity log', 'network')
      await until(() => ui('document.querySelector(".browser-activity").textContent.includes("Clear network")'), 'network activity controls')
      await setSelect('Request type', 'xhr')
      await ui('Array.from(document.querySelectorAll(".browser-activity label")).find(label => label.textContent === "Failed only").querySelector("input").click()')
      await until(() => ui('document.querySelectorAll(".browser-network tbody tr").length > 0'), 'failed Fetch/XHR filter')
      assert.ok((await ui('document.querySelector(".browser-network").textContent')).includes('/fail'))
      assert.ok(!(await ui('document.querySelector(".browser-network").textContent')).includes('/api.json'))
      await until(() => ui(`document.querySelector('[aria-label="Web app URL"]').value === ${JSON.stringify(url)}`), 'activity address and capture state refreshed')
      await writeFile(join(artifacts, 'activity-network.png'), (await capture(window.webContents, 'filtered activity network')).toPNG())
      await ui('document.querySelector(".session-pane-visible .session-browser-toggle").click()')
      await delay(300)
      assert.equal(browser.view.getVisible(), false)
      assert.deepEqual(await ui('window.unhandled'), [])
      const disposedPage = browser.view
      await browser.dispose()
      assert.ok(!window.contentView.children.includes(disposedPage), 'closed session removes its native browser view')
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
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, newPages: true, openerCallbacks: true, newPagePost: true, nativeOverrides: true, cli: true, sessionIsolation: true, powershellDiagnostics: true, copilotInstructions: true }, null, 2))
      console.log('Browser debug check passed: native overrides, live file changes, CLI telemetry, isolation, and layout.')
    } catch (error) {
      console.error(error)
      throw error
    } finally {
      await browser.dispose(); await second.dispose(); window.destroy(); site.closeAllConnections(); site.close()
      assert.equal(resolve(sessionRoot, '..'), resolve(tmpdir()), 'cleanup is confined to the owned temporary test directory')
      await rm(sessionRoot, { recursive: true, force: true })
      app.quit()
    }
  }
}
