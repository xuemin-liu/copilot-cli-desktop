// Real Electron/Chromium check: a session that keeps Local Overrides to itself. Its DevTools starts with defaults instead
// of the shared settings, its folders and its Local Overrides switch stay its own, and none of it reaches the shared
// sessions, while it is open or after an app restart.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-overrides-private')
const sharedId = '11111111-1111-4111-8111-111111111111'
const privateId = '22222222-2222-4222-8222-222222222222'
const laterId = '33333333-3333-4333-8333-333333333333'
const restartId = '44444444-4444-4444-8444-444444444444'
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (read, label, timeoutMs = 20000) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const profile = await mkdtemp(join(artifacts, 'profile-'))
  const sharedFolder = join(profile, 'shared-overrides')
  const privateFolder = join(profile, 'private-overrides')
  await mkdir(sharedFolder, { recursive: true }); await mkdir(privateFolder, { recursive: true })
  const site = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>fixture</title>') })
  await new Promise(accept => site.listen(0, '127.0.0.1', accept))
  try {
    for (const phase of ['live', 'restart']) {
      const env = { ...process.env, PRIVATE_PROFILE: profile, PRIVATE_ORIGIN: `http://127.0.0.1:${site.address().port}`, PRIVATE_SHARED: sharedFolder, PRIVATE_FOLDER: privateFolder }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), phase], { env, stdio: 'inherit', windowsHide: true })
      const timer = setTimeout(() => child.kill(), 120000)
      try {
        const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
        assert.equal(code, 0, `private overrides ${phase} phase failed`)
      } finally { clearTimeout(timer) }
    }
    const live = JSON.parse(await readFile(join(profile, 'live.json'), 'utf8'))
    const restart = JSON.parse(await readFile(join(profile, 'restart.json'), 'utf8'))
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, live, restart }, null, 2))
    console.log('A session with its own Local Overrides started with DevTools defaults, kept its folder and switch to itself while shared sessions kept theirs, and both survived a restart.')
  } finally { site.closeAllConnections(); site.close() }
} else {
  const { app, BrowserWindow } = await import('electron')
  const profile = process.env.PRIVATE_PROFILE
  const origin = process.env.PRIVATE_ORIGIN
  const sharedFolder = process.env.PRIVATE_SHARED
  const privateFolder = process.env.PRIVATE_FOLDER
  app.setPath('userData', profile)
  void run().catch(error => { console.error(error); app.exit(1) })

  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserProfilePaths } = await import('../dist/src/main/browser-profile.js')
    const { shareDevtoolsSettings } = await import('../dist/src/main/browser-devtools-settings.js')
    const owner = new BrowserWindow({ show: false })
    const browsers = []
    // As main.ts does: the DevTools settings step first, then the browser, private ones with their own DevTools partition.
    const open = (id, { private: own = false } = {}) => {
      shareDevtoolsSettings(profile, id, { private: own })
      const paths = browserProfilePaths(profile, id)
      const browser = new BrowserDebug(owner, paths.settings, { partition: paths.partition, endpointPath: join(profile, `${id}-control.json`),
        ...(own ? { devtoolsPartition: paths.devtoolsPartition } : {}), reportError: message => console.error(message) })
      browsers.push(browser)
      return browser
    }
    const devtools = async browser => {
      browser.action('devtools')
      const tools = await until(() => browser.view.webContents.devToolsWebContents, 'DevTools opened')
      await until(() => tools.executeJavaScript('Boolean(globalThis.DevToolsAPI)'), 'DevTools frontend')
      return tools
    }
    const devtoolsState = async tools => until(() => tools.executeJavaScript(`(async () => {
      const Common = await import('devtools://devtools/bundled/core/common/common.js');
      if (!Common.Settings.Settings.hasInstance()) return null;
      const Persistence = await import('devtools://devtools/bundled/models/persistence/persistence.js');
      const manager = Persistence.IsolatedFileSystemManager.IsolatedFileSystemManager.instance();
      await manager.waitForFileSystems();
      return {
        overridesEnabled: Common.Settings.Settings.instance().moduleSetting('persistence-network-overrides-enabled').get(),
        folders: manager.fileSystems().map(fs => fs.path()).filter(path => path.startsWith('file:')).map(path => decodeURIComponent(new URL(path).pathname).replace(/^\\//, '').toLowerCase()),
      };
    })()`), 'DevTools state')
    const enableOverrides = tools => tools.executeJavaScript(`(async () => {
      const Common = await import('devtools://devtools/bundled/core/common/common.js');
      Common.Settings.Settings.instance().moduleSetting('persistence-network-overrides-enabled').set(true);
    })()`)
    const saved = async file => { try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null } }
    const partitionPrefs = id => saved(join(profile, 'Partitions', encodeURIComponent(`browser-debug:${id}`), 'Preferences'))
    const has = (folders, folder) => folders.includes(folder.replace(/\\/g, '/').toLowerCase())

    try {
      if (process.argv[2] === 'live') {
        // A shared session sets up the shared overrides: a folder and the switch on.
        const shared = open(sharedId)
        await shared.navigate(`${origin}/shared`)
        const sharedTools = await devtools(shared)
        shared.view.webContents.addWorkSpace(sharedFolder)
        await enableOverrides(sharedTools)
        await until(async () => (await partitionPrefs(sharedId))?.electron?.devtools?.preferences?.['persistence-network-overrides-enabled'] === 'true', 'shared switch saved', 60000)
        await until(async () => (await saved(join(profile, 'Preferences')))?.devtools?.file_system_paths?.[sharedFolder] !== undefined, 'shared folder saved', 60000)

        // A private session starts with defaults: switch off, and none of the shared folders.
        const own = open(privateId, { private: true })
        await own.navigate(`${origin}/own`)
        const ownTools = await devtools(own)
        const fresh = await devtoolsState(ownTools)
        assert.equal(fresh.overridesEnabled, false, 'the shared switch is not copied in')
        assert.ok(!has(fresh.folders, sharedFolder), `the shared folder is not listed: ${JSON.stringify(fresh.folders)}`)
        // It sets up its own.
        own.view.webContents.addWorkSpace(privateFolder)
        await enableOverrides(ownTools)
        await until(async () => (await partitionPrefs(privateId))?.electron?.devtools?.preferences?.['persistence-network-overrides-enabled'] === 'true', 'private switch saved', 60000)
        const ownState = await devtoolsState(ownTools)
        assert.ok(has(ownState.folders, privateFolder), `its own folder: ${JSON.stringify(ownState.folders)}`)
        const footer = await until(() => { const state = own.snapshot.overrides; return state?.devtools ? state : null }, 'footer status')
        assert.equal(footer.scope, 'session', 'the footer says these are this session\'s own')
        assert.equal((await until(() => shared.snapshot.overrides, 'shared footer')).scope, 'shared')

        // The shared session never sees the private folder, and a shared session opened later gets the shared settings only.
        assert.ok(!has((await devtoolsState(sharedTools)).folders, privateFolder))
        const later = open(laterId)
        await later.navigate(`${origin}/later`)
        const laterState = await devtoolsState(await devtools(later))
        assert.equal(laterState.overridesEnabled, true, 'a later shared session gets the shared switch')
        assert.ok(has(laterState.folders, sharedFolder) && !has(laterState.folders, privateFolder), JSON.stringify(laterState.folders))
        await writeFile(join(profile, 'live.json'), JSON.stringify({ fresh, ownState, laterState }))
      } else {
        // After a restart: startup gathers the shared settings first, as main.ts does. The private session's settings stay out.
        shareDevtoolsSettings(profile)
        const store = await saved(join(profile, 'browser-devtools.json'))
        assert.deepEqual(store.private, [privateId])
        const own = open(privateId, { private: true })
        await own.navigate(`${origin}/own-again`)
        const ownState = await devtoolsState(await devtools(own))
        assert.equal(ownState.overridesEnabled, true, 'its own switch survives a restart')
        assert.ok(has(ownState.folders, privateFolder) && !has(ownState.folders, sharedFolder), `its own folder survives, alone: ${JSON.stringify(ownState.folders)}`)
        const next = open(restartId)
        await next.navigate(`${origin}/next`)
        const nextState = await devtoolsState(await devtools(next))
        assert.equal(nextState.overridesEnabled, true)
        assert.ok(has(nextState.folders, sharedFolder) && !has(nextState.folders, privateFolder), JSON.stringify(nextState.folders))
        await writeFile(join(profile, 'restart.json'), JSON.stringify({ ownState, nextState }))
      }
    } finally {
      await Promise.all(browsers.map(browser => browser.dispose()))
      owner.destroy()
    }
    app.quit()
  }
}
