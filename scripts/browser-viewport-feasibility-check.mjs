// Feasibility probe only: uses the production native, masked capture path.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scale = process.argv.find(arg => arg.startsWith('--force-device-scale-factor=')) ?? '--force-device-scale-factor=1.25'
assert.match(scale, /^--force-device-scale-factor=(1|1.25|2)$/)
const artifacts = resolve('test-results/browser-viewport-feasibility', scale.split('=')[1])
await mkdir(artifacts, { recursive: true })
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [scale, fileURLToPath(import.meta.url), scale], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 60000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  void run()
  async function run() {
  const { app, BrowserWindow, nativeImage } = await import('electron')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  const server = createServer((_req, res) => res.end(`<!doctype html><style>body{margin:0}#target{position:absolute;left:100px;top:80px;width:80px;height:60px;background:red}</style><div id="target"></div><input style="position:absolute;left:300px;top:80px" value="masked"><script>window.events=[];for(const type of ['click','wheel','pointerdown','pointerup'])target.addEventListener(type,e=>events.push({type,x:e.clientX,y:e.clientY}));</script>`))
  let window, reader
  try {
    await app.whenReady()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    window = new BrowserWindow({ width: 1000, height: 800, useContentSize: true, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    window.restore(); window.show(); window.focus()
    await new Promise(resolve => setTimeout(resolve, 300))
    const { BrowserReader } = await import('../dist/src/main/browser-reader.js')
    const wc = window.webContents
    reader = new BrowserReader({ pages: () => [wc], active: () => wc.id, select: () => {}, owner: () => window, recording: () => true, visible: () => true })
    reader.add(wc); await reader.capturing(wc)
    const send = (method, params = {}) => wc.debugger.sendCommand(method, params)
    const state = () => wc.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})')
    const original = await state(), observations = []
    for (const dpr of [1, 2]) {
      // Marked before the command: finally resets even if its acknowledgement fails.
      try {
        await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 480, deviceScaleFactor: dpr, mobile: false })
        await new Promise(resolve => setTimeout(resolve, 150))
        const report = await reader.test({ description: 'Input under emulation', expected: 'Target receives native input', steps: [
          { action: 'click', selector: '#target' }, { action: 'wheel', selector: '#target', deltaY: 20 },
          { action: 'drag', selector: '#target', path: [{ x: 10, y: 10 }, { x: 50, y: 40 }] },
          { action: 'assert', selector: '#target', condition: 'visible' }, { action: 'screenshot' },
        ] }, new AbortController().signal)
        await writeFile(join(artifacts, `dpr-${dpr}.report.json`), JSON.stringify(report, null, 2))
        const screenshot = await reader.run('screenshot', [String(wc.id)], undefined, true)
        const png = screenshot?.imageBase64 ? Buffer.from(screenshot.imageBase64, 'base64') : null
        if (png) await writeFile(join(artifacts, `dpr-${dpr}.png`), png)
        const native = png ? nativeImage.createFromBuffer(png) : null
        const bitmap = native?.getSize() ?? null
        const dom = await state()
        const events = await wc.executeJavaScript('events.splice(0)')
        const click = events.find(event => event.type === 'click'), wheel = events.find(event => event.type === 'wheel'), dragEnd = events.filter(event => event.type === 'pointerup').at(-1)
        const inputAligned = click?.x === 140 && click?.y === 110 && wheel?.x === 140 && wheel?.y === 110 && dragEnd?.x === 150 && dragEnd?.y === 120
        let markerAligned = false
        if (native && bitmap) {
          const bytes = native.toBitmap(), x = Math.floor(140 * bitmap.width / dom.width), y = Math.floor(110 * bitmap.height / dom.height)
          const pixel = [...bytes.subarray((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4)]
          markerAligned = pixel[1] === 0 && pixel[3] === 255 && Math.max(pixel[0], pixel[2]) === 255 && Math.min(pixel[0], pixel[2]) === 0
        }
        observations.push({ configured: { width: 640, height: 480, dpr }, dom, bitmap, expectedBitmap: { width: 640 * dpr, height: 480 * dpr },
          exactBitmap: bitmap?.width === 640 * dpr && bitmap?.height === 480 * dpr, inputAligned, markerAligned, inputStatus: report.status, failure: report.steps.find(step => step.status === 'failed')?.reason, captureState: screenshot.state, captureReason: screenshot.reason, events })
      } finally { await send('Emulation.clearDeviceMetricsOverride').catch(() => wc.debugger.detach()) }
      assert.deepEqual(await state(), original, 'metrics restored after probe')
    }
    const result = { electron: process.versions.electron, hostScale: scale, original, observations,
      feasible: observations.every(item => item.exactBitmap && item.inputStatus === 'passed' && item.inputAligned && item.markerAligned), restored: await state() }
    await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
    reader.dispose(); window.destroy(); server.close(); app.exit(0)
  } catch (error) { console.error(error); reader?.dispose(); window?.destroy(); server.close(); app.exit(1) }
  }
}
