// Real Electron with the installed Copilot CLI: the Tasks panel says so when that CLI is not the verified version.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/workflow-version-notice')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 180_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const directory = join(out, `run-${Date.now()}`)
  app.setPath('userData', join(directory, 'userdata'))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await mkdir(join(directory, 'userdata'), { recursive: true })
    await mkdir(join(directory, 'copilot-home'), { recursive: true })
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    const workspace = join(directory, 'workspace'); await mkdir(workspace)
    await writeFile(join(workspace, 'a.txt'), 'version notice fixture\n')
    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const { WORKFLOW_CLI_VERSION } = await import('../dist/src/main/workflow-capabilities.js')
    const profile = createWorkspaceProfile(workspace)
    await writeDesktopConfig(join(directory, 'userdata', 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id,
      closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })
    await import('../dist/src/main/main.js')
    await app.whenReady()
    let win
    for (let index = 0; index < 600 && !win; index++) { win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')); if (!win) await delay(100) }
    assert.ok(win)
    win.setContentSize(1400, 900)
    const ui = code => win.webContents.executeJavaScript(code)
    const state = () => ui('window.copilotDesktop.getState()')
    // The panel lists a session once the CLI has given it an id.
    let current
    for (const end = Date.now() + 60_000; Date.now() < end; await delay(200)) {
      current = await state()
      if (current.resolution?.version && current.tabs.some(tab => tab.lastSessionId) && await ui('Boolean(document.querySelector(".workflow-tasks"))')) break
    }
    const installed = current.resolution?.version
    assert.ok(installed, 'the installed CLI version is known')
    assert.ok(await ui('Boolean(document.querySelector(".workflow-tasks"))'), 'the Tasks panel is shown')
    const note = await ui('document.querySelector(".workflow-tasks [role=note]")?.textContent ?? null')
    await writeFile(join(out, 'panel.png'), (await win.webContents.capturePage()).toPNG())
    if (installed === WORKFLOW_CLI_VERSION) {
      assert.equal(note, null, 'the verified version needs no explanation')
      console.log(`PASS: CLI ${installed} is the verified version; no notice`)
    } else {
      assert.equal(note, `Task reports and automatic work are verified with Copilot CLI ${WORKFLOW_CLI_VERSION} only. Version ${installed} is installed, so both are off. Task outcomes can still be set by hand.`)
      assert.match(await ui('document.querySelector(".workflow-tasks summary").textContent'), / · reports off$/, 'the closed panel says so too')
      console.log(`PASS: CLI ${installed} is installed; the Tasks panel says task reports and automatic work are off`)
    }
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.closeTab(tab.id)})()').catch(() => {})
    await delay(1000); app.exit(0)
  }
}
