// Real desktop control check on a Windows desktop: the session helper, the loopback endpoint, the Win32 layer, screen
// capture, the banner and the stop key, against a throwaway HTA window this check opens (never your own apps).
// It moves the mouse and types into that window, so leave the mouse and keyboard alone while it runs (about 30 s).
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const artifacts = resolve('test-results/desktop-control')
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (read, label, timeout = 15000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(150) }
  throw new Error(`Timed out: ${label}`)
}

if (process.platform !== 'win32') {
  console.log('[desktop-control-check] Windows-only check skipped.')
} else if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 120000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Desktop control check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true, 'Every desktop control check must complete')
    console.log('[desktop-control-check] passed')
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, globalShortcut, nativeImage } = await import('electron')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  // The check opens and closes its own windows; closing the last one must not end it.
  app.on('window-all-closed', () => {})
  void run().catch(error => { console.error(error); app.exit(1) })

  async function run() {
    await app.whenReady()
    const { DesktopControl } = await import('../dist/src/main/desktop-control.js')
    const { DesktopOverlay, captureDesktopArea, desktopDisplays, encodeDesktopPng } = await import('../dist/src/main/desktop-capture.js')
    const { WindowsDesktopInputMonitor, WindowsDesktopNative } = await import('../dist/src/main/desktop-native.js')
    const { prepareDesktopControlSessionEnvironment } = await import('../dist/src/main/desktop-control-session.js')

    const folder = await mkdtemp(join(tmpdir(), 'desktop-control-check-'))
    const out = join(folder, 'hta-out.txt')
    const hta = join(folder, 'check.hta')
    // Distinctive colours let the check find each control in the screenshot, as Copilot would by looking.
    await writeFile(hta, `<html><head><title>Desktop control check</title>
<HTA:APPLICATION ID="dc" APPLICATIONNAME="desktopcontrolcheck" SINGLEINSTANCE="no" SCROLL="no" />
<script>window.resizeTo(640, 420); window.moveTo(160, 160);
function save() { var fso = new ActiveXObject("Scripting.FileSystemObject"); var f = fso.CreateTextFile(${JSON.stringify(out)}, true, true);
  f.Write(document.getElementById("t").value + "|" + document.getElementById("n").innerText); f.Close(); }
</script></head><body style="margin:0;background:#ffffff;font:16px Segoe UI">
<input id="t" style="position:absolute;left:20px;top:20px;width:300px;height:34px;background:#c86432;border:0" onkeyup="save()">
<button id="b" style="position:absolute;left:20px;top:90px;width:220px;height:64px;background:#44aa88;border:0" onclick="document.getElementById('n').innerText = +document.getElementById('n').innerText + 1; save()"></button>
<span id="n" style="position:absolute;left:260px;top:110px">0</span>
<input id="p" type="password" style="position:absolute;left:20px;top:190px;width:300px;height:34px;background:#3264c8;border:0">
</body></html>`)
    const viewer = spawn('mshta.exe', [hta], { stdio: 'ignore' })

    const env = await prepareDesktopControlSessionEnvironment(folder, 'Ctrl+Alt+Shift+X', { ...process.env })
    const approvals = []
    const overlay = new DesktopOverlay('Ctrl+Alt+Shift+X')
    const native = new WindowsDesktopNative()
    const STOP = 'Control+Alt+Shift+X'
    const control = new DesktopControl({
      ownProgramPath: process.execPath,
      reservedAccelerators: () => ['CommandOrControl+Alt+H', STOP],
      stopKeyLabel: 'Ctrl+Alt+Shift+X',
      sessionFolder: () => folder,
      sessionRefusal: () => null,
      sessionTitle: () => 'Check session',
      approve: async request => { approvals.push(request.app); return 'session' },
      displays: desktopDisplays,
      capture: captureDesktopArea,
      encodePng: encodeDesktopPng,
      overlay: state => overlay.update(state),
      stopKey: (active, stop) => {
        if (!active) { globalShortcut.unregister(STOP); return true }
        return globalShortcut.isRegistered(STOP) || globalShortcut.register(STOP, stop)
      },
      changed: () => {},
      locked: () => false,
      log: message => console.error(message),
    }, native, new WindowsDesktopInputMonitor())

    const helper = (...args) => new Promise(accept => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', env.COPILOT_DESKTOP_CONTROL_HELPER, ...args], { env, windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
        accept(error ? { ok: false, message: stderr.trim() } : { ok: true, value: JSON.parse(stdout) })
      })
    })
    const ok = async (...args) => {
      const result = await helper(...args)
      assert.equal(result.ok, true, `${args.join(' ')}: ${result.message}`)
      return result.value
    }
    const refusedWith = async (pattern, ...args) => {
      const result = await helper(...args)
      assert.equal(result.ok, false, `${args.join(' ')} should be refused`)
      assert.match(result.message, pattern, args.join(' '))
    }
    /** Centre of the pixels close to a colour in a screenshot (BGRA). */
    const find = (png, [r, g, b]) => {
      const image = nativeImage.createFromPath(png)
      const { width, height } = image.getSize()
      const bitmap = image.toBitmap()
      let sx = 0, sy = 0, count = 0
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4
        if (Math.abs(bitmap[offset + 2] - r) < 12 && Math.abs(bitmap[offset + 1] - g) < 12 && Math.abs(bitmap[offset] - b) < 12) { sx += x; sy += y; count++ }
      }
      assert.ok(count > 50, `colour ${r},${g},${b} not found in ${png}`)
      return [Math.round(sx / count), Math.round(sy / count)]
    }
    const readOut = async () => (await readFile(out)).toString('utf16le').replace(/^﻿/, '')

    try {
      await refusedWith(/off for this session/, 'status')
      await control.enable('tab-1')
      assert.equal((await ok('status')).enabled, true)

      const window = await until(async () => (await ok('windows')).windows.find(entry => entry.title === 'Desktop control check'), 'HTA window')
      assert.equal(window.status, 'needs approval')
      assert.equal((await ok('focus', window.id)).focused, true)
      assert.deepEqual(approvals, ['mshta'])
      await delay(400)

      // Type into the text field, found by its colour.
      let shot = await ok('screenshot', window.id)
      let [x, y] = find(shot.path, [0xc8, 0x64, 0x32])
      await ok('click', shot.frameId, String(x), String(y))
      const text = join(folder, 'text.txt')
      await writeFile(text, 'hello from desktop control')
      await delay(200)
      await ok('type', shot.frameId, '-File', text)
      await until(async () => (await readOut().catch(() => '')).startsWith('hello from desktop control|'), 'typed text saved by the HTA')

      // Click the button twice through fresh screenshots.
      for (let click = 1; click <= 2; click++) {
        await delay(300)
        shot = await ok('screenshot', window.id)
        ;[x, y] = find(shot.path, [0x44, 0xaa, 0x88])
        await ok('click', shot.frameId, String(x), String(y))
        await until(async () => (await readOut().catch(() => '')).endsWith(`|${click}`), `click ${click} counted`)
      }

      // A password field is never typed into.
      await delay(300)
      shot = await ok('screenshot', window.id)
      ;[x, y] = find(shot.path, [0x32, 0x64, 0xc8])
      await ok('click', shot.frameId, String(x), String(y))
      await delay(300)
      await refusedWith(/password field|could not tell/, 'type', shot.frameId, '-File', text)

      // Win-key chords and the app's own shortcuts are refused; an allowed chord goes through.
      await refusedWith(/Win-key/, 'key', shot.frameId, 'win+r')
      await refusedWith(/own shortcuts/, 'key', shot.frameId, 'ctrl+alt+h')
      await ok('key', shot.frameId, 'tab')

      // Blocked windows: the taskbar (File Explorer) and this app's own window.
      const taskbar = (await native.windows()).find(entry => entry.className === 'Shell_TrayWnd')
      assert.ok(taskbar, 'taskbar window')
      await refusedWith(/File Explorer/, 'screenshot', taskbar.id)
      const own = new BrowserWindow({ width: 300, height: 200, x: 900, y: 160, title: 'desktop control own window', show: true })
      await own.loadURL('data:text/html,<title>desktop control own window</title>')
      const ownWindow = await until(async () => (await native.windows()).find(entry => entry.title === 'desktop control own window'), 'own window')
      await refusedWith(/own windows/, 'screenshot', ownWindow.id)
      own.destroy()

      // Frames from before a screen change are not used.
      shot = await ok('screenshot', window.id)
      control.invalidateFrames()
      await refusedWith(/screen changed/, 'click', shot.frameId, '5', '5')

      // The stop key turns control off everywhere.
      await native.key([0x11, 0x12, 0x10, 0x58])
      await until(async () => control.enabledTabs().length === 0, 'stop key turns control off')
      await refusedWith(/off for this session/, 'status')

      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, approvals }))
      console.log('[desktop-control-check] all checks passed')
    } finally {
      viewer.kill()
      execFile('taskkill.exe', ['/F', '/T', '/PID', String(viewer.pid)], () => {})
      await control.dispose()
      overlay.dispose()
      await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    }
    app.exit(0)
  }
}
