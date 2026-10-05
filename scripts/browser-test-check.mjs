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
    let writes = 0; let approvals = 0; let navigationWaiting = false
    const site = createServer((request, response) => {
      response.setHeader('content-type', 'text/html')
      if (request.url === '/never-load') { navigationWaiting = true; return }
      if (request.url === '/redirect-target') { response.end('<h1>Changed document</h1><button id="redirect-target" onclick="fetch(\'/write\',{method:\'POST\'})">Unexpected target</button>'); return }
      if (request.url === '/write') { writes++; response.end('written'); return }
      if (request.url === '/frame') { response.end(`<input id="field" aria-label="Frame input"><button id="button" onclick="result.textContent=event.isTrusted?'Frame passed':'Untrusted'">Run</button><p id="result"></p>`); return }
      if (request.url === '/frames') { response.end(`<h1>Frames</h1><iframe style="display:block;height:150px" src="/frame"></iframe><iframe style="display:block;height:150px" src="http://localhost:${site.address().port}/frame"></iframe>`); return }
      response.end(`<!doctype html><title>Generic test application</title><style>body{font:16px sans-serif}#detail{display:none}.cover{position:fixed;inset:0;z-index:100;background:#fff}#hover-result{display:none}#hover-target:hover + #hover-result{display:block}</style>
        <label>User <input id="user"></label><label>Password <input id="password" type="password"></label>
        <button id="login" onclick="login.hidden=true;setTimeout(()=>list.hidden=false,100)">Log in</button>
        <section id="list" hidden><input id="search" aria-label="Search" onkeydown="if(event.key==='Enter')row.hidden=this.value!=='ITEM-42'">
        <select id="category"><option value="old">Old</option><option value="new">New</option></select><input id="check" type="checkbox">
        <div id="row" hidden ondblclick="detail.style.display='block';trusted.textContent=event.isTrusted?'Trusted double-click':'Untrusted';document.querySelector('#canvas').getContext('2d').fillRect(0,0,20,20)">ITEM-42</div></section>
        <section id="detail"><h2 id="title">ITEM-42 details</h2><p id="trusted"></p><img id="image" width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='green'/%3E%3C/svg%3E"><canvas id="canvas" width="20" height="20"></canvas></section>
        <button id="write" onclick="fetch('/write',{method:'POST'})">Write</button><div class="duplicate">One</div><div class="duplicate">Two</div><button id="hover-target">Hover menu</button><p id="hover-result">Menu expanded</p>
        <div data-testid="editor"><div id="editor" contenteditable="true">private-editor-value</div></div><textarea>private-textarea-value</textarea>`)
    })
    await new Promise(resolve => site.listen(0, resolve))
    const window = new BrowserWindow({ show: false, width: 1100, height: 850 })
    await window.loadURL('data:text/html,<title>Isolated browser testing fixture</title>')
    const endpoint = join(artifacts, 'control.json')
    const environment = await prepareBrowserSessionEnvironment(join(artifacts, 'helpers'), 'tab-1', process.env)
    Object.assign(process.env, environment, { COPILOT_DESKTOP_BROWSER_STATE: endpoint, BROWSER_TEST_PASSWORD: 'fixture-private-password' })
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint, approveInteraction: async () => { approvals++; return false } })
    const second = new BrowserDebug(window, join(artifacts, `second-settings-${Date.now()}.json`), { endpointPath: join(artifacts, 'second-control.json') })
    const url = `http://127.0.0.1:${site.address().port}/`
    const plan = steps => ({ description: 'Exercise a user-described workflow 用户测试', expected: 'Expected checks pass', steps })
    const step = (action, label, rest) => ({ action, label, ...rest })
    const visible = (selector, extra = {}) => step('assert', 'Expected element visible', { selector, condition: 'visible', ...extra })
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
      const targets = await browserCommand(['test-targets'])
      assert.ok(targets.targets.some(target => target.selector === '#password'))
      assert.ok(!JSON.stringify(targets).includes('private-editor-value')); assert.ok(!JSON.stringify(targets).includes('private-textarea-value'))
      const workflow = await execute([
        step('navigate', 'Open the app', { url }), step('fill', 'Enter user', { selector: '#user', value: 'fixture-user' }),
        step('fill', 'Enter password', { selector: '#password', valueFromEnv: 'BROWSER_TEST_PASSWORD' }), step('click', 'Log in', { selector: '#login' }),
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
      await browser.navigate(url + 'frames')
      const frames = (await browserCommand(['frames'])).frames
      assert.equal(frames.length, 3)
      for (const frame of frames.slice(1)) {
        const report = await execute([step('fill', 'Frame input', { selector: '#field', frame: frame.id, value: 'frame-value' }),
          step('assert', 'Frame value', { selector: '#field', frame: frame.id, condition: 'value', expected: 'frame-value' }),
          step('click', 'Frame click', { selector: '#button', frame: frame.id }),
          step('assert', 'Frame event', { selector: '#result', frame: frame.id, condition: 'text', expected: 'Frame passed' })])
        assert.equal(report.status, 'passed', JSON.stringify(report))
      }
      await browser.view.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify('<div id="frame-cover" style="position:fixed;inset:0;z-index:999;background:white" onclick="fetch(\'/write\',{method:\'POST\'})"></div>')})`)
      for (const frame of frames.slice(1)) {
        const report = await execute([step('click', 'Covered frame click', { selector: '#button', frame: frame.id }), visible('#result', { frame: frame.id })])
        assert.equal(report.status, 'failed', JSON.stringify(report)); assert.match(report.steps[0].reason, /covered/)
        assert.equal(writes, 0, 'a covered frame must never click the covering page control')
      }
      await browser.view.webContents.executeJavaScript('document.querySelector("#frame-cover").remove()')
      const isolated = await execute([visible('#button', { frame: String(second.view.webContents.id) })])
      assert.equal(isolated.status, 'failed'); assert.match(isolated.steps[0].reason, /Frame is unavailable/)
      const testRoute = `http://127.0.0.1:${controller.port}/test`
      assert.equal((await fetch(testRoute, { method: 'POST', body: '{}' })).status, 401)
      assert.equal((await fetch(testRoute, { method: 'POST', headers: { origin: 'https://untrusted.test', authorization: `Bearer ${controller.token}` } })).status, 403)
      assert.equal((await request({ ...plan([visible('#title')]), script: 'alert(1)' })).status, 400)
      assert.equal((await fetch(testRoute, { method: 'POST', headers: { authorization: `Bearer ${controller.token}`, 'content-type': 'application/json' }, body: ' '.repeat(131073) })).status, 413)
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, workflow: true, nativeInput: true, nativeDoubleClick: true,
        screenshots: true, installedPowerShell: true, failStopsWrites: true, ambiguity: true, coveredTarget: true, cancel: true, tabChange: true,
        disconnect: true, sameOriginFrame: true, crossOriginFrame: true, isolation: true, authentication: true, noPerStepApproval: approvals === 0,
        unicode: true, hover: true, openShadowRoot: true, contentEditable: true, navigationCancellation: true, hiddenCancellation: true,
        targetValuesWithheld: true, frameOverlayStopsWrites: true, replacedTargetStopsWrites: true, changedDocumentStopsWrites: true, hoverReflow: true }, null, 2))
      console.log('Browser testing check passed: general workflow, native input, expectations, evidence, frames, cancellation and installed helper.')
    } finally { await browser.dispose(); await second.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit() }
  }
}
