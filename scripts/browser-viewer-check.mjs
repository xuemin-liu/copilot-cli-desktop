import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scale = process.argv.find(arg => arg.startsWith('--force-device-scale-factor=')) ?? '--force-device-scale-factor=1.25'
assert.match(scale, /^--force-device-scale-factor=(1|1.25|2)$/)
const artifacts = resolve('test-results/browser-viewer', scale.split('=')[1])
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
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
    const html = `<!doctype html><style>body{margin:0;font:12px sans-serif}button{font-size:12px}#canvas{position:absolute;left:20px;top:100px;width:300px;height:150px}#drop{position:absolute;left:380px;top:120px;width:70px;height:70px;background:#777}#privateInput{position:absolute;left:500px;top:150px;width:80px}#source{display:inline-block;background:#ccc}</style>
      <button id="good">Good</button><button id="bad">Transient stale</button><button id="late">Late commit</button><button id="linked">Linked</button><button id="embed">Embed</button><button id="leave">Leave</button><button id="fetch">Fetch</button><button id="load">Load cache</button><button id="close">Close cache</button>
      <button id="line">Line</button><button id="probe">Probe</button><button id="zoom">Zoom 2x</button><button id="reset">Reset</button>
      <div id="source" draggable="true">Series</div><div id="drop" data-dropped="no"></div>
      <canvas id="canvas" width="300" height="150"></canvas><input id="privateInput" value="SECRET_FIXTURE">
      <div id="measurement" data-measurement-value="0" data-measurement-unit="mm">Measurement</div>
      <div id="cache" data-cache-bytes="0" data-workers="0" data-gpu-estimate="0">Cache statistics</div><div id="state" data-ready="no" data-render="0">State</div>
      <script>
        const state=document.getElementById('state'), cache=document.getElementById('cache'), canvas=document.getElementById('canvas'), measurement=document.getElementById('measurement');
        const paint=()=>{const c=canvas.getContext('2d');for(let i=0;i<3;i++){c.fillStyle=['#111','#777','#eee'][i];c.fillRect(i*100,0,100,150)}};paint();
        let tool='line',start;
        const point=e=>{const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*300/r.width,y:(e.clientY-r.top)*150/r.height}};
        line.onclick=()=>tool='line';probe.onclick=()=>tool='probe';zoom.onclick=()=>{canvas.style.width='600px';canvas.style.height='300px'};
        reset.onclick=()=>{canvas.style.width='300px';canvas.style.height='150px'};
        canvas.onpointerdown=e=>{if(tool==='line')start=point(e)};
        canvas.onpointerup=e=>{if(tool==='line'&&start){const end=point(e);measurement.dataset.measurementValue=String(Math.hypot((end.x-start.x)*0.5,(end.y-start.y)*2));measurement.dataset.measurementUnit='mm';start=null}};
        canvas.onpointermove=e=>{if(tool==='probe'){measurement.dataset.measurementValue=String([-1000,0,1000][Math.max(0,Math.min(2,Math.floor(point(e).x/100)))]);measurement.dataset.measurementUnit='HU'}};
        document.getElementById('load').onclick=()=>{cache.dataset.cacheBytes='4096';cache.dataset.workers='2';cache.dataset.gpuEstimate='8192'};
        document.getElementById('close').onclick=()=>{cache.dataset.cacheBytes='0';cache.dataset.workers='0';cache.dataset.gpuEstimate='0'};
        const emit=(type,revision,frame,viewport='v1')=>console.debug('desktop-test-frame '+JSON.stringify({version:1,type,viewport,epoch:'fixture1',revision,frame,timeMs:performance.now()}));
        late.onclick=()=>{emit('request',10,7);setTimeout(()=>{state.dataset.render='7';emit('commit',10,7)},300)};
        embed.onclick=()=>{const frame=document.createElement('iframe');frame.style.cssText='position:absolute;left:600px;top:30px;width:30px;height:30px';frame.onload=()=>{state.dataset.embedded='yes'};frame.src='/blank';document.body.append(frame)};
        leave.onclick=()=>{emit('request',30,9);location.href='/slow';setTimeout(()=>emit('commit',30,9),150)};
        linked.onclick=()=>{emit('request',20,5);emit('request',20,5,'v2');setTimeout(()=>emit('commit',20,5),100);setTimeout(()=>emit('commit',20,5,'v2'),300)};
        good.onclick=()=>{for(let i=0;i<4;i++){emit('request',i,i);state.dataset.render=String(i);emit('commit',i,i)}console.debug('frames complete')};
        bad.onclick=()=>{emit('request',1,1);emit('request',2,2);state.dataset.render='2';emit('commit',2,2);state.dataset.render='1';emit('commit',1,1);emit('request',3,2);state.dataset.render='2';emit('commit',3,2);console.debug('frames complete')};
        document.getElementById('fetch').onclick=async()=>{state.dataset.ready='no';await fetch('/image').then(r=>r.text());await fetch('/image').then(r=>r.text());state.dataset.ready='yes'};
        source.ondragstart=e=>e.dataTransfer.setData('text/plain','fixture');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();drop.dataset.dropped='yes'};
      </script>`
    const server = createServer((req, res) => {
      if (req.url === '/image') { res.setHeader('Cache-Control', 'public, max-age=3600'); res.end('fixture image payload'); return }
      res.setHeader('Cache-Control', 'no-store')
      if (req.url === '/blank') { res.end('embedded'); return }
      if (req.url === '/slow') { setTimeout(() => res.end(html), 800); return }
      res.end(html)
    })
    let window, reader
    const reports = []
    try {
      await app.whenReady(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${server.address().port}`
      window = new BrowserWindow({ width: 1000, height: 800, useContentSize: true, show: true })
      const wc = window.webContents
      const { BrowserReader } = await import('../dist/src/main/browser-reader.js')
      const { ConsoleBuffer } = await import('../dist/src/main/browser-console-buffer.js')
      const { sanitizedText } = await import('../dist/src/main/browser-privacy.js')
      const buffer = new ConsoleBuffer(), listeners = new Set()
      wc.on('console-message', details => {
        const entry = { level: details.level, message: sanitizedText(details.message), source: details.sourceId, line: details.lineNumber }
        for (const listener of listeners) listener(entry)
        // Deliberately do not retain console text: frame evidence must be independent of recording.
        buffer.drop(wc.id)
      })
      reader = new BrowserReader({ pages: () => [wc], active: () => wc.id, select: () => {}, owner: () => window, recording: () => false, visible: () => true,
        console: { mark: () => buffer.mark(), slice: (id, after, through, max) => buffer.slice(id, after, through, max), watch: (_id, listener) => { listeners.add(listener); return () => listeners.delete(listener) } } })
      reader.add(wc)
      const load = async () => { await wc.loadURL(origin); window.restore(); window.show(); window.focus(); await new Promise(resolve => setTimeout(resolve, 150)) }
      await load(); await reader.capturing(wc)
      const geometry = () => wc.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})')
      const original = await geometry()
      const execute = async (steps, extra = {}, signal = new AbortController().signal) => {
        const report = await reader.test({ description: 'PACS helper acceptance', expected: 'Instrumented fixture truth and capture geometry agree', steps, ...extra }, signal)
        reports.push(report); await writeFile(join(artifacts, `report-${reports.length}.json`), JSON.stringify(report, null, 2)); return report
      }
      const pass = report => assert.equal(report.status, 'passed', JSON.stringify(report.steps))
      const fail = (report, reason) => { assert.equal(report.status, 'failed'); assert.match(report.steps.find(step => step.status === 'failed').reason, reason) }
      const visible = { action: 'assert', selector: '#canvas', condition: 'visible' }
      const frameSteps = id => [{ action: 'click', selector: id }, { action: 'waitFor', condition: 'consoleMessage', expected: 'frames complete' },
        { action: 'frameSequence', sequence: { viewport: 'v1', epoch: 'fixture1', since: 1, minFrames: 3 } }]
      pass(await execute(frameSteps('#good')))
      const stale = await execute(frameSteps('#bad')); fail(stale, /stale/)
      assert.equal(await wc.executeJavaScript('state.dataset.render'), '2', 'final state is correct, but the transient stale commit was caught')
      // frameCommitted: the wait ends when the viewport's latest request has committed the expected frame.
      const committed = (frame, extra = {}, viewport = 'v1') => ({ condition: 'frameCommitted', commit: { viewport, epoch: 'fixture1', frame, ...extra } })
      const late = await execute([{ action: 'click', selector: '#late' }, { action: 'waitFor', ...committed(7, { since: 1 }), timeoutMs: 5000 },
        { action: 'assert', selector: '#state', condition: 'attribute', attribute: 'data-render', expected: '7' }, { action: 'assert', ...committed(7) }]); pass(late)
      assert.equal(late.steps[1].data.frameCommitted.revision, 10)
      assert.ok(late.steps[1].data.frameCommitted.requestToCommitMs >= 250, 'the wait saw the delayed commit, not the request')
      fail(await execute([{ action: 'click', selector: '#good' }, { action: 'assert', ...committed(2, { since: 1 }), timeoutMs: 400 }]), /latest request of the viewport is for frame 3/)
      // Evidence from before the since step does not count, even though the viewport still shows that frame.
      fail(await execute([{ action: 'click', selector: '#good' }, { action: 'waitFor', ...committed(3, { since: 1 }) }, visible, { action: 'assert', ...committed(3, { since: 3 }), timeoutMs: 400 }]), /no frame request/)
      // The stale fixture ends settled on revision 3: readiness now is true, the transient stale commit is frameSequence's to catch.
      pass(await execute([{ action: 'click', selector: '#bad' }, { action: 'assert', ...committed(2, { since: 1 }) }]))
      const both = await execute([{ action: 'click', selector: '#linked' }, { action: 'waitFor', all: [committed(5, { since: 1 }), committed(5, { since: 1 }, 'v2')], timeoutMs: 5000 }, visible]); pass(both)
      assert.deepEqual(both.steps[1].data.conditions.map(condition => condition.frameCommitted.revision), [20, 20])
      // A reload starts a new document: the old document's commit is no longer evidence.
      fail(await execute([{ action: 'click', selector: '#good' }, { action: 'waitFor', ...committed(3) }, { action: 'reload' }, { action: 'assert', ...committed(3), timeoutMs: 400 }]), /no frame request/)
      // A frame navigating inside the page leaves the top document's evidence alone.
      pass(await execute([{ action: 'click', selector: '#good' }, { action: 'waitFor', ...committed(3) }, { action: 'click', selector: '#embed' },
        { action: 'waitFor', selector: '#state', condition: 'attribute', attribute: 'data-embedded', expected: 'yes' }, { action: 'assert', ...committed(3) }]))
      // What the outgoing document logs while a slow navigation is pending is not evidence for the new document.
      const left = await execute([{ action: 'click', selector: '#leave' }, { action: 'waitFor', ...committed(9, { since: 1 }) }, { action: 'waitFor', condition: 'url', expected: '/slow' },
        { action: 'waitFor', selector: '#good', condition: 'visible' }, { action: 'assert', ...committed(9), timeoutMs: 400 }])
      assert.deepEqual(left.steps.map(step => step.status), ['passed', 'passed', 'passed', 'passed', 'failed'], JSON.stringify(left.steps))
      fail(left, /no frame request/)
      await load()
      const m = (unit, expected) => ({ action: 'assertMeasurement', selector: '#measurement', unit, expected, tolerance: 0.05 })
      pass(await execute([{ action: 'click', selector: '#line' }, { action: 'drag', selector: '#canvas', path: [{ x: 20, y: 70 }, { x: 120, y: 70 }] }, m('mm', 50),
        { action: 'click', selector: '#zoom' }, { action: 'drag', selector: '#canvas', path: [{ x: 40, y: 140 }, { x: 240, y: 140 }] }, m('mm', 50)]))
      await load()
      pass(await execute([{ action: 'click', selector: '#probe' }, { action: 'hover', selector: '#canvas', point: { x: 150, y: 60 } }, m('HU', 0),
        { action: 'hover', selector: '#canvas', point: { x: 250, y: 60 } }, m('HU', 1000)]))
      fail(await execute([m('mm', 1000)]), /unit/)
      const samples = [{ name: 'decoded', attribute: 'data-cache-bytes', unit: 'bytes' }, { name: 'workers', attribute: 'data-workers', unit: 'count' }, { name: 'gpuEstimate', attribute: 'data-gpu-estimate', unit: 'bytes' }]
      const sampled = await execute([{ action: 'sampleMetrics', selector: '#cache', samples }, { action: 'click', selector: '#load' },
        { action: 'sampleMetrics', selector: '#cache', samples }, { action: 'click', selector: '#close' },
        { action: 'sampleMetrics', selector: '#cache', since: 1, samples: samples.map(sample => ({ ...sample, maxGrowth: 0 })) }]); pass(sampled)
      assert.equal(sampled.steps[2].data.sampleMetrics.samples[0].value, 4096)
      const alias = await execute([{ action: 'sampleMetrics', selector: '#cache', samples: [{ name: '__proto__', attribute: 'data-cache-bytes', unit: 'bytes', max: 0 }] }]); pass(alias)
      assert.equal(alias.steps[0].data.sampleMetrics.samples[0].value, 0)
      fail(await execute([{ action: 'click', selector: '#load' }, { action: 'sampleMetrics', selector: '#cache', samples: [{ ...samples[0], max: 1 }] }]), /limit/)
      const network = await execute([{ action: 'click', selector: '#fetch' }, { action: 'waitFor', selector: '#state', condition: 'attribute', attribute: 'data-ready', expected: 'yes' },
        { action: 'networkSummary', networkMatch: { urlPattern: origin + '/image', method: 'GET' }, minRequests: 2, maxRequests: 2, maxFailures: 0, maxBytes: 4096, minCacheHits: 1 }]); pass(network)
      assert.ok(network.steps[2].data.networkSummary.encodedBytes > 0)
      const fractional = await execute([visible, { action: 'screenshot' }], { viewport: { width: 400, height: 400, dpr: 1.1 } })
      pass(fractional)
      assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(fractional.screenshots[0].imageBase64, 'base64')).getSize(), { width: 440, height: 440 })
      assert.deepEqual(await geometry(), original)
      for (const dpr of [1, 2]) {
        await load()
        const viewport = { width: 640, height: 480, dpr }
        const report = await execute([{ action: 'click', selector: '#probe' }, { action: 'hover', selector: '#canvas', point: { x: 150, y: 60 } }, m('HU', 0),
          { action: 'wheel', selector: '#canvas', deltaY: 20 }, { action: 'dragTo', selector: '#source', dropSelector: '#drop' },
          { action: 'assert', selector: '#drop', condition: 'attribute', attribute: 'data-dropped', expected: 'yes' },
          { action: 'screenshot' }, { action: 'compareScreenshot', baselineStep: 7 }], { viewport }); pass(report)
        const bytes = Buffer.from(report.screenshots[0].imageBase64, 'base64'), image = nativeImage.createFromBuffer(bytes)
        assert.deepEqual(image.getSize(), { width: 640 * dpr, height: 480 * dpr })
        const bitmap = image.toBitmap(), index = (160 * dpr * 640 * dpr + 520 * dpr) * 4
        assert.deepEqual([...bitmap.subarray(index, index + 3)], [17, 17, 17], 'input pixels are masked at the configured DPR')
        await writeFile(join(artifacts, `viewport-dpr-${dpr}.png`), bytes)
        // Image pixels are deterministic; native form-control rasterization can still depend on host scaling.
        if (scale.endsWith('=1.25')) {
          const path = resolve('test-results/browser-viewer/1', `viewport-dpr-${dpr}.png`)
          try {
            const reference = nativeImage.createFromBuffer(await readFile(path)), crop = { x: 20 * dpr, y: 100 * dpr, width: 300 * dpr, height: 150 * dpr }
            assert.ok(image.crop(crop).toBitmap().equals(reference.crop(crop).toBitmap()), 'canvas pixels match across host scales at the same configured DPR')
            await writeFile(join(artifacts, `cross-host-dpr-${dpr}.json`), JSON.stringify({ sameDimensions: JSON.stringify(image.getSize()) === JSON.stringify(reference.getSize()), canvasPixelsEqual: true,
              wholePagePixelsEqual: image.toBitmap().equals(reference.toBitmap()), limitation: 'Native controls and font rasterization may differ across host scaling.' }))
          } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        assert.deepEqual(await geometry(), original); assert.equal(report.evidence.viewport.restored, true)
        fail(await execute([{ action: 'assert', selector: '#missing', condition: 'visible', timeoutMs: 100 }], { viewport }), /visible/)
        assert.deepEqual(await geometry(), original)
        const stop = new AbortController(); const timer = setTimeout(() => stop.abort(), 250)
        const cancelled = await execute([{ action: 'waitFor', selector: '#missing', condition: 'visible' }, visible], { viewport }, stop.signal); clearTimeout(timer)
        assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(await geometry(), original)
        const resized = await execute([{ action: 'resizeViewport', viewport: { width: 600, height: 400, dpr } }, visible,
          { action: 'reload' }, { action: 'screenshot' }], { viewport }); pass(resized)
        assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(resized.screenshots[0].imageBase64, 'base64')).getSize(), { width: 600 * dpr, height: 400 * dpr })
        assert.deepEqual(await geometry(), original)
      }
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, runs: reports.length, scale }))
      console.log(`Viewer acceptance passed (${reports.length} runs, ${scale}).`)
      reader.dispose(); window.destroy(); server.close(); app.exit(0)
    } catch (error) { console.error(error); reader?.dispose(); window?.destroy(); server.close(); app.exit(1) }
  }
}
