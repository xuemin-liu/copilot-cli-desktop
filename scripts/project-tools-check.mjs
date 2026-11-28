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
    const sessions = new Map([['s1', { browserProfileId: '11111111-1111-4111-8111-111111111111', workspaceProfileId: 'p1', status: 'running' }], ['s2', { browserProfileId: '22222222-2222-4222-8222-222222222222', workspaceProfileId: 'p1', status: 'running' }]])
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
      await action({ type: 'close', id: selected })
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
    assert.equal(state().activeId, a.id, 'B starts with the workspace selection')
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
    // Re-add the removed workspace with its original ID.
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
    // A cancelled session close keeps its browser available to its background owner.
    await contents(reopened).executeJavaScript('document.querySelector("#value").value="popout draft"')
    const browser = tools.resource(reopened.resource).browser
    await browser.action('view:console')
    assert.equal(browser.view.getVisible(), false)
    const popped = await action({ type: 'pop-out', id: reopened.id })
    assert.equal(popped.projects.find(project => project.profileId === 'p1').tabs.find(tab => tab.id === reopened.id).detached, true, 'pop-out reply reflects native window ownership')
    await until(() => state().tabs.find(tab => tab.id === reopened.id)?.detached, 'popped out')
    assert.equal(browser.view.getVisible(), true, 'a popped-out page is visible even when Console was selected')
    const returned = await action({ type: 'return', id: reopened.id })
    assert.equal(returned.projects.find(project => project.profileId === 'p1').tabs.find(tab => tab.id === reopened.id).detached, false, 'return reply reflects panel ownership')
    assert.equal(await contents(reopened).executeJavaScript('document.querySelector("#value").value'), 'popout draft')
    // Chrome model: a popped-out page leaves the panel, which moves to a docked neighbour; the agent stays on the moved page.
    const connection = () => tools.state().connections.find(entry => entry.sessionId === 's2').pageId
    await action({ type: 'add', kind: 'browser', url: `${url}/docked-neighbor` })
    const docked = state().tabs.find(tab => tab.id === state().activeId)
    assert.equal(connection(), docked.pageId, 'adding a browser tab points the agent at it')
    await action({ type: 'select', id: reopened.id })
    assert.equal(connection(), reopened.pageId, 'choosing a browser tab points the agent at it')
    await action({ type: 'pop-out', id: reopened.id })
    assert.equal(state().activeId, docked.id, 'pop-out moves the panel to the docked neighbour')
    assert.equal(state().visible, true)
    assert.equal(connection(), reopened.pageId, 'the agent stays on the popped-out page')
    await action({ type: 'metadata', id: docked.id, label: 'Docked' }); await action({ type: 'width', width: 500 })
    tools.refreshConnections()
    assert.equal(connection(), reopened.pageId, 'unrelated changes do not retarget the agent')
    await action({ type: 'select', id: reopened.id })
    assert.equal(state().activeId, docked.id, 'choosing a windowed tab raises its window and leaves the panel alone')
    await assert.rejects(action({ type: 'reorder', id: reopened.id, beforeId: docked.id }), /own window/)
    assert.equal(tools.showSessionWindow('s2'), true, 'the session Browser button raises the agent page window')
    await action({ type: 'select', id: docked.id })
    assert.equal(connection(), docked.pageId, 'choosing a docked tab retargets the agent')
    assert.equal(tools.showSessionWindow('s2'), false, 'a docked agent page has no window to raise')
    await action({ type: 'return', id: reopened.id })
    assert.deepEqual([state().activeId, state().visible, state().tabs.find(tab => tab.id === reopened.id).detached], [reopened.id, true, false], 'return docks, selects and shows')
    await action({ type: 'close', id: docked.id })
    // Popping out the only docked tab leaves the panel open and blank; its window closing leaves the panel as it is.
    await action({ type: 'pop-out', id: reopened.id })
    assert.deepEqual([state().activeId, state().visible], [null, true], 'nothing docked: blank panel')
    await action({ type: 'visible', visible: false }); await action({ type: 'visible', visible: true })
    assert.deepEqual([state().activeId, state().visible, state().tabs.length], [null, true, 1], 'Show with nothing docked creates no tab')
    await action({ type: 'return', id: reopened.id })
    assert.deepEqual([state().activeId, state().visible], [reopened.id, true])
    // The cap is global, including hidden projects; failure must not create an extra tab.
    while (tools.state().projects.flatMap(project => project.tabs).filter(tab => tab.pageId !== undefined).length < 32)
      await tools.action('p2', { type: 'add', kind: 'browser' })
    await assert.rejects(action({ type: 'add', kind: 'browser' }), /32 browser pages.*p1: 1, p2: 31/)
    assert.equal(state().tabs.length, 1)
    await tools.removeProject('p2')
    assert.equal(contents(other), undefined)
    // A private browser stays available to its live owner in the background.
    const guest = await bridge('s1')
    sessions.set('s1', { workspaceProfileId: 'p1', status: 'running', browserProfileId: '11111111-1111-4111-8111-111111111111' })
    currentSession = 's1'; tools.refreshConnections()
    assert.ok(!(await guest('/read/tabs')).body.tabs.some(page => page.id === reopened.pageId))
    assert.equal((await guest(`/read/select?arg=${reopened.pageId}`)).status, 400)
    assert.equal((await guest(`/read/snapshot?arg=${reopened.pageId}`)).status, 400)
    assert.equal((await s2('/status')).body.activePageId, reopened.pageId)
    await action({ type: 'add', kind: 'browser', url: `${url}/foreground` })
    const foregroundTab = state().tabs.find(tab => tab.id === state().activeId)
    await until(() => contents(foregroundTab)?.getURL().endsWith('/foreground') && !contents(foregroundTab).isLoading(), 'foreground loaded')
    const scopedBrowser = tools.resource(foregroundTab.resource).browser
    const sourcePage = scopedBrowser.pages.get(reopened.pageId)
    scopedBrowser.runContextAction(sourcePage, 'open-link', { linkURL: `${url}/context-link` })
    await until(() => state().tabs.some(tab => tab.url?.endsWith('/context-link')), 'context menu child')
    const linked = state().tabs.find(tab => tab.url?.endsWith('/context-link'))
    assert.equal(linked.ownerId, reopened.ownerId, 'context menu link inherits the clicked page owner')
    currentSession = 's2'; tools.refreshConnections()
    await action({ type: 'pop-out', id: linked.id })
    await action({ type: 'select', id: reopened.id })
    const popup = scopedBrowser.pages.get(linked.pageId)
    popup.certificateWarning = { id: 91, url: 'https://fixture.invalid', host: 'fixture.invalid', error: 'ERR_CERT_DATE_INVALID' }
    popup.error = 'Detached fixture error'
    assert.equal(scopedBrowser.snapshot.certificateWarning?.pageId, linked.pageId)
    assert.equal(scopedBrowser.snapshot.errorPageId, linked.pageId)
    currentSession = 's1'; tools.refreshConnections()
    assert.equal(scopedBrowser.snapshot.certificateWarning, undefined, 'another owner’s detached warning stays with its session')
    assert.equal(scopedBrowser.snapshot.errorPageId, undefined)
    scopedBrowser.action('certificate-back:91')
    assert.equal(popup.certificateWarning?.id, 91, 'a stale answer cannot change another owner’s warning')
    popup.certificateWarning = null
    popup.error = null
    for (const inspect of [
      () => scopedBrowser.runContextAction(popup, 'inspect', { x: 2, y: 2 }),
      () => popup.contents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'F12' }),
    ]) {
      let release
      const activation = new Promise(resolve => { release = resolve })
      options.activateProject = async (_profileId, ownerId) => {
        assert.equal(ownerId, linked.ownerId)
        await activation
        currentSession = 's2'; tools.refreshConnections()
      }
      inspect()
      assert.equal(scopedBrowser.uiPageId, foregroundTab.pageId, 'inspection waits for the owner before switching native views')
      release()
      await until(() => state().activeId === linked.id && !state().tabs.find(tab => tab.id === linked.id).detached && scopedBrowser.snapshot.view === 'devtools', 'inspection in owning panel')
      await action({ type: 'pop-out', id: linked.id })
      currentSession = 's1'; tools.refreshConnections()
    }
    delete options.activateProject
    const confirmation = contents(reopened).executeJavaScript("confirm('owner confirmation')", true)
    await until(async () => (await s2('/status')).body.dialog?.pageId === reopened.pageId, 'owner receives confirmation')
    assert.equal(scopedBrowser.snapshot.dialog, undefined, 'foreground panel excludes another owner’s dialog')
    await assert.rejects(scopedBrowser.answerDialog(false), /No page dialog/)
    await action({ type: 'close', id: foregroundTab.id })
    currentSession = 's2'; tools.refreshConnections()
    await scopedBrowser.answerDialog(true)
    assert.equal(await confirmation, true)
    await action({ type: 'close', id: linked.id })
    currentSession = 's1'; tools.refreshConnections()
    // A cancelled session close keeps its browser available to its background owner.
    await contents(reopened).executeJavaScript('document.querySelector("#touch").click();window.onbeforeunload=()=>"editing";void 0', true)
    confirm = false
    assert.equal(await tools.releaseSession('s2', false), null)
    assert.equal((await s2('/status')).body.activePageId, reopened.pageId)
    confirm = true
    currentSession = null; tools.refreshConnections()
    assert.equal((await s2('/status')).body.activePageId, reopened.pageId)
    currentSession = 's2'; tools.refreshConnections()
    // Restart restores descriptors, not resources or launchers.
    await action({ type: 'add', kind: 'browser', url: `${url}/saved-neighbor` })
    // A page in its own window is saved as a docked tab: windows are not restored.
    await action({ type: 'pop-out', id: state().activeId })
    await action({ type: 'select', id: reopened.id })
    await action({ type: 'add', kind: 'new' })
    await tools.dispose()
    // Desktop runtime IDs can change with startup order; the persisted tab UUID identifies its tools.
    sessions.set('restored-s2', sessions.get('s2')); sessions.delete('s2'); currentSession = 'restored-s2'
    tools = new ProjectToolService(options)
    assert.equal(state().tabs.some(tab => tab.kind === 'new'), false)
    assert.equal(state().tabs.some(tab => tab.pageId !== undefined), false)
    tools.showProject('p1')
    assert.equal(state().tabs.length, 2)
    assert.equal(state().tabs.some(tab => tab.detached), false, 'restart restores windowed pages as docked tabs')
    const restored = state().tabs.find(tab => tab.id === state().activeId)
    const neighbor = state().tabs.find(tab => tab.id !== restored.id)
    assert.equal(neighbor.pageId, undefined, 'inactive saved neighbor stays lazy')
    await action({ type: 'close', id: restored.id })
    assert.equal(state().activeId, neighbor.id)
    assert.ok(state().tabs[0].pageId, 'closing active restored page opens its selected saved neighbor')
    // Temporary reviewer sessions (even with a browserProfileId or without one) must never own the panel or persist a layout.
    const revProfileId = '33333333-3333-4333-8333-333333333333'
    sessions.set('rev-hosted', { browserProfileId: revProfileId, workspaceProfileId: 'p1', status: 'running', tempReviewer: { groupId: 'g1', hostTabId: 'restored-s2' } })
    sessions.set('rev-standalone', { workspaceProfileId: 'p1', status: 'running', tempReviewer: { groupId: 'g2', hostTabId: null } })
    currentSession = 'rev-hosted'; tools.refreshConnections()
    assert.equal(state().ownerId, undefined, 'hosted tempReviewer never becomes panel owner')
    currentSession = 'rev-standalone'; tools.refreshConnections()
    assert.equal(state().ownerId, undefined, 'standalone tempReviewer never becomes panel owner')
    currentSession = 'restored-s2'; tools.refreshConnections()
    assert.equal(state().ownerId, '22222222-2222-4222-8222-222222222222')
    await tools.dispose()
    const savedManifest = JSON.parse(await readFile(join(options.userData, 'workspace-tool-tabs-v2.json'), 'utf8'))
    const savedP1 = savedManifest.projects.find(project => project.profileId === 'p1')
    assert.equal(revProfileId in savedP1.layouts, false, 'tempReviewer browserProfileId is never persisted as a layout owner')
    assert.equal('rev-hosted' in savedP1.layouts, false, 'tempReviewer runtime id is never persisted as a layout owner')
    assert.equal('rev-standalone' in savedP1.layouts, false, 'standalone tempReviewer id is never persisted as a layout owner')
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, checks: ['zero tabs', 'add/focus Git', 'hide retention', 'independent cursors', 'session cookie survival', 'popup opener', 'beforeunload cancellation', 'true last close', 'no resurrection', 'bridge survives group disposal', 'lazy restart', 'separate project cookies', 'pop-out retention', 'pop-out leaves the strip', 'agent stays on popped page', 'blank panel', 'global cap', 'workspace removal', 'explicit disconnect', 'tempReviewer owner exclusion'] }, null, 2))
    console.log('Project tool lifecycle checks passed.')
    win.destroy(); server.close(); app.exit(0)
  } catch (error) {
    console.error(error)
    await tools?.dispose().catch(() => {}); win?.destroy(); server?.close(); app.exit(1)
  }
  })()
}
