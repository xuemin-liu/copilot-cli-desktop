// Real Electron: the Add workspace dialog takes the keyboard when it opens, and Escape closes it without reaching the session.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/add-workspace-dialog')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 180_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
  console.log('PASS: the Add workspace dialog takes the focus and closes on Escape')
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  const directory = join(out, `run-${Date.now()}`)
  app.setPath('userData', join(directory, 'userdata'))
  // What is typed into the session while the dialog is open.
  const written = []
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (name, handler) => handle(name, (event, ...args) => {
    if (name === 'desktop:write-tab') written.push(args[1])
    return handler(event, ...args)
  })
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await mkdir(join(directory, 'userdata'), { recursive: true })
    await mkdir(join(directory, 'copilot-home'), { recursive: true })
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    const workspace = join(directory, 'workspace'); await mkdir(workspace)
    await writeFile(join(workspace, 'a.txt'), 'dialog fixture\n')
    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const profile = createWorkspaceProfile(workspace)
    await writeDesktopConfig(join(directory, 'userdata', 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id,
      closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })
    await import('../dist/src/main/main.js')
    await app.whenReady()
    let win
    for (let index = 0; index < 600 && !win; index++) { win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')); if (!win) await delay(100) }
    assert.ok(win)
    win.setContentSize(1400, 900)
    win.show(); win.focus(); win.webContents.focus()
    const ui = code => win.webContents.executeJavaScript(code)
    const until = async (code, label) => {
      const end = Date.now() + 20_000
      while (Date.now() < end) { if (await ui(`Boolean(${code})`)) return; await delay(30) }
      throw new Error(`Timed out: ${label}`)
    }
    const key = keyCode => { for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode }) }
    const open = async () => {
      // As a person does: the terminal has the keyboard, then the sidebar button is clicked.
      await ui('document.querySelector(".session-pane .xterm-helper-textarea").focus()')
      const spot = await ui('(() => { const r = document.querySelector(\'[aria-label="Add workspace"]\').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()')
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...spot, button: 'left', clickCount: 1 })
      await until('document.querySelector(".input-dialog")', 'dialog opens')
      await delay(200)
    }
    const closed = label => until('!document.querySelector(".input-dialog")', label)
    await until('document.querySelector(".session-pane .xterm-helper-textarea")', 'session terminal')
    await until('document.querySelector(\'[aria-label="Add workspace"]\')', 'Add workspace button')
    await delay(3000) // the CLI finishes drawing, so nothing it asks the terminal is mistaken for typing
    written.length = 0

    await open()
    assert.equal(await ui('document.activeElement?.closest(".input-dialog") !== null'), true, 'the focus is inside the dialog when it opens')
    assert.equal(await ui('document.activeElement?.getAttribute("name")'), 'workspace-type')
    key('Escape')
    await closed('Escape closes the dialog')

    // After a click on the backdrop the focus is on the page, not in the dialog: Escape still closes it.
    await open()
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: 8, y: 8, button: 'left', clickCount: 1 })
    await delay(150)
    assert.equal(await ui('Boolean(document.querySelector(".input-dialog"))'), true, 'a click outside does not close it')
    key('Escape')
    await closed('Escape closes the dialog after a click outside it')

    // Typing in the dialog's own field still works, and Escape from there closes it too.
    await open()
    key('Down')
    await until('document.querySelector("#input-dialog-value") === document.activeElement', 'General shows the name field, focused')
    win.webContents.insertText('Notes')
    await until('document.querySelector("#input-dialog-value").value === "Notes"', 'typing reaches the field')
    key('Escape')
    await closed('Escape closes the dialog from its text field')

    await delay(300)
    const typed = written.filter(data => !/^\u001b\[[IO]$/.test(data))
    assert.deepEqual(typed, [], 'nothing typed for the dialog reached the session')
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.closeTab(tab.id)})()').catch(() => {})
    await delay(1000); app.exit(0)
  }
}
