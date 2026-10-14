// Real Electron/Chromium check: site permissions and zoom are shared by every session's browser and kept across
// restarts, and the shared browser profile gives sessions one set of cookies while each keeps its own pages and capture.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-profile-share')
const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const thirdId = '33333333-3333-4333-8333-333333333333'
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (read, label, timeoutMs = 15000) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const profile = await mkdtemp(join(artifacts, 'profile-'))
  const site = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); return }
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>fixture</title><p>fixture</p>')
  })
  await new Promise(accept => site.listen(0, '127.0.0.1', accept))
  const origin = `http://127.0.0.1:${site.address().port}`
  try {
    for (const phase of ['separate', 'shared', 'restart']) {
      const env = { ...process.env, SHARE_PROFILE: profile, SHARE_ORIGIN: origin }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), phase], { env, stdio: 'inherit', windowsHide: true })
      const timer = setTimeout(() => child.kill(), 60000)
      try {
        const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
        assert.equal(code, 0, `Browser profile sharing ${phase} phase failed`)
      } finally { clearTimeout(timer) }
    }
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, separateSessionsShareZoomAndPermissions: true,
      sharedProfileSharesCookies: true, captureStaysPerSession: true, keptAcrossRestart: true }, null, 2))
    console.log('Zoom and site permissions carry across separate sessions and restarts; the shared profile shares cookies while capture stays per session.')
  } finally { site.closeAllConnections(); site.close() }
} else {
  const { app, BrowserWindow } = await import('electron')
  const profile = process.env.SHARE_PROFILE
  const origin = process.env.SHARE_ORIGIN
  app.setPath('userData', profile)
  void run().catch(error => { console.error(error); app.exit(1) })

  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { SitePermissions } = await import('../dist/src/main/browser-permissions.js')
    const { BrowserZoom } = await import('../dist/src/main/browser-zoom.js')
    const { SHARED_BROWSER_PROFILE_ID, browserProfilePaths } = await import('../dist/src/main/browser-profile.js')
    const fail = message => { throw new Error(message) }
    // The same shared stores main.ts gives every session's browser.
    const sitePermissions = new SitePermissions(undefined, { file: join(profile, 'browser-permissions.json'), reportError: fail })
    const zoom = new BrowserZoom(join(profile, 'browser-zoom.json'), fail)
    const owner = new BrowserWindow({ show: false })
    const prompts = []
    const browsers = []
    const open = (id, shared) => {
      const browser = new BrowserDebug(owner, browserProfilePaths(profile, id).settings, {
        partition: browserProfilePaths(profile, shared ? SHARED_BROWSER_PROFILE_ID : id).partition,
        endpointPath: join(profile, `${id}-control.json`), sitePermissions, zoom, reportError: message => console.error(message),
        approvePermission: async description => { prompts.push(description); return true } })
      browsers.push(browser)
      return browser
    }
    const run = (browser, code) => browser.view.webContents.executeJavaScript(code, true)
    const notifications = browser => run(browser, 'Notification.permission')

    try {
      if (process.argv[2] === 'separate') {
        const first = open(firstId, false)
        const second = open(secondId, false)
        assert.notEqual(first.partition, second.partition)
        await first.navigate(`${origin}/first`)
        await second.navigate(`${origin}/second`)

        // Zoom: one session zooms a site, and the other session showing that site follows at once.
        first.action('zoom-in')
        assert.equal(first.snapshot.zoomFactor, 1.1)
        await until(() => second.snapshot.zoomFactor === 1.1, 'second session follows the zoom live')
        const third = open(thirdId, false)
        await third.navigate(`${origin}/third`)
        await until(() => third.snapshot.zoomFactor === 1.1, 'a session opened later starts at the saved zoom')

        // Site permissions: answered once, then every session's pages have it without another prompt.
        assert.equal(await notifications(second), 'denied', 'nothing is allowed before the user answers')
        assert.equal(await run(first, 'Notification.requestPermission()'), 'granted')
        assert.equal(prompts.length, 1)
        assert.match(prompts[0], /every session's browser/)
        assert.equal(await notifications(second), 'granted', 'a separate session sees the answer')
        assert.equal(await run(third, 'Notification.requestPermission()'), 'granted')
        assert.equal(prompts.length, 1, 'no second prompt')
        // Closing a session keeps the answers for the others.
        await first.dispose()
        assert.equal(await notifications(second), 'granted')
        assert.equal(second.snapshot.sitePermissions.length, 1)

        // Separate sessions still keep their own cookies.
        await run(second, 'document.cookie = "who=second; Max-Age=3600; Path=/"')
        assert.equal(await run(third, 'document.cookie'), '')
      } else if (process.argv[2] === 'shared') {
        const first = open(firstId, true)
        const second = open(secondId, true)
        assert.equal(first.partition, second.partition)
        await first.navigate(`${origin}/first`)
        await second.navigate(`${origin}/second`)
        // One set of cookies and storage, like one Chrome profile.
        await run(first, 'document.cookie = "login=shared-user; Max-Age=3600; Path=/"; localStorage.setItem("user", "shared-user")')
        assert.equal(await run(second, 'document.cookie'), 'login=shared-user')
        assert.equal(await run(second, 'localStorage.getItem("user")'), 'shared-user')
        // Pages, capture and permission checks stay with the browser that owns the page.
        await run(first, 'fetch("/api/first").then(r => r.text())')
        await run(second, 'fetch("/api/second").then(r => r.text())')
        const captured = browser => browser.snapshot.network.map(entry => new URL(entry.url).pathname).filter(path => path.startsWith('/api/'))
        await until(() => captured(first).length && captured(second).length, 'both sessions capture network')
        assert.deepEqual(captured(first), ['/api/first'])
        assert.deepEqual(captured(second), ['/api/second'])
        assert.equal(await notifications(first), 'granted', 'saved answer applies on the shared profile')
        assert.equal(await notifications(second), 'granted')
        // Closing one session leaves the shared session's hooks working for the other.
        await first.dispose()
        await run(second, 'fetch("/api/after-close").then(r => r.text())')
        await until(() => captured(second).includes('/api/after-close'), 'capture continues after another session closes')
        assert.equal(await notifications(second), 'granted')
        assert.equal(await run(second, 'document.cookie'), 'login=shared-user')
      } else {
        const browser = open(thirdId, false)
        await browser.navigate(`${origin}/restart`)
        await until(() => browser.snapshot.zoomFactor === 1.1, 'zoom survives a restart')
        assert.equal(await notifications(browser), 'granted', 'site permission survives a restart')
        assert.equal(prompts.length, 0)
        const shared = open(secondId, true)
        await shared.navigate(`${origin}/shared`)
        assert.equal(await run(shared, 'document.cookie'), 'login=shared-user', 'shared logins survive a restart')
        assert.deepEqual(JSON.parse(await readFile(join(profile, 'browser-zoom.json'), 'utf8')), { '127.0.0.1': 1.1 })
      }
    } finally {
      await Promise.all(browsers.map(browser => browser.dispose()))
      await Promise.all([sitePermissions.flush(), zoom.flush()])
      owner.destroy()
    }
    app.quit()
  }
}
