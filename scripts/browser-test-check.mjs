import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const artifacts = resolve('test-results/browser-testing')
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
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
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
    const plan = steps => ({ description: 'Exercise a user-described workflow 用户测试', expected: 'Expected checks pass', steps })
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
    const dragResult = step('assert', 'Canvas reports the intended endpoint', { selector: '#drag-status', condition: 'text', expected: 'Dragged to 240,90' })
    let sequence = 0
    const runId = Date.now()
    const execute = async (steps, shell = false) => {
      const input = join(artifacts, `plan-${runId}-${++sequence}.json`); const output = join(artifacts, `report-${runId}-${sequence}.json`)
      await writeFile(input, JSON.stringify(plan(steps)))
      const result = shell ? JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', environment.COPILOT_DESKTOP_BROWSER_HELPER, 'test', input, '-OutputPath', output], { env: process.env, windowsHide: true, timeout: 60000 })).stdout)
        : await browserCommand(['test', input, output])
      assert.ok(!JSON.stringify(result).includes('fixture-private-password')); assert.ok(!JSON.stringify(result).includes('imageBase64'))
      return result
    }
    try {
      browser.setBounds({ x: 0, y: 0, width: 1000, height: 700 }); window.showInactive()
      await browser.open(); await second.open(); await browser.navigate(url)
      await assert.rejects(execute([visible('#login')]), /Testing mode/)
      browser.action('testing:on')
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
      const controller = JSON.parse(await readFile(endpoint, 'utf8'))
      const request = (value, signal) => fetch(`http://127.0.0.1:${controller.port}/test`, { method: 'POST', headers: { authorization: `Bearer ${controller.token}`, 'content-type': 'application/json' }, body: JSON.stringify(value), ...(signal ? { signal } : {}) })
      for (const shell of [false, true]) {
        await browser.view.webContents.executeJavaScript(dragSetup)
        const target = (await browserCommand(['test-targets'])).targets.find(target => target.selector === '#drag-canvas')
        assert.equal(target.bounds.width, 300); assert.equal(target.bounds.height, 140)
        const report = await execute([drag(), dragResult], shell)
        assert.equal(report.status, 'passed', JSON.stringify(report))
        const state = await browser.view.webContents.executeJavaScript('window.dragFixture')
        assert.ok(state.events.every(event => event.trusted), 'drag dispatches trusted native pointer events')
        assert.ok(state.events.filter(event => event.type === 'pointermove').length > 2, 'drag interpolates between waypoints')
        assert.ok(state.events.filter(event => event.type === 'pointermove').every(event => event.buttons === 1))
        assert.ok(state.events.some(event => event.type === 'pointermove' && event.x === 80 && event.y === 40), 'drag visits the intermediate waypoint')
        assert.equal(state.events[0].type, 'pointerdown'); assert.ok(state.events.some(event => event.type === 'pointerup' && event.buttons === 0))
        assert.equal(state.pressed, false)
      }
      browser.view.webContents.setZoomFactor(1.25)
      await browser.view.webContents.executeJavaScript(dragSetup)
      const zoomedDrag = await execute([drag(), dragResult])
      assert.equal(zoomedDrag.status, 'passed', JSON.stringify(zoomedDrag))
      browser.view.webContents.setZoomFactor(1)
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
        browser.action('testing:on')
      }
      await browser.view.webContents.executeJavaScript('document.querySelector("#drag-canvas").remove();document.querySelector("#drag-status").remove()')
      const waiting = plan([step('waitFor', 'Waiting to cancel', { selector: '#never', condition: 'visible' }), step('click', 'Must not write', { selector: '#write' }), visible('#title')])
      const lastCompleted = browser.snapshot.testing.report
      let pending = request(waiting)
      await until(() => browser.snapshot.testing.running, 'test started')
      assert.deepEqual(browser.snapshot.testing.report, lastCompleted, 'starting a run preserves the completed report and viewport layout')
      browser.action('testing:off')
      assert.equal((await (await pending).json()).status, 'cancelled'); assert.equal(writes, 0)
      browser.action('testing:on'); pending = request(waiting)
      await until(() => browser.snapshot.testing.running, 'test started for hide'); browser.setBounds(null)
      assert.equal((await (await pending).json()).status, 'cancelled'); assert.equal(browser.snapshot.testing.enabled, false)
      browser.setBounds({ x: 0, y: 0, width: 1000, height: 700 })
      browser.action('testing:on'); pending = request(waiting)
      await until(() => browser.snapshot.testing.running, 'test started for switch'); const oldPage = browser.snapshot.activePageId; browser.action('new-page')
      assert.equal((await (await pending).json()).status, 'cancelled'); assert.equal(browser.snapshot.testing.enabled, false)
      browser.action(`select-page:${oldPage}`); browser.action('testing:on')
      const disconnected = new AbortController(); pending = request(waiting, disconnected.signal).catch(() => null)
      await until(() => browser.snapshot.testing.running, 'test started for disconnect'); disconnected.abort(); await pending
      await until(() => !browser.snapshot.testing.running, 'disconnected test stops'); assert.equal(writes, 0)
      browser.action('testing:on')
      pending = request(plan([step('navigate', 'Navigation to cancel', { url: url + 'never-load' }), visible('#title')]))
      await until(() => navigationWaiting, 'navigation started'); browser.action('testing:off')
      assert.equal((await (await pending).json()).status, 'cancelled')
      browser.action('testing:on')
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
      }
      const foreignReady = await execute([visible('#result', { frame: foreignFrame.id })])
      assert.equal(foreignReady.status, 'passed', 'cross-origin frame assertions remain read-only')
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
      assert.equal((await fetch(testRoute, { method: 'POST', headers: { authorization: `Bearer ${controller.token}`, 'content-type': 'application/json' }, body: ' '.repeat(131073) })).status, 413)
      await browser.navigate(foreignUrl)
      assert.equal(browser.snapshot.testing.enabled, false, 'manual origin changes revoke the grant')
      await assert.rejects(execute([visible('#q')]), /Testing mode/)
      browser.action('testing:on')
      assert.equal((await execute([step('fill', 'Explicitly chosen site', { selector: '#q', value: 'user-test-input' }), visible('#q')])).status, 'passed')
      await until(() => receivedValues.includes('user-test-input'), 'explicit user origin grant permits input')
      assert.ok(!receivedValues.includes('unrelated-env-secret-value-123'))
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, workflow: true, nativeInput: true, nativeDoubleClick: true,
        screenshots: true, installedPowerShell: true, failStopsWrites: true, ambiguity: true, coveredTarget: true, cancel: true, tabChange: true,
        disconnect: true, sameOriginFrame: true, crossOriginFrame: true, isolation: true, authentication: true, noPerStepApproval: approvals === 0,
        unicode: true, hover: true, openShadowRoot: true, contentEditable: true, navigationCancellation: true, hiddenCancellation: true,
        targetValuesWithheld: true, frameOverlayStopsWrites: true, replacedTargetStopsWrites: true, changedDocumentStopsWrites: true, hoverReflow: true,
        environmentInputsRestricted: true, originBoundNavigation: true, crossOriginRedirectBlocked: true, crossOriginLinkBlocked: true,
        crossOriginInputBlocked: true, crossOriginFocusStealingBlocked: true, manualOriginChangeRevokesGrant: true, explicitOriginGrant: true,
        thirdPartyFrameNavigation: true, thirdPartyFrameRedirect: true, redirectedFrameInputBlocked: true, generatedPlanWithoutLabels: true,
        nativeCoordinateDrag: true, dragInterpolation: true, dragBounds: true, dragGeometryGuard: true, dragOverlayGuard: true,
        dragReplacementGuard: true, zoomedCoordinateDrag: true, dragCancellationReleasesButton: true, dragPageSwitchReleasesButton: true,
        sameOriginFrameDrag: true, crossOriginDragBlocked: true }, null, 2))
      console.log('Browser testing check passed: general workflow, native input, expectations, evidence, frames, cancellation and installed helper.')
    } finally { await browser.dispose(); await second.dispose(); window.destroy(); site.closeAllConnections(); site.close(); foreign.closeAllConnections(); foreign.close(); app.quit() }
  }
}
