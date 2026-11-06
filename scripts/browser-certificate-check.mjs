// Isolated real Electron/Chromium check of the certificate warning, against HTTPS servers with certificates that do not match.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const artifacts = resolve('test-results/browser-certificate')
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (read, label) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}

if (!process.versions.electron) {
  await rm(artifacts, { recursive: true, force: true })
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const { build } = await import('esbuild')
  await build({ stdin: { contents: `
    import { createRoot } from 'react-dom/client';
    import { SessionWorkspace } from './src/renderer/components/SessionWorkspace';
    import './src/renderer/styles.css';
    const tabs = [{ id: 'tab-1', title: 'First session', status: 'running' }];
    createRoot(document.getElementById('root')).render(<SessionWorkspace tabs={tabs} activeTabId="tab-1" obscured={false} canOpenTab={false}
      onActivate={() => {}} onCreate={() => {}} onFork={() => {}} onClose={() => {}} onRestart={() => {}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(artifacts, 'fixture.js'), platform: 'browser', jsx: 'automatic',
    plugins: [{ name: 'fixture-terminal', setup(build) {
      build.onResolve({ filter: /TerminalPane\.js$/ }, () => ({ path: 'terminal', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react"; export function TerminalPane({tabId}) { return <div data-terminal>{tabId} terminal fixture</div>; }', loader: 'jsx', resolveDir: process.cwd() }))
    } }],
  })
  await writeFile(join(artifacts, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root" style="display:flex;height:100vh"><script src="fixture.js"></script></div></body></html>')
  const env = { ...process.env, COPILOT_DESKTOP_BROWSER_STATE: join(artifacts, 'control.json') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 120000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Browser certificate check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true, 'All certificate checks must complete before Electron exits')
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, 'profile'))
  void run().catch(error => { console.error(error); app.exit(1) })

  /** A key and self-signed certificate for a name the check never visits, so every address gets a name mismatch. */
  async function certificate(name) {
    const key = join(artifacts, `${name}.key`)
    const cert = join(artifacts, `${name}.crt`)
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30',
      '-subj', `/CN=${name}.invalid`, '-addext', `subjectAltName=DNS:${name}.invalid`], { windowsHide: true })
    return { key: await readFile(key), cert: await readFile(cert) }
  }

  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserCommand } = await import('../dist/src/cli/browser-control.js')
    const serve = async (server, host = '127.0.0.1') => { await new Promise(accept => server.listen(0, host, accept)); return server.address().port }
    const requests = { bad: [], changed: [] }
    const pageFor = title => (request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><title>${title}</title><h1>${title}</h1><script>fetch('/api.json').then(r => r.json()).then(j => { document.title = '${title} ' + j.ok })</script>`)
    }
    const handler = (log, title) => (request, response) => {
      log.push(request.url)
      if (request.url === '/api.json') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":"api"}'); return }
      pageFor(title)(request, response)
    }
    const badPort = await serve(createHttpsServer(await certificate('bad'), handler(requests.bad, 'Bad site')))
    const changedPort = await serve(createHttpsServer(await certificate('changed'), handler(requests.changed, 'Changed site')))
    const bad = `https://127.0.0.1:${badPort}/`
    const changed = `https://127.0.0.1:${changedPort}/`
    const plainPort = await serve(createHttpServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      // An unaccepted host, with the certificate this check accepts for 127.0.0.1, as an image and a frame of a plain page.
      if (request.url === '/embeds') response.end(`<!doctype html><title>Embeds</title><img src="https://localhost:${badPort}/pixel"><iframe src="https://localhost:${badPort}/frame"></iframe>`)
      else response.end('<!doctype html><title>Plain page</title><h1>Plain page</h1>')
    }))
    const plain = `http://127.0.0.1:${plainPort}/`

    const window = new BrowserWindow({ width: 1200, height: 860, show: false, webPreferences: {
      preload: resolve('src/preload/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    } })
    const browser = new BrowserDebug(window, join(artifacts, 'settings.json'), { popupWindows: () => true })
    ipcMain.handle('desktop:browser-open', () => browser.open())
    ipcMain.handle('desktop:browser-state', () => browser.snapshot)
    ipcMain.handle('desktop:browser-navigate', (_event, _tabId, value) => browser.navigate(value))
    ipcMain.handle('desktop:browser-action', (_event, _tabId, action) => browser.action(action))
    ipcMain.handle('desktop:browser-bounds', (_event, _tabId, bounds) => { browser.setBounds(bounds) })
    const ui = code => window.webContents.executeJavaScript(code)
    const shot = async name => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    const go = async address => {
      await ui(`(() => {
        const input = document.querySelector('[aria-label="Web app URL"]');
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(address)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.browser-toolbar').requestSubmit();
      })()`)
    }
    const click = text => ui(`[...document.querySelectorAll('.browser-certificate button')].find(button => button.textContent.startsWith(${JSON.stringify(text)})).click()`)
    const warned = id => until(async () => { const warning = browser.snapshot.certificateWarning; return warning && warning.id !== id && await ui('Boolean(document.querySelector(".browser-certificate"))') ? warning : null }, 'certificate warning')
      .catch(error => { const { activePageId, pages, error: failure, certificateWarning, view } = browser.snapshot; throw new Error(`${error.message} after ${id}: ${JSON.stringify({ activePageId, pages, failure, certificateWarning, view })}`) })
    const cleared = () => until(async () => !browser.snapshot.certificateWarning && await ui('!document.querySelector(".browser-certificate")'), 'warning cleared')
    const title = expected => until(() => browser.view.webContents.getTitle() === expected, `page title ${expected}`)

    window.showInactive()
    await window.loadFile(join(artifacts, 'index.html'))
    await until(() => ui('document.querySelector(".session-browser-toggle") !== null'), 'browser toggle')
    await ui('document.querySelector(".session-browser-toggle").click()')
    await until(() => ui('Boolean(document.querySelector(".browser-panel"))'), 'browser pane')
    await delay(300)

    // The address bar reaches an untrusted certificate: the panel warns in place of the page, and nothing was sent to the site.
    await go(bad)
    let warning = await warned()
    assert.equal(warning.error, 'ERR_CERT_AUTHORITY_INVALID', 'Chromium ranks an untrusted issuer above the name mismatch')
    assert.equal(warning.host, '127.0.0.1')
    assert.match(warning.subject, /bad\.invalid/)
    assert.match(warning.fingerprint, /^sha256\//)
    assert.deepEqual(requests.bad, [], 'a refused certificate sends no request')
    assert.equal(browser.view.getVisible(), false, 'the page is hidden behind the warning')
    assert.equal(browser.snapshot.url, bad, 'the address bar keeps the refused address')
    assert.equal(await ui('document.querySelector(".browser-error")'), null, 'the warning replaces the error line')
    assert.equal(await ui('document.querySelector(".browser-certificate").closest(".browser-viewport") !== null'), true, 'the warning fills the page area')
    assert.equal(await ui('document.querySelector(".browser-certificate details").open'), false, 'Proceed starts behind Advanced')
    assert.equal(await ui('document.activeElement?.closest(".browser-certificate") ?? null'), null, 'the warning does not take focus from typing')
    assert.equal(browser.snapshot.certificateBypass, undefined)
    await shot('warning')

    // The assistant's status reports the failure, without the warning it cannot answer.
    const status = await browserCommand(['status'])
    assert.equal(status.error, 'ERR_CERT_AUTHORITY_INVALID')
    assert.equal(status.certificateWarning, undefined, 'the warning stays out of CLI metadata')

    // Reloading asks again, and an answer for the replaced warning does nothing.
    await ui('document.querySelector("[aria-label=\\"Reload browser\\"]").click()')
    const reloaded = await warned(warning.id)
    browser.action(`certificate-proceed:${warning.id}`)
    await delay(500)
    assert.equal(browser.snapshot.certificateWarning?.id, reloaded.id, 'a stale answer leaves the current warning')
    assert.deepEqual(requests.bad, [], 'a stale answer accepts nothing')
    assert.throws(() => browser.action('certificate-proceed:abc'), /Unknown browser action/)
    warning = reloaded

    // Go back with no history blanks the tab, accepts nothing, and Chromium does not remember the refusal.
    await click('Go back')
    await cleared()
    await until(() => browser.view.getVisible(), 'page shown again')
    await until(() => browser.view.webContents.getURL() === 'about:blank' && !browser.snapshot.loading, 'blank page after Go back')
    assert.equal(browser.snapshot.error, null)
    assert.deepEqual(requests.bad, [])
    await go(bad)
    warning = await warned(warning.id)
    assert.deepEqual(requests.bad, [], 'Go back accepted nothing')

    // Proceed loads the page and its own resources, and the toolbar says it is not secure.
    await until(() => !browser.snapshot.loading && ui('!document.querySelector(".browser-footer").textContent.startsWith("Loading")'), 'the failed load stops loading')
    await ui('document.querySelector(".browser-certificate summary").click()')
    await until(() => ui('[...document.querySelectorAll(".browser-certificate button")].some(button => button.textContent.startsWith("Proceed") && button.getBoundingClientRect().height > 0)'), 'Proceed shown under Advanced')
    await delay(300)
    await shot('advanced')
    await click('Proceed to 127.0.0.1')
    await cleared()
    await title('Bad site api')
    assert.equal(browser.view.getVisible(), true)
    assert.equal(browser.snapshot.error, null)
    assert.equal(browser.snapshot.certificateBypass, true)
    assert.deepEqual(requests.bad, ['/', '/api.json'])
    await until(() => ui('document.querySelector(".browser-not-secure") !== null'), 'not secure indicator')
    await shot('proceeded')

    // The accepted certificate keeps working: a reload and a new page on the same host do not warn.
    const seen = requests.bad.length
    browser.action('reload')
    await until(() => requests.bad.length >= seen + 2 && !browser.snapshot.loading, 'accepted page reloaded')
    assert.equal(browser.snapshot.certificateWarning, undefined)
    await browser.navigate(`${bad}other`)
    assert.equal(browser.snapshot.certificateWarning, undefined, 'the same certificate on the same host does not warn again')

    // Another certificate on the host warns again, and Go back returns to the page before it.
    await go(changed)
    warning = await warned(warning.id)
    assert.match(warning.subject, /changed\.invalid/)
    assert.deepEqual(requests.changed, [], 'a changed certificate is not covered')
    assert.equal(browser.snapshot.certificateBypass, undefined, 'the warning replaces the not secure indicator')
    await click('Go back')
    await cleared()
    await until(() => browser.view.webContents.getURL() === `${bad}other` && !browser.snapshot.loading, 'back to the accepted page')
    assert.equal(browser.view.getVisible(), true)
    assert.deepEqual(requests.changed, [])

    // Resources and frames with a certificate nobody accepted fail quietly: no warning, and the page stays.
    await browser.navigate(`${plain}embeds`)
    const embedded = requests.bad.length
    await title('Embeds')
    await delay(1000)
    assert.equal(browser.snapshot.certificateWarning, undefined, 'only a main document warns')
    assert.equal(browser.view.getVisible(), true)
    assert.equal(browser.snapshot.certificateBypass, undefined, 'a plain address is not marked')
    assert.equal(requests.bad.length, embedded, 'an unaccepted host gets no request')

    // A new navigation takes the warning away, without an answer.
    await browser.navigate(`https://localhost:${badPort}/`)
    warning = await warned(warning.id)
    assert.equal(warning.host, 'localhost')
    await go(plain)
    await cleared()
    await title('Plain page')
    assert.equal(browser.view.getVisible(), true)
    assert.equal(browser.snapshot.error, null, 'the address bar clears the old failure')

    // A popup window has no panel, so its warning shows above the page that opened it.
    const openPopup = async address => {
      const before = new Set(browser.snapshot.pages.map(page => page.id))
      browser.view.webContents.focus()
      for (const type of ['mouseDown', 'mouseUp']) browser.view.webContents.sendInputEvent({ type, x: 20, y: 20, button: 'left', clickCount: 1 })
      await delay(200)
      await browser.view.webContents.executeJavaScript(`void window.open(${JSON.stringify(address)}, '_blank', 'width=500,height=400')`, true)
      return until(() => browser.snapshot.pages.find(page => !before.has(page.id)), 'popup page')
    }
    const opener = browser.snapshot.activePageId
    const popup = await openPopup(`https://localhost:${badPort}/`)
    assert.equal(popup.window, true, 'the page opened in its own window')
    warning = await warned(warning.id)
    assert.equal(warning.pageId, popup.id)
    assert.equal(browser.snapshot.activePageId, opener)
    assert.equal(browser.view.getVisible(), true, 'the opener stays on show')
    assert.equal(await ui('Boolean(document.querySelector(".browser-certificate-banner"))'), true, 'a popup warning is a banner')
    assert.equal(await ui('document.querySelector(".browser-error")'), null, 'the banner replaces the error line')
    await until(() => ui('document.querySelector(".browser-certificate-banner").textContent.includes("In the popup window")'), 'popup named in the banner')
    await shot('popup')
    await click('Go back')
    await until(() => !browser.snapshot.pages.some(page => page.id === popup.id), 'Go back closes the popup')
    await cleared()

    const second = await openPopup(`https://localhost:${badPort}/second`)
    warning = await warned(warning.id)
    assert.equal(warning.pageId, second.id)
    await click('Proceed to localhost')
    await cleared()
    await until(() => requests.bad.includes('/second'), 'popup loaded after Proceed')
    browser.action(`close-page:${second.id}`)

    // A name mismatch from a trusted issuer is ERR_CERT_COMMON_NAME_INVALID (-200), which only a verifier can produce here:
    // a self-signed certificate is reported as untrusted first. A new certificate, because Chromium caches verification results.
    const mismatchPort = await serve(createHttpsServer(await certificate('mismatch'), handler(requests.bad, 'Mismatch site')))
    browser.view.webContents.session.setCertificateVerifyProc((_request, callback) => callback(-200))
    await go(`https://127.0.0.1:${mismatchPort}/mismatch`)
    warning = await warned(warning.id)
    assert.equal(warning.error, 'ERR_CERT_COMMON_NAME_INVALID')
    assert.equal(await ui('document.querySelector(".browser-certificate").textContent.includes("The certificate is not valid for 127.0.0.1.")'), true)
    assert.equal(requests.bad.includes('/mismatch'), false)
    await shot('name-mismatch')
    await ui('document.querySelector(".browser-certificate details").open = true')
    await click('Proceed to 127.0.0.1')
    await cleared()
    await title('Mismatch site api')
    assert.equal(browser.snapshot.certificateBypass, true)

    // Errors a person cannot judge have no way past them: no Proceed, and an answer for one accepts nothing.
    for (const [code, error, text] of [[-206, 'ERR_CERT_REVOKED', 'has been revoked'], [-207, 'ERR_CERT_INVALID', 'could not be verified'], [-203, 'ERR_CERT_CONTAINS_ERRORS', 'could not be verified']]) {
      const log = []
      const port = await serve(createHttpsServer(await certificate(`refused${-code}`), handler(log, 'Refused site')))
      browser.view.webContents.session.setCertificateVerifyProc((_request, callback) => callback(code))
      await go(`https://127.0.0.1:${port}/`)
      warning = await warned(warning.id)
      assert.equal(warning.error, error)
      await until(() => ui(`document.querySelector(".browser-certificate").textContent.includes(${JSON.stringify(text)})`), `${error} explained`)
      await ui('document.querySelector(".browser-certificate details").open = true')
      assert.equal(await ui('document.querySelector(".browser-certificate-proceed")'), null, `${error} offers no Proceed`)
      assert.equal(await ui('[...document.querySelectorAll(".browser-certificate button")].some(button => button.textContent === "Go back")'), true, `${error} offers Go back`)
      if (code === -206) { await delay(300); await shot('revoked') }
      browser.action(`certificate-proceed:${warning.id}`)
      await delay(500)
      assert.equal(browser.snapshot.certificateWarning?.id, warning.id, `an answer for ${error} leaves the warning`)
      assert.equal(browser.view.getVisible(), false, `the page stays hidden behind ${error}`)
      assert.equal(browser.snapshot.certificateBypass, undefined, `${error} is not marked as proceeded past`)
      assert.deepEqual(log, [], `an answer for ${error} accepts nothing`)
      await click('Go back')
      await cleared()
      await until(() => browser.view.getVisible() && !browser.snapshot.loading, `page shown after ${error}`)
      assert.deepEqual(log, [])
    }
    browser.view.webContents.session.setCertificateVerifyProc(null)

    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true }))
    console.log('Browser certificate check passed.')
    await browser.dispose()
    app.exit(0)
  }
}
