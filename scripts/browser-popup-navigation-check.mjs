import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-popup-navigation')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (read, name, timeoutMs = 15000) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50) }
  throw new Error(`Timed out: ${name}`)
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), '{"passed":false}')
  const profile = join(artifacts, `profile-${Date.now()}`)
  const folder = join(profile, 'overrides')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'fixture.txt'), 'fixture')
  await writeFile(join(profile, 'Preferences'), JSON.stringify({ devtools: { file_system_paths: { [folder]: 'overrides' } } }))
  const partition = join(profile, 'Partitions', encodeURIComponent('browser-debug:popup-navigation'))
  await mkdir(partition, { recursive: true })
  await writeFile(join(partition, 'Preferences'), JSON.stringify({ electron: { devtools: { preferences: {
    'persistence-network-overrides-enabled': 'true',
  } } } }))
  const env = { ...process.env, POPUP_NAVIGATION_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 120000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BaseWindow, BrowserWindow, webContents } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', process.env.POPUP_NAVIGATION_PROFILE)
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const requests = []
    const site = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ path: request.url, method: request.method, body, referrer: request.headers.referer })
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><title>${request.url}</title><p>Popup navigation fixture</p>`)
    })
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${site.address().port}`
    const folder = join(process.env.POPUP_NAVIGATION_PROFILE, 'overrides', `127.0.0.1%3A${site.address().port}`)
    await mkdir(folder, { recursive: true })
    for (const name of ['viewer', 'reused', 'posted']) await writeFile(join(folder, name),
      `<!doctype html><title>overridden ${name}</title><script>window.opener.popupReadyCount = (window.opener.popupReadyCount || 0) + 1</script>`)
    const window = new BrowserWindow({ show: false, width: 900, height: 700 })
    await window.loadURL('data:text/html,<title>Popup navigation host</title>')
    let ownWindow = true
    let passed = false
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), {
      endpointPath: join(artifacts, 'control.json'), popupWindows: () => ownWindow, partition: 'persist:browser-debug:popup-navigation',
    })
    try {
      browser.setBounds({ x: 0, y: 0, width: 800, height: 600 })
      window.show()
      await browser.open()
      await browser.navigate(`${base}/opener`)
      const contents = browser.view.webContents
      await until(() => !contents.isLoading(), 'opener loaded')
      browser.action('devtools')
      await until(() => contents.devToolsWebContents && !contents.devToolsWebContents.isLoading(), 'opener DevTools loaded')
      const { OVERRIDES_SCRIPT } = await import('../dist/src/main/browser-overrides.js')
      await until(async () => (await contents.devToolsWebContents.executeJavaScript(OVERRIDES_SCRIPT))?.enabled, 'overrides enabled')
      if (process.argv.includes('--no-overrides')) await contents.devToolsWebContents.executeJavaScript(`(async () => {
        const C = await import('devtools://devtools/bundled/core/common/common.js');
        C.Settings.Settings.instance().moduleSetting('persistence-network-overrides-enabled').set(false);
      })()`)
      browser.action('view:page')
      const overrideStartupFailure = process.argv.includes('--overrides-failure')
      const ensureDevtools = browser.ensureDevtools.bind(browser)
      browser.ensureDevtools = page => {
        if (overrideStartupFailure && page.contents.id !== contents.id) throw new Error('Simulated popup DevTools startup failure')
        const tools = ensureDevtools(page)
        if (!overrideStartupFailure && page.contents.id !== contents.id) {
          // A committed DevTools frame can run while its overall frontend load is still pending.
          tools.isLoading = () => true
          assert.equal(tools.getBackgroundThrottling(), false)
        }
        return tools
      }
      const popupWindows = () => BaseWindow.getAllWindows().filter(owner => owner !== window && !owner.isDestroyed())
      for (const inWindow of [true, false]) {
        ownWindow = inWindow
        contents.focus()
        contents.sendInputEvent({ type: 'mouseDown', x: 300, y: 200, button: 'left', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', x: 300, y: 200, button: 'left', clickCount: 1 })
        await until(() => browser.pages.get(contents.id).activatedAt > 0, 'opener receives native activation')
        await contents.executeJavaScript(`window.popup = window.open('/viewer#study/89', 'viewer', 'width=420,height=360');
          window.popup.document.body.style.backgroundColor = '#000000';
          window.popup.document.body.appendChild(Object.assign(window.popup.document.createElement('b'), {
            textContent: 'Initializing Study. Please wait...'
          })); void 0`)
        const entry = await until(() => browser.snapshot.pages.find(page => page.id !== contents.id), 'initializing popup created')
        const popup = webContents.fromId(entry.id)
        await until(() => popup.getURL() === `${base}/viewer#study/89` && !popup.isLoading(),
          'viewer loads without waiting for the full DevTools frontend load', 30000)
        assert.equal(Boolean(entry.window), inWindow)
        assert.equal(browser.snapshot.pages.length, 2, 'popup navigation does not create an extra blank page')
        const activationError = browser.pages.get(entry.id).error
        if (overrideStartupFailure) assert.match(activationError, /Could not activate Local Overrides/)
        else assert.equal(activationError, null, 'ordinary popup overrides activation must succeed')
        if (overrideStartupFailure) {
          // A popup window leaves its opener selected (selecting the popup would end the opener's Testing mode),
          // so the browser panel and page strip must show the popup's error instead.
          const shown = browser.snapshot
          assert.equal(shown.activePageId, inWindow ? contents.id : entry.id, 'a popup window leaves its opener selected')
          assert.match(shown.error ?? '', /Could not activate Local Overrides/, 'the browser panel shows the popup error')
          assert.match(shown.pages.find(page => page.id === entry.id)?.error ?? '', /Could not activate Local Overrides/, 'the page strip marks the failed popup')
          assert.equal(shown.errorPageId, inWindow ? entry.id : undefined, 'the desktop can name the popup window the error belongs to')
          // Titles can carry credentials, so the CLI status names the failed popup by id only.
          const secret = 'https://title.example.test/view?access_token=review-secret-title-token'
          await popup.executeJavaScript(`document.title = ${JSON.stringify(secret)}`)
          await until(() => popup.getTitle() === secret, 'secret-bearing popup title')
          const control = JSON.parse(await readFile(join(artifacts, 'control.json'), 'utf8'))
          const status = await (await fetch(`http://127.0.0.1:${control.port}/status`, { headers: { authorization: `Bearer ${control.token}` } })).json()
          assert.equal(JSON.stringify(status).includes('review-secret-title-token'), false, 'no popup title in CLI status')
          assert.match(status.error ?? '', /Could not activate Local Overrides/)
          assert.equal(status.errorPageId, inWindow ? entry.id : undefined)
          await popup.executeJavaScript(`document.title = '/viewer'`)
        }
        const overrides = !process.argv.includes('--no-overrides') && !overrideStartupFailure
        assert.equal(await popup.executeJavaScript('document.title'), overrides ? 'overridden viewer' : '/viewer', 'first response uses the configured overrides')
        assert.equal(await popup.executeJavaScript('window.opener.location.pathname'), '/opener', 'opener is preserved')
        await contents.executeJavaScript(`window.reused = window.open('/reused', 'viewer'); void 0`)
        await until(() => popup.getURL() === `${base}/reused` && !popup.isLoading(), 'named popup reused')
        assert.equal(await contents.executeJavaScript('window.reused === window.popup'), true, 'named navigation preserves the popup reference')
        assert.equal(browser.snapshot.pages.length, 2, 'named navigation does not create another page')
        if (overrides) {
          assert.equal(await popup.executeJavaScript('document.title'), 'overridden reused')
          assert.equal(await contents.executeJavaScript('window.popupReadyCount'), 2)
        }
        await contents.executeJavaScript(`(() => {
          const form = document.createElement('form');
          form.method = 'POST'; form.action = '/posted'; form.target = 'viewer';
          const input = document.createElement('input'); input.name = 'fixture'; input.value = 'kept';
          form.append(input); document.body.append(form); form.requestSubmit(); form.remove();
        })()`)
        await until(() => popup.getURL() === `${base}/posted` && !popup.isLoading(), 'POST navigates the existing popup')
        assert.equal(browser.snapshot.pages.length, 2)
        assert.equal(await popup.executeJavaScript('document.title'), overrides ? 'overridden posted' : '/posted')
        if (overrides) {
          assert.equal(await contents.executeJavaScript('window.popupReadyCount'), 3)
          await contents.executeJavaScript('window.popupReadyCount = 0')
        }
        await contents.executeJavaScript('window.popup.close()')
        await until(() => browser.snapshot.pages.length === 1 && popupWindows().length === 0, 'viewer popup closed')
        browser.action(`select-page:${contents.id}`)
        assert.equal(browser.snapshot.error, null, 'a closed popup takes its error with it')
      }
      assert.equal(requests.filter(request => request.path === '/viewer').length, 2, 'each viewer document is requested once, without replay')
      assert.equal(requests.filter(request => request.path === '/reused').length, 2)
      const posts = requests.filter(request => request.path === '/posted')
      assert.equal(posts.length, 2, 'each POST reaches the server exactly once')
      assert.ok(posts.every(request => request.method === 'POST' && request.body === 'fixture=kept' && request.referrer === `${base}/opener`))
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true }))
      passed = true
      console.log('PASS: popup initialization, first-response overrides, opener callbacks and named reuse in windows and tabs')
    } finally {
      await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close()
      if (passed) app.exit(0)
    }
  }
}
