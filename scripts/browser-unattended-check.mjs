import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const scale = process.argv.find(arg => arg.startsWith('--force-device-scale-factor='))
const networkOnly = process.argv.includes('--network-only')
if (scale) assert.ok(/^--force-device-scale-factor=(1|1\.25|1\.5|2)$/.test(scale), 'Acceptance scales: 1, 1.25, 1.5, 2')
const artifacts = resolve('test-results/browser-unattended', scale?.split('=')[1] ?? 'default')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (read, label) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50) }
  throw new Error(`Timed out: ${label}`)
}
if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [...(scale ? [scale] : []), fileURLToPath(import.meta.url), ...(networkOnly ? ['--network-only'] : [])], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 240000)
  try {
    assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0)
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
    let saves = 0
    const html = `<!doctype html><meta charset="utf-8"><title>Generic unattended UI fixture</title>
      <style>body{font:14px sans-serif;margin:12px}.icon{display:inline-block;cursor:pointer;padding:8px;border:1px solid #888;position:relative}
      #menu{display:none;position:absolute;top:30px;left:0;background:#fff;z-index:10;width:100px}.tools:hover #menu{display:block}
      #stage{position:relative;width:400px;height:200px;margin-top:20px}canvas,#surface{position:absolute;inset:0;width:400px;height:200px;touch-action:none}
      #cover{position:fixed;inset:0;z-index:999;background:#ddd}dialog input{width:100px}</style>
      <div role="toolbar"><div class="icon tools" title="Drawing tools" aria-label="Drawing tools" tabindex="0">✎
        <div id="menu" role="menu"><span class="icon" role="menuitem" title="Line tool" onclick="chooseTool(this)">Line</span></div></div>
        <span class="icon" title="Edit number" onclick="numberDialog.showModal()">123</span>
        <button id="handle-tool" onclick="tool='handle'">Handle</button><button id="save" onclick="save()">Save</button>
        <button id="dirty" onclick="window.onbeforeunload=()=>true">Unsaved changes</button>
        <button id="clean" onclick="window.onbeforeunload=null">Saved changes</button>
        <button id="ineffective" onclick="tool='none'">Ineffective tool</button>
        <button id="obstruct" onclick="obstruct=true">Obstruct next input</button>
        <button id="slow" onclick="fetch('/slow').catch(()=>{})">Slow request</button>
      </div><p id="tool-state">No tool</p>
      <div id="stage"><canvas id="image" width="800" height="400" data-test-render="busy"></canvas>
        <svg id="surface" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg"><circle id="handle" cx="180" cy="100" r="10" fill="#f80"/></svg></div>
      <p id="shape">empty</p><p id="handle-state">180,100</p><p id="angle">0</p><p id="pixel-result">empty pixels</p><p id="save-status">idle</p><p id="loading">Drawing…</p>
      <dialog id="numberDialog"><label>Exact value <input id="number" type="number" value="0" step="0.1"></label>
        <button onclick="commitNumber()">Apply</button></dialog>
      <button id="hidden-control" hidden>Hidden</button><div id="duplicates"><button class="duplicate">Same</button><button class="duplicate">Same</button></div>
      <script>
      let tool='none', pressed=false, obstruct=false, start=null, end=null, revision=0;
      window.fixtureEvents=[];const canvas=document.querySelector('canvas'), surface=document.querySelector('#surface'), ctx=canvas.getContext('2d');
      function render(){canvas.dataset.testRender='busy';loading.hidden=false;const current=++revision;
        setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{if(current!==revision)return;
          ctx.fillStyle='#123';ctx.fillRect(0,0,800,400);if(start&&end){ctx.strokeStyle='#ff0';ctx.lineWidth=6;ctx.beginPath();ctx.moveTo(start.x*2,start.y*2);ctx.lineTo(end.x*2,end.y*2);ctx.stroke();}
          canvas.dataset.testRender='ready';canvas.dataset.testRevision=String(current);loading.hidden=true;
          const pixel=ctx.getImageData(160,90,1,1).data;
          document.querySelector('#pixel-result').textContent=pixel[0]===255&&pixel[1]===255&&pixel[2]===0?'line pixels rendered':'background pixels rendered';
        })),120);}
      function chooseTool(el){tool='draw';start=null;end=null;document.querySelector('#shape').textContent='empty';el.setAttribute('aria-selected','true');document.querySelector('#tool-state').textContent='Line selected';render()}
      function commitNumber(){document.querySelector('#angle').textContent=String(Number(number.value));numberDialog.close();render()}
      number.onkeydown=e=>{if(e.key==='Enter')commitNumber()};
      function point(e){const r=surface.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
      for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])surface.addEventListener(type,e=>{
        if(type==='pointermove'&&!pressed)return;window.fixtureEvents.push({type,trusted:e.isTrusted,buttons:e.buttons,shift:e.shiftKey});
        if(type==='pointerdown'){pressed=true;surface.setPointerCapture(e.pointerId);surface.dataset.testModifier=e.shiftKey?'shift':'none';if(tool==='draw'&&document.querySelector('#shape').textContent==='empty'){start=point(e);end=start}
          if(obstruct){obstruct=false;const cover=document.createElement('div');cover.id='cover';document.body.append(cover)}}
        if(type==='pointermove'&&tool==='draw'){end=point(e);render()}
        if(type==='pointermove'&&tool==='handle'){const p=point(e);handle.setAttribute('cx',p.x);handle.setAttribute('cy',p.y);document.querySelector('#handle-state').textContent=Math.round(p.x)+','+Math.round(p.y)}
        if(type==='pointerup'||type==='pointercancel'){pressed=false;if(tool==='draw'){document.querySelector('#shape').textContent='drawn';render()}}
      });
      surface.addEventListener('dblclick',()=>{document.querySelector('#shape').textContent='finished';render()});
      document.addEventListener('keyup',e=>{if(e.key==='Shift')surface.dataset.testShiftReleased='true'});
      async function save(){try{const r=await fetch('/api/save',{method:'POST'});await r.text();document.querySelector('#save-status').textContent=r.ok?'saved':'HTTP '+r.status;console.log('fixture save status '+r.status)}catch{document.querySelector('#save-status').textContent='transport failed';console.warn('fixture transport failed')}}
      render();
      </script>`
    const site = createServer(async (request, response) => {
      if (request.url === '/api/save') { saves++; response.setHeader('content-type', 'application/json'); response.end('{"saved":true}'); return }
      if (request.url === '/slow') { await delay(3000); response.end('done'); return }
      response.setHeader('content-type', 'text/html'); response.end(html)
    })
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${site.address().port}/`
    const window = new BrowserWindow({ show: false, width: 1100, height: 900 })
    await window.loadURL('data:text/html,Generic acceptance host')
    const endpoint = join(artifacts, 'control.json')
    const env = await prepareBrowserSessionEnvironment(join(artifacts, 'helpers'), 'tab-1', process.env)
    Object.assign(process.env, env, { COPILOT_DESKTOP_BROWSER_STATE: endpoint })
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint })
    const other = new BrowserDebug(window, join(artifacts, `other-settings-${Date.now()}.json`), { endpointPath: join(artifacts, 'other-control.json') })
    const results = []
    let sequence = 0
    const visible = selector => ({ action: 'assert', selector, condition: 'visible' })
    const text = (selector, expected, timeoutMs) => ({ action: 'assert', selector, condition: 'text', expected, ...(timeoutMs ? { timeoutMs } : {}) })
    const ready = [{ selector: '#image', condition: 'attribute', attribute: 'data-test-render', expected: 'ready' }, { selector: '#loading', condition: 'hidden' }]
    const execute = async (steps, extra = {}, shell = false) => {
      const basename = `${Date.now()}-${++sequence}`
      const input = join(artifacts, `${basename}.plan.json`), output = join(artifacts, `${basename}.report.json`)
      await writeFile(input, JSON.stringify({ description: 'Generic unattended UI acceptance', expected: 'Observable assertions match; delivery alone is insufficient', steps, ...extra }))
      const report = shell ? JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', env.COPILOT_DESKTOP_BROWSER_HELPER, 'test', input, '-OutputPath', output], { env: process.env, windowsHide: true, timeout: 90000 })).stdout)
        : await browserCommand(['test', input, output])
      results.push({ path: report.path, status: report.status, outcomes: report.steps.map(step => step.outcome) })
      return report
    }
    const passed = report => assert.equal(report.status, 'passed', JSON.stringify(report.steps))
    const discover = () => browserCommand(['test-targets'])
    const named = (discovery, title) => { const target = discovery.targets.find(target => target.title === title); assert.ok(target, title); return target }
    const controller = async () => JSON.parse(await readFile(endpoint, 'utf8'))
    try {
      browser.setBounds({ x: 0, y: 0, width: 1000, height: 740 }); window.showInactive()
      await browser.open(); await other.open(); await browser.navigate(url); await other.navigate(url)
      browser.action('testing:on')
      if (!networkOnly) {
      passed(await execute([{ action: 'reload', all: ready }, visible('#image')], {}, process.platform === 'win32'))
      assert.equal(browser.snapshot.testing.enabled, true)
      let discovery = await discover()
      assert.ok(discovery.unavailable.some(target => target.id === 'hidden-control'))
      const old = named(discovery, 'Drawing tools')
      assert.equal(old.selectorUnique, false)
      discovery = await discover()
      const stale = await execute([{ action: 'hover', targetRef: old.ref }, visible('#image')])
      assert.equal(stale.status, 'failed'); assert.match(stale.steps[0].reason, /stale/)
      passed(await execute([{ action: 'hover', targetRef: named(discovery, 'Drawing tools').ref }, visible('#menu')]))
      discovery = await discover()
      passed(await execute([{ action: 'click', targetRef: named(discovery, 'Line tool').ref }, text('#tool-state', 'Line selected')]))
      for (const zoom of [0.8, 1, 1.25, 1.5]) {
        browser.view.webContents.setZoomFactor(zoom)
        passed(await execute([
          { action: 'hover', selector: '.tools' }, { action: 'click', selector: '#menu [role=menuitem]' }, { action: 'waitFor', all: ready },
          { action: 'screenshot', label: `Before drawing at zoom ${zoom}` },
          { action: 'hover', selector: '#image', inputSelector: '#surface', point: { x: 20, y: 20 } },
          { action: 'drag', selector: '#image', inputSelector: '#surface', modifiers: ['Shift'], path: [{ x: 20, y: 20 }, { x: 90, y: 40 }, { x: 140, y: 70 }], durationMs: 200 },
          { action: 'doubleClick', selector: '#image', inputSelector: '#surface', point: { x: 140, y: 70 } },
          { action: 'waitFor', all: ready }, text('#shape', 'finished'), text('#pixel-result', 'line pixels rendered'),
          { action: 'assert', selector: '#image', condition: 'canvasPainted' },
          { action: 'assert', selector: '#surface', condition: 'attribute', attribute: 'data-test-shift-released', expected: 'true' },
          { action: 'screenshot', label: `After verified rendering at zoom ${zoom}` },
        ]))
        const events = await browser.view.webContents.executeJavaScript('window.fixtureEvents')
        assert.ok(events.length > 3 && events.every(event => event.trusted))
        passed(await execute([{ action: 'click', selector: '#handle-tool' },
          { action: 'drag', selector: '#image', inputSelector: '#surface', path: [{ x: 180, y: 100 }, { x: 240, y: 120 }], durationMs: 200 },
          text('#handle-state', '240,120')]))
        await browser.view.webContents.executeJavaScript('handle.setAttribute("cx",180);handle.setAttribute("cy",100)')
      }
      browser.view.webContents.setZoomFactor(1)
      discovery = await discover()
      passed(await execute([{ action: 'click', targetRef: named(discovery, 'Edit number').ref },
        { action: 'fill', selector: '#number', value: '37.5' }, { action: 'press', selector: '#number', key: 'Enter' },
        { action: 'waitFor', all: ready }, { action: 'assert', selector: '#angle', condition: 'numericValue', expected: 37.5, tolerance: 0.001 }]))
      passed(await execute([{ action: 'click', selector: '[title="Edit number"]' }, { action: 'fill', selector: '#number', value: '99' },
        { action: 'press', selector: '#number', key: 'Escape' }, { action: 'assert', selector: '#numberDialog', condition: 'hidden' },
        { action: 'assert', selector: '#angle', condition: 'numericValue', expected: 37.5 }]))
      const before = await discover()
      const reloaded = await execute([{ action: 'reload', all: ready }, visible('#image')]); passed(reloaded)
      assert.equal(reloaded.steps[0].data.navigation, 'completed'); assert.equal(reloaded.steps[0].data.testingEnabled, true)
      const afterReloadStale = await execute([{ action: 'click', targetRef: named(before, 'Edit number').ref }, visible('#image')])
      assert.equal(afterReloadStale.status, 'failed'); assert.match(afterReloadStale.steps[0].reason, /stale/)
      const notReady = await execute([{ action: 'reload', timeoutMs: 1000, all: [{ selector: '#never-ready', condition: 'visible' }] }, visible('#image')])
      assert.equal(notReady.status, 'failed'); assert.equal(notReady.steps[0].data.navigation, 'completed')
      assert.equal(notReady.steps[0].data.testingEnabled, true); assert.equal(notReady.steps[0].data.applicationReadiness, 'timed out')
      passed(await execute([{ action: 'click', selector: '#dirty' }, visible('#image')]))
      const cancelledReload = await execute([{ action: 'reload', dialog: { accept: false } }, visible('#image')]); passed(cancelledReload)
      assert.equal(cancelledReload.steps[0].data.navigation, 'cancelled')
      passed(await execute([{ action: 'click', selector: '#clean' }, visible('#image')]))

      // A lost native input acknowledgement may follow an actual save. Keep
      // uncertainty in the journal; never deliver the following action.
      const debuggerTransport = browser.view.webContents.debugger
      const nativeSend = debuggerTransport.sendCommand.bind(debuggerTransport)
      let loseAcknowledgement = true
      debuggerTransport.sendCommand = async (method, params, ...rest) => {
        const result = await nativeSend(method, params, ...rest)
        if (loseAcknowledgement && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          loseAcknowledgement = false; throw new Error('Fixture: native input acknowledgement lost.')
        }
        return result
      }
      try {
        const count = saves
        const uncertain = await execute([{ action: 'click', selector: '#save' }, { action: 'click', selector: '#dirty' }, visible('#image')])
        assert.equal(uncertain.status, 'failed'); assert.equal(uncertain.steps[0].outcome, 'uncertain'); assert.equal(uncertain.steps[1].outcome, 'skipped')
        await until(() => saves === count + 1, 'save happened despite lost acknowledgement')
        assert.equal((await browserCommand(['status'])).testing.report.steps[0].delivery, 'uncertain')
      } finally { debuggerTransport.sendCommand = nativeSend }

      // Delivered input without an application effect must fail its semantic assertion.
      const ineffective = await execute([{ action: 'click', selector: '#ineffective' },
        { action: 'drag', selector: '#surface', path: [{ x: 20, y: 20 }, { x: 40, y: 40 }], durationMs: 100 }, text('#shape', 'drawn', 100)])
      assert.equal(ineffective.status, 'failed'); assert.equal(ineffective.steps[1].outcome, 'delivered'); assert.equal(ineffective.steps[2].outcome, 'assertion-failed')
      const ambiguous = await execute([{ action: 'click', selector: '.duplicate' }, visible('#image')])
      assert.equal(ambiguous.status, 'failed'); assert.match(ambiguous.steps[0].reason, /ambiguous/)
      const hidden = await execute([{ action: 'click', selector: '#hidden-control' }, visible('#image')])
      assert.equal(hidden.status, 'failed'); assert.match(hidden.steps[0].reason, /hidden/)
      passed(await execute([{ action: 'click', selector: '#obstruct' }, visible('#image')]))
      await browser.view.webContents.executeJavaScript('delete surface.dataset.testShiftReleased')
      const obstructed = await execute([{ action: 'drag', selector: '#surface', modifiers: ['Shift'], path: [{ x: 20, y: 20 }, { x: 40, y: 40 }], durationMs: 100 }, visible('#image')])
      assert.equal(obstructed.status, 'failed'); assert.match(obstructed.steps[0].reason, /covered.*Hit element/)
      const coveredDiscovery = await discover()
      assert.equal(coveredDiscovery.targets.find(target => target.selector === '#save').reason, 'covered at inspected point')
      await browser.view.webContents.executeJavaScript('document.querySelector("#cover").remove()')
      passed(await execute([{ action: 'assert', selector: '#surface', condition: 'attribute', attribute: 'data-test-shift-released', expected: 'true' },
        { action: 'click', selector: '#surface', point: { x: 10, y: 10 } },
        { action: 'assert', selector: '#surface', condition: 'attribute', attribute: 'data-test-modifier', expected: 'none' }]))
      await browser.view.webContents.executeJavaScript(`(() => {const el=document.createElement('div');el.id='replace';el.className='icon';el.textContent='Replace';el.onmouseenter=()=>el.replaceWith(el.cloneNode(true));document.body.prepend(el)})()`)
      const replaced = await execute([{ action: 'click', selector: '#replace' }, visible('#image')])
      assert.equal(replaced.status, 'failed'); assert.match(replaced.steps[0].reason, /replaced/)
      discovery = await discover()
      const replacementRef = discovery.targets.find(target => target.selector === '#replace').ref
      await browser.view.webContents.executeJavaScript('document.querySelector("#replace").replaceWith(document.querySelector("#replace").cloneNode(true))')
      const replacedReference = await execute([{ action: 'click', targetRef: replacementRef }, visible('#image')])
      assert.equal(replacedReference.status, 'failed'); assert.match(replacedReference.steps[0].reason, /stale/)
      await browser.view.webContents.executeJavaScript(`(() => {const frame=document.createElement('iframe');frame.id='child';frame.src='/child';document.body.append(frame)})()`)
      const child = await until(async () => (await browserCommand(['frames'])).frames.find(frame => frame.parentId && frame.url === url + 'child'), 'child frame')
      discovery = await discover()
      const wrongFrame = await execute([{ action: 'click', frame: child.id, targetRef: named(discovery, 'Edit number').ref }, visible('#image')])
      assert.equal(wrongFrame.status, 'failed'); assert.match(wrongFrame.steps[0].reason, /stale/)
      await browser.view.webContents.executeJavaScript('document.querySelector("#child").remove()')

      }
      for (const failure of ['transport', 'http']) {
        const count = saves
        const report = await execute([{ action: 'click', selector: '#save' },
          { action: 'waitFor', all: [{ condition: 'requestComplete', request: { urlPattern: url + 'api/save', method: 'POST', state: failure === 'transport' ? 'failed' : 'finished', ...(failure === 'http' ? { status: 503 } : {}) } },
            { selector: '#save-status', condition: 'text', expected: failure === 'transport' ? 'transport failed' : 'HTTP 503' }] },
          text('#save-status', failure === 'transport' ? 'transport failed' : 'HTTP 503'), { action: 'screenshot' }],
          { allowNetworkFailures: true, networkFailures: [{ urlPattern: url + 'api/save', method: 'POST', failure, ...(failure === 'http' ? { status: 503 } : {}), maxRequests: 1, durationMs: 10000 }] })
        passed(report); assert.equal(saves, count); assert.equal(report.evidence.network.affectedRequests.length, 1); assert.equal(report.evidence.network.failureRulesRemoved, true)
        passed(await execute([{ action: 'click', selector: '#save' }, text('#save-status', 'saved')]))
      }
      // While a rule is armed, a second page still reaches the real service.
      const control = await controller()
      if (!networkOnly) {
        await browser.view.webContents.executeJavaScript('delete surface.dataset.testShiftReleased;window.fixtureEvents=[]')
        const dragCancellation = fetch(`http://127.0.0.1:${control.port}/test`, { method: 'POST', headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ description: 'Cancel held native input', expected: 'Buttons and Shift are released', steps: [
            { action: 'drag', selector: '#surface', modifiers: ['Shift'], path: [{ x: 20, y: 20 }, { x: 100, y: 100 }], durationMs: 3000 }, visible('#image')] }) })
        await until(() => browser.view.webContents.executeJavaScript('window.fixtureEvents.some(event=>event.type==="pointerdown")'), 'held pointer before cancellation')
        browser.action('testing:off')
        const cancelled = await (await dragCancellation).json()
        assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.steps[1].outcome, 'skipped')
        await until(() => browser.view.webContents.executeJavaScript('surface.dataset.testShiftReleased==="true"&&window.fixtureEvents.some(event=>event.type==="pointerup"&&event.buttons===0)'), 'button and modifier cleanup')
        browser.action('testing:on')
      }
      const pending = fetch(`http://127.0.0.1:${control.port}/test`, { method: 'POST', headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Cancellation cleanup', expected: 'Waiting is cancelled safely', allowNetworkFailures: true,
        networkFailures: [{ urlPattern: url + 'api/save', method: 'POST', failure: 'transport', maxRequests: 2, durationMs: 10000 }], steps: [
          { action: 'click', selector: '#slow' }, { action: 'waitFor', selector: '#never', condition: 'visible' }, visible('#image')] }) })
      await until(() => browser.snapshot.testing.step === 2, 'live recovery checkpoint')
      const live = await browserCommand(['status'])
      assert.ok(live.testing.runId); assert.ok(live.testing.currentAction.id); assert.equal(live.testing.lastCompletedAction.action, 'click')
      assert.equal(live.testing.journal.completed, false); assert.equal(live.testing.journal.steps[0].outcome, 'delivered')
      assert.equal(await other.view.webContents.executeJavaScript(`fetch(${JSON.stringify(url + 'api/save')},{method:'POST'}).then(r=>r.status)`), 200)
      browser.action('testing:off')
      const stopped = await (await pending).json(); assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.evidence.network.failureRulesRemoved, true)
      assert.equal(await browser.view.webContents.executeJavaScript(`fetch('/api/save',{method:'POST'}).then(r=>r.status)`), 200)
      browser.action('testing:on')
      // Loss of the HTTP caller must not lose the action journal or repeat a save.
      const disconnected = new AbortController()
      const lost = fetch(`http://127.0.0.1:${control.port}/test`, { method: 'POST', headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' }, signal: disconnected.signal,
        body: JSON.stringify({ description: 'Disconnected caller', expected: 'Save is not repeated', steps: [{ action: 'click', selector: '#save' }, { action: 'waitFor', selector: '#never', condition: 'visible' }, visible('#image')] }) }).catch(() => null)
      await until(() => browser.snapshot.testing.step === 2, 'save checkpoint before disconnect'); disconnected.abort(); await lost
      await until(() => !browser.snapshot.testing.running, 'disconnected test stops')
      const recovery = await browserCommand(['status'])
      assert.equal(recovery.testing.report.status, 'cancelled'); assert.equal(recovery.testing.lastCompletedAction.action, 'click')
      const ui = networkOnly ? 'skipped' : 'passed'
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, coverage: networkOnly ? 'network-only' : 'full', scale: scale ?? 'host default', devicePixelRatio: await browser.view.webContents.executeJavaScript('devicePixelRatio'), zooms: networkOnly ? [] : [0.8, 1, 1.25, 1.5],
        reload: ui, cancelReload: ui, references: ui, nativeOverlayPointers: ui, drawingAndHandle: ui, exactNumericInput: ui, explicitRenderReadiness: ui,
        ineffectiveDragFailsAssertion: ui, scopedFailures: 'passed', cleanupOnCancellation: 'passed', recoveryJournal: 'passed', screenshotRegionComparison: 'optional, not implemented',
        reports: results.map(report => ({ ...report, expectation: report.status === 'failed' ? 'expected failure, verified by acceptance harness' : 'expected success' })) }, null, 2))
      console.log(`Unattended browser acceptance passed (${scale ?? 'default scale'}). Evidence: ${artifacts}`)
    } finally {
      await browser.dispose(); await other.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit()
    }
  }
}
