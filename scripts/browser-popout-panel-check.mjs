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
  const { app, BaseWindow, BrowserWindow, webContents } = await import('electron')
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
    const state = () => ui('window.copilotDesktop.toolsState()')
    await until('document.querySelector(".session-pane")', 'initial CLI tab')
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.unloadTab(tab.id)})()')
    const current = async () => (await state()).projects.find(project => project.profileId === p1.id)
    try {
      await ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)}, {type:'add',kind:'browser',url:${JSON.stringify(address+'/popout')}})`)
      await until('document.querySelector(".tool-context button")?.textContent==="Open in window"', 'initial open button')
      const tab=(await current()).tabs.find(t=>t.kind==='browser')
      const page=webContents.fromId(tab.pageId)
      const loaded = Date.now() + 20_000
      while(page.isLoading() || !page.getURL().endsWith('/popout')) { assert.ok(Date.now() < loaded); await delay(30) }
      await page.executeJavaScript(`document.querySelector('#note').value='Preserve my page'`)
      for(let cycle=0;cycle<4;cycle++) {
        await click('.tool-context button')
        await until('document.querySelector(".tool-context button")?.textContent==="Return to panel"', 'pop-out updates the button')
        await delay(150)
        assert.equal(await ui('document.querySelector(".tool-context button").textContent'),'Return to panel','label stays correct after the action reply')
        assert.equal(await page.executeJavaScript(`document.querySelector('#note').value`),'Preserve my page')
        const popup = BaseWindow.getAllWindows().find(window => window.id !== win.id && window.contentView.children.some(view => view.webContents?.id === page.id))
        assert.ok(popup, 'page is in its own window')
        const toolbar = popup.contentView.children.find(view => view.webContents && view.webContents.id !== page.id)?.webContents
        assert.ok(toolbar, 'popup has its own app-owned return toolbar')
        await until('document.querySelector(".browser-viewport-detached")', 'detached placeholder appears')
        assert.equal(await ui('getComputedStyle(document.querySelector(".browser-viewport-detached")).backgroundColor'), 'rgb(11, 14, 20)')
        const ready = Date.now() + 20_000
        while (toolbar.isLoading()) { assert.ok(Date.now() < ready); await delay(30) }
        assert.equal(await toolbar.executeJavaScript('document.querySelector("button").textContent'), 'Return to panel')
        assert.equal(await toolbar.executeJavaScript('typeof window.copilotDesktop'), 'undefined', 'remote browser controls receive no desktop bridge')
        popup.setContentSize(760, 530)
        await delay(100)
        const bounds = popup.contentView.children.find(view => view.webContents?.id === page.id).getBounds()
        const [popupWidth, popupHeight] = popup.getContentSize()
        assert.deepEqual(bounds, { x: 0, y: 40, width: popupWidth, height: popupHeight - 40 }, 'toolbar reserves space without covering the page')
        if (cycle === 0) {
          await writeFile(join(directory, 'detached-panel.png'), (await win.webContents.capturePage()).toPNG())
          await writeFile(join(directory, 'popup-toolbar.png'), (await toolbar.capturePage()).toPNG())
        }
        if (cycle === 1) await click('.session-tools-toggle')
        if (cycle === 2) {
          await ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)}, {type:'add',kind:'git'})`)
          await ui(`window.copilotDesktop.activateProfile(${JSON.stringify(p2.id)})`)
        }
        if (cycle === 1 || cycle === 3) {
          win.maximize()
          const maximized = Date.now() + 5000
          while (!win.isMaximized()) { assert.ok(Date.now() < maximized); await delay(30) }
        }
        if (cycle === 2) {
          win.unmaximize()
          const normal = Date.now() + 5000
          while (win.isMaximized()) { assert.ok(Date.now() < normal); await delay(30) }
        }
        await delay(100)
        const mainBounds = win.getBounds()
        if (cycle === 2 || cycle === 3) {
          win.minimize()
          const minimized = Date.now() + 5000
          while (!win.isMinimized()) { assert.ok(Date.now() < minimized); await delay(30) }
        }
        const point = await toolbar.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
        popup.focus(); toolbar.focus()
        toolbar.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
        toolbar.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
        await until('document.querySelector(".tool-context button")?.textContent==="Open in window"', 'popup return button restores the panel')
        assert.equal((await ui('window.copilotDesktop.getState()')).activeProfileId, p1.id)
        assert.equal((await current()).activeId, tab.id)
        assert.equal((await current()).visible, true)
        assert.equal(win.isMinimized(), false, 'return reveals a minimized main window')
        assert.equal(win.isMaximized(), cycle === 1 || cycle === 3, 'return preserves maximized main window state')
        assert.deepEqual(win.getBounds(), mainBounds, 'return preserves main window size and position')
        assert.ok(popup.isDestroyed()); assert.ok(toolbar.isDestroyed(), 'toolbar renderer is disposed on return')
        await until('document.querySelector(".browser-viewport") && !document.querySelector(".browser-viewport-detached")', 'returned page removes detached placeholder')

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
      await ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)},{type:'pop-out',id:${JSON.stringify(tab.id)}})`)
      const closing = BaseWindow.getAllWindows().find(window => window.id !== win.id && window.contentView.children.some(view => view.webContents?.id === page.id))
      const closingToolbar = closing.contentView.children.find(view => view.webContents && view.webContents.id !== page.id).webContents
      closing.close()
      const closed = Date.now() + 20_000
      while (!page.isDestroyed() || !closingToolbar.isDestroyed()) { assert.ok(Date.now() < closed, 'closing popup disposes page and toolbar'); await delay(30) }
      await writeFile(join(directory,'result.json'),JSON.stringify({passed:true,cycles:4,pageStatePreserved:true,actionRepliesCurrent:true,popupReturnButton:true,darkPlaceholder:true,hiddenPanelReturn:true,otherWorkspaceReturn:true,toolbarDisposed:true,popupCloseDisposed:true,maximizedStatePreserved:true,minimizedWindowRestored:true},null,2))
      console.log('Browser pop-out button actual-app check passed:',directory)
    } finally {
      for(const tab of (await current()).tabs) await ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)},{type:'close',id:${JSON.stringify(tab.id)}})`)
      await new Promise(resolve=>server.close(resolve))
      app.quit()
    }
  }
}
