import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = resolve('test-results/other-cli-settings')
const delay = ms => new Promise(r => setTimeout(r, ms))

if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 150_000)
  try { assert.equal(await new Promise((res, rej) => { child.once('error', rej); child.once('exit', res) }), 0) }
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
    execFileSync('git', ['init', '-q'], { cwd: workspace })
    const configPath = join(directory, 'userdata', 'desktop.json')
    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const p1 = createWorkspaceProfile(workspace)
    await writeDesktopConfig(configPath, { ...DEFAULT_DESKTOP_CONFIG, profiles: [p1], activeProfileId: p1.id,
      closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })

    // 1. Pure-launch check: the descriptor builds the exact argv we expect.
    const { buildOtherCliLaunchArgs } = await import('../dist/src/main/agent-cli-settings.js')
    assert.deepEqual(buildOtherCliLaunchArgs('claude', { approval: 'plan', model: 'claude-sonnet-5' }),
      ['--permission-mode', 'plan', '--model', 'claude-sonnet-5'])
    assert.deepEqual(buildOtherCliLaunchArgs('codex', { approval: 'never', sandbox: 'read-only' }),
      ['--ask-for-approval', 'never', '--sandbox', 'read-only'])
    console.log('OK: descriptor argv')

    await import('../dist/src/main/main.js')
    await app.whenReady()

    // 2. Drive the Settings window's per-CLI editor through the real app.
    let main
    for (let i = 0; i < 150 && !main; i++) {
      main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html'))
      if (!main) await delay(100)
    }
    assert.ok(main, 'main window')
    await main.webContents.executeJavaScript('window.copilotDesktop.openSettings()')
    let win
    for (let i = 0; i < 150 && !win; i++) {
      win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('settings.html'))
      if (!win) await delay(100)
    }
    {
      assert.ok(win, 'settings window')
      win.setContentSize(1100, 900)
      const ui = code => win.webContents.executeJavaScript(code)
      const until = async (code, label) => {
        const end = Date.now() + 20_000
        while (Date.now() < end) { if (await ui(`Boolean(${code})`)) return; await delay(40) }
        await writeFile(join(out, 'settings-failure.png'), (await win.webContents.capturePage()).toPNG())
        throw new Error(`Timed out: ${label}`)
      }
      await until('document.querySelector(".other-cli-settings")', 'per-CLI settings block')
      const tabCount = await ui('document.querySelectorAll(".other-cli-tab").length')
      assert.equal(tabCount, 3, 'one tab per other CLI')
      // Claude tab (first) should show an approval selector and a model input.
      await ui('document.querySelectorAll(".other-cli-tab")[0].click()')
      await until('document.querySelector(".other-cli-settings select")', 'Claude approval selector')
      const hasModel = await ui('Boolean([...document.querySelectorAll(".other-cli-settings input")].length)')
      assert.ok(hasModel, 'Claude model input present')
      // Codex tab (second) shows two selectors (approval + sandbox).
      await ui('document.querySelectorAll(".other-cli-tab")[1].click()')
      await until('document.querySelectorAll(".other-cli-settings select").length === 2', 'Codex approval + sandbox selectors')
      // Antigravity tab (third) shows the managed note and no selector.
      await ui('document.querySelectorAll(".other-cli-tab")[2].click()')
      await until('document.querySelector(".other-cli-settings .settings-disclaimer")', 'Antigravity managed note')
      // Back to Claude for the screenshot, scrolled into view.
      await ui('document.querySelectorAll(".other-cli-tab")[0].click()')
      await ui('document.querySelector(".other-cli-settings").scrollIntoView({ block: "center" })')
      await delay(150)
      await mkdir(out, { recursive: true })
      await writeFile(join(out, 'settings.png'), (await win.webContents.capturePage()).toPNG())
      console.log('OK: settings UI renders per-CLI tabs')
    }

    console.log('OK: all checks passed')
    app.exit(0)
  }
}
