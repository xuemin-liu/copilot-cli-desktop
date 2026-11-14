import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/optional-tabs-app')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 180_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, webContents } = await import('electron')
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
    const click = selector => ui(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const type = (selector, value) => ui(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    const state = () => ui('window.copilotDesktop.toolsState()')
    await until('document.querySelector(".session-pane")', 'initial CLI tab')
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.unloadTab(tab.id)})()')
    const current = async () => (await state()).projects.find(project => project.profileId === p1.id)
    await until('document.querySelector(".session-tools-toggle")?.innerText.includes("New tab")', 'empty optional panel')
    assert.equal((await current()).tabs.length, 0)
    assert.equal(await ui('document.querySelectorAll(".tool-panel-commandbar").length'), 0)
    assert.ok(await ui('Boolean(document.querySelector(".session-pane-header .session-tools-toggle"))'))
    assert.ok(await ui('Math.abs(document.querySelector(".session-pane-visible .session-pane-header").getBoundingClientRect().top-document.querySelector(".tool-panel-workspace").getBoundingClientRect().top)<1'), 'session toolbar starts at the top; no extra command row')
    await click('.session-tools-toggle')
    await until('document.querySelector(".tool-launcher")', 'new tab launcher')
    await type('[aria-label="New browser URL"]', `${address}/Browser-A`)
    await ui('document.querySelector(".tool-launcher form").requestSubmit()')
    await until('document.querySelectorAll(".tool-tab").length===1 && !!document.querySelector(".browser-panel")', 'browser A tab')
    const a = (await current()).tabs[0]
    await until(`document.querySelector('[aria-label="Web app URL"]')?.value.includes('Browser-A')`, 'browser A loaded')
    await click('.workspace-tools-header > [aria-label="New tab"]')
    await until('document.querySelector(".tool-launcher")', 'second launcher')
    await type('[aria-label="New browser URL"]', `${address}/Browser-B`)
    await ui('document.querySelector(".tool-launcher form").requestSubmit()')
    await until('document.querySelectorAll(".tool-tab").length===2 && document.querySelectorAll(".browser-panel").length===2', 'two browsers')
    const b = (await current()).tabs.find(tab => tab.id !== a.id)
    await click('.workspace-tools-header > [aria-label="New tab"]')
    await until('document.querySelector(".tool-launcher")', 'Git launcher')
    await ui('[...document.querySelectorAll(".tool-launcher-types button")].find(button=>button.innerText.startsWith("Git")).click()')
    await until('document.querySelectorAll(".tool-tab").length===3 && !!document.querySelector(".git-panel")', 'Git shares the strip')
    assert.equal(await ui('document.querySelectorAll(".browser-pages").length'), 0)
    await until('!document.querySelector(".git-panel")?.innerText.includes("Looking for repositories")', 'Git loaded')
    await until(`document.querySelector('[aria-label="Commit message"]')`, 'commit box')
    await type('[aria-label="Commit message"]', 'Retained project draft')
    await writeFile(join(out, 'three-tabs.png'), (await win.webContents.capturePage()).toPNG())
    await click('.session-tools-toggle')
    await until('document.querySelector(".session-tools-toggle")?.innerText.includes("Show tabs")', 'panel hidden')
    assert.equal((await current()).tabs.length, 3)
    await click('.session-tools-toggle')
    await until('document.querySelector(".session-tools-toggle")?.innerText.includes("Hide tabs")', 'panel restored')
    const gitId = (await current()).tabs.find(tab => tab.kind === 'git').id
    assert.equal((await current()).activeId, gitId)
    await ui(`window.copilotDesktop.activateProfile(${JSON.stringify(p2.id)})`)
    await until('document.querySelector(".session-tools-toggle")?.innerText.includes("New tab")', 'other project empty')
    await ui(`window.copilotDesktop.activateProfile(${JSON.stringify(p1.id)})`)
    await until('document.querySelector(".session-tools-toggle")?.innerText.includes("Hide tabs")', 'project tabs restored')
    assert.equal((await current()).tabs.length, 3)
    assert.equal(await ui(`document.querySelector('[aria-label="Commit message"]').value`), 'Retained project draft')
    await click(`[data-tab-id="${a.id}"]`)
    await until(`document.querySelector('[data-tab-id="${a.id}"]')?.getAttribute('aria-selected')==='true'`, 'select A')
    await writeFile(join(out, 'browser-tab.png'), (await win.webContents.capturePage()).toPNG())
    const beforeClose = webContents.fromId(b.pageId)
    await click(`[data-tab-id="${b.id}"] + .tool-tab-close`)
    await until('document.querySelectorAll(".tool-tab").length===2', 'close inactive B')
    assert.ok(beforeClose.isDestroyed())
    assert.equal((await current()).activeId, a.id)
    win.setContentSize(700, 700)
    await until('getComputedStyle(document.querySelector(".project-dock-main")).display==="none"', 'narrow takeover')
    await click('.workspace-tools:not([hidden]) .workspace-tools-header > [aria-label="Hide tabs"]')
    await until('getComputedStyle(document.querySelector(".project-dock-main")).display!=="none"', 'hide returns CLI')
    await click('.session-tools-toggle')
    win.setContentSize(1500, 900)
    await click(`[data-tab-id="${a.id}"] + .tool-tab-close`)
    await until('document.querySelectorAll(".tool-tab").length===1', 'close A')
    await click(`[data-tab-id="${gitId}"] + .tool-tab-close`)
    await until('document.querySelector(".session-tools-toggle")?.innerText.includes("New tab")', 'last tab closes panel')
    assert.equal((await current()).tabs.length, 0)
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.closeTab(tab.id)})()')
    await until('document.querySelector(".empty-state > .session-tools-toggle")', 'tools remain available without sessions')
    await click('.empty-state > .session-tools-toggle')
    await until('document.querySelector(".tool-launcher")', 'open tools without a session')
    await click('.tool-tab-close')
    await until('!document.querySelector(".tool-launcher")', 'close tools without a session')
    await delay(150) // Let Chromium present the empty state before capturing it.
    await writeFile(join(out, 'empty-panel.png'), (await win.webContents.capturePage()).toPNG())
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, checks: ['no CLI browser required', 'session toolbar without extra row', 'launcher', 'Browser A/B/Git', 'hide/show', 'project switch', 'individual close', 'native page destroyed', 'narrow layout', 'last tab closes panel', 'tools with zero sessions'] }, null, 2))
    console.log('Optional tabs real app check passed.')
    server.close(); app.quit()
  }
}
