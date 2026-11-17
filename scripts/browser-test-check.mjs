import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const artifacts = resolve('test-results/browser-testing')
// Focused acceptance check; the default still exercises the complete workflow.
const viewerOnly = process.argv.includes('--viewer-only')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (read, name) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await read()) return; await delay(100) }
  throw new Error(`Timed out: ${name}`)
}
if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), '{"passed":false}')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const scale = process.argv.slice(2).find(arg => arg.startsWith('--force-device-scale-factor='))
  if (scale) assert.ok(/^--force-device-scale-factor=\d+(\.\d+)?$/.test(scale) && Number(scale.split('=')[1]) >= 0.5 && Number(scale.split('=')[1]) <= 3, 'Display scale must be within 0.5–3')
  const child = spawn((await import('electron')).default, [...(scale ? [scale] : []), fileURLToPath(import.meta.url), ...(viewerOnly ? ['--viewer-only'] : [])], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 150000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserCommand } = await import('../dist/src/cli/browser-control.js')
    const { prepareBrowserSessionEnvironment } = await import('../dist/src/main/browser-session.js')
    let writes = 0; let approvals = 0; let navigationWaiting = false; let foreignRequests = 0
    const receivedValues = []
    const foreign = createServer(async (request, response) => {
      foreignRequests++
      if (request.url === '/leak') { let body = ''; for await (const chunk of request) body += chunk; receivedValues.push(body); response.end('received'); return }
      response.setHeader('content-type', 'text/html')
      response.end('<input id="q" oninput="fetch(\'/leak\',{method:\'POST\',body:this.value})"><input id="field" oninput="fetch(\'/leak\',{method:\'POST\',body:this.value})"><select id="choice"><option value="old">Old</option><option value="new">New</option></select><button id="button">Run</button><p id="result">Foreign frame ready</p>')
    })
    await new Promise(resolve => foreign.listen(0, resolve))
    const foreignUrl = `http://127.0.0.1:${foreign.address().port}/`
    const site = createServer((request, response) => {
      response.setHeader('content-type', 'text/html')
      if (request.url === '/origin-redirect') { response.writeHead(302, { location: foreignUrl }); response.end(); return }
      if (request.url === '/frame-origin-redirect') { response.writeHead(302, { location: `http://localhost:${foreign.address().port}/frame` }); response.end(); return }
      if (request.url === '/redirect-frames') { response.end('<h1 id="ok">App ready</h1><iframe src="/frame-origin-redirect"></iframe>'); return }
      if (request.url === '/never-load') { navigationWaiting = true; return }
      if (request.url === '/redirect-target') { response.end('<h1>Changed document</h1><button id="redirect-target" onclick="fetch(\'/write\',{method:\'POST\'})">Unexpected target</button>'); return }
      if (request.url === '/write') { writes++; response.end('written'); return }
      if (request.url === '/frame') { response.end(`<input id="field" aria-label="Frame input"><button id="button" onclick="result.textContent=event.isTrusted?'Frame passed':'Untrusted'">Run</button><p id="result"></p>`); return }
      if (request.url === '/frames') { response.end(`<h1>Frames</h1><iframe style="display:block;height:150px" src="/frame"></iframe><iframe style="display:block;height:150px" src="http://localhost:${foreign.address().port}/frame"></iframe>`); return }
      response.end(`<!doctype html><title>Generic test application</title><style>body{font:16px sans-serif}#detail{display:none}.cover{position:fixed;inset:0;z-index:100;background:#fff}#hover-result{display:none}#hover-target:hover + #hover-result{display:block}</style>
        <input id="simple-search" aria-label="Search" onkeydown="if(event.key==='Enter'){history.pushState(null,'','/search?q='+encodeURIComponent(this.value));searchResult.textContent='Search results for '+this.value}"><p id="searchResult"></p>
        <label>User <input id="user"></label><label>Password <input id="password" type="password"></label>
        <button id="login" onclick="login.hidden=true;setTimeout(()=>list.hidden=false,100)">Log in</button>
        <section id="list" hidden><input id="search" aria-label="Search" onkeydown="if(event.key==='Enter')row.hidden=this.value!=='ITEM-42'">
        <select id="category"><option value="old">Old</option><option value="new">New</option></select><input id="check" type="checkbox">
        <div id="row" hidden ondblclick="detail.style.display='block';trusted.textContent=event.isTrusted?'Trusted double-click':'Untrusted';document.querySelector('#canvas').getContext('2d').fillRect(0,0,20,20)">ITEM-42</div></section>
        <section id="detail"><h2 id="title">ITEM-42 details</h2><p id="trusted"></p><img id="image" width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='green'/%3E%3C/svg%3E"><canvas id="canvas" width="20" height="20"></canvas></section>
        <a id="cross-link" href="${foreignUrl}">Another site</a><button id="write" onclick="fetch('/write',{method:'POST'})">Write</button><div class="duplicate">One</div><div class="duplicate">Two</div><button id="hover-target">Hover menu</button><p id="hover-result">Menu expanded</p>
        <div data-testid="editor"><div id="editor" contenteditable="true">private-editor-value</div></div><textarea>private-textarea-value</textarea>`)
    })
    await new Promise(resolve => site.listen(0, resolve))
    const window = new BrowserWindow({ show: false, width: 1100, height: 850 })
    await window.loadURL('data:text/html,<title>Isolated browser testing fixture</title>')
    const endpoint = join(artifacts, 'control.json')
    const environment = await prepareBrowserSessionEnvironment(join(artifacts, 'helpers'), 'tab-1', process.env)
    Object.assign(process.env, environment, { COPILOT_DESKTOP_BROWSER_STATE: endpoint, COPILOT_TEST_PASSWORD: 'fixture-private-password' })
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint, approveInteraction: async () => { approvals++; return false } })
    const second = new BrowserDebug(window, join(artifacts, `second-settings-${Date.now()}.json`), { endpointPath: join(artifacts, 'second-control.json') })
    const url = `http://127.0.0.1:${site.address().port}/`
    const plan = (steps, extra = {}) => ({ description: 'Exercise a user-described workflow 用户测试', expected: 'Expected checks pass', steps, ...extra })
    const step = (action, label, rest) => ({ action, label, ...rest })
    const visible = (selector, extra = {}) => step('assert', 'Expected element visible', { selector, condition: 'visible', ...extra })
    const dragSetup = `(${function () {
      window.dragFixtureCleanup?.()
      for (const id of ['drag-canvas', 'drag-status', 'drag-cover']) document.getElementById(id)?.remove()
      const canvas = document.createElement('canvas'); canvas.id = 'drag-canvas'; canvas.width = 600; canvas.height = 280
      canvas.style.cssText = 'display:block;width:300px;height:140px;touch-action:none;background:#eef'
      const status = document.createElement('p'); status.id = 'drag-status'; status.textContent = 'Ready'
      document.body.append(canvas, status)
      window.dragFixture = { events: [], mode: '', pressed: false }
      const released = event => {
        // Removing a captured element routes cancellation/up to the document,
        // rather than the removed canvas. Observe native button state there too.
        if (window.dragFixture.pressed && event.target !== canvas && event.buttons === 0) {
          window.dragFixture.events.push({ type: event.type, buttons: event.buttons, trusted: event.isTrusted })
          window.dragFixture.pressed = false
        }
      }
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, released)
      window.dragFixtureCleanup = () => { for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.removeEventListener(type, released) }
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => {
        const state = window.dragFixture; const rect = canvas.getBoundingClientRect()
        const x = Math.round(event.clientX - rect.left); const y = Math.round(event.clientY - rect.top)
        if (type === 'pointermove' && !state.pressed) return
        state.events.push({ type, x, y, buttons: event.buttons, trusted: event.isTrusted })
        if (type === 'pointerdown') {
          state.pressed = true; canvas.setPointerCapture(event.pointerId)
          if (state.mode === 'move') canvas.style.marginLeft = '20px'
          if (state.mode === 'replace') canvas.replaceWith(canvas.cloneNode(true))
          if (state.mode === 'cover') { const cover = document.createElement('div'); cover.id = 'drag-cover'; cover.style.cssText = 'position:fixed;inset:0;z-index:999;background:white'; document.body.append(cover) }
        }
        if (type === 'pointermove') canvas.getContext('2d').fillRect(x * 2, y * 2, 4, 4)
        if (type === 'pointerup') { state.pressed = false; status.textContent = 'Dragged to ' + x + ',' + y }
        if ((type === 'pointercancel' || type === 'lostpointercapture') && event.buttons === 0) state.pressed = false
      })
      return true
    }.toString()})()`
    const drag = (extra = {}) => step('drag', 'Drag canvas path', { selector: '#drag-canvas', path: [{ x: 20, y: 20 }, { x: 80, y: 40 }, { x: 240, y: 90 }], durationMs: 200, ...extra })
    const dragResult = step('assert', 'Canvas reports drag completion', { selector: '#drag-status', condition: 'text', expected: 'Dragged to ' })
    const assertDragEndpoint = async contents => {
      const status = await contents.executeJavaScript('document.querySelector("#drag-status").textContent')
      const point = /^Dragged to (-?\d+),(-?\d+)$/.exec(status)
      assert.ok(point, `Invalid drag endpoint: ${status}`)
      // Native coordinates are quantized to physical pixels. Frame offsets and
      // fractional display scaling can shift the delivered CSS point by a pixel.
      assert.ok(Math.abs(Number(point[1]) - 240) <= 1 && Math.abs(Number(point[2]) - 90) <= 1, `Drag endpoint is outside one CSS pixel of (240,90): ${status}`)
    }
    const checkViewerDrag = async () => {
      // A viewer renders an oversized image under a sibling SVG that receives
      // native input. Only the requested points need to be in the viewport.
      const viewerSetup = `(${function () {
        document.querySelector('#viewer-fixture')?.remove()
        const fixture = document.createElement('div'); fixture.id = 'viewer-fixture'
        fixture.innerHTML = '<button id="measurement-tool" style="position:fixed;top:0;right:0;z-index:1002">Measure</button><canvas id="coronal-image" width="1600" height="1000" style="position:absolute;left:30px;top:60px;width:1600px;height:1000px;z-index:1000"></canvas><svg id="viewer-input" xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:30px;top:60px;width:1600px;height:1000px;z-index:1001;touch-action:none"></svg>'
        document.body.append(fixture); window.scrollTo(0, 0)
        const canvas = fixture.querySelector('canvas'); const surface = fixture.querySelector('svg')
        const context = canvas.getContext('2d'); context.fillStyle = '#333'; context.fillRect(0, 0, 1600, 1000)
        window.viewerFixture = { selected: false, pressed: false, events: [], obstruct: false }
        fixture.querySelector('button').onclick = () => { window.viewerFixture.selected = true }
        for (const type of ['pointerdown', 'pointermove', 'pointerup']) surface.addEventListener(type, event => {
          const state = window.viewerFixture
          if (!state.selected || type === 'pointermove' && !state.pressed) return
          state.events.push({ type, trusted: event.isTrusted, buttons: event.buttons })
          const rect = surface.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top
          if (type === 'pointerdown') {
            state.pressed = true; surface.setPointerCapture(event.pointerId)
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.id = 'measurement'
            for (const [key, value] of Object.entries({ x1: x, y1: y, x2: x, y2: y, stroke: '#ffff00', 'stroke-width': 4, 'pointer-events': 'none' })) line.setAttribute(key, String(value))
            surface.append(line)
            if (state.obstruct) {
              const cover = document.createElement('input'); cover.id = 'viewer-obstruction'; cover.className = 'dialog-cover'; cover.type = 'password'; cover.value = 'never-report-this-field-value'
              cover.setAttribute('aria-label', 'never-report-this-label'); cover.style.cssText = 'position:fixed;inset:0;z-index:1003'
              fixture.append(cover)
            }
          }
          if (type === 'pointermove') { const line = surface.querySelector('line'); line.setAttribute('x2', String(x)); line.setAttribute('y2', String(y)) }
          if (type === 'pointerup') state.pressed = false
        })
        return true
      }.toString()})()`
      const viewerDrag = (extra = {}) => drag({ selector: '#coronal-image', inputSelector: '#viewer-input', ...extra })
      const measurementVisible = visible('#measurement')
      const setupViewer = async () => {
        await browser.view.webContents.executeJavaScript(viewerSetup)
        assert.equal((await execute([step('click', 'Select measurement tool', { selector: '#measurement-tool' }), visible('#coronal-image')])).status, 'passed')
      }
      await setupViewer()
      const noSurface = await execute([viewerDrag({ inputSelector: undefined }), measurementVisible])
      assert.equal(noSurface.status, 'failed')
      const noSurfacePoint = await browser.view.webContents.executeJavaScript('(() => { const rect = document.querySelector("#coronal-image").getBoundingClientRect(); return { x: rect.left + 20, y: rect.top + 20 } })()')
      assert.ok(noSurface.steps[0].reason.includes('path point 1/3 at viewport (' + noSurfacePoint.x + ', ' + noSurfacePoint.y + ')'))
      assert.match(noSurface.steps[0].reason, /covered.*"tag":"svg".*"id":"viewer-input"/)
      assert.equal((await browser.view.webContents.executeJavaScript('window.viewerFixture')).events.length, 0)
      for (const direct of [false, true]) {
        await setupViewer()
        const measured = await execute([viewerDrag(direct ? { selector: '#viewer-input', inputSelector: undefined } : {}), measurementVisible,
          step('screenshot', 'Visible measurement on cropped image', {})])
        assert.equal(measured.status, 'passed', JSON.stringify(measured))
        const state = await browser.view.webContents.executeJavaScript('window.viewerFixture')
        assert.ok(state.events.every(event => event.trusted)); assert.equal(state.pressed, false)
        const endpoint = await browser.view.webContents.executeJavaScript('({x:Number(document.querySelector("#measurement").getAttribute("x2")),y:Number(document.querySelector("#measurement").getAttribute("y2"))})')
        assert.ok(Math.abs(endpoint.x - 240) <= 1 && Math.abs(endpoint.y - 90) <= 1)
        await writeFile(join(artifacts, `viewer-measurement-${direct ? 'direct' : 'overlay'}.png`), await readFile(measured.screenshots[0].path))
      }
      await setupViewer()
      const outsideViewport = await execute([viewerDrag({ path: [{ x: 20, y: 20 }, { x: 1500, y: 90 }] }), measurementVisible])
      assert.equal(outsideViewport.status, 'failed'); assert.match(outsideViewport.steps[0].reason, /path point 2\/2 at viewport \(1530, 150\).*outside the viewport.*Hit element: null/)
      assert.equal((await browser.view.webContents.executeJavaScript('window.viewerFixture')).events.length, 0)
      await setupViewer()
      await browser.view.webContents.executeJavaScript('window.viewerFixture.obstruct=true')
      const obstructedViewer = await execute([viewerDrag(), step('click', 'Do not write after obstruction', { selector: '#write' }), measurementVisible])
      assert.equal(obstructedViewer.status, 'failed'); assert.equal(obstructedViewer.steps[1].status, 'skipped')
      assert.match(obstructedViewer.steps[0].reason, /segment 1\/2, sample 1\/\d+ toward path point 2\/3 at viewport \([\d.]+, [\d.]+\).*covered.*"tag":"input".*"id":"viewer-obstruction".*dialog-cover/)
      assert.ok(!JSON.stringify(obstructedViewer).includes('never-report-this'))
      const obstructedState = await browser.view.webContents.executeJavaScript('window.viewerFixture')
      assert.equal(obstructedState.pressed, false); assert.equal(writes, 0)
      assert.ok(obstructedState.events.some(event => event.type === 'pointerup' && event.buttons === 0 && event.trusted))
      const ancestorResults = []
      for (const inputSelector of ['html', 'body', '#viewer-fixture', '#viewer-shadow-host']) {
        await setupViewer()
        await browser.view.webContents.executeJavaScript(`(() => {
          window.viewerFixture.obstruct = true
          if (${JSON.stringify(inputSelector)} === '#viewer-shadow-host') {
            const host = document.createElement('div'); host.id = 'viewer-shadow-host'
            document.querySelector('#viewer-fixture').append(host)
            host.attachShadow({ mode: 'open' }).append(document.querySelector('#coronal-image'), document.querySelector('#viewer-input'))
          }
        })()`)
        const report = await execute([viewerDrag({ inputSelector }), measurementVisible])
        const state = await browser.view.webContents.executeJavaScript('window.viewerFixture')
        ancestorResults.push({ inputSelector, status: report.status, reason: report.steps[0].reason, events: state.events.length })
      }
      await setupViewer()
      await browser.view.webContents.executeJavaScript(`(() => {
        const panel = document.createElement('div'); panel.id = 'viewer-scroll-panel'
        panel.style.cssText = 'position:fixed;left:10px;top:60px;width:400px;height:200px;overflow:auto;z-index:1000'
        const content = document.createElement('div'); content.style.cssText = 'position:relative;width:400px;height:650px'
        for (const surface of [document.querySelector('#coronal-image'), document.querySelector('#viewer-input')]) {
          surface.style.cssText = 'position:absolute;left:0;top:440px;width:300px;height:150px;touch-action:none'
          content.append(surface)
        }
        panel.append(content); document.querySelector('#viewer-fixture').append(panel)
      })()`)
      const clippedBefore = await browser.view.webContents.executeJavaScript('({top:document.querySelector("#coronal-image").getBoundingClientRect().top,height:innerHeight})')
      assert.ok(clippedBefore.top > 260 && clippedBefore.top + 20 < clippedBefore.height, 'start is in the window but clipped below the panel')
      const scrolled = await execute([viewerDrag({ path: [{ x: 20, y: 20 }, { x: 60, y: 40 }] }), measurementVisible])
      const panelScrollTop = await browser.view.webContents.executeJavaScript('document.querySelector("#viewer-scroll-panel").scrollTop')
      await setupViewer()
      await browser.view.webContents.executeJavaScript(`(() => {
        const icons = document.createElement('div'); icons.id = 'viewer-icons'
        for (let index = 0; index < 150; index++) {
          const button = document.createElement('button'); button.id = 'icon-' + index
          button.innerHTML = '<svg width="12" height="12"><svg width="6" height="6"></svg></svg>'
          icons.append(button)
        }
        const shadowButton = document.createElement('div'); shadowButton.id = 'shadow-icon-button'; shadowButton.setAttribute('role', 'button')
        shadowButton.attachShadow({ mode: 'open' }).innerHTML = '<svg width="12" height="12"></svg>'
        icons.append(shadowButton); document.body.prepend(icons)
      })()`)
      const discovery = await browserCommand(['test-targets'])
      const icons = { svgCount: discovery.targets.filter(target => target.tag === 'svg').length,
        hasWrite: discovery.targets.some(target => target.selector === '#write'),
        hasViewerInput: discovery.targets.some(target => target.selector === '#viewer-input'), truncated: discovery.truncated }
      await writeFile(join(artifacts, `viewer-regressions-${runId}.json`), JSON.stringify({ ancestorResults, scrolled, panelScrollTop, icons }, null, 2))
      await browser.view.webContents.executeJavaScript('document.querySelector("#viewer-icons").remove()')
      for (const ancestor of ancestorResults) {
        assert.equal(ancestor.status, 'failed', `ancestor input surface must be rejected: ${ancestor.inputSelector}`)
        assert.match(ancestor.reason, /ancestor/); assert.equal(ancestor.events, 0)
      }
      assert.equal(scrolled.status, 'passed', JSON.stringify(scrolled)); assert.ok(panelScrollTop > 0)
      assert.deepEqual(icons, { svgCount: 1, hasWrite: true, hasViewerInput: true, truncated: false })
      await browser.view.webContents.executeJavaScript('document.querySelector("#viewer-fixture").remove()')
    }
    let sequence = 0
    const runId = Date.now()
    const execute = async (steps, shell = false, extra = {}) => {
      const input = join(artifacts, `plan-${runId}-${++sequence}.json`); const output = join(artifacts, `report-${runId}-${sequence}.json`)
      await writeFile(input, JSON.stringify(plan(steps, extra)))
      const result = shell ? JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', environment.COPILOT_DESKTOP_BROWSER_HELPER, 'test', input, '-OutputPath', output], { env: process.env, windowsHide: true, timeout: 60000 })).stdout)
        : await browserCommand(['test', input, output])
      assert.ok(!JSON.stringify(result).includes('fixture-private-password')); assert.ok(!JSON.stringify(result).includes('imageBase64'))
      return result
    }
    try {
      browser.setBounds({ x: 0, y: 0, width: 1000, height: 700 }); window.showInactive()
      await browser.open(); await second.open(); await browser.navigate(url)
      assert.equal(browser.snapshot.testing.enabled, true, 'HTTP page is ready without opt-in')
      assert.ok((await browserCommand(['test-targets'])).targets.length > 0, 'test discovery needs no opt-in')
      assert.equal((await execute([visible('#login')])).status, 'passed', 'first test needs no enable action')
      if (viewerOnly) {
        await checkViewerDrag()
        await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, viewerOverlayMeasurement: true, directSvgInputSurface: true,
          partiallyVisibleDragSurface: true, dragPointDiagnostics: true, obstructionMetadataWithholdsValues: true, obstructedViewerReleasesPointer: true,
          automaticTesting: true, installedPowerShell: false }, null, 2))
        console.log('Viewer drag acceptance check passed: native measurement, cropped viewport, obstruction diagnostics and pointer release.')
        return
      }
      const controller = JSON.parse(await readFile(endpoint, 'utf8'))
      const request = (value, signal) => fetch(`http://127.0.0.1:${controller.port}/test`, { method: 'POST', headers: { authorization: `Bearer ${controller.token}`, 'content-type': 'application/json' }, body: JSON.stringify(value), ...(signal ? { signal } : {}) })
      const generatedWithoutLabels = await execute([
        { action: 'fill', selector: '#simple-search', value: 'amazon fire tv bub' },
        { action: 'press', selector: '#simple-search', key: 'Enter' },
        { action: 'waitFor', condition: 'url', expected: '/search' },
        { action: 'assert', condition: 'text', selector: 'body', expected: 'amazon fire tv bub' },
      ], true)
      assert.equal(generatedWithoutLabels.status, 'passed', JSON.stringify(generatedWithoutLabels))
      assert.deepEqual(generatedWithoutLabels.steps.map(item => item.label), ['fill step 1', 'press step 2', 'waitFor step 3', 'assert step 4'])
      process.env.UNRELATED_SECRET_FOR_TEST = 'unrelated-env-secret-value-123'
      for (const shell of [false, true]) {
        await assert.rejects(execute([step('navigate', 'Untrusted destination', { url: foreignUrl }),
          step('fill', 'Unrelated secret', { selector: '#q', valueFromEnv: 'UNRELATED_SECRET_FOR_TEST' }), visible('#q')], shell), /COPILOT_TEST_/)
        const blocked = await execute([step('navigate', 'Different origin', { url: foreignUrl }),
          step('fill', 'Test password', { selector: '#q', valueFromEnv: 'COPILOT_TEST_PASSWORD' }), visible('#q')], shell)
        assert.equal(blocked.status, 'failed', JSON.stringify(blocked)); assert.match(blocked.steps[0].reason, /origin/)
        assert.equal(blocked.steps[1].status, 'skipped'); assert.equal(foreignRequests, 0); assert.deepEqual(receivedValues, [])
      }
      delete process.env.UNRELATED_SECRET_FOR_TEST
      const redirected = await execute([step('navigate', 'Redirect to another origin', { url: url + 'origin-redirect' }), visible('#q')])
      assert.equal(redirected.status, 'failed', JSON.stringify(redirected)); assert.equal(foreignRequests, 0)
      await browser.navigate(url)
      const linked = await execute([step('click', 'Link to another origin', { selector: '#cross-link' }), visible('#q', { timeoutMs: 100 })])
      assert.equal(linked.status, 'failed', JSON.stringify(linked)); assert.equal(foreignRequests, 0)
      const targets = await browserCommand(['test-targets'])
      assert.ok(targets.targets.some(target => target.selector === '#password'))
      assert.ok(!JSON.stringify(targets).includes('private-editor-value')); assert.ok(!JSON.stringify(targets).includes('private-textarea-value'))
      const workflow = await execute([
        step('navigate', 'Open the app', { url }), step('fill', 'Enter user', { selector: '#user', value: 'fixture-user' }),
        step('fill', 'Enter password', { selector: '#password', valueFromEnv: 'COPILOT_TEST_PASSWORD' }), step('click', 'Log in', { selector: '#login' }),
        step('waitFor', 'Wait for list', { selector: '#list', condition: 'visible' }), step('fill', 'Search item', { selector: '#search', value: 'ITEM-42' }),
        step('press', 'Submit search', { selector: '#search', key: 'Enter' }), step('select', 'Choose category', { selector: '#category', value: 'new' }),
        step('assert', 'Category is selected', { selector: '#category', condition: 'value', expected: 'new' }), step('click', 'Check option', { selector: '#check' }),
        step('assert', 'Option is checked', { selector: '#check', condition: 'checked', expected: true }), step('doubleClick', 'Open item', { selector: '#row' }),
        step('assert', 'Correct detail opened', { selector: '#title', condition: 'text', expected: 'ITEM-42 details' }),
        step('assert', 'Native double-click delivered', { selector: '#trusted', condition: 'text', expected: 'Trusted double-click' }),
        step('assert', 'Image loaded', { selector: '#image', condition: 'imageLoaded' }), step('assert', 'Canvas painted', { selector: '#canvas', condition: 'canvasPainted' }),
        step('screenshot', 'Capture outcome', {}),
      ])
      assert.equal(workflow.status, 'passed', JSON.stringify(workflow)); assert.equal(approvals, 0)
      assert.equal(workflow.origin, new URL(url).origin)
      assert.ok((await readFile(workflow.screenshots[0].path)).length > 100)
      assert.equal(browser.snapshot.testing.report.status, 'passed')
      const savedPassword = await browser.view.webContents.executeJavaScript('document.querySelector("#password").value')
      assert.equal(savedPassword, 'fixture-private-password')
      const replacement = await execute([step('fill', 'Replace input', { selector: '#search', value: 'replacement 中文' }),
        step('assert', 'Input replaced', { selector: '#search', condition: 'value', expected: 'replacement 中文' }),
        step('fill', 'Clear input', { selector: '#search', value: '' }), step('assert', 'Input cleared', { selector: '#search', condition: 'value', expected: '' })])
      assert.equal(replacement.status, 'passed', JSON.stringify(replacement))
      const shell = await execute([visible('#title'), step('screenshot', 'Shell evidence', {})], true)
      assert.equal(shell.status, 'passed', JSON.stringify(shell))
      assert.ok(shell.description.includes('用户测试'), 'PowerShell reports preserve UTF-8 descriptions')
      const hovered = await execute([step('hover', 'Open hover menu', { selector: '#hover-target' }), visible('#hover-result')])
      assert.equal(hovered.status, 'passed', JSON.stringify(hovered))
      const shadowHtml = '<input id="shadow-field"><button id="shadow-button" onclick="this.getRootNode().querySelector(\'#shadow-result\').textContent=event.isTrusted?\'Shadow passed\':\'Untrusted\'">Run</button><p id="shadow-result"></p>'
      await browser.view.webContents.executeJavaScript(`(() => { const host = document.createElement('div'); document.body.append(host); host.attachShadow({mode:'open'}).innerHTML=${JSON.stringify(shadowHtml)} })()`)
      const shadow = await execute([step('fill', 'Shadow field', { selector: '#shadow-field', value: 'shadow value' }),
        step('assert', 'Shadow value', { selector: '#shadow-field', condition: 'value', expected: 'shadow value' }),
        step('click', 'Shadow click', { selector: '#shadow-button' }), step('assert', 'Shadow result', { selector: '#shadow-result', condition: 'text', expected: 'Shadow passed' })])
      assert.equal(shadow.status, 'passed', JSON.stringify(shadow))
      const editable = await execute([step('fill', 'Edit rich text', { selector: '#editor', value: 'edited content' }),
        step('assert', 'Rich text updated', { selector: '#editor', condition: 'text', expected: 'edited content' })])
      assert.equal(editable.status, 'passed', JSON.stringify(editable))
      await browser.view.webContents.executeJavaScript(`(() => {
        const target = document.createElement('button'); target.id = 'replace-target'; target.textContent = 'Original';
        target.addEventListener('mouseenter', () => {
          const replacement = document.createElement('button'); replacement.id = 'replace-target'; replacement.textContent = 'Replacement';
          replacement.addEventListener('click', () => fetch('/write', {method:'POST'})); target.replaceWith(replacement);
        }); document.body.append(target);
      })()`)
      const replaced = await execute([step('click', 'Target changes during pointer movement', { selector: '#replace-target' }), visible('#title')])
      assert.equal(replaced.status, 'failed', JSON.stringify(replaced)); assert.match(replaced.steps[0].reason, /replaced/)
      assert.equal(writes, 0, 'a target replacement must never receive the original click')
      await browser.view.webContents.executeJavaScript(`(() => {
        const target = document.createElement('button'); target.id = 'redirect-target'; target.textContent = 'Navigate on hover';
        target.addEventListener('mouseenter', () => location.assign('/redirect-target')); document.body.append(target);
      })()`)
      const changedDocument = await execute([step('click', 'Document changes during pointer movement', { selector: '#redirect-target' }), visible('#title')])
      assert.equal(changedDocument.status, 'failed', JSON.stringify(changedDocument)); assert.equal(writes, 0)
      await browser.navigate(url)
      const failed = await execute([visible('#does-not-exist', { timeoutMs: 100 }), step('click', 'Must not write', { selector: '#write' })])
      assert.equal(failed.status, 'failed'); assert.equal(failed.steps[1].status, 'skipped'); assert.equal(writes, 0)
      const ambiguous = await execute([step('click', 'Ambiguous', { selector: '.duplicate' }), visible('#title')])
      assert.equal(ambiguous.status, 'failed'); assert.match(ambiguous.steps[0].reason, /exactly one/)
      await browser.view.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<div id="cover" class="cover"></div>')`)
      const covered = await execute([step('click', 'Covered', { selector: '#write' }), visible('#title')])
      assert.equal(covered.status, 'failed'); assert.equal(writes, 0)
      await browser.view.webContents.executeJavaScript('document.querySelector("#cover").remove()')
      for (const shell of [false, true]) {
        await browser.view.webContents.executeJavaScript(dragSetup)
        const target = (await browserCommand(['test-targets'])).targets.find(target => target.selector === '#drag-canvas')
        assert.equal(target.bounds.width, 300); assert.equal(target.bounds.height, 140)
        const report = await execute([drag(), dragResult], shell)
        assert.equal(report.status, 'passed', JSON.stringify(report))
        await assertDragEndpoint(browser.view.webContents)
        const state = await browser.view.webContents.executeJavaScript('window.dragFixture')
        assert.ok(state.events.every(event => event.trusted), 'drag dispatches trusted native pointer events')
        assert.ok(state.events.filter(event => event.type === 'pointermove').length > 2, 'drag interpolates between waypoints')
        assert.ok(state.events.filter(event => event.type === 'pointermove').every(event => event.buttons === 1))
        assert.ok(state.events.some(event => event.type === 'pointermove' && Math.abs(event.x - 80) <= 1 && Math.abs(event.y - 40) <= 1), 'drag visits the intermediate waypoint within one CSS pixel')
        assert.equal(state.events[0].type, 'pointerdown'); assert.ok(state.events.some(event => event.type === 'pointerup' && event.buttons === 0))
        assert.equal(state.pressed, false)
      }
      browser.view.webContents.setZoomFactor(1.25)
      await browser.view.webContents.executeJavaScript(dragSetup)
      const zoomedDrag = await execute([drag(), dragResult])
      assert.equal(zoomedDrag.status, 'passed', JSON.stringify(zoomedDrag))
      await assertDragEndpoint(browser.view.webContents)
      browser.view.webContents.setZoomFactor(1)
      await checkViewerDrag()
      for (const mode of ['bounds', 'move', 'cover', 'replace']) {
        await browser.view.webContents.executeJavaScript(dragSetup)
        await browser.view.webContents.executeJavaScript(`window.dragFixture.mode=${JSON.stringify(mode)}`)
        const report = await execute([drag(mode === 'bounds' ? { path: [{ x: 20, y: 20 }, { x: 300, y: 90 }] } : {}), step('click', 'Must not write after bad drag', { selector: '#write' }), dragResult])
        assert.equal(report.status, 'failed', JSON.stringify(report)); assert.equal(report.steps[1].status, 'skipped')
        assert.match(report.steps[0].reason, mode === 'bounds' ? /bounds/ : mode === 'move' ? /geometry changed/ : mode === 'replace' ? /replaced/ : /covered/)
        const state = await browser.view.webContents.executeJavaScript('window.dragFixture')
        assert.equal(state.pressed, false, `failed drag releases its captured pointer (${mode})`); assert.equal(writes, 0)
        if (mode === 'bounds') assert.equal(state.events.length, 0, 'invalid endpoint is rejected before pointer down')
        else assert.ok(state.events.some(event => ['pointerup', 'pointercancel', 'lostpointercapture'].includes(event.type) && event.trusted && event.buttons === 0), 'failed drag clears native button state')
      }
      // HTML5 drag-and-drop: a thumbnail list and viewer cells, as in an imaging viewer.
      const dndSetup = mode => `(${function (mode) {
        document.querySelector('#dnd-fixture')?.remove()
        const fixture = document.createElement('div'); fixture.id = 'dnd-fixture'
        fixture.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:420px;z-index:2000;background:#fff'
        fixture.innerHTML = '<ul style="position:absolute;left:10px;top:10px;margin:0;padding:0;list-style:none"><li data-container draggable="true" style="width:140px;height:60px;background:#8cf">Ball Phantom Axia</li><li data-container style="width:140px;height:60px;background:#ccc;margin-top:8px">Not draggable</li></ul>'
          + '<div id="D_3" style="position:absolute;left:300px;top:150px;width:300px;height:200px;background:#333;color:#fff">Empty<canvas id="C_3" width="40" height="40"></canvas></div>'
        document.body.append(fixture)
        window.dndFixture = { events: [], clicks: 0 }
        for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend', 'click']) fixture.addEventListener(type, event => window.dndFixture.events.push({ type, trusted: event.isTrusted, target: event.target.id || event.target.localName }), true)
        const source = fixture.querySelector('li[draggable]'); const cell = fixture.querySelector('#D_3')
        source.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', 'series-42'); event.dataTransfer.effectAllowed = 'copy' })
        cell.addEventListener('click', () => window.dndFixture.clicks++)
        if (mode !== 'reject') cell.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' })
        cell.addEventListener('drop', event => {
          event.preventDefault()
          const series = event.dataTransfer.getData('text/plain')
          cell.firstChild.textContent = 'Loaded ' + series
          cell.querySelector('canvas').getContext('2d').fillRect(0, 0, 40, 40)
          console.log('dropped ' + series)
        })
        if (mode === 'cover') { const cover = document.createElement('div'); cover.id = 'dnd-cover'; cover.style.cssText = 'position:absolute;left:280px;top:130px;width:360px;height:240px;z-index:5'; fixture.append(cover) }
        return true
      }.toString()})(${JSON.stringify(mode)})`
      const dragTo = (extra = {}) => step('dragTo', 'Drop series on empty cell', { selector: 'li[data-container]', text: 'Ball Phantom Axia', dropSelector: '#D_3', dropPoint: { x: 200, y: 150 }, durationMs: 300, ...extra })
      const dndState = () => browser.view.webContents.executeJavaScript('window.dndFixture')
      for (const shell of [false, true]) {
        await browser.view.webContents.executeJavaScript(dndSetup(''))
        const dropped = await execute([dragTo(), step('assert', 'Cell shows the series', { selector: '#D_3', condition: 'text', expected: 'Loaded series-42' }),
          step('assert', 'Cell canvas is painted', { selector: '#C_3', condition: 'canvasPainted' }),
          step('assert', 'Drop handler logged', { condition: 'consoleMessage', expected: 'dropped series-42' })], shell)
        assert.equal(dropped.status, 'passed', JSON.stringify(dropped))
        const report = dropped.steps[0].data.dragAndDrop
        assert.equal(report.dragstartFired, true); assert.equal(report.dragstartOnSource, true); assert.equal(report.dragoverAccepted, true)
        assert.equal(report.dropFired, true); assert.equal(report.dropAccepted, true); assert.equal(report.dropOnTarget, true)
        assert.equal(report.dragendFired, true); assert.equal(report.dropEffect, 'copy')
        const events = (await dndState()).events
        assert.deepEqual([...new Set(events.map(event => event.type))], ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'], JSON.stringify(events))
        assert.ok(events.every(event => event.trusted), 'drag-and-drop events are trusted')
      }
      // A source point alone leaves the drop at the target's visible center, not at the source's offset.
      await browser.view.webContents.executeJavaScript(dndSetup('') + ';document.querySelector("#D_3").style.width="60px";document.querySelector("#D_3").style.height="60px"')
      const sourcePointOnly = await execute([dragTo({ point: { x: 130, y: 50 }, dropPoint: undefined }), step('assert', 'Cell shows the series', { selector: '#D_3', condition: 'text', expected: 'Loaded series-42' })])
      assert.equal(sourcePointOnly.status, 'passed', JSON.stringify(sourcePointOnly))
      // Cancelled and refused drops end the drag, release the pointer and leave later input working.
      const dndFailures = [
        ['reject', dragTo(), /did not accept the drop/, true],
        ['', dragTo({ text: 'Not draggable' }), /did not start an HTML5 drag/, false],
        ['cover', dragTo(), /covered/, false],
        ['', dragTo({ dropSelector: '#missing' }), /^Drag drop target: .*no matching target/, false],
        ['', step('drag', 'Pointer drag on a draggable item', { selector: 'li[data-container]', text: 'Ball Phantom Axia', path: [{ x: 20, y: 20 }, { x: 60, y: 40 }, { x: 130, y: 50 }], durationMs: 200 }), /HTML5 drag-and-drop session/, true],
      ]
      for (const [mode, action, reason, started] of dndFailures) {
        await browser.view.webContents.executeJavaScript(dndSetup(mode))
        const report = await execute([action, step('click', 'Must not write after failed drop', { selector: '#write' }), visible('#D_3')])
        assert.equal(report.status, 'failed', JSON.stringify(report)); assert.match(report.steps[0].reason, reason)
        assert.equal(report.steps[1].status, 'skipped'); assert.equal(writes, 0)
        const events = (await dndState()).events
        assert.equal(events.some(event => event.type === 'dragstart'), started, JSON.stringify(events))
        if (started) assert.ok(events.some(event => event.type === 'dragend'), 'a started drag is ended')
        assert.ok(!events.some(event => event.type === 'drop'), 'a failed drop delivers no drop event')
        await browser.view.webContents.executeJavaScript('document.querySelector("#dnd-cover")?.remove()')
        const clicked = await execute([step('click', 'Cell still takes clicks', { selector: '#D_3' }), visible('#D_3')])
        assert.equal(clicked.status, 'passed', JSON.stringify(clicked)); assert.equal((await dndState()).clicks, 1, `input works after a failed drop (${reason})`)
      }
      await browser.view.webContents.executeJavaScript('document.querySelector("#dnd-fixture").remove()')
      {
      // compareScreenshot: a viewer cell with a WebGL image and a 2D overlay, compared with a reference PNG
      // recorded by an ordinary screenshot step.
      const compareSetup = state => `(${function (state) {
        document.querySelector('#cmp-fixture')?.remove()
        // Form controls are masked wherever they are, even under an overlay, so the rest of the page is hidden while comparing.
        for (const child of document.body.children) if (!child.hasAttribute('data-cmp-hidden')) { child.setAttribute('data-cmp-hidden', child.style.display); child.style.display = 'none' }
        const fixture = document.createElement('div'); fixture.id = 'cmp-fixture'
        fixture.style.cssText = `position:fixed;left:0;top:0;width:${state.wide ? 280 : 240}px;height:170px;z-index:3000;background:#102030`
        fixture.innerHTML = `<canvas id="cmp-gl" width="${state.wide ? 280 : 240}" height="120" style="display:block"></canvas><canvas id="cmp-2d" width="240" height="40" style="display:block"></canvas>`
          + `<span id="cmp-stamp" style="position:absolute;left:4px;top:4px;width:90px;height:16px;background:#000;color:#ff0;font:12px monospace">${state.stamp ?? '2026-11-17'}</span>`
        document.body.append(fixture)
        const gl = fixture.querySelector('#cmp-gl').getContext('webgl', { antialias: false })
        gl.enable(gl.SCISSOR_TEST)
        const rect = (x, y, width, height, [r, g, b]) => { gl.scissor(x, y, width, height); gl.clearColor(r / 255, g / 255, b / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT) }
        rect(0, 0, state.wide ? 280 : 240, 120, [40, 40, 40])
        // A bright block on the left; "flip" mirrors it to the right, as a flipped image would.
        rect(state.flip ? 150 : 20, 20, 70, 80, [230, 230, 230])
        rect(100, 50, 40, 20, [200, 60, 60])
        const context = fixture.querySelector('#cmp-2d').getContext('2d')
        const shade = 120 + (state.shade ?? 0)
        context.fillStyle = `rgb(${shade},${shade},${shade})`; context.fillRect(0, 0, 240, 40)
        context.fillStyle = 'rgb(0,160,255)'; context.fillRect(10, 10, 60, 20)
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))
      }.toString()})(${JSON.stringify(state)})`
      const { nativeImage: images } = await import('electron')
      const compare = (baseline, extra = {}) => step('compareScreenshot', 'Cell matches the reference', { selector: '#cmp-fixture', baseline, ...extra })
      await browser.view.webContents.executeJavaScript(compareSetup({}))
      const recorded = await execute([step('screenshot', 'Record the reference', { selector: '#cmp-fixture' }), visible('#cmp-fixture')])
      assert.equal(recorded.status, 'passed', JSON.stringify(recorded))
      const baseline = recorded.screenshots[0].path
      const reference = images.createFromPath(baseline)
      assert.ok(!reference.isEmpty(), 'the recorded screenshot is a PNG')
      const compareResults = {}
      for (const shell of [false, true]) {
        const same = await execute([compare(baseline)], shell)
        assert.equal(same.status, 'passed', JSON.stringify(same))
        assert.equal(same.steps[0].outcome, 'assertion-passed')
        assert.equal(same.steps[0].data.comparison.differentPixels, 0, JSON.stringify(same.steps[0].data))
        assert.deepEqual(same.screenshots.map(image => image.kind), ['capture'], 'a match keeps only the capture')
        compareResults[shell ? 'shellMatch' : 'match'] = same.steps[0].data.comparison
      }
      // A flipped image fails; the diff image marks the changed block in red.
      await browser.view.webContents.executeJavaScript(compareSetup({ flip: true }))
      const flipped = await execute([compare(baseline), step('click', 'Must not run after a failed comparison', { selector: '#write' })], true)
      assert.equal(flipped.status, 'failed', JSON.stringify(flipped)); assert.equal(flipped.steps[0].outcome, 'assertion-failed')
      assert.equal(flipped.steps[1].status, 'skipped'); assert.equal(writes, 0)
      assert.match(flipped.steps[0].reason, /differ from the baseline/)
      const flip = flipped.steps[0].data.comparison
      assert.ok(flip.differentPixels > 0 && flip.diffBounds, JSON.stringify(flip))
      // The blocks move between x 20–90 and x 150–220 CSS pixels, rows 20–100 of the WebGL canvas (drawn from the bottom).
      assert.ok(Math.abs(flip.diffBounds.x - 20) <= 1 && Math.abs(flip.diffBounds.x + flip.diffBounds.width - 220) <= 1, JSON.stringify(flip.diffBounds))
      assert.ok(Math.abs(flip.diffBounds.y - 20) <= 1 && Math.abs(flip.diffBounds.y + flip.diffBounds.height - 100) <= 1, JSON.stringify(flip.diffBounds))
      assert.deepEqual(flipped.screenshots.map(image => image.kind), ['capture', 'diff'])
      const diff = images.createFromPath(flipped.screenshots[1].path)
      const diffBitmap = diff.toBitmap(); const diffSize = diff.getSize()
      let red = 0
      for (let index = 0; index < diffBitmap.length; index += 4) {
        if (diffBitmap[index + 1] === 0 && (diffBitmap[index] === 255 && diffBitmap[index + 2] === 0 || diffBitmap[index] === 0 && diffBitmap[index + 2] === 255)) red++
      }
      assert.equal(red, flip.differentPixels, 'the diff image marks exactly the differing pixels')
      assert.deepEqual(diffSize, reference.getSize())
      compareResults.flip = flip
      // A change only inside an ignored area passes; the same change without it fails.
      await browser.view.webContents.executeJavaScript(compareSetup({ stamp: '2027-01-01' }))
      const stampChanged = await execute([compare(baseline)])
      assert.equal(stampChanged.status, 'failed', JSON.stringify(stampChanged))
      const ignored = await execute([compare(baseline, { ignore: [{ x: 0, y: 0, width: 100, height: 24 }] })])
      assert.equal(ignored.status, 'passed', JSON.stringify(ignored))
      assert.ok(ignored.steps[0].data.comparison.ignoredPixels > 0 && ignored.steps[0].data.comparison.differentPixels === 0, JSON.stringify(ignored.steps[0].data))
      compareResults.ignored = ignored.steps[0].data.comparison
      // A slight shade change fails an exact comparison and passes a per-channel tolerance above it.
      await browser.view.webContents.executeJavaScript(compareSetup({ shade: 3 }))
      const strict = await execute([compare(baseline)])
      assert.equal(strict.status, 'failed', JSON.stringify(strict)); assert.ok(strict.steps[0].data.comparison.maxChannelDelta <= 4, JSON.stringify(strict.steps[0].data))
      const tolerant = await execute([compare(baseline, { imageTolerance: { channel: 4 } })])
      assert.equal(tolerant.status, 'passed', JSON.stringify(tolerant))
      const ratio = await execute([compare(baseline, { imageTolerance: { maxDiffRatio: 0.5 } })])
      assert.equal(ratio.status, 'passed', JSON.stringify(ratio)); assert.match(ratio.steps[0].detail, /within the allowed 50%/)
      // A different size is refused, never rescaled.
      await browser.view.webContents.executeJavaScript(compareSetup({ wide: true }))
      const resized = await execute([compare(baseline)])
      assert.equal(resized.status, 'failed', JSON.stringify(resized)); assert.match(resized.steps[0].reason, /Nothing is rescaled/)
      assert.deepEqual(resized.screenshots.map(image => image.kind), ['capture'])
      // A file that is not a PNG is refused.
      const notPng = join(artifacts, `not-png-${runId}.png`); await writeFile(notPng, 'not a png')
      const unreadable = await execute([compare(notPng)])
      assert.equal(unreadable.status, 'failed', JSON.stringify(unreadable)); assert.match(unreadable.steps[0].reason, /not a PNG/)
      await assert.rejects(execute([compare(join(artifacts, 'missing-baseline.png'))]), /does not exist/)
      await assert.rejects(execute([compare(join(artifacts, 'missing-baseline.png'))], true), /does not exist/)
      await writeFile(join(artifacts, `compare-${runId}.json`), JSON.stringify(compareResults, null, 2))
      await browser.view.webContents.executeJavaScript('document.querySelector("#cmp-fixture").remove();for (const child of document.querySelectorAll("[data-cmp-hidden]")) { child.style.display = child.getAttribute("data-cmp-hidden"); child.removeAttribute("data-cmp-hidden") }')
      }
      // Geometry phases: a target that keeps moving before the press, one that moves on
      // mousedown, and one that moves between double-click presses. Each fails with the
      // phase it was observed in, and none delivers the click it was supposed to.
      const geometrySetup = mode => `(${function (mode) {
        window.geometryFixture?.stop?.()
        document.querySelector('#geo-target')?.remove()
        const target = document.createElement('button'); target.id = 'geo-target'; target.textContent = 'Toolbar tool'; target.dataset.grp = 'g'
        target.style.cssText = 'position:fixed;left:400px;top:200px;width:120px;height:40px;z-index:2000'
        document.body.append(target)
        const state = window.geometryFixture = { events: [], stop: null }
        for (const type of ['pointerdown', 'click', 'dblclick']) target.addEventListener(type, event => {
          state.events.push({ type, detail: event.detail, trusted: event.isTrusted })
          if (type === 'pointerdown' && mode === 'mousedown') target.style.left = '420px'
          if (type === 'click' && event.detail === 1 && mode === 'between') target.style.left = '420px'
        })
        // Moves 2px every frame, so two samples taken frames apart never see the same bounds.
        let frame = 0; let handle = 0; let moving = mode === 'jitter' || mode === 'settles'
        const move = () => { if (!moving) return; target.style.left = `${400 + (++frame * 2) % 300}px`; handle = requestAnimationFrame(move) }
        if (moving) handle = requestAnimationFrame(move)
        const end = mode === 'settles' ? setTimeout(() => { moving = false; cancelAnimationFrame(handle); target.style.left = '400px' }, 400) : 0
        state.stop = () => { moving = false; cancelAnimationFrame(handle); clearTimeout(end) }
        return true
      }.toString()})(${JSON.stringify(mode)})`
      const geometryEvents = () => browser.view.webContents.executeJavaScript('window.geometryFixture.events.map(event => event.type)')
      const clickTool = step('click', 'Click the toolbar tool', { selector: '#geo-target' })
      const toolGroup = step('assert', 'Tool is in link group g', { selector: '#geo-target', condition: 'attribute', attribute: 'data-grp', expected: 'g' })
      await browser.view.webContents.executeJavaScript(geometrySetup('jitter'))
      const jitter = await execute([clickTool, toolGroup])
      assert.equal(jitter.status, 'failed', JSON.stringify(jitter)); assert.match(jitter.steps[0].reason, /pre-press settling.*No button press was sent/)
      assert.equal(jitter.steps[0].data.geometry.phase, 'pre-press settling', JSON.stringify(jitter.steps[0]))
      assert.ok(jitter.steps[0].data.geometry.before.target && jitter.steps[0].data.geometry.after.target)
      assert.deepEqual(await geometryEvents(), [], 'no press reaches a target that never settles')
      const hoverJitter = await execute([step('hover', 'Hover the toolbar tool', { selector: '#geo-target' }), toolGroup])
      assert.equal(hoverJitter.status, 'failed', JSON.stringify(hoverJitter)); assert.match(hoverJitter.steps[0].reason, /during pointer settling/)
      assert.equal(hoverJitter.steps[0].data.geometry.phase, 'pointer settling', JSON.stringify(hoverJitter.steps[0]))
      const neverStable = await execute([step('waitFor', 'Tool settles', { selector: '#geo-target', condition: 'stable', stableMs: 300, timeoutMs: 1500 }), toolGroup])
      assert.equal(neverStable.status, 'failed', JSON.stringify(neverStable)); assert.match(neverStable.steps[0].reason, /changed|still for/)
      await browser.view.webContents.executeJavaScript(geometrySetup('settles'))
      const settled = await execute([step('waitFor', 'Tool settles', { selector: '#geo-target', condition: 'stable', stableMs: 300 }), clickTool, toolGroup])
      assert.equal(settled.status, 'passed', JSON.stringify(settled))
      assert.ok(settled.steps[0].durationMs >= 600, `stable waits for movement to stop and then the window (${settled.steps[0].durationMs} ms)`)
      assert.deepEqual(await geometryEvents(), ['pointerdown', 'click'])
      await browser.view.webContents.executeJavaScript(geometrySetup('mousedown'))
      const pressMoved = await execute([clickTool, step('click', 'Must not write after a moved click', { selector: '#write' }), toolGroup])
      assert.equal(pressMoved.status, 'failed', JSON.stringify(pressMoved)); assert.equal(pressMoved.steps[1].status, 'skipped')
      assert.match(pressMoved.steps[0].reason, /Target moved or geometry changed after press 1 of the click/)
      assert.equal(pressMoved.steps[0].delivery, 'partial')
      assert.deepEqual({ phase: pressMoved.steps[0].data.geometry.phase, press: pressMoved.steps[0].data.geometry.press, released: pressMoved.steps[0].data.geometry.released },
        { phase: 'after press', press: 1, released: 'away from the target' })
      assert.equal(pressMoved.steps[0].data.geometry.after.target.left - pressMoved.steps[0].data.geometry.before.target.left, 20)
      assert.deepEqual(await geometryEvents(), ['pointerdown'], 'a press that moved its target is released away from it, so no click fires')
      await browser.view.webContents.executeJavaScript(geometrySetup('between'))
      const betweenMoved = await execute([step('doubleClick', 'Double-click the tool', { selector: '#geo-target' }), toolGroup])
      assert.equal(betweenMoved.status, 'failed', JSON.stringify(betweenMoved))
      assert.match(betweenMoved.steps[0].reason, /between double-click presses of the double-click/)
      assert.deepEqual({ phase: betweenMoved.steps[0].data.geometry.phase, pressesSent: betweenMoved.steps[0].data.geometry.pressesSent },
        { phase: 'between double-click presses', pressesSent: 1 })
      assert.ok(!(await geometryEvents()).includes('dblclick'), 'the second press is never sent after the target moved')
      assert.equal(writes, 0)
      await browser.view.webContents.executeJavaScript('window.geometryFixture.stop?.(); document.querySelector("#geo-target").remove()')
      // Console: real Chromium console events, uncaught exceptions, a same-origin frame,
      // a flood of one library warning, and recording switched off.
      const consoleSetup = `(${function () {
        document.querySelector('#console-fixture')?.remove()
        const fixture = document.createElement('div'); fixture.id = 'console-fixture'
        fixture.innerHTML = '<button id="log-ready">Open viewer</button><button id="throw">Break viewer</button><button id="flood">Render</button><button id="frame-error">Frame error</button><iframe id="console-frame" srcdoc="<p>frame</p>" style="height:30px"></iframe>'
        document.body.append(fixture)
        fixture.querySelector('#log-ready').onclick = () => setTimeout(() => console.debug('viewer ready: frames=2 mpr=true'), 200)
        fixture.querySelector('#throw').onclick = () => setTimeout(() => { throw new TypeError('frame is undefined') }, 50)
        fixture.querySelector('#flood').onclick = () => { for (let i = 0; i < 400; i++) console.warn('CanvasTextAlign is deprecated'); console.error('CanvasTextAlign failed once') }
        fixture.querySelector('#frame-error').onclick = () => fixture.querySelector('#console-frame').contentWindow.console.error('error inside the frame')
        return true
      }.toString()})()`
      await browser.view.webContents.executeJavaScript(consoleSetup)
      const ready = await execute([step('click', 'Open viewer', { selector: '#log-ready' }),
        step('waitFor', 'Viewer logs ready', { condition: 'consoleMessage', expected: 'viewer ready*', level: 'debug', timeoutMs: 5000 }),
        step('assert', 'No info message claims it', { condition: 'consoleMessage', expected: 'viewer ready*', level: 'info', timeoutMs: 300 })])
      assert.deepEqual(ready.steps.map(item => item.status), ['passed', 'passed', 'failed'], JSON.stringify(ready))
      assert.deepEqual(ready.steps[1].console.entries.map(entry => entry.message), ['viewer ready: frames=2 mpr=true'])
      const before = await execute([step('assert', 'Ready from an earlier run does not count', { condition: 'consoleMessage', expected: 'viewer ready*', timeoutMs: 300 })])
      assert.equal(before.status, 'failed', 'a message from an earlier run never satisfies a new run')
      const flood = await execute([step('click', 'Render', { selector: '#flood' }), step('click', 'Break viewer', { selector: '#throw' }),
        step('waitFor', 'Wait for the viewer', { selector: '#never-there', condition: 'visible', timeoutMs: 20000 }),
        step('click', 'Must not write after a console error', { selector: '#write' }), visible('#log-ready')], false, { failOnConsoleError: true, consoleErrorIgnore: ['CanvasTextAlign*'] })
      assert.equal(flood.status, 'failed', JSON.stringify(flood))
      // Messages reach the main process asynchronously, so a burst can spill into the next step's slice.
      const warnings = flood.evidence.console.filter(entry => entry.level === 'warning')
      assert.equal(warnings.reduce((sum, entry) => sum + (entry.count ?? 1), 0), 400, JSON.stringify(flood.evidence.console))
      assert.ok(warnings.length <= flood.steps.length, 'a flood of one warning is kept once per step with its count')
      assert.ok(flood.evidence.console.some(entry => entry.message === 'CanvasTextAlign failed once'), 'an ignored error is still reported')
      const broken = flood.steps.findIndex(item => item.status === 'failed')
      assert.ok(broken === 1 || broken === 2, `the uncaught error fails the click or the wait after it (${broken})`)
      assert.match(flood.steps[broken].reason, /Console error during this step: .*frame is undefined/)
      assert.ok(flood.steps[2].durationMs < 5000, 'a wait stops at its next poll after a console error')
      assert.ok(flood.steps.slice(broken + 1).every(item => item.status === 'skipped')); assert.equal(writes, 0)
      assert.equal(flood.evidence.capture.consoleComplete, true)
      const frame = await execute([step('click', 'Frame error', { selector: '#frame-error' }), visible('#log-ready')], false, { failOnConsoleError: true })
      // Console messages arrive asynchronously: the error fails the click or the step after it.
      const frameObserved = frame.status === 'failed' && frame.steps.some(item => item.status === 'failed' && /error inside the frame/.test(item.reason ?? ''))
      assert.ok(frameObserved, `the latch sees a same-origin frame's console error: ${JSON.stringify(frame)}`)
      browser.action('record-console:off')
      try {
        const unrecorded = await execute([step('click', 'Break viewer', { selector: '#throw' }),
          step('waitFor', 'Wait for the viewer', { selector: '#never-there', condition: 'visible', timeoutMs: 3000 }), visible('#log-ready')], false, { failOnConsoleError: true })
        assert.equal(unrecorded.status, 'failed', 'the latch still sees errors while recording is off')
        assert.match(unrecorded.steps.find(item => item.status === 'failed').reason, /frame is undefined/)
        assert.equal(unrecorded.evidence.capture.consoleComplete, false, 'the report says the console was not fully recorded')
      } finally { browser.action('record-console:on') }
      await browser.view.webContents.executeJavaScript('document.querySelector("#console-fixture").remove()')
      // Input: native wheel with modifiers, page-level keys, letter keys, and the focus guard.
      const inputSetup = `(${function () {
        document.querySelector('#input-fixture')?.remove()
        const fixture = document.createElement('div'); fixture.id = 'input-fixture'
        fixture.innerHTML = '<canvas id="stack" width="200" height="120" style="display:block;width:200px;height:120px;background:#ddd"></canvas>'
          + '<div id="scroller" style="height:80px;width:200px;overflow:auto"><div style="height:2000px"><p id="scroll-item" style="margin:20px 0">Item</p></div></div>'
          + '<canvas id="shifting" width="100" height="40" style="display:block;width:100px;height:40px;background:#bbb"></canvas>'
          + '<input id="shortcut-field" aria-label="Notes"><iframe id="key-frame" srcdoc="<input id=inner>" style="height:40px"></iframe>'
        document.body.prepend(fixture)
        const state = window.inputFixture = { wheels: [], keys: [] }
        fixture.querySelector('#stack').addEventListener('wheel', event => {
          event.preventDefault(); state.wheels.push({ deltaY: event.deltaY, ctrl: event.ctrlKey, shift: event.shiftKey, trusted: event.isTrusted })
        }, { passive: false })
        // A wheel handler that moves its own canvas, which stays fully visible.
        fixture.querySelector('#shifting').addEventListener('wheel', event => { event.preventDefault(); event.currentTarget.style.marginLeft = `${(parseInt(event.currentTarget.style.marginLeft) || 0) + 30}px` }, { passive: false })
        document.addEventListener('keydown', event => {
          state.keys.push({ key: event.key, code: event.code, ctrl: event.ctrlKey, trusted: event.isTrusted, target: event.target.id || event.target.localName })
          if (event.ctrlKey && event.key === 'b') event.preventDefault()
        })
        return true
      }.toString()})()`
      const contents = browser.view.webContents
      await contents.executeJavaScript(inputSetup)
      await until(() => contents.executeJavaScript('document.querySelector("#key-frame").contentDocument?.querySelector("#inner") !== null'), 'key frame loaded')
      const fixtureState = () => contents.executeJavaScript('window.inputFixture')
      const zoomBefore = contents.getZoomFactor()
      const wheeled = await execute([step('wheel', 'Ctrl+wheel through the stack', { selector: '#stack', deltaY: 120, repeat: 3, modifiers: ['Control'] }),
        step('wheel', 'Plain wheel', { selector: '#stack', deltaY: -120 }), visible('#stack')])
      assert.equal(wheeled.status, 'passed', JSON.stringify(wheeled))
      assert.deepEqual(wheeled.steps[0].data.wheel, { deltaX: 0, deltaY: 120, requested: 3, sent: 3 })
      const wheels = (await fixtureState()).wheels
      assert.deepEqual(wheels.map(event => [Math.sign(event.deltaY), event.ctrl, event.trusted]), [[1, true, true], [1, true, true], [1, true, true], [-1, false, true]], 'native wheel events carry the held modifier, which is released afterwards')
      assert.equal(contents.getZoomFactor(), zoomBefore, 'a Ctrl+wheel the page handles does not zoom the browser')
      assert.equal((await execute([step('wheel', 'Scroll the list', { selector: '#scroller', deltaY: 300 }), visible('#scroller')])).status, 'passed')
      await until(() => contents.executeJavaScript('document.querySelector("#scroller").scrollTop > 0'), 'wheel scrolls its container')
      await contents.executeJavaScript('document.querySelector("#scroller").scrollTop = 0')
      const itemWheel = await execute([step('wheel', 'Wheel on an item that scrolls away', { selector: '#scroll-item', deltaY: 100, repeat: 5 }), visible('#scroller')])
      assert.equal(itemWheel.status, 'failed', JSON.stringify(itemWheel)); assert.match(itemWheel.steps[0].reason, /Target moved (or was covered )?between wheel events/)
      assert.equal(itemWheel.steps[0].data.geometry.phase, 'between wheel events')
      assert.ok(itemWheel.steps[0].data.geometry.eventsSent >= 1 && itemWheel.steps[0].data.geometry.eventsSent < 5, JSON.stringify(itemWheel.steps[0].data))
      const shifted = await execute([step('wheel', 'Wheel a canvas that moves itself', { selector: '#shifting', deltaY: 100, repeat: 3 }), visible('#stack')])
      assert.equal(shifted.status, 'failed', JSON.stringify(shifted)); assert.match(shifted.steps[0].reason, /^Target moved between wheel events after 1 of 3 were sent\. Changed: x/)
      assert.deepEqual([shifted.steps[0].data.geometry.phase, shifted.steps[0].data.geometry.eventsSent, shifted.steps[0].data.wheel.sent], ['between wheel events', 1, 1])
      assert.equal(await contents.executeJavaScript('document.querySelector("#shifting").style.marginLeft'), '30px', 'no wheel event follows the move')
      await contents.executeJavaScript('document.activeElement?.blur(); window.inputFixture.keys = []')
      const pageKey = await execute([step('press', 'Page shortcut', { scope: 'page', key: 'k' }), visible('#stack')])
      assert.equal(pageKey.status, 'passed', JSON.stringify(pageKey)); assert.equal(pageKey.steps[0].data.keyboard.focus, 'document body')
      await contents.executeJavaScript('document.querySelector("#shortcut-field").focus()')
      const chord = await execute([step('press', 'Bold shortcut', { scope: 'page', key: 'b', modifiers: ['Control'] }), visible('#stack')])
      assert.equal(chord.status, 'passed', JSON.stringify(chord)); assert.equal(chord.steps[0].data.keyboard.focus.id, 'shortcut-field')
      assert.equal(await contents.executeJavaScript('document.querySelector("#shortcut-field").value'), '', 'a Control chord never types its letter')
      const typed = await execute([step('press', 'Type a letter', { selector: '#shortcut-field', key: 'x' }), visible('#stack')])
      assert.equal(typed.status, 'passed', JSON.stringify(typed))
      assert.equal(await contents.executeJavaScript('document.querySelector("#shortcut-field").value'), 'x')
      assert.deepEqual((await fixtureState()).keys.filter(event => event.key !== 'Control').map(event => [event.key, event.code, event.ctrl, event.trusted, event.target]),
        [['k', 'KeyK', false, true, 'body'], ['b', 'KeyB', true, true, 'shortcut-field'], ['x', 'KeyX', false, true, 'shortcut-field']])
      await contents.executeJavaScript('document.querySelector("#key-frame").contentDocument.querySelector("#inner").focus(); window.inputFixture.keys = []')
      const framed = await execute([step('press', 'Page key while a frame has focus', { scope: 'page', key: 'k' }), visible('#stack')])
      assert.equal(framed.status, 'failed', JSON.stringify(framed)); assert.match(framed.steps[0].reason, /focus is inside a frame/)
      assert.equal(framed.steps[0].delivery, 'not-attempted')
      assert.equal(await contents.executeJavaScript('document.querySelector("#key-frame").contentDocument.querySelector("#inner").value'), '', 'no key reaches the frame')
      await contents.executeJavaScript('document.querySelector("#input-fixture").remove()')
      // Screenshot crops: the whole viewport is masked first, then cut to an element or a region.
      const { nativeImage } = await import('electron')
      await contents.executeJavaScript(`(${function () {
        document.querySelector('#crop-fixture')?.remove()
        const fixture = document.createElement('div'); fixture.id = 'crop-fixture'
        fixture.style.cssText = 'position:fixed;left:20px;top:20px;width:160px;height:40px;background:#fff;z-index:3000'
        fixture.innerHTML = '<div style="position:absolute;left:0;top:0;width:60px;height:40px;background:#f00"></div><input id="crop-input" value="private-crop-value" style="position:absolute;left:80px;top:0;width:60px;height:30px;border:0;background:#0f0">'
        const mover = document.createElement('div'); mover.id = 'crop-mover'; mover.style.cssText = 'position:fixed;left:300px;top:20px;width:40px;height:40px;background:#00f;z-index:3000'
        let frame = 0; const move = () => { mover.style.left = `${300 + (++frame % 100)}px`; window.cropMove = requestAnimationFrame(move) }; window.cropMove = requestAnimationFrame(move)
        document.body.append(fixture, mover)
        return true
      }.toString()})()`)
      const pixel = (image, x, y) => { const size = image.getSize(); const bitmap = image.toBitmap(); const i = (Math.min(size.height - 1, Math.round(y)) * size.width + Math.min(size.width - 1, Math.round(x))) * 4; return [bitmap[i], bitmap[i + 1], bitmap[i + 2]] }
      const red = ([a, g, b]) => Math.max(a, b) >= 200 && Math.min(a, b) <= 60 && g <= 60
      const cropped = await execute([step('screenshot', 'Crop to the element', { selector: '#crop-fixture' }), step('screenshot', 'Crop to a region', { region: { x: 20, y: 20, width: 60, height: 40 } }), visible('#crop-fixture')])
      assert.equal(cropped.status, 'passed', JSON.stringify(cropped))
      const [elementShot, regionShot] = cropped.screenshots.map(shot => ({ ...shot, image: nativeImage.createFromPath(shot.path) }))
      const scale = elementShot.image.getSize().width / 160
      assert.ok(Math.abs(elementShot.region.x - 20) < 1 && Math.abs(elementShot.region.width - 160) < 1.5, JSON.stringify(elementShot.region))
      assert.ok(Math.abs(elementShot.image.getSize().height - 40 * scale) <= 2, `element crop is the element's size (${JSON.stringify(elementShot.image.getSize())})`)
      assert.ok(red(pixel(elementShot.image, 30 * scale, 20 * scale)), `red block is inside the element crop: ${pixel(elementShot.image, 30 * scale, 20 * scale)}`)
      assert.ok(pixel(elementShot.image, 110 * scale, 15 * scale).every(value => Math.abs(value - 17) <= 2), `the input stays masked inside the crop: ${pixel(elementShot.image, 110 * scale, 15 * scale)}`)
      assert.ok(Math.abs(regionShot.image.getSize().width - 60 * scale) <= 2 && red(pixel(regionShot.image, 30 * scale, 20 * scale)), 'a region crop holds only that region')
      const outside = await execute([step('screenshot', 'Crop off screen', { region: { x: 19000, y: 0, width: 50, height: 50 } }), visible('#crop-fixture')])
      assert.equal(outside.status, 'failed'); assert.match(outside.steps[0].reason, /outside the visible viewport/); assert.equal(outside.screenshots.length, 0)
      const moving = await execute([step('screenshot', 'Crop a moving element', { selector: '#crop-mover' }), visible('#crop-fixture')])
      assert.equal(moving.status, 'failed', JSON.stringify(moving)); assert.match(moving.steps[0].reason, /moved or resized during capture/); assert.equal(moving.screenshots.length, 0)
      await contents.executeJavaScript('cancelAnimationFrame(window.cropMove); document.querySelector("#crop-fixture").remove(); document.querySelector("#crop-mover").remove()')
      for (const switchPage of [false, true]) {
        await browser.view.webContents.executeJavaScript(dragSetup)
        const contents = browser.view.webContents; const pageId = browser.snapshot.activePageId
        const dragging = request(plan([drag({ durationMs: 2000 }), step('click', 'Must not write after cancelled drag', { selector: '#write' }), dragResult]))
        await until(() => contents.executeJavaScript('window.dragFixture.pressed'), 'native drag begins')
        browser.action(switchPage ? 'new-page' : 'testing:off')
        assert.equal((await (await dragging).json()).status, 'cancelled')
        const cancelledState = await contents.executeJavaScript('window.dragFixture')
        await writeFile(join(artifacts, `drag-cancel-${switchPage ? 'page' : 'stop'}.json`), JSON.stringify(cancelledState, null, 2))
        assert.equal(cancelledState.pressed, false, `cancelled drag releases its captured pointer (page switch: ${switchPage})`)
        assert.ok(cancelledState.events.some(event => ['pointerup', 'pointercancel', 'lostpointercapture'].includes(event.type) && event.trusted && event.buttons === 0), 'cancellation clears native button/capture state')
        assert.equal(writes, 0)
        if (switchPage) browser.action(`select-page:${pageId}`)
      }
      await browser.view.webContents.executeJavaScript('document.querySelector("#drag-canvas").remove();document.querySelector("#drag-status").remove()')
      const waiting = plan([step('waitFor', 'Waiting to cancel', { selector: '#never', condition: 'visible' }), step('click', 'Must not write', { selector: '#write' }), visible('#title')])
      const lastCompleted = browser.snapshot.testing.report
      let pending = request(waiting)
      await until(() => browser.snapshot.testing.running, 'test started')
      assert.deepEqual(browser.snapshot.testing.report, lastCompleted, 'starting a run preserves the completed report and viewport layout')
      browser.action('testing:off')
      assert.equal((await (await pending).json()).status, 'cancelled'); assert.equal(writes, 0)
      pending = request(waiting)
      await until(() => browser.snapshot.testing.running, 'test started for hide'); browser.setBounds(null)
      assert.equal((await (await pending).json()).status, 'cancelled'); assert.equal(browser.snapshot.testing.enabled, false)
      await assert.rejects(execute([visible('#title')]), /Show the selected browser page/)
      browser.setBounds({ x: 0, y: 0, width: 1000, height: 700 })
      pending = request(waiting)
      await until(() => browser.snapshot.testing.running, 'test started for switch'); const oldPage = browser.snapshot.activePageId; browser.action('new-page')
      assert.equal((await (await pending).json()).status, 'cancelled'); assert.equal(browser.snapshot.testing.enabled, false)
      await assert.rejects(execute([visible('body')]), /Open an HTTP or HTTPS page/)
      browser.action(`select-page:${oldPage}`)
      const disconnected = new AbortController(); pending = request(waiting, disconnected.signal).catch(() => null)
      await until(() => browser.snapshot.testing.running, 'test started for disconnect'); disconnected.abort(); await pending
      await until(() => !browser.snapshot.testing.running, 'disconnected test stops'); assert.equal(writes, 0)
      pending = request(plan([step('navigate', 'Navigation to cancel', { url: url + 'never-load' }), visible('#title')]))
      await until(() => navigationWaiting, 'navigation started'); browser.action('testing:off')
      assert.equal((await (await pending).json()).status, 'cancelled')
      const embedded = await execute([step('navigate', 'Open app with third-party frame', { url: url + 'frames' }), visible('h1')])
      assert.equal(embedded.status, 'passed', JSON.stringify(embedded))
      const frames = (await browserCommand(['frames'])).frames
      assert.equal(frames.length, 3)
      const sameFrame = frames.find(frame => frame.url === url + 'frame')
      const foreignFrame = frames.find(frame => frame.url.startsWith(`http://localhost:${foreign.address().port}/`))
      assert.ok(sameFrame); assert.ok(foreignFrame)
      for (const frame of [sameFrame]) {
        const report = await execute([step('fill', 'Frame input', { selector: '#field', frame: frame.id, value: 'frame-value' }),
          step('assert', 'Frame value', { selector: '#field', frame: frame.id, condition: 'value', expected: 'frame-value' }),
          step('click', 'Frame click', { selector: '#button', frame: frame.id }),
          step('assert', 'Frame event', { selector: '#result', frame: frame.id, condition: 'text', expected: 'Frame passed' })])
        assert.equal(report.status, 'passed', JSON.stringify(report))
        const childContents = browser.view.webContents.mainFrame.frames.find(child => child.url === url + 'frame')
        await childContents.executeJavaScript(dragSetup)
        await browser.view.webContents.executeJavaScript('document.querySelector("iframe").style.height="350px"')
        const dragged = await execute([drag({ frame: frame.id }), { ...dragResult, frame: frame.id }])
        assert.equal(dragged.status, 'passed', JSON.stringify(dragged))
        await assertDragEndpoint(childContents)
      }
      const foreignReady = await execute([visible('#result', { frame: foreignFrame.id })])
      assert.equal(foreignReady.status, 'passed', 'cross-origin frame assertions remain read-only')
      // count is per frame: the top document has no #button, and each frame has exactly one.
      const counted = await execute([step('assert', 'No button in the top document', { selector: '#button', condition: 'count', expected: 0 }),
        step('assert', 'One button in the same-origin frame', { selector: '#button', frame: sameFrame.id, condition: 'count', expected: 1 }),
        step('assert', 'One button in the cross-origin frame', { selector: '#button', frame: foreignFrame.id, condition: 'count', expected: 1 })])
      assert.equal(counted.status, 'passed', JSON.stringify(counted))
      for (const [action, rest] of [['fill', { selector: '#field', value: 'unrelated-env-secret-value-123' }],
        ['select', { selector: '#choice', value: 'new' }], ['press', { selector: '#field', key: 'Enter' }], ['click', { selector: '#button' }],
        ['drag', { selector: '#button', path: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }]]) {
        const blocked = await execute([step(action, 'Untrusted frame input', { frame: foreignFrame.id, ...rest }), visible('#result', { frame: foreignFrame.id })])
        assert.equal(blocked.status, 'failed', JSON.stringify(blocked)); assert.match(blocked.steps[0].reason, /origin/)
        assert.deepEqual(receivedValues, [])
      }
      await browser.view.webContents.executeJavaScript(`(() => {
        const input = document.createElement('input'); input.id = 'focus-steal';
        input.addEventListener('focus', () => document.querySelectorAll('iframe')[1].focus()); document.body.append(input);
      })()`)
      const focusSteal = await execute([step('fill', 'Frame steals focus', { selector: '#focus-steal', value: 'unrelated-env-secret-value-123' }),
        visible('#result', { frame: foreignFrame.id })])
      assert.equal(focusSteal.status, 'failed', JSON.stringify(focusSteal)); assert.match(focusSteal.steps[0].reason, /focus changed/)
      assert.deepEqual(receivedValues, [], 'cross-origin focus stealing cannot receive test input')
      await browser.view.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify('<div id="frame-cover" style="position:fixed;inset:0;z-index:999;background:white" onclick="fetch(\'/write\',{method:\'POST\'})"></div>')})`)
      for (const frame of [sameFrame]) {
        const report = await execute([step('click', 'Covered frame click', { selector: '#button', frame: frame.id }), visible('#result', { frame: frame.id })])
        assert.equal(report.status, 'failed', JSON.stringify(report)); assert.match(report.steps[0].reason, /covered/)
        assert.equal(writes, 0, 'a covered frame must never click the covering page control')
      }
      await browser.view.webContents.executeJavaScript('document.querySelector("#frame-cover").remove()')
      const isolated = await execute([visible('#button', { frame: String(second.view.webContents.id) })])
      assert.equal(isolated.status, 'failed'); assert.match(isolated.steps[0].reason, /Frame is unavailable/)
      const redirectedFrame = await execute([step('navigate', 'Open app with redirected third-party frame', { url: url + 'redirect-frames' }), visible('#ok')])
      assert.equal(redirectedFrame.status, 'passed', JSON.stringify(redirectedFrame))
      const child = (await browserCommand(['frames'])).frames.find(frame => frame.url.startsWith(`http://localhost:${foreign.address().port}/`))
      assert.ok(child, 'the third-party iframe redirect completes')
      assert.equal((await execute([visible('#result', { frame: child.id })])).status, 'passed')
      const redirectedInput = await execute([step('fill', 'Redirected frame input stays blocked', { selector: '#field', frame: child.id, value: 'unrelated-env-secret-value-123' }), visible('#ok')])
      assert.equal(redirectedInput.status, 'failed', JSON.stringify(redirectedInput)); assert.match(redirectedInput.steps[0].reason, /origin/)
      assert.deepEqual(receivedValues, [])
      const testRoute = `http://127.0.0.1:${controller.port}/test`
      assert.equal((await fetch(testRoute, { method: 'POST', body: '{}' })).status, 401)
      assert.equal((await fetch(testRoute, { method: 'POST', headers: { origin: 'https://untrusted.test', authorization: `Bearer ${controller.token}` } })).status, 403)
      assert.equal((await request({ ...plan([visible('#title')]), script: 'alert(1)' })).status, 400)
      // The JSON route also carries reference images, so its byte limit is larger; the plan itself stays within 128 KiB.
      const { MAX_TEST_REQUEST_BYTES } = await import('../dist/src/main/browser-test-plan.js')
      assert.equal((await fetch(testRoute, { method: 'POST', headers: { authorization: `Bearer ${controller.token}`, 'content-type': 'application/json' }, body: ' '.repeat(MAX_TEST_REQUEST_BYTES + 1) })).status, 413)
      const oversized = await request(plan([visible('#title', { label: 'x'.repeat(150) })], { expected: 'y'.repeat(4000), description: 'z'.repeat(4000), consoleErrorIgnore: undefined, steps: Array.from({ length: 50 }, () => visible('#title' + ', #absent'.repeat(55), { text: 'w'.repeat(2000), label: 'v'.repeat(200) })) }))
      assert.equal(oversized.status, 400); assert.match((await oversized.json()).message, /128 KiB/)
      await browser.navigate(foreignUrl)
      assert.equal(browser.snapshot.testing.enabled, true, 'new site is ready for a fresh run automatically')
      assert.equal((await execute([step('fill', 'Explicitly chosen site', { selector: '#q', value: 'user-test-input' }), visible('#q')])).status, 'passed')
      await until(() => receivedValues.includes('user-test-input'), 'new test binds to the newly selected site')
      assert.ok(!receivedValues.includes('unrelated-env-secret-value-123'))
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, workflow: true, nativeInput: true, nativeDoubleClick: true,
        screenshots: true, screenshotComparison: true, installedPowerShell: true, failStopsWrites: true, ambiguity: true, coveredTarget: true, cancel: true, tabChange: true,
        disconnect: true, sameOriginFrame: true, crossOriginFrame: true, isolation: true, authentication: true, noPerStepApproval: approvals === 0,
        unicode: true, hover: true, openShadowRoot: true, contentEditable: true, navigationCancellation: true, hiddenCancellation: true,
        targetValuesWithheld: true, frameOverlayStopsWrites: true, replacedTargetStopsWrites: true, changedDocumentStopsWrites: true, hoverReflow: true,
        environmentInputsRestricted: true, originBoundNavigation: true, crossOriginRedirectBlocked: true, crossOriginLinkBlocked: true,
        crossOriginInputBlocked: true, crossOriginFocusStealingBlocked: true, manualOriginChangeRevokesGrant: true, explicitOriginGrant: true,
        thirdPartyFrameNavigation: true, thirdPartyFrameRedirect: true, redirectedFrameInputBlocked: true, generatedPlanWithoutLabels: true,
        nativeCoordinateDrag: true, dragInterpolation: true, dragBounds: true, dragGeometryGuard: true, dragOverlayGuard: true,
        dragReplacementGuard: true, zoomedCoordinateDrag: true, dragCancellationReleasesButton: true, dragPageSwitchReleasesButton: true,
        sameOriginFrameDrag: true, crossOriginDragBlocked: true, dragEndpointTolerance: 1,
        html5DragAndDrop: true, html5DropRefusedOrCancelled: true, pointerDragRefusesHtml5Drag: true,
        viewerOverlayMeasurement: true, directSvgInputSurface: true, partiallyVisibleDragSurface: true,
        dragPointDiagnostics: true, obstructionMetadataWithholdsValues: true, obstructedViewerReleasesPointer: true,
        geometryPhaseDiagnostics: true, stableCondition: true, dataAttributeCondition: true,
        consoleMessageCondition: true, consoleErrorLatch: true, consoleRepeatCompression: true, consoleLatchWithoutRecording: true,
        nativeModifierWheel: true, wheelContainerScroll: true, wheelMovedTargetStops: true, pageLevelKeys: true, characterKeys: true, frameFocusGuard: true,
        screenshotElementCrop: true, screenshotRegionCrop: true, cropKeepsMasks: true, movingCropRejected: true, frameCount: true,
        devicePixelRatio: await browser.view.webContents.executeJavaScript('window.devicePixelRatio') }, null, 2))
      console.log('Browser testing check passed: general workflow, native input, expectations, evidence, frames, cancellation and installed helper.')
    } finally {
      await browser.dispose(); await second.dispose()
      window.destroy(); site.closeAllConnections(); site.close(); foreign.closeAllConnections(); foreign.close()
      app.quit()
    }
  }
}
