// Real Electron/Chromium check: the browser footer's Local Overrides status follows what the page's DevTools really uses.
// Before DevTools runs it comes from the saved preferences and says the overrides are not applied yet; once DevTools runs,
// shown or hidden, it comes from DevTools itself, and a change made in DevTools shows up without reopening anything.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-overrides-status')
const profileId = '55555555-5555-4555-8555-555555555555'
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (read, label, timeoutMs = 15000) => {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) { last = await read(); if (last) return last; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const profile = await mkdtemp(join(artifacts, 'profile-'))
  const overrides = join(profile, 'overrides-folder')
  await mkdir(overrides, { recursive: true })
  // What DevTools saves after "Select folder for overrides" and enabling Local Overrides in an earlier session.
  await writeFile(join(profile, 'Preferences'), JSON.stringify({ devtools: { file_system_paths: { [overrides]: 'overrides' } } }))
  const partition = join(profile, 'Partitions', encodeURIComponent(`browser-debug:${profileId}`))
  await mkdir(partition, { recursive: true })
  await writeFile(join(partition, 'Preferences'), JSON.stringify({ electron: { devtools: { preferences: { 'persistence-network-overrides-enabled': 'true' } } } }))
  const site = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>fixture</title>') })
  await new Promise(accept => site.listen(0, '127.0.0.1', accept))
  try {
    const env = { ...process.env, STATUS_PROFILE: profile, STATUS_ORIGIN: `http://127.0.0.1:${site.address().port}`, STATUS_OVERRIDES: overrides }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 90000)
    try {
      const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
      assert.equal(code, 0, 'Local Overrides status check failed')
    } finally { clearTimeout(timer) }
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true }, null, 2))
    console.log('The Local Overrides status showed the saved folder before DevTools ran, then followed DevTools live, shown and hidden.')
  } finally { site.closeAllConnections(); site.close() }
} else {
  const { app, BrowserWindow } = await import('electron')
  const profile = process.env.STATUS_PROFILE
  const overrides = process.env.STATUS_OVERRIDES
  app.setPath('userData', profile)
  void run().catch(error => { console.error(error); app.exit(1) })

  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserProfilePaths } = await import('../dist/src/main/browser-profile.js')
    const { overridesStatus } = await import('../dist/src/main/browser-overrides-status.js')
    const owner = new BrowserWindow({ show: false })
    const paths = browserProfilePaths(profile, profileId)
    const browser = new BrowserDebug(owner, paths.settings, { partition: paths.partition, endpointPath: join(profile, 'control.json'),
      reportError: message => console.error(message) })
    const status = async (label, matches) => until(() => { const state = browser.snapshot.overrides; return state && matches(state) ? state : null }, label)
    const sameFolder = state => state.folder?.toLowerCase() === overrides.toLowerCase()
    try {
      await browser.navigate(`${process.env.STATUS_ORIGIN}/`)
      const saved = await status('saved settings read', state => state.enabled && sameFolder(state))
      assert.equal(saved.devtools, false, 'no DevTools runs for the page yet')
      assert.equal(overridesStatus(saved).tone, 'warning', 'enabled overrides that do not apply yet are a warning')

      browser.action('devtools')
      const live = await status('DevTools answered', state => state.devtools)
      assert.ok(live.enabled && sameFolder(live), `DevTools uses the saved folder and toggle: ${JSON.stringify(live)}`)
      assert.equal(overridesStatus(live).tone, 'on')

      // Hidden DevTools still applies overrides.
      browser.action('view:page')
      await delay(1500)
      assert.equal(browser.snapshot.overrides?.devtools, true, 'hidden DevTools still counts as running')

      // Turning Local Overrides off in DevTools shows up without reopening anything.
      await browser.view.webContents.devToolsWebContents.executeJavaScript(`(async () => {
        const Common = await import('devtools://devtools/bundled/core/common/common.js');
        Common.Settings.Settings.instance().moduleSetting('persistence-network-overrides-enabled').set(false);
      })()`)
      const off = await status('toggle change seen', state => !state.enabled)
      assert.equal(overridesStatus(off).text, 'Local Overrides: off')
    } finally {
      await browser.dispose()
      owner.destroy()
    }
    app.quit()
  }
}
