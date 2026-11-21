// Real Electron: the main window's page process is killed, and the window comes back with its sessions.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/window-recovery')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 120_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
  console.log('PASS: the main window reloads after its page process dies, and asks when it keeps dying')
} else {
  const { app, BrowserWindow, dialog } = await import('electron')
  const directory = join(out, `run-${Date.now()}`)
  app.setPath('userData', join(directory, 'userdata'))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await mkdir(join(directory, 'userdata'), { recursive: true })
    await mkdir(join(directory, 'copilot-home'), { recursive: true })
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    const workspace = join(directory, 'workspace'); await mkdir(workspace)
    await writeFile(join(workspace, 'a.txt'), 'window recovery fixture\n')
    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const profile = createWorkspaceProfile(workspace)
    await writeDesktopConfig(join(directory, 'userdata', 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id,
      closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })
    const asked = []
    let answer = 1
    dialog.showMessageBox = async (_window, options) => { asked.push(options); return { response: answer } }
    await import('../dist/src/main/main.js')
    await app.whenReady()
    let win
    for (let index = 0; index < 150 && !win; index++) { win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')); if (!win) await delay(100) }
    assert.ok(win)
    const ui = code => win.webContents.executeJavaScript(code)
    const shown = async label => {
      const end = Date.now() + 30_000
      while (Date.now() < end) {
        if (!win.webContents.isCrashed() && await ui('Boolean(document.querySelector(".session-pane .xterm"))').catch(() => false)) return
        await delay(50)
      }
      throw new Error(`Timed out: ${label}`)
    }
    const sessions = async () => (await ui('window.copilotDesktop.getState()')).tabs.map(tab => [tab.id, tab.status])
    const log = () => readFile(join(directory, 'userdata', 'logs', 'app.log'), 'utf8').catch(() => '')
    const kill = async () => {
      const gone = new Promise(resolve => win.webContents.once('render-process-gone', resolve))
      win.webContents.forcefullyCrashRenderer()
      await gone
    }
    await shown('first session')
    const before = await sessions()
    assert.equal(before.length, 1)
    // Mark the page, so a page that answers afterwards is known to be a new one.
    await ui('window.__beforeCrash = true')

    for (let death = 1; death <= 3; death++) {
      await kill()
      await shown(`page back after death ${death}`)
      assert.equal(await ui('window.__beforeCrash === undefined'), true, 'a new page was loaded')
      assert.deepEqual(await sessions(), before, 'the session is the same one, still running')
      await ui('window.__beforeCrash = true')
    }
    assert.equal(asked.length, 0)

    // The fourth death in a minute: no reload, a question instead. "Not Now" leaves the window as it is.
    await kill()
    await delay(1500)
    assert.equal(asked.length, 1)
    assert.match(asked[0].detail, /sessions are still running/)
    assert.equal(win.webContents.isCrashed(), true, 'not reloaded without being asked')
    assert.equal(win.isDestroyed(), false)

    // Reload brings it back. The dead page cannot be killed again, so the next death is asked about by loading it by hand.
    answer = 0
    await win.loadFile(fileURLToPath(new URL('../dist/src/renderer/index.html', import.meta.url)))
    await shown('page loaded by hand')
    await kill()
    await shown('page back after choosing Reload')
    assert.equal(asked.length, 2)
    assert.deepEqual(await sessions(), before)

    const text = await log()
    assert.equal(text.match(/Main window page process ended \(reason=[\w-]+ exitCode=-?\d+\); loading the page again/g)?.length, 3, text)
    assert.equal(text.match(/it keeps ending, so asking before another reload/g)?.length, 2, text)
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.closeTab(tab.id)})()').catch(() => {})
    await delay(1000); app.exit(0)
  }
}
