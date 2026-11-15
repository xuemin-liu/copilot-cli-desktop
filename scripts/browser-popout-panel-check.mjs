import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/browser-popout-panel')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
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
    try {
      await ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)}, {type:'add',kind:'browser',url:${JSON.stringify(address+'/popout')}})`)
      await until('document.querySelector(".tool-context button")?.textContent==="Open in window"', 'initial open button')
      const tab=(await current()).tabs.find(t=>t.kind==='browser')
      const page=webContents.fromId(tab.pageId)
      while(page.isLoading()) await delay(30)
      await page.executeJavaScript(`document.querySelector('#note').value='Preserve my page'`)
      for(let cycle=0;cycle<3;cycle++) {
        await click('.tool-context button')
        await until('document.querySelector(".tool-context button")?.textContent==="Return to panel"', 'pop-out updates the button')
        await delay(150)
        assert.equal(await ui('document.querySelector(".tool-context button").textContent'),'Return to panel','label stays correct after the action reply')
        assert.equal(await page.executeJavaScript(`document.querySelector('#note').value`),'Preserve my page')
        await click('.tool-context button')
        await until('document.querySelector(".tool-context button")?.textContent==="Open in window"', 'return updates the button')
        assert.equal((await current()).tabs.find(t=>t.id===tab.id).detached,false)
        assert.equal(webContents.fromId(tab.pageId),page)
        assert.equal(await page.executeJavaScript(`document.querySelector('#note').value`),'Preserve my page')
        assert.ok(win.contentView.children.some(view=>view.webContents?.id===tab.pageId),'page reattached to the main window')
      }
      // IPC replies must agree with state notifications, even before React applies either.
      for(const type of ['pop-out','return']) {
        const reply=await ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)},{type:${JSON.stringify(type)},id:${JSON.stringify(tab.id)}})`)
        assert.equal(reply.projects.find(p=>p.profileId===p1.id).tabs.find(t=>t.id===tab.id).detached,type==='pop-out')
      }
      await writeFile(join(directory,'result.json'),JSON.stringify({passed:true,cycles:3,pageStatePreserved:true,actionRepliesCurrent:true},null,2))
      console.log('Browser pop-out button actual-app check passed:',directory)
    } finally {
      for(const tab of (await current()).tabs) await ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)},{type:'close',id:${JSON.stringify(tab.id)}})`)
      await new Promise(resolve=>server.close(resolve))
      app.quit()
    }
  }
}
