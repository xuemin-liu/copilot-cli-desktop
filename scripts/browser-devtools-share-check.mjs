// Real Electron/Chromium check: DevTools settings and address-bar history carry from one session's browser to the next,
// both while the first session is open and after an app restart that prunes the closed sessions' partitions.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-devtools-share')
const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const thirdId = '33333333-3333-4333-8333-333333333333'
const controlId = '44444444-4444-4444-8444-444444444444'
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
  const overrides = join(profile, 'overrides-folder')
  await mkdir(overrides, { recursive: true })
  const site = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>fixture</title>') })
  await new Promise(accept => site.listen(0, '127.0.0.1', accept))
  const origin = `http://127.0.0.1:${site.address().port}`
  try {
    for (const phase of ['live', 'restart']) {
      const env = { ...process.env, SHARE_PROFILE: profile, SHARE_ORIGIN: origin, SHARE_OVERRIDES: overrides }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), phase], { env, stdio: 'inherit', windowsHide: true })
      const timer = setTimeout(() => child.kill(), 90000)
      try {
        const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
        assert.equal(code, 0, `DevTools sharing ${phase} phase failed`)
      } finally { clearTimeout(timer) }
    }
    const live = JSON.parse(await readFile(join(profile, 'live.json'), 'utf8'))
    const restart = JSON.parse(await readFile(join(profile, 'restart.json'), 'utf8'))
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, live, restart }, null, 2))
    console.log(`DevTools settings reached a session opened while the first was still running (Chromium saved them after ${live.savedAfterMs} ms).`)
    console.log('After a restart that pruned both earlier partitions, a new session still had the overrides folder, the toggle and the shared history.')
  } finally { site.closeAllConnections(); site.close() }
} else {
  const { app, BrowserWindow } = await import('electron')
  const profile = process.env.SHARE_PROFILE
  const origin = process.env.SHARE_ORIGIN
  const overrides = process.env.SHARE_OVERRIDES
  app.setPath('userData', profile)
  void run().catch(error => { console.error(error); app.exit(1) })

  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { BrowserHistory } = await import('../dist/src/main/browser-history.js')
    const { browserProfilePaths } = await import('../dist/src/main/browser-profile.js')
    const { pruneBrowserProfiles } = await import('../dist/src/main/browser-cleanup.js')
    const { shareDevtoolsSettings } = await import('../dist/src/main/browser-devtools-settings.js')
    const owner = new BrowserWindow({ show: false })
    const history = new BrowserHistory(join(profile, 'browser-history.json'), message => { throw new Error(message) })
    const browsers = []
    // Same order as main.ts: share settings into the partition, then let BrowserDebug create its session.
    const open = (id, share = true) => {
      if (share) shareDevtoolsSettings(profile, id)
      const paths = browserProfilePaths(profile, id)
      const browser = new BrowserDebug(owner, paths.settings, { partition: paths.partition, endpointPath: join(profile, `${id}-control.json`), history,
        reportError: message => console.error(message) })
      browsers.push(browser)
      return browser
    }
    const devtools = async browser => {
      browser.action('devtools')
      const tools = await until(() => browser.view.webContents.devToolsWebContents, 'DevTools opened')
      await until(() => tools.executeJavaScript('Boolean(globalThis.DevToolsAPI)'), 'DevTools frontend')
      return tools
    }
    // What a person would see in that session's DevTools: the Local Overrides toggle and the added folders.
    const devtoolsState = async tools => {
      await until(() => tools.executeJavaScript(`(async () => {
        const Persistence = await import('devtools://devtools/bundled/models/persistence/persistence.js');
        return Persistence.IsolatedFileSystemManager.IsolatedFileSystemManager.instance().fileSystems().length > 0;
      })()`), 'DevTools loaded its folders')
      return tools.executeJavaScript(`(async () => {
        const Common = await import('devtools://devtools/bundled/core/common/common.js');
        const Persistence = await import('devtools://devtools/bundled/models/persistence/persistence.js');
        return {
          overridesEnabled: Common.Settings.Settings.instance().moduleSetting('persistence-network-overrides-enabled').get(),
          folders: Persistence.IsolatedFileSystemManager.IsolatedFileSystemManager.instance().fileSystems().map(fs => fs.path()),
        };
      })()`)
    }
    const savedPreferences = async id => {
      const directory = id ? join(profile, 'Partitions', encodeURIComponent(`browser-debug:${id}`)) : profile
      try { return JSON.parse(await readFile(join(directory, 'Preferences'), 'utf8')) }
      catch { return null }
    }
    // DevTools names folders by file URL.
    const hasFolder = folders => folders.some(folder => folder.startsWith('file:') && fileURLToPath(folder).toLowerCase() === overrides.toLowerCase())

    try {
      if (process.argv[2] === 'live') {
        const first = open(firstId)
        await first.navigate(`${origin}/first?page=2`)
        const firstTools = await devtools(first)
        first.view.webContents.addWorkSpace(overrides)
        await firstTools.executeJavaScript(`(async () => {
          const Common = await import('devtools://devtools/bundled/core/common/common.js');
          Common.Settings.Settings.instance().moduleSetting('persistence-network-overrides-enabled').set(true);
        })()`)
        // Chromium writes Preferences on its own schedule; the next session only sees what has reached disk. The toggle is
        // saved in the session's partition, while the DevTools view's default session saves the folder for every session.
        const changedAt = Date.now()
        await until(async () => (await savedPreferences(firstId))?.electron?.devtools?.preferences?.['persistence-network-overrides-enabled'] === 'true',
          'Chromium saved the first session DevTools settings', 60000)
        const savedAfterMs = Date.now() - changedAt
        await until(async () => (await savedPreferences())?.devtools?.file_system_paths?.[overrides] !== undefined, 'Chromium saved the folder', 60000)

        // Control: without sharing, a new session's DevTools has the folder but Local Overrides stays off.
        const control = open(controlId, false)
        const controlState = await devtoolsState(await devtools(control))
        assert.equal(controlState.overridesEnabled, false, 'an unshared session starts with Local Overrides off')
        assert.ok(hasFolder(controlState.folders), 'the folder is already shared through the default session')

        const second = open(secondId)
        await second.navigate(`${origin}/second`)
        const secondState = await devtoolsState(await devtools(second))
        assert.equal(secondState.overridesEnabled, true, 'Local Overrides toggle carried over to a new session')
        assert.ok(hasFolder(secondState.folders), `Overrides folder carried over to a new session: ${JSON.stringify(secondState.folders)}`)

        const expectedHistory = [`${origin}/second`, `${origin}/first`]
        assert.deepEqual(first.snapshot.history.slice(0, 2), expectedHistory, 'first session sees the second session history')
        assert.deepEqual(second.snapshot.history.slice(0, 2), expectedHistory, 'second session sees the first session history')
        await history.flush()
        await writeFile(join(profile, 'live.json'), JSON.stringify({ savedAfterMs, secondState, history: second.snapshot.history }))
      } else {
        // Startup collects every partition before closed sessions are pruned, as main.ts does.
        shareDevtoolsSettings(profile)
        await pruneBrowserProfiles(profile, [thirdId])
        assert.equal(await savedPreferences(firstId), null, 'first session partition was pruned')
        assert.equal(await savedPreferences(secondId), null, 'second session partition was pruned')

        const third = open(thirdId)
        assert.deepEqual(third.snapshot.history.slice(0, 2), [`${origin}/second`, `${origin}/first`], 'history survives a restart')
        assert.ok(!JSON.stringify(third.snapshot.history).includes('?'), 'query strings are dropped')
        await third.navigate(`${origin}/third`)
        const thirdState = await devtoolsState(await devtools(third))
        assert.equal(thirdState.overridesEnabled, true, 'Local Overrides toggle survives a restart')
        assert.ok(hasFolder(thirdState.folders), `Overrides folder survives a restart: ${JSON.stringify(thirdState.folders)}`)
        await history.flush()
        const savedHistory = JSON.parse(await readFile(join(profile, 'browser-history.json'), 'utf8'))
        assert.deepEqual(savedHistory.slice(0, 3), [`${origin}/third`, `${origin}/second`, `${origin}/first`])
        await writeFile(join(profile, 'restart.json'), JSON.stringify({ thirdState, savedHistory }))
      }
    } finally {
      await Promise.all(browsers.map(browser => browser.dispose()))
      owner.destroy()
    }
    app.quit()
  }
}
