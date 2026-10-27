// Real Chromium regression: popup overrides must affect the first response, without showing DevTools or replaying POSTs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-popup-overrides')
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (read, label) => {
  const end = Date.now() + 20000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50) }
  throw new Error(`Timed out: ${label}`)
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const profile = await mkdtemp(join(artifacts, 'profile-'))
  const sharedFolder = join(profile, 'shared-overrides')
  const privateFolder = join(profile, 'private-overrides')
  const posts = []
  const site = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    if (request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      posts.push({ path: request.url, body, referrer: request.headers.referer })
    }
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('<!doctype html><title>incomplete network stream</title>')
      return // A content override must not wait for this response body to finish.
    }
    if (request.url === '/shared.js') {
      response.setHeader('content-type', 'application/javascript')
      response.end('window.marker = "network"')
    } else {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>network document</title><script src="/shared.js"></script>')
    }
  })
  await new Promise(accept => site.listen(0, '127.0.0.1', accept))
  const origin = `http://127.0.0.1:${site.address().port}`
  const host = `127.0.0.1%3A${site.address().port}`
  const document = marker => `<!doctype html><title>${marker} document</title><script src="/shared.js"></script><script>window.opener?.postMessage("${marker}-ready", location.origin)</script>`
  for (const [folder, marker] of [[sharedFolder, 'shared'], [privateFolder, 'private']]) {
    await mkdir(join(folder, host), { recursive: true })
    await writeFile(join(folder, host, 'shared.js'), `window.marker = "${marker}"`)
    await writeFile(join(folder, host, '.headers'), JSON.stringify([{ applyTo: '*', headers: [
      { name: 'x-popup-override', value: marker },
    ] }]))
    for (const name of ['popup', 'post', 'nested', 'stream']) await writeFile(join(folder, host, name), document(marker))
  }
  // DevTools populates folders in 1000-file chunks; the first popup must wait for the final chunk too.
  await mkdir(join(sharedFolder, 'unrelated'), { recursive: true })
  await Promise.all(Array.from({ length: 1005 }, (_, index) => writeFile(join(sharedFolder, 'unrelated', `${index}.txt`), 'fixture')))
  await writeFile(join(profile, 'Preferences'), JSON.stringify({ devtools: { file_system_paths: { [sharedFolder]: 'overrides' } } }))
  const cases = [
    { id: '11111111-1111-4111-8111-111111111111', enabled: true },
    { id: '22222222-2222-4222-8222-222222222222', enabled: true, private: true },
    { id: '33333333-3333-4333-8333-333333333333', enabled: false },
  ]
  for (const entry of cases) {
    const partition = join(profile, 'Partitions', encodeURIComponent(`browser-debug:${entry.id}`))
    await mkdir(partition, { recursive: true })
    await writeFile(join(partition, 'Preferences'), JSON.stringify({ electron: { devtools: { preferences: {
      'persistence-network-overrides-enabled': String(entry.enabled),
    } } } }))
    if (entry.private) {
      const toolsPartition = join(profile, 'Partitions', encodeURIComponent(`browser-devtools:${entry.id}`))
      await mkdir(toolsPartition, { recursive: true })
      await writeFile(join(toolsPartition, 'Preferences'), JSON.stringify({ devtools: { file_system_paths: { [privateFolder]: 'overrides' } } }))
    }
  }
  try {
    const env = { ...process.env, POPUP_PROFILE: profile, POPUP_ORIGIN: origin, POPUP_CASES: JSON.stringify(cases) }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 120000)
    try {
      const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
      assert.equal(code, 0, 'Popup Local Overrides check failed')
    } finally { clearTimeout(timer) }
    assert.equal(posts.length, 2, 'each shared/private POST reaches the server exactly once')
    assert.ok(posts.every(post => post.path === '/post' && post.body === 'fixture=kept' && post.referrer === `${origin}/parent`))
    const results = JSON.parse(await readFile(join(profile, 'cases.json'), 'utf8'))
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, results, posts }, null, 2))
    console.log('Popup first-response overrides, hidden DevTools, POST/opener semantics, nested popups, private folders and disabled overrides passed.')
  } finally { site.closeAllConnections(); site.close() }
} else {
  const { app, BrowserWindow } = await import('electron')
  const profile = process.env.POPUP_PROFILE
  const origin = process.env.POPUP_ORIGIN
  app.setPath('userData', profile)
  void run().catch(error => { console.error(error); app.exit(1) })

  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserProfilePaths } = await import('../dist/src/main/browser-profile.js')
    const { OVERRIDES_SCRIPT } = await import('../dist/src/main/browser-overrides.js')
    const owner = new BrowserWindow({ show: false })
    const browsers = []
    const results = []
    const loaded = (contents, marker) => until(async () => {
      if (contents.isLoadingMainFrame()) return false
      return await contents.executeJavaScript('window.marker') === marker
    }, `${marker} script loaded`)
    try {
      for (const entry of JSON.parse(process.env.POPUP_CASES)) {
        const paths = browserProfilePaths(profile, entry.id)
        const browser = new BrowserDebug(owner, paths.settings, { partition: paths.partition,
          ...(entry.private ? { devtoolsPartition: paths.devtoolsPartition } : {}), endpointPath: join(profile, `${entry.id}-control.json`) })
        browsers.push(browser)
        await browser.navigate(`${origin}/parent`)
        const parent = browser.view.webContents
        browser.action('devtools')
        const tools = await until(() => parent.devToolsWebContents, 'parent DevTools')
        await until(async () => {
          if (tools.isLoading()) return false
          const value = await tools.executeJavaScript(OVERRIDES_SCRIPT)
          return value?.enabled === entry.enabled && value.folders.length
        }, 'parent configured overrides')
        browser.action('view:page')
        await parent.executeJavaScript('window.readyMessage = ""; addEventListener("message", event => { window.readyMessage = event.data }); window.child = window.open("/popup", "_blank"); void 0')
        await until(() => browser.snapshot.pages.length === 2 && browser.view.webContents.id !== parent.id, 'popup tab created')
        const popup = browser.view.webContents
        const marker = entry.enabled ? (entry.private ? 'private' : 'shared') : 'network'
        // Wait for the first committed document. Do not reload or open this popup's DevTools.
        await until(() => !popup.isLoadingMainFrame() && popup.getURL() === `${origin}/popup`, 'initial popup navigation')
        assert.equal(await popup.executeJavaScript('document.title'), `${marker} document`, 'first popup document uses its override')
        assert.equal(browser.snapshot.view, 'page', 'activation never selects a DevTools panel')
        assert.equal(browser.snapshot.devtools, false, 'DevTools stays hidden')
        if (!entry.enabled) {
          assert.equal(popup.devToolsWebContents, null, 'disabled overrides do not start popup DevTools')
          results.push({ private: false, enabled: false, marker })
          continue
        }
        await loaded(popup, marker)
        assert.ok(popup.devToolsWebContents, 'native popup DevTools runs in the background')
        await until(() => parent.executeJavaScript(`window.readyMessage === ${JSON.stringify(`${marker}-ready`)}`), 'opener callback preserved')
        await popup.executeJavaScript('window.nested = window.open("/nested", "_blank"); void 0')
        await until(() => browser.view.webContents.id !== popup.id, 'nested popup selected')
        const nested = browser.view.webContents
        await loaded(nested, marker)
        assert.equal(await nested.executeJavaScript('document.title'), `${marker} document`)
        browser.action(`close-page:${nested.id}`)
        browser.action(`select-page:${parent.id}`)
        await parent.executeJavaScript('const form = document.createElement("form"); form.method="POST"; form.action="/post"; form.target="_blank"; const input=document.createElement("input"); input.name="fixture"; input.value="kept"; form.append(input); document.body.append(form); form.requestSubmit(); void 0')
        await until(() => browser.view.webContents.id !== parent.id, 'POST popup selected')
        const post = browser.view.webContents
        await loaded(post, marker)
        assert.equal(await post.executeJavaScript('document.title'), `${marker} document`)
        browser.action(`close-page:${post.id}`)
        browser.action(`select-page:${parent.id}`)
        await parent.executeJavaScript('window.headerOnly=window.open("/header-only","_blank");void 0')
        await until(() => browser.view.webContents.id !== parent.id, 'header-only popup selected')
        const headerOnly = browser.view.webContents
        await loaded(headerOnly, marker)
        assert.equal(await headerOnly.executeJavaScript('document.title'), 'network document', 'header-only override preserves the network body')
        browser.action(`close-page:${headerOnly.id}`)
        if (!entry.private) {
          browser.action(`select-page:${parent.id}`)
          await parent.executeJavaScript('window.stream=window.open("/stream","_blank");void 0')
          await until(() => browser.view.webContents.id !== parent.id, 'streaming popup selected')
          const stream = browser.view.webContents
          await loaded(stream, marker)
          assert.equal(await stream.executeJavaScript('document.title'), `${marker} document`, 'content override does not await the original streaming body')
          browser.action(`close-page:${stream.id}`)
        }
        browser.action(`select-page:${parent.id}`)
        await parent.executeJavaScript('window.blank=window.open("", "_blank"); blank.document.write(\'<script src="/shared.js"></script>\'); blank.document.close(); void 0')
        await until(() => browser.view.webContents.id !== parent.id, 'written popup selected')
        const blank = browser.view.webContents
        await loaded(blank, marker)
        browser.action(`close-page:${blank.id}`)
        browser.action(`select-page:${parent.id}`)
        await parent.executeJavaScript('window.quick=window.open("/popup","_blank"); quick.close(); void 0')
        await until(() => browser.snapshot.pages.length === 2, 'closing a popup during activation')
        browser.action(`select-page:${popup.id}`)
        const folder = join(profile, entry.private ? 'private-overrides' : 'shared-overrides')
        const host = `127.0.0.1%3A${new URL(origin).port}`
        await writeFile(join(folder, host, 'shared.js'), `window.marker = "${marker}-updated"`)
        browser.action('hard-reload')
        await loaded(popup, `${marker}-updated`)
        const popupTools = popup.devToolsWebContents
        browser.action(`close-page:${popup.id}`)
        await until(() => popupTools.isDestroyed(), 'closing a popup disposes its hidden DevTools')
        if (!entry.private) {
          browser.action(`select-page:${parent.id}`)
          await tools.executeJavaScript('(async()=>{const C=await import("devtools://devtools/bundled/core/common/common.js");C.Settings.Settings.instance().moduleSetting("persistence-network-overrides-enabled").set(false);})()')
          await parent.executeJavaScript('window.off=window.open("/popup","_blank");void 0')
          await until(() => browser.view.webContents.id !== parent.id, 'popup after live disable')
          const off = browser.view.webContents
          await loaded(off, 'network')
          assert.equal(off.devToolsWebContents, null, 'a live disable wins over saved/footer settings')
          browser.action(`close-page:${off.id}`)
        }
        results.push({ private: Boolean(entry.private), enabled: true, marker })
      }
      await writeFile(join(profile, 'cases.json'), JSON.stringify(results))
    } finally {
      await Promise.all(browsers.map(browser => browser.dispose()))
      owner.destroy()
    }
    app.quit()
  }
}
