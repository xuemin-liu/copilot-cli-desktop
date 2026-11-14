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
    let confirm = false, confirmations = 0
    const errors = []
    const options = { userData: app.getPath('userData'), owner: () => win,
      project: id => ['p1', 'p2'].includes(id) ? { name: id, path: out } : undefined,
      session: id => sessions.get(id), defaults: () => ({ shared: false, overrides: 'private' }),
      browserOptions: () => ({ confirmLeave: async () => { confirmations++; return confirm } }), changed: () => {}, error: error => errors.push(String(error)) }
    tools = new ProjectToolService(options)
    const state = () => tools.state().projects.find(project => project.profileId === 'p1')
    const action = value => tools.action('p1', value)
    const until = async (test, name) => { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (await test()) return; await delay(30) } throw new Error(`Timed out: ${name}`) }
    const contents = tab => webContents.fromId(tab.pageId)
    tools.showProject('p1')
    assert.equal(state().tabs.length, 0)
    assert.equal(state().visible, false)
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
    const s1 = await bridge('s1'), s2 = await bridge('s2')
    assert.equal((await s1('/status')).status, 409)
    await action({ type: 'connect', id: a.id, sessionId: 's1' })
    await action({ type: 'connect', id: b.id, sessionId: 's2' })
    assert.equal((await s1('/status')).body.activePageId, a.pageId)
    assert.equal((await s2('/status')).body.activePageId, b.pageId)
    await action({ type: 'select', id: b.id })
    assert.equal((await s1('/status')).body.activePageId, a.pageId)
    assert.equal((await s2(`/read/select?arg=${a.pageId}`)).status, 200)
    assert.equal(state().activeId, b.id)
    assert.equal((await s1('/status')).body.activePageId, a.pageId)
    assert.equal((await s2('/status')).body.activePageId, a.pageId)
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
    assert.equal(tools.state().connections.find(entry => entry.sessionId === 's2').pageId, null)
    const reopened = state().tabs[0]
    assert.notEqual(reopened.id, b.id)
    assert.equal((await s2('/status')).status, 409)
    assert.equal((await s2(`/read/select?arg=${reopened.pageId}`)).status, 200)
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
    await action({ type: 'pop-out', id: reopened.id })
    await until(() => state().tabs.find(tab => tab.id === reopened.id)?.detached, 'popped out')
    await action({ type: 'return', id: reopened.id })
    assert.equal(await contents(reopened).executeJavaScript('document.querySelector("#value").value'), 'popout draft')
    // The cap is global, including hidden projects; failure must not create an extra tab.
    while (tools.state().projects.flatMap(project => project.tabs).filter(tab => tab.pageId !== undefined).length < 32)
      await tools.action('p2', { type: 'add', kind: 'browser' })
    await assert.rejects(action({ type: 'add', kind: 'browser' }), /32 browser pages.*p1: 1, p2: 31/)
    assert.equal(state().tabs.length, 1)
    await tools.removeProject('p2')
    assert.equal(contents(other), undefined)
    // An explicitly disconnected empty cursor is revocable without inventing a replacement page.
    await action({ type: 'disconnect', sessionId: 's2' })
    assert.equal((await s2('/status')).status, 409)
    // Restart restores descriptors, not resources or launchers.
    await action({ type: 'add', kind: 'new' })
    await tools.dispose(); tools = new ProjectToolService(options)
    assert.equal(state().tabs.some(tab => tab.kind === 'new'), false)
    assert.equal(state().tabs.some(tab => tab.pageId !== undefined), false)
    tools.showProject('p1')
    assert.equal(state().tabs.length, 1)
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, checks: ['zero tabs', 'add/focus Git', 'hide retention', 'independent cursors', 'session cookie survival', 'popup opener', 'beforeunload cancellation', 'true last close', 'no resurrection', 'bridge survives group disposal', 'lazy restart', 'separate project cookies', 'pop-out retention', 'global cap', 'workspace removal', 'explicit disconnect'] }, null, 2))
    console.log('Project tool lifecycle checks passed.')
    await tools.dispose(); win.destroy(); server.close(); app.exit(0)
  } catch (error) {
    console.error(error)
    await tools?.dispose().catch(() => {}); win?.destroy(); server?.close(); app.exit(1)
  }
  })()
}
