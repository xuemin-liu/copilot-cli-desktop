import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scale = process.argv.find(arg => arg.startsWith('--force-device-scale-factor=')) ?? '--force-device-scale-factor=1'
assert.match(scale, /^--force-device-scale-factor=(1|1.25|2)$/)
const artifacts = resolve('test-results/browser-state', scale.split('=')[1])
await mkdir(artifacts, { recursive: true })
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [scale, fileURLToPath(import.meta.url), scale], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 120000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  void run()
  async function run() {
    const { app, BrowserWindow, nativeImage } = await import('electron')
    app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    const html = `<!doctype html><style>body{margin:0;font:14px sans-serif}#viewer{width:300px;height:160px;background:#246;position:absolute;top:80px;left:20px}#dot{position:absolute;left:30px;top:40px;width:30px;height:30px;background:#fff}#mask{position:absolute;left:80px;top:20px;width:60px;height:25px}#cover{position:absolute;inset:0;display:none;background:#aaa;z-index:3}</style>
      <button id="change">Change</button><button id="reset">Reset</button><button id="private">Private</button><button id="replace">Replace</button><button id="moveMask">Move mask</button>
      <div id="viewer" data-revision="10" data-request="0" data-render="0" data-pending="0" data-quality="full"><div id="dot"></div><input id="mask" value="hidden"></div><div id="cover"></div>
      <div id="linked" data-value="10.1">10.1</div><div id="numeric">10</div><input id="secret" type="password" data-value="99"><div id="hidden" hidden data-value="5"></div>
      <div id="other" style="position:absolute;left:20px;top:280px;width:300px;height:100px;background:#567"></div>
      <script>
        let frame=0,pending=0;window.mode='normal';window.wheels=[];
        const v=document.getElementById('viewer');
        change.onclick=()=>{v.dataset.revision='11';dot.style.left='70px'};
        reset.onclick=()=>{v.dataset.revision='10';dot.style.left='30px'};
        document.getElementById('private').onclick=()=>v.setAttribute('data-private','');
        replace.onclick=()=>v.replaceWith(v.cloneNode(true));
        moveMask.onclick=()=>{mask.style.left='160px'};
        v.addEventListener('wheel',e=>{e.preventDefault();wheels.push(performance.now()); if(mode==='cover'){cover.style.display='block';return}
          if(mode==='normal')return;
          const request=++frame;v.dataset.request=String(request);v.dataset.pending=String(++pending);v.dataset.quality='loading';
          fetch('/frame/'+request).then(r=>r.text()).then(()=>new Promise(r=>setTimeout(r,20))).then(()=>{
            if(mode==='buggy'||request===frame){v.dataset.render=String(request);v.dataset.quality='full'}
          }).finally(()=>{v.dataset.pending=String(--pending)})
        },{passive:false});
      </script>`
    const server = createServer((req, res) => { res.setHeader('Cache-Control', 'no-store'); res.end(req.url.startsWith('/frame/') ? 'frame' : html) })
    let window, reader
    const reports = []
    try {
      await app.whenReady(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${server.address().port}`
      window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: true })
      const wc = window.webContents
      const { BrowserReader } = await import('../dist/src/main/browser-reader.js')
      reader = new BrowserReader({ pages: () => [wc], active: () => wc.id, select: () => {}, owner: () => window, recording: () => true, visible: () => true })
      reader.add(wc)
      const load = async () => { await wc.loadURL(origin); window.restore(); window.show(); window.focus(); await new Promise(resolve => setTimeout(resolve, 150)) }
      await load(); await reader.capturing(wc)
      const execute = async (steps, extra = {}, signal = new AbortController().signal) => {
        const report = await reader.test({ description: 'Viewer state acceptance', expected: 'Independent fixture assertions hold', steps, ...extra }, signal)
        reports.push(report)
        await writeFile(join(artifacts, `report-${reports.length}.json`), JSON.stringify(report, null, 2))
        return report
      }
      const passed = report => assert.equal(report.status, 'passed', JSON.stringify(report.steps))
      const failed = (report, pattern) => { assert.equal(report.status, 'failed'); if (pattern) assert.match(report.steps.find(s => s.status === 'failed').reason, pattern) }
      const capture = { action: 'capture', name: 'r0', selector: '#viewer', attribute: 'data-revision' }
      const check = (expected, extra = {}) => ({ action: 'assert', selector: '#viewer', condition: 'attribute', attribute: 'data-revision', expected, timeoutMs: 150, ...extra })
      const visible = { action: 'assert', selector: '#viewer', condition: 'visible' }
      const stateReport = await execute([capture, { action: 'click', selector: '#change' }, check({ captured: 'r0', op: 'greater' }),
        check({ captured: 'r0', op: 'changed' }), { action: 'click', selector: '#reset' }, check({ captured: 'r0' }),
        check({ selector: '#linked', attribute: 'data-value', op: 'within' }, { tolerance: 0.11 })])
      passed(stateReport); assert.equal(stateReport.steps[0].outcome, 'observed'); assert.equal(stateReport.steps[0].data.capture.value, '10')
      failed(await execute([check({ selector: '#linked', attribute: 'data-value', numeric: true }, { tolerance: 0.09 })]))
      passed(await execute([check(10, { tolerance: 0.01 }), { ...check({ selector: '#viewer', attribute: 'data-revision' }), selector: '#numeric', condition: 'numericValue', attribute: undefined }]))
      failed(await execute([check({ selector: '#secret', attribute: 'data-value', numeric: true })]), /private|sensitive/)
      const discovered = await reader.test({ description: 'Discover state', expected: 'Viewer visible', steps: [{ action: 'discover' }, visible] }, new AbortController().signal)
      const ref = discovered.steps[0].data.discovery.targets.find(target => target.selector === '#linked').ref
      passed(await execute([check({ targetRef: ref, attribute: 'data-value', numeric: true }, { tolerance: 0.11 })]))
      for (const value of ['', 'NaN', 'Infinity']) {
        await wc.executeJavaScript(`viewer.setAttribute('data-revision',${JSON.stringify(value)})`)
        failed(await execute([check(10)]), /nonblank finite/)
      }
      await load()
      for (const selector of ['#secret', '#hidden']) failed(await execute([{ ...capture, selector, attribute: 'data-value' }, visible]), /private|sensitive|visible/)
      failed(await execute([capture, { action: 'click', selector: '#private' }, check({ captured: 'r0' }, { selector: '#numeric', condition: 'numericValue', attribute: undefined })]), /private/)
      await load()
      failed(await execute([capture, { action: 'click', selector: '#replace' }, check({ captured: 'r0' })]), /removed|replaced/)
      await load()
      failed(await execute([capture, { action: 'reload' }, check({ captured: 'r0' })]), /unavailable/)
      failed(await execute([capture, { action: 'navigate', url: origin }, check({ captured: 'r0' })]), /unavailable/)
      passed(await execute([capture, check({ captured: 'r0' })]))
      await wc.executeJavaScript("viewer.dataset.revision='x'.repeat(257)")
      failed(await execute([capture, visible]), /256/)
      await wc.executeJavaScript("viewer.dataset.token='test-secret';viewer.dataset.revision='Bearer abcdefghijklmnopqrstuvwxyz'")
      const redacted = await execute([{ ...capture, attribute: 'data-token' }, { ...capture, name: 'credential' }, visible])
      passed(redacted); assert.equal(redacted.steps[0].data.capture.value, '[redacted]'); assert.ok(!JSON.stringify(redacted).includes('abcdefghijklmnopqrstuvwxyz'))
      await load()
      const wheel = { action: 'wheel', selector: '#viewer', point: { x: 10, y: 10 }, deltaY: 20, repeat: 4, intervalMs: 40 }
      const timed = await execute([wheel, visible]); passed(timed)
      assert.equal(timed.steps[0].data.wheel.sent, 4); assert.equal(timed.steps[0].data.wheel.intervalsMs.length, 3)
      assert.ok(timed.steps[0].data.wheel.intervalsMs.every(ms => ms >= 35))
      await wc.executeJavaScript("mode='cover'")
      const covered = await execute([{ ...wheel, intervalMs: 100 }, visible]); failed(covered, /covered/); assert.equal(covered.steps[0].data.wheel.sent, 1)
      await load()
      const stop = new AbortController(); const timer = setTimeout(() => stop.abort(), 450)
      const cancelled = await execute([{ ...wheel, repeat: 20, intervalMs: 100 }, visible], {}, stop.signal); clearTimeout(timer)
      assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.steps[0].data.wheel.sent < 20)
      // Delay frame 1 deliberately; input speed does not decide whether the bug occurs.
      for (const mode of ['buggy', 'fixed']) {
        await load(); await wc.executeJavaScript(`mode=${JSON.stringify(mode)}`)
        const report = await execute([{ ...wheel, repeat: 2, intervalMs: 0 },
          { action: 'waitFor', selector: '#viewer', condition: 'attribute', attribute: 'data-request', expected: '2' },
          { ...capture, name: 'requested', attribute: 'data-request' },
          { action: 'waitFor', selector: '#viewer', condition: 'attribute', attribute: 'data-pending', expected: '0' },
          check({ captured: 'requested' }, { attribute: 'data-render' }), check('full', { attribute: 'data-quality' })],
        { allowNetworkFailures: true, networkFailures: [{ urlPattern: origin + '/frame/1', method: 'GET', failure: 'delay', delayMs: 800, maxRequests: 1, durationMs: 5000 }] })
        if (mode === 'buggy') failed(report, /comparison/); else passed(report)
      }
      await load()
      const shot = { action: 'screenshot', selector: '#viewer' }, compare = { action: 'compareScreenshot', selector: '#viewer', baselineStep: 1 }
      passed(await execute([shot, { action: 'click', selector: '#change' }, { action: 'click', selector: '#reset' }, compare, { ...compare, baselineStep: 4 }]))
      failed(await execute([shot, { action: 'click', selector: '#change' }, compare]), /differ/)
      await load()
      const union = await execute([shot, { action: 'click', selector: '#moveMask' }, compare]); passed(union)
      const png = Buffer.from(union.screenshots.at(-1).imageBase64, 'base64'); const image = nativeImage.createFromBuffer(png)
      const { width, height } = image.getSize(); const bytes = image.toBitmap(); const sx = width / 300, sy = height / 160
      for (const x of [90, 170]) { const offset = (Math.floor(30 * sy) * width + Math.floor(x * sx)) * 4; assert.deepEqual([...bytes.subarray(offset, offset + 3)], [17, 17, 17]) }
      await load()
      const diffUnion = await execute([shot, { action: 'click', selector: '#moveMask' }, { action: 'click', selector: '#change' }, compare]); failed(diffUnion, /differ/)
      assert.ok(diffUnion.screenshots.some(image => image.kind === 'diff'))
      failed(await execute([shot, { ...compare, selector: undefined, region: { x: 20, y: 80, width: 250, height: 160 } }]), /different CSS sizes/)
      await load()
      passed(await execute([shot, { action: 'screenshot', selector: '#other' }, { action: 'click', selector: '#change' },
        { ...compare, selector: '#other', baselineStep: 2 }, { action: 'click', selector: '#reset' }, compare]))
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, runs: reports.length, scale }))
      console.log(`Browser state acceptance passed (${reports.length} runs, ${scale}).`)
      reader.dispose(); window.destroy(); server.close(); app.exit(0)
    } catch (error) { console.error(error); reader?.dispose(); window?.destroy(); server.close(); app.exit(1) }
  }
}
