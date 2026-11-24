import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/myterminal-parity-app')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 120_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, Notification, dialog, clipboard, shell } = await import('electron')
  const root = join(out, `run-${Date.now()}`)
  app.setPath('userData', join(root, 'userdata'))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await mkdir(join(root, 'userdata'), { recursive: true })
    process.env.COPILOT_HOME = join(root, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    await mkdir(process.env.COPILOT_HOME)
    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const p1 = createWorkspaceProfile(root), p2 = createWorkspaceProfile(out)
    await writeDesktopConfig(join(root, 'userdata', 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [p1,p2], activeProfileId: p1.id,
      closeBehavior: 'quit', trayEnabled: false, automaticUpdateChecks: false })
    await import('../dist/src/main/main.js')
    await app.whenReady()
    let win
    const until = async (predicate, label, timeout = 12_000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) { if (await predicate()) return; await delay(50) }
      if (win) { win.show(); await writeFile(join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
      throw new Error(`Timed out: ${label}`)
    }
    await until(() => (win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html'))), 'main window', 30000)
    const ui = code => Promise.race([win.webContents.executeJavaScript(code, true).catch(e=>{throw new Error(`Renderer failed: ${code}`,{cause:e})}), delay(15000).then(() => { throw new Error(`Renderer call timed out: ${code}`) })])
    await until(() => ui('Boolean(document.querySelector(".session-pane"))'), 'full app renderer')
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.unloadTab(tab.id)})()')
    const notifications = [], originalShow = Notification.prototype.show, originalDialog = dialog.showMessageBox
    Notification.prototype.show = function () { notifications.push({ title: this.title, body: this.body }); originalShow.call(this); setTimeout(() => this.close(), 500) }
    dialog.showMessageBox = (...args) => args.at(-1)?.title === 'Trust SSH host?' ? Promise.resolve({ response: 1 }) : originalDialog(...args)
    const { fixture } = await import('../scripts/myterminal-ssh-fixture.mjs')
    const ssh = await fixture()
    console.log('Full app and SSH fixture ready')
    const action = request => ui(`window.copilotDesktop.toolTerminal(${JSON.stringify(p1.id)},${JSON.stringify(request)})`)
    const tools = request => ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)},${JSON.stringify(request)})`)
    const activate = id => ui(`window.copilotDesktop.activateProfile(${JSON.stringify(id)})`)
    const priorClipboard=await clipboard.readText()
    const opened = [], originalOpen = shell.openExternal
    shell.openExternal = async url => { opened.push(url) }
    try {
      const feature=(method,...args)=>ui(`window.copilotDesktop.myTerminal(${JSON.stringify(p1.id)},${JSON.stringify(method)},${JSON.stringify(args)})`)
      await feature('sessions:save',{id:'parity',name:'Named server',host:'127.0.0.1',port:ssh.port,username:'tester',password:'secret',authType:'password'})
      await feature('settings:set',{osc52ClipboardEnabled:true,defaultScrollback:100000})
      await feature('favorites:set',`127.0.0.1:${ssh.port}`,['/saved-bookmark'])
      const terminal=await action({action:'create',kind:'ssh',config:{transport:'managed',connectionId:'parity',host:'127.0.0.1'}})
      const id=terminal.id, host=`#tool-content-${id}`
      await until(()=>ui(`document.querySelector('${host} .terminal-toolbar')?.innerText.includes('Connected')`),'terminal connected')
      assert.equal(terminal.title,'Named server')
      assert.equal(terminal.terminal.port,ssh.port)
      assert.equal(terminal.terminal.username,'tester')
      assert.equal(terminal.terminal.password,undefined)
      // Inspect the real mounted component's xterm, without a production test hook.
      await ui(`window.parityTerminal=()=>{const el=document.querySelector('${host} .terminal-toolbar');let fiber=el[Object.keys(el).find(k=>k.startsWith('__reactFiber'))];for(;fiber;fiber=fiber.return){if(fiber.memoizedProps?.host?.getTerminal)return fiber.memoizedProps.host.getTerminal()}throw Error('Terminal component missing')};void 0`)
      await ui(`window.originalTerm=parityTerminal();void 0`)
      await ui(`document.querySelector('${host} button[title="Toggle SFTP panel"]').click()`)

      await until(()=>ui(`document.querySelector('${host} .sftp-panel')?.innerText.includes('sample.txt')`),'SFTP loaded')
      assert.equal(await ui(`document.querySelector('${host} .sftp-panel').innerText.includes('/saved-bookmark')`),true)
      await ui(`document.querySelector('${host} button[title="Add to favorites"]').click()`)
      assert.ok((await feature('favorites:get',`127.0.0.1:${ssh.port}`)).includes('/'),'favorite uses connection port')
      await ui(`[...document.querySelectorAll('${host} .sftp-panel tbody tr')].find(row=>row.textContent.includes('sample.txt')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
      await until(()=>ui(`document.querySelector('${host} .file-editor-textarea')?.value==='remote original'`),'editor opened')
      await ui(`(()=>{const e=document.querySelector('${host} .file-editor-textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'UNSAVED_AUDIT');e.dispatchEvent(new Event('input',{bubbles:true}));window.auditConfirms=[];window.confirm=text=>{window.auditConfirms.push(text);return false}})()`)
      await until(()=>ui(`Boolean(document.querySelector('${host} .file-editor-modified'))`),'unsaved draft')
      const split=await action({action:'split',id})
      await until(()=>ssh.shells===2,'two live SSH shells')
      await until(()=>ui(`Boolean(document.querySelector('${host} button[title="Close split pane"]'))`),'split view attached')
      await ui(`window.paritySplit=()=>{const el=document.querySelector('${host} button[title="Close split pane"]');let f=el[Object.keys(el).find(k=>k.startsWith('__reactFiber'))];for(;f;f=f.return)if(f.memoizedProps?.termInstanceRef)return f.memoizedProps.termInstanceRef.current};void 0`)
      const expectedGrids=await ui(`[parityTerminal(),paritySplit()].map(t=>({cols:t.cols,rows:t.rows})).sort((a,b)=>a.cols-b.cols||a.rows-b.rows)`)
      const before=await action({action:'read',id})
      await tools({type:'visible',visible:false})
      await activate(p2.id)
      ssh.disconnect()
      await until(async()=>{const next=await action({action:'read',id});return next.status==='running'&&next.generation!==before.generation},'parent reconnected')
      await delay(1200)
      await until(async()=>(await action({action:'read',id:split.id})).status==='running'&&ssh.shells===2,'both SSH panes reconnected')
      await until(()=>JSON.stringify(ssh.grids.toSorted((a,b)=>a.cols-b.cols||a.rows-b.rows))===JSON.stringify(expectedGrids),'hidden reconnect restores both PTY grids')
      assert.equal(await ui(`document.querySelector('${host} .file-editor-textarea')?.value`),'UNSAVED_AUDIT','reconnect preserves unsaved editor')
      assert.equal(await ui('parityTerminal()===originalTerm'),true,'same xterm survives reconnect')
      assert.deepEqual(await ui('window.auditConfirms'),[])
      assert.equal(ssh.files.get('/sample.txt').toString(),'remote original')
      await until(()=>ui(`document.querySelector('${host} .terminal-toolbar')?.innerText.includes('Connected')`),'reconnected status')
      await activate(p1.id)
      await tools({type:'visible',visible:true})
      // Saving the preserved editor must use the replacement SSH transport.
      await ui(`[...document.querySelectorAll('${host} .file-editor-overlay button')].find(b=>b.textContent==='Save').click()`)
      await until(()=>ssh.files.get('/sample.txt').toString()==='UNSAVED_AUDIT','draft saved after reconnect')
      // The shared context menu must act on the split pane that was right-clicked.
      const splitMenu=`document.querySelector('${host} button[title="Close split pane"]').nextElementSibling.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:60,clientY:60}))`
      await clipboard.writeText('SPLIT_PASTE')
      await ui(splitMenu)
      await until(()=>ui(`Boolean(document.querySelector('${host} .context-menu'))`),'split context menu')
      await ui(`[...document.querySelectorAll('${host} .context-menu button')].find(b=>b.textContent==='Paste').click()`)
      await until(async()=>(await action({action:'read',id:split.id})).output.includes('SPLIT_PASTE'),'split paste reached split SSH')
      assert.equal((await action({action:'read',id})).output.includes('SPLIT_PASTE'),false,'split paste stays out of the main pane')
      await ui(`parityTerminal().clearSelection();parityTerminal().write('MAIN_ONLY');paritySplit().write('SPLIT_COPY_MARK');void 0`)
      await delay(200)
      await ui(`paritySplit().selectAll();${splitMenu}`)
      await until(()=>ui(`document.querySelector('${host} .context-menu button')?.disabled===false`),'split copy enabled')
      await ui(`[...document.querySelectorAll('${host} .context-menu button')].find(b=>b.textContent==='Copy').click()`)
      await until(async()=>(await clipboard.readText()).includes('SPLIT_COPY_MARK'),'split copy reached system clipboard')
      assert.equal((await clipboard.readText()).includes('MAIN_ONLY'),false,'split copy does not copy the main pane')
      await action({action:'unsplit',id})
      await ui(`[...document.querySelectorAll('${host} .file-editor-overlay button')].find(b=>b.textContent==='Close').click()`)
      await ui(`document.querySelector('${host} button[title="Toggle SFTP panel"]').click()`)
      await until(()=>ui('parityTerminal().cols>20'),'terminal grid restored after SFTP')
      // Exercise MyTerminal's actual context-menu clipboard handlers.
      await clipboard.writeText('PARITY_PASTE')
      await ui(`document.querySelector('${host} .terminal-wrapper > div').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:50,clientY:50}))`)
      await until(()=>ui(`Boolean(document.querySelector('${host} .context-menu'))`),'context menu')
      await ui(`[...document.querySelectorAll('${host} .context-menu button')].find(b=>b.textContent==='Paste').click()`)
      await until(async()=>(await action({action:'read',id})).output.includes('PARITY_PASTE'),'native paste reached SSH')
      await ui(`parityTerminal().selectAll();document.querySelector('${host} .terminal-wrapper > div').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:50,clientY:50}))`)
      await until(()=>ui(`Boolean(document.querySelector('${host} .context-menu'))`),'copy menu')
      await ui(`[...document.querySelectorAll('${host} .context-menu button')].find(b=>b.textContent==='Copy').click()`)
      await until(async()=>(await clipboard.readText()).includes('PARITY_PASTE'),'native copy reached system clipboard')
      // The app still denies window.open; the actual WebLinksAddon uses the native handler.
      assert.equal(await ui(`window.open('https://example.com')===null`),true)
      await ui(`parityTerminal()._addonManager._addons.find(a=>typeof a.instance._handler==='function').instance._handler(new MouseEvent('click'),'https://example.com/parity')`)
      await until(()=>opened.includes('https://example.com/parity'),'terminal hyperlink dispatched')
      for(const key of ['t','w']) {
        await ui(`parityTerminal().focus()`)
        win.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers:['control']})
        win.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers:['control']})
      }
      await until(async()=>{const text=(await action({action:'read',id})).output;return text.includes('\x14')&&text.includes('\x17')},'Ctrl+T and Ctrl+W reach SSH')
      const panel=await ui(`window.copilotDesktop.toolsState()`)
      assert.equal(panel.projects.find(p=>p.profileId===p1.id).activeId,id)
      assert.equal(await ui('Boolean(document.querySelector(".tool-launcher"))'),false,'Ctrl+T does not open launcher')
      assert.ok((await action({action:'list'})).some(t=>t.id===id),'Ctrl+W does not close terminal')
      const log=await feature('logging:start',id,join(root,'logs'))
      assert.ok(log.filePath)
      ssh.broadcast('LOG_BEGIN\x1b]0;title\x07\x1b[31mred\x1b[0m\x1b(BLOG_END\r\n')
      await until(async()=>(await readFile(log.filePath,'utf8').catch(()=>'' )).includes('LOG_END'),'log flushed')
      const logged=await readFile(log.filePath,'utf8')
      assert.ok(logged.includes('LOG_BEGINredLOG_END'))
      assert.ok(!logged.includes('\x1b'),'original stripAnsi removes OSC and charset sequences')
      // Process output while hidden AND while another project owns all input controls.
      await tools({type:'visible',visible:false})
      await activate(p2.id)
      await clipboard.writeText('PARITY_SENTINEL')
      ssh.broadcast('\x1b]52;c;UEFSSVRZX0NMSVBCT0FSRA==\x07')
      await until(async()=>await clipboard.readText()==='PARITY_CLIPBOARD','hidden OSC52 processed immediately')
      // More output than the CLI replay buffer, but below the configured xterm scrollback.
      const lines=Array.from({length:8000},(_,i)=>`PARITY_ROW_${String(i).padStart(4,'0')} `+'x'.repeat(60)+'\r\n').join('')
      ssh.broadcast(lines+'PARITY_STREAM_END\r\n')
      await until(()=>ui(`(()=>{const b=parityTerminal().buffer.active;return Array.from({length:Math.min(80,b.length)},(_,i)=>b.getLine(Math.max(0,b.length-80)+i)?.translateToString(true)).join('').includes('PARITY_STREAM_END')})()`),'hidden xterm parsed stream',20000)
      assert.equal(await ui(`(()=>{const b=parityTerminal().buffer.active;for(let i=0;i<b.length;i++)if(b.getLine(i)?.translateToString(true).includes('PARITY_ROW_0000'))return true;return false})()`),true,'hidden scrollback retains early output beyond replay cap')
      await activate(p1.id)
      await tools({type:'visible',visible:true})
      await until(()=>ui(`Boolean(document.querySelector('${host} .xterm-helper-textarea'))`),'terminal restored')
      assert.equal(await ui('parityTerminal()===originalTerm'),true)
      const result={unsavedDraftPreserved:true,nativeClipboard:true,splitReconnect:true,connectionMetadataAndFavorites:true,hyperlinks:true,terminalShortcuts:true,originalAnsiLogging:true,hiddenOutputAndOsc52:true,sourceRevision:'3de4e4a'}
      await writeFile(join(root,'result.json'),JSON.stringify(result,null,2))
      console.log('All eight parity checks passed:',JSON.stringify(result),'Evidence:',root)
    } catch (error) { console.error(error); console.log(await ui(`(()=>{const t=window.parityTerminal?.();if(!t)return null;const b=t.buffer.active;return {cols:t.cols,scrollback:t.options.scrollback,length:b.length,tail:Array.from({length:Math.min(40,b.length)},(_,i)=>b.getLine(Math.max(0,b.length-40)+i)?.translateToString(true))}})()`).catch(()=>null)); throw error } finally {
      await activate(p1.id)
      await clipboard.writeText(priorClipboard)
      for (const tab of (await action({action:'list'})).filter(tab=>!tab.parentId)) await action({action:'close',id:tab.id})
      await clipboard.writeText(priorClipboard); shell.openExternal=originalOpen; Notification.prototype.show=originalShow; dialog.showMessageBox=originalDialog
      await ssh.close()
      app.quit()
    }
  }
}
