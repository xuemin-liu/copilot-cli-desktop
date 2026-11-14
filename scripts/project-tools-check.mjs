// Real Electron pages and session transports: no renderer mock can prove resources close.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/project-tools')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 120_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  void (async () => {
  const { app, BrowserWindow, webContents } = await import('electron')
  app.setPath('userData', join(out, `userdata-${Date.now()}`))
  await app.whenReady()
  const { ProjectToolService } = await import('../dist/src/main/project-tools.js')
  let tools, server, win
  try {
    server = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<title>${request.url}</title><input id="value"><button id="touch">touch</button><p>${request.url}</p>`) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    win = new BrowserWindow({ show: false, width: 1200, height: 800 })
    await win.loadURL('about:blank')
    const sessions = new Map([['s1', { workspaceProfileId: 'p1', status: 'running' }], ['s2', { workspaceProfileId: 'p1', status: 'running' }]])
    let currentSession = null
    let confirm = false, confirmations = 0
    const errors = []
    const options = { userData: app.getPath('userData'), owner: () => win,
      project: id => ['p1', 'p2'].includes(id) ? { name: id, path: out } : undefined,
      session: id => sessions.get(id), currentSession: () => currentSession, defaults: () => ({ shared: false, overrides: 'private' }),
      browserOptions: () => ({ confirmLeave: async () => { confirmations++; return confirm } }), changed: () => {}, error: error => errors.push(String(error)) }
    tools = new ProjectToolService(options)
    const state = () => tools.state().projects.find(project => project.profileId === 'p1')
    const action = value => tools.action('p1', value)
    const until = async (test, name) => { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (await test()) return; await delay(30) } throw new Error(`Timed out: ${name}`) }
    const contents = tab => webContents.fromId(tab.pageId)
    // Change ownership modes in the same Chromium session without importing private settings or losing cookies.
    const p2 = () => tools.state().projects.find(project => project.profileId === 'p2')
    await tools.action('p2', { type: 'overrides', mode: 'shared' })
    await tools.action('p2', { type: 'add', kind: 'browser' })
    await tools.action('p2', { type: 'close', id: p2().tabs[0].id })
    await tools.action('p2', { type: 'overrides', mode: 'private' })
    await tools.action('p2', { type: 'add', kind: 'browser', url: `${url}/private-settings` })
    const privateTab = p2().tabs[0], profileId = p2().browserProfileId
    await until(() => contents(privateTab)?.getURL().endsWith('/private-settings') && !contents(privateTab).isLoading(), 'private page loaded')
    const privateBrowser = tools.resource(privateTab.resource).browser
    privateBrowser.action('view:devtools')
    const privateFrontend = privateBrowser.pages.get(privateTab.pageId).tools.webContents
    await until(async () => !privateFrontend.isLoading() && await privateFrontend.executeJavaScript(`(async()=>{const C=await import('devtools://devtools/bundled/core/common/common.js');return C.Settings.Settings.hasInstance()})()`), 'private frontend ready')
    await privateFrontend.executeJavaScript(`(async()=>{const C=await import('devtools://devtools/bundled/core/common/common.js');const s=C.Settings.Settings.instance();s.createSetting('private-transition-key','default').set('private');s.moduleSetting('persistence-network-overrides-enabled').set(true)})()`)
    await contents(privateTab).session.cookies.set({ url, name: 'mode-switch', value: 'kept' })
    assert.ok(JSON.parse(await readFile(join(options.userData, 'browser-devtools.json'), 'utf8')).private.includes(profileId))
    await tools.action('p2', { type: 'close', id: privateTab.id })
    await tools.action('p2', { type: 'overrides', mode: 'shared' })
    await tools.action('p2', { type: 'add', kind: 'browser', url: `${url}/shared-settings` })
    const sharedTab = p2().tabs[0], sharedBrowser = tools.resource(sharedTab.resource).browser
    const sharedFrontend = sharedBrowser.pages.get(sharedTab.pageId).tools.webContents
    const preferences = await sharedFrontend.executeJavaScript(`(async()=>{const H=await import('devtools://devtools/bundled/core/host/host.js');const C=await import('devtools://devtools/bundled/core/common/common.js');return {raw:await new Promise(r=>H.InspectorFrontendHost.InspectorFrontendHostInstance.getPreferences(r)),enabled:C.Settings.Settings.instance().moduleSetting('persistence-network-overrides-enabled').get()}})()`)
    assert.equal(preferences.raw['private-transition-key'], undefined)
    assert.equal(preferences.enabled, false)
    assert.equal((await contents(sharedTab).session.cookies.get({ url, name: 'mode-switch' }))[0].value, 'kept')
    assert.equal(JSON.parse(await readFile(join(options.userData, 'browser-devtools.json'), 'utf8')).private.includes(profileId), false)
    // A failed settings write keeps private preferences excluded without poisoning unrelated tools.
    await tools.action('p2', { type: 'close', id: sharedTab.id })
    await tools.action('p2', { type: 'overrides', mode: 'private' })
    await tools.action('p2', { type: 'add', kind: 'browser' })
    await tools.action('p2', { type: 'close', id: p2().tabs[0].id })
    await tools.action('p2', { type: 'overrides', mode: 'shared' })
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const initializePreferences = BrowserDebug.prototype.initializePreferences
    BrowserDebug.prototype.initializePreferences = function(values, complete) {
      return initializePreferences.call(this, values, () => { throw new Error('fixture settings write failed') })
    }
    try { await assert.rejects(tools.action('p2', { type: 'add', kind: 'browser' }), /fixture settings write failed/) }
    finally { BrowserDebug.prototype.initializePreferences = initializePreferences }
    const failedTab = p2().tabs[0]
    assert.match(failedTab.error, /Close this project's Browser tabs/)
    assert.ok(JSON.parse(await readFile(join(options.userData, 'browser-devtools.json'), 'utf8')).private.includes(profileId))
    await assert.rejects(tools.resource(failedTab.resource).browser.navigate(url), /fixture settings write failed/)
    await tools.action('p2', { type: 'add', kind: 'git' })
    assert.equal(p2().tabs.find(tab => tab.id === p2().activeId).kind, 'git')
    await tools.action('p2', { type: 'visible', visible: false })
    assert.equal(p2().visible, false)
    await tools.action('p2', { type: 'select', id: failedTab.id })
    await tools.action('p2', { type: 'close', id: failedTab.id })
    await tools.action('p2', { type: 'add', kind: 'browser' })
    assert.equal(JSON.parse(await readFile(join(options.userData, 'browser-devtools.json'), 'utf8')).private.includes(profileId), false)
    await tools.removeProject('p2')
    tools.showProject('p1')
    assert.equal(state().tabs.length, 0)
    assert.equal(state().visible, false)
    await action({ type: 'add', kind: 'browser' })
    const blank = state().tabs[0]
    await action({ type: 'close', id: blank.id })
    assert.equal(state().tabs.length, 0, 'a new blank Browser tab closes without starting a document')
    assert.equal(contents(blank), undefined)
    await action({ type: 'add', kind: 'browser', url: `${url}/a?query=kept` })
    const a = { ...state().tabs[0] }
    await until(() => contents(a)?.getURL().includes('/a?query=kept') && !contents(a).isLoading(), 'A loaded')
    await contents(a).executeJavaScript('document.querySelector("#value").value="retained form"')
    await action({ type: 'add', kind: 'browser', url: `${url}/b` })
    const b = { ...state().tabs.find(tab => tab.id !== a.id) }
    await until(() => contents(b)?.getURL().endsWith('/b') && !contents(b).isLoading(), 'B loaded')
    await action({ type: 'add', kind: 'git' }); await action({ type: 'add', kind: 'git' })
    assert.equal(state().tabs.filter(tab => tab.kind === 'git').length, 1)
    await action({ type: 'select', id: a.id })
    await action({ type: 'visible', visible: false }); await action({ type: 'visible', visible: true })
    assert.equal(state().activeId, a.id)
    assert.equal(await contents(a).executeJavaScript('document.querySelector("#value").value'), 'retained form')
    const bridge = async id => {
      const path = join(out, `${id}-control.json`)
      await tools.startBridge(id, 'p1', path)
      const endpoint = JSON.parse(await readFile(path, 'utf8'))
      return async route => {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, { headers: { authorization: `Bearer ${endpoint.token}` }, method: route.startsWith('/read/select') ? 'POST' : 'GET' })
        return { status: response.status, body: await response.json() }
      }
    }
    const s1 = await bridge('s1'); let s2 = await bridge('s2')
    assert.equal((await s1('/status')).status, 409)
    currentSession = 's1'; tools.refreshConnections()
    assert.equal((await s1('/status')).body.activePageId, a.pageId)
    assert.equal((await s2('/status')).status, 409)
    await action({ type: 'select', id: b.id })
    assert.equal((await s1('/status')).body.activePageId, b.pageId)
    // Non-browser panel selections must not recurse through reader cursor validation.
    for (const kind of ['git', 'new']) {
      await action({ type: 'add', kind })
      const selected = state().activeId
      const status = await s1('/status')
      assert.equal(status.status, 200)
      assert.equal(status.body.activePageId, b.pageId)
      assert.equal((await s1('/read/tabs')).status, 200)
      assert.equal(state().activeId, selected)
      if (kind === 'new') await action({ type: 'close', id: selected })
    }
    await action({ type: 'select', id: b.id })
    await action({ type: 'visible', visible: false })
    assert.equal((await s1('/status')).status, 200)
    assert.equal(state().visible, false)
    await action({ type: 'visible', visible: true })
    currentSession = 's2'; tools.refreshConnections()
    assert.equal((await s1('/status')).status, 409)
    assert.equal((await s2('/status')).body.activePageId, b.pageId)
    assert.equal((await s2(`/read/select?arg=${a.pageId}`)).status, 200)
    assert.equal(state().activeId, b.id)
    tools.refreshConnections()
    assert.equal((await s2('/status')).body.activePageId, a.pageId)
    // Revocation is checked at async command boundaries, even before a renderer/state event arrives.
    const group = tools.resource(b.resource).browser, serve = group.serveControl
    let cursor
    group.serveControl = function(request, response, options) { cursor = options.cursor; return serve.call(this, request, response, options) }
    await s2('/status'); group.serveControl = serve
    currentSession = 's1'
    assert.throws(() => cursor.validate(), /Current session/)
    currentSession = 's2'; tools.refreshConnections()
    // Restart publishes a new endpoint and reconnects the current session automatically.
    await tools.stopBridge('s2')
    const resumed = await bridge('s2')
    assert.equal((await resumed('/status')).body.activePageId, b.pageId)
    sessions.get('s2').status = 'completed'
    assert.equal((await resumed('/status')).status, 409)
    sessions.get('s2').status = 'running'
    assert.equal((await resumed('/status')).body.activePageId, b.pageId)
    sessions.get('s2').workspaceProfileId = 'p2'
    assert.equal((await resumed('/status')).status, 409)
    sessions.get('s2').workspaceProfileId = 'p1'
    assert.equal((await resumed('/status')).body.activePageId, b.pageId)
    s2 = resumed
    await s2(`/read/select?arg=${a.pageId}`)
    await contents(a).session.cookies.set({ url, name: 'project', value: 'survives-session' })
    await tools.stopBridge('s1'); sessions.delete('s1')
    assert.equal((await contents(a).session.cookies.get({ url, name: 'project' }))[0].value, 'survives-session')
    // Script-created pages retain their opener and become first-class panel tabs.
    await contents(a).executeJavaScript(`void window.open(${JSON.stringify(url + '/child')})`, true)
    await until(() => state().tabs.filter(tab => tab.kind === 'browser').length === 3, 'popup appears in panel')
    const child = { ...state().tabs.find(tab => tab.kind === 'browser' && ![a.id, b.id].includes(tab.id)) }
    await until(() => contents(child)?.getURL().endsWith('/child') && !contents(child).isLoading(), 'popup loaded')
    assert.equal(await contents(child).executeJavaScript('Boolean(window.opener)'), true)
    await action({ type: 'close', id: a.id })
    assert.equal(state().activeId, b.id)
    assert.equal(contents(a), undefined)
    assert.ok(contents(child))
    assert.equal((await s2('/status')).status, 409)
    assert.equal((await s2('/read/tabs')).status, 200)
    assert.throws(() => tools.resource(a.resource), /closed/)
    tools.bounds(a.resource, null)
    await action({ type: 'close', id: child.id })
    // A beforeunload cancellation must retain the tab until destruction is acknowledged.
    await contents(b).executeJavaScript('document.querySelector("#touch").click();window.onbeforeunload=()=>"unsaved";void 0', true)
    await action({ type: 'close', id: b.id })
    assert.ok(confirmations > 0, 'beforeunload asked')
    assert.ok(contents(b), 'cancel keeps native page')
    assert.equal(state().activeId, b.id)
    confirm = true
    await action({ type: 'close', id: b.id })
    assert.equal(contents(b), undefined)
    await until(() => (state().tabs.filter(tab => tab.kind === 'browser').length === 0), 'last browser removed')
    assert.equal((await s2('/status')).status, 409)
    await action({ type: 'close', id: state().tabs[0].id })
    assert.equal(state().visible, false)
    await action({ type: 'add', kind: 'browser', url: `${url}/reopened` })
    const reopened = state().tabs[0]
    assert.equal(tools.state().connections.find(entry => entry.sessionId === 's2').pageId, reopened.pageId)
    assert.notEqual(reopened.id, b.id)
    assert.equal((await s2('/status')).body.activePageId, reopened.pageId)
    // Switching projects hides native pages and keeps cookies isolated in separate-profile mode.
    await tools.action('p2', { type: 'add', kind: 'browser', url: `${url}/other-project` })
    const other = tools.state().projects.find(project => project.profileId === 'p2').tabs[0]
    await until(() => contents(other)?.getURL().endsWith('/other-project') && !contents(other).isLoading(), 'other project loaded')
    assert.equal((await contents(other).session.cookies.get({ url, name: 'project' })).length, 0)
    assert.equal((await contents(reopened).session.cookies.get({ url, name: 'project' }))[0].value, 'survives-session')
    tools.showProject('p2'); tools.showProject('p1')
    // Pop-out/return reuse the same native page and its form state.
    await action({ type: 'select', id: reopened.id })
    await until(() => contents(reopened)?.getURL().endsWith('/reopened') && !contents(reopened).isLoading(), 'reopened loaded')
    await contents(reopened).executeJavaScript('document.querySelector("#value").value="popout draft"')
    const browser = tools.resource(reopened.resource).browser
    await browser.action('view:console')
    assert.equal(browser.view.getVisible(), false)
    await action({ type: 'pop-out', id: reopened.id })
    await until(() => state().tabs.find(tab => tab.id === reopened.id)?.detached, 'popped out')
    assert.equal(browser.view.getVisible(), true, 'a popped-out page is visible even when Console was selected')
    await action({ type: 'return', id: reopened.id })
    assert.equal(await contents(reopened).executeJavaScript('document.querySelector("#value").value'), 'popout draft')
    // The cap is global, including hidden projects; failure must not create an extra tab.
    while (tools.state().projects.flatMap(project => project.tabs).filter(tab => tab.pageId !== undefined).length < 32)
      await tools.action('p2', { type: 'add', kind: 'browser' })
    await assert.rejects(action({ type: 'add', kind: 'browser' }), /32 browser pages.*p1: 1, p2: 31/)
    assert.equal(state().tabs.length, 1)
    await tools.removeProject('p2')
    assert.equal(contents(other), undefined)
    // No active session means no connection; it does not create or discard pages.
    currentSession = null; tools.refreshConnections()
    assert.equal((await s2('/status')).status, 409)
    // Restart restores descriptors, not resources or launchers.
    await action({ type: 'add', kind: 'browser', url: `${url}/saved-neighbor` })
    await action({ type: 'select', id: reopened.id })
    await action({ type: 'add', kind: 'new' })
    await tools.dispose(); tools = new ProjectToolService(options)
    assert.equal(state().tabs.some(tab => tab.kind === 'new'), false)
    assert.equal(state().tabs.some(tab => tab.pageId !== undefined), false)
    tools.showProject('p1')
    assert.equal(state().tabs.length, 2)
    const restored = state().tabs.find(tab => tab.id === state().activeId)
    const neighbor = state().tabs.find(tab => tab.id !== restored.id)
    assert.equal(neighbor.pageId, undefined, 'inactive saved neighbor stays lazy')
    await action({ type: 'close', id: restored.id })
    assert.equal(state().activeId, neighbor.id)
    assert.ok(state().tabs[0].pageId, 'closing active restored page opens its selected saved neighbor')
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, checks: ['zero tabs', 'add/focus Git', 'hide retention', 'independent cursors', 'session cookie survival', 'popup opener', 'beforeunload cancellation', 'true last close', 'no resurrection', 'bridge survives group disposal', 'lazy restart', 'separate project cookies', 'pop-out retention', 'global cap', 'workspace removal', 'explicit disconnect'] }, null, 2))
    console.log('Project tool lifecycle checks passed.')
    await tools.dispose(); win.destroy(); server.close(); app.exit(0)
  } catch (error) {
    console.error(error)
    await tools?.dispose().catch(() => {}); win?.destroy(); server?.close(); app.exit(1)
  }
  })()
}
