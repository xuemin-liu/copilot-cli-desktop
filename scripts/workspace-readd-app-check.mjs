import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/workspace-readd-app')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 180_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, webContents, dialog } = await import('electron')
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
    await writeFile(join(workspace, 'a.txt'), 'tab lifecycle fixture\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: workspace })
    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const p1 = createWorkspaceProfile(workspace), p2 = createWorkspaceProfile(directory)
    await writeDesktopConfig(join(directory, 'userdata', 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [p1, p2], activeProfileId: p1.id,
      closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })
    const server = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<title>${request.url}</title><body style="background:#eef2f6;padding:20px;font-family:sans-serif"><h1>${request.url}</h1><input id="note" placeholder="Your page state stays here"></body>`) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = `http://127.0.0.1:${server.address().port}`
    await import('../dist/src/main/main.js')
    await app.whenReady()
    let win
    for (let index = 0; index < 150 && !win; index++) { win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')); if (!win) await delay(100) }
    assert.ok(win)
    win.setContentSize(1500, 900)
    const ui = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(`${error}\n${code}`) })
    const until = async (code, label) => {
      const end = Date.now() + 20_000
      while (Date.now() < end) { if (await ui(`Boolean(${code})`)) return; await delay(30) }
      await writeFile(join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG())
      throw new Error(`Timed out: ${label}\n${await ui('document.body.innerText')}`)
    }
    const state = () => ui('window.copilotDesktop.toolsState()')
    await until('document.querySelector(".session-pane")', 'initial CLI tab')
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.unloadTab(tab.id)})()')
    const current = async () => (await state()).projects.find(project => project.profileId === p1.id)
    const action = request => ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)},${JSON.stringify(request)})`)
    const feature = (method, args = []) => ui(`window.copilotDesktop.myTerminal(${JSON.stringify(p1.id)},${JSON.stringify(method)},${JSON.stringify(args)})`)
    const terminal = request => ui(`window.copilotDesktop.toolTerminal(${JSON.stringify(p1.id)},${JSON.stringify(request)})`)
    const choose = dialog.showOpenDialog
    // Only automate the native folder chooser; real preload, IPC, persistence and tools remain in use.
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] })
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        await action({ type: 'add', kind: 'browser', url: address + '/before-removal' })
        const oldBrowser = (await current()).tabs.find(tab => tab.kind === 'browser')
        const oldPage = webContents.fromId(oldBrowser.pageId)
        await action({ type: 'add', kind: 'local' })
        await until('document.querySelector(".terminal-status")?.innerText.includes("Connected")', 'initial terminal connects')
        const oldTerminal = (await current()).tabs.find(tab => tab.kind === 'local')
        await feature('snippets:save', [{ id: 'old-snippet', name: 'Deleted with workspace', command: 'echo old' }])
        const oldProfile = (await current()).browserProfileId
        await ui(`(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs.filter(t=>t.workspaceProfileId===${JSON.stringify(p1.id)})){await window.copilotDesktop.unloadTab(tab.id);await window.copilotDesktop.closeTab(tab.id)}})()`)
        await ui(`window.copilotDesktop.removeProfile(${JSON.stringify(p1.id)})`)
        assert.ok(!(await ui('window.copilotDesktop.getState()')).profiles.some(profile => profile.id === p1.id))
        assert.equal(await current(), undefined)
        assert.ok(oldPage.isDestroyed(), 'removed browser is destroyed')
        await assert.rejects(terminal({ action: 'read', id: oldTerminal.id }), /Workspace|project/i)
        const added = await ui('window.copilotDesktop.selectWorkspace()')
        assert.ok(added.profiles.some(profile => profile.id === p1.id && profile.path === workspace), 'same folder gets the same workspace ID')
        await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.unloadTab(tab.id)})()')
        assert.deepEqual(await feature('snippets:getAll'), [], 'removed MyTerminal data does not return')
        await feature('snippets:save', [{ id: 'fresh', name: 'New workspace data', command: 'echo fresh' }])
        assert.equal((await feature('snippets:getAll'))[0].id, 'fresh')
        await action({ type: 'add', kind: 'browser', url: address + '/readded-' + cycle })
        const browser = (await current()).tabs.find(tab => tab.kind === 'browser')
        assert.notEqual((await current()).browserProfileId, oldProfile)
        const page = webContents.fromId(browser.pageId)
        const loaded = Date.now() + 20_000
        while (page.isLoading() || !page.getURL().endsWith('/readded-' + cycle)) {
          assert.ok(Date.now() < loaded, 're-added browser navigation completes')
          await delay(30)
        }
        assert.equal(await page.executeJavaScript('document.querySelector("h1").textContent'), '/readded-' + cycle)
        assert.ok(win.contentView.children.some(view => view.webContents?.id === browser.pageId))
        await action({ type: 'add', kind: 'git' })
        await until(`document.querySelector('.git-panel') && document.querySelector('[aria-label="Commit message"]')`, 'Git works after re-add')
        await action({ type: 'add', kind: 'local' })
        await until('document.querySelector(".terminal-status")?.innerText.includes("Connected")', 'new terminal connects without restarting app')
        const freshTerminal = (await current()).tabs.find(tab => tab.kind === 'local')
        assert.notEqual(freshTerminal.id, oldTerminal.id)
        await assert.rejects(terminal({ action: 'read', id: oldTerminal.id }), /does not belong/)
        await terminal({ action: 'write', id: freshTerminal.id, text: process.platform === 'win32' ? "Write-Output ('READDED_' + 'TERMINAL')\r" : "printf 'READDED_%s\\n' TERMINAL\r" })
        await until('document.querySelector(".tool-terminal-screen")?.innerText.includes("READDED_TERMINAL")', 'real terminal output rendered after re-add')
        await writeFile(join(directory, `cycle-${cycle}.png`), (await win.webContents.capturePage()).toPNG())
        for (const tab of (await current()).tabs) await action({ type: 'close', id: tab.id })
      }
      await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, cycles: 2, sameWorkspaceId: true, browser: true, git: true, nativeTerminalOutput: true, myTerminalDataReset: true, oldTerminalRejected: true }, null, 2))
      console.log('Workspace remove/re-add actual-app check passed:', directory)
    } finally {
      dialog.showOpenDialog = choose
      await new Promise(resolve => server.close(resolve))
      app.quit()
    }
  }
}
