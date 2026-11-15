import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/myterminal-background-app')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 120_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, Notification, dialog } = await import('electron')
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
    const ui = code => Promise.race([win.webContents.executeJavaScript(code, true), delay(15000).then(() => { throw new Error(`Renderer call timed out: ${code}`) })])
    await until(() => ui('Boolean(document.querySelector(".session-pane"))'), 'full app renderer')
    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.unloadTab(tab.id)})()')
    const notifications = [], originalShow = Notification.prototype.show, originalDialog = dialog.showMessageBox
    Notification.prototype.show = function () { notifications.push({ title: this.title, body: this.body }); originalShow.call(this); setTimeout(() => this.close(), 500) }
    dialog.showMessageBox = (...args) => args.at(-1)?.title === 'Trust SSH host?' ? Promise.resolve({ response: 1 }) : originalDialog(...args)
    const { fixture } = await import('./myterminal-ssh-fixture.mjs')
    const ssh = await fixture()
    console.log('Full app and SSH fixture ready')
    const action = request => ui(`window.copilotDesktop.toolTerminal(${JSON.stringify(p1.id)},${JSON.stringify(request)})`)
    const tools = request => ui(`window.copilotDesktop.toolsAction(${JSON.stringify(p1.id)},${JSON.stringify(request)})`)
    const activate = id => ui(`window.copilotDesktop.activateProfile(${JSON.stringify(id)})`)
    try {
      await ui(`window.copilotDesktop.myTerminal(${JSON.stringify(p1.id)},'sessions:save',[${JSON.stringify({id:'background-test',name:'Background SSH',host:'127.0.0.1',port:ssh.port,username:'tester',password:'secret',authType:'password'})}])`)
      console.log('Connection saved')
      const terminal = await action({ action:'create',kind:'ssh',config:{transport:'managed',connectionId:'background-test',host:'127.0.0.1'} })
      const id = terminal.id
      console.log('Terminal created', id)
      await until(() => ssh.shells === 1, 'SSH connected')
      await until(() => ui('Boolean(document.querySelector(".terminal-toolbar"))'), 'original terminal component')
      const first = await action({action:'read',id})
      // Leave another tab selected and the entire app unfocused.
      await tools({type:'add',kind:'git'})
      win.hide()
      await until(() => !win.isFocused(), 'app unfocused')
      ssh.broadcast('\x07BACKGROUND_BELL\r\n')
      await until(() => notifications.length === 1, 'inactive terminal native bell notification')
      ssh.broadcast('\x07\x07')
      await delay(400)
      assert.equal(notifications.length,1,'original five-second notification cooldown')
      ssh.disconnect()
      await until(async () => { const s=await action({action:'read',id}); return s.status==='running' && s.generation!==first.generation }, 'inactive tab reconnect')
      const second = await action({action:'read',id})
      // Hiding the panel and switching projects must not stop its live lifecycle.
      await tools({type:'visible',visible:false})
      await activate(p2.id)
      win.hide()
      await until(() => ssh.shells===1, 'one reconnected shell')
      ssh.broadcast('\x07OTHER_PROJECT_BELL\r\n')
      await until(() => notifications.length===2, 'other project native bell notification')
      ssh.disconnect()
      await until(() => ssh.shells===0, 'server disconnected')
      await until(() => ssh.shells===1, 'hidden other-project SSH reconnect')
      await assert.rejects(action({action:'write',id,text:'WRONG_PROJECT'}),/current project/,'CLI/renderer input authorization remains scoped')
      await activate(p1.id)
      const third=await action({action:'read',id})
      assert.notEqual(third.generation,second.generation)
      // A cancelled retry and a closed tab must never reconnect later.
      ssh.disconnect()
      await until(async()=> (await action({action:'read',id})).reconnectCountdown>0,'pending retry')
      await action({action:'cancel-reconnect',id})
      await delay(5500)
      assert.equal(ssh.shells,0,'cancel prevents reconnect')
      await action({action:'restart',id})
      await until(()=>ssh.shells===1,'manual reconnect')
      ssh.disconnect()
      await until(async()=> (await action({action:'read',id})).reconnectCountdown>0,'retry before close')
      await action({action:'close',id})
      await delay(5500)
      assert.equal(ssh.shells,0,'closing tab cancels retry')
      const local = await action({action:'create',kind:'local'})
      await tools({type:'visible',visible:false})
      win.hide()
      const bellCommand = process.platform==='win32' ? '[Console]::Write([char]7)\r' : "printf '\\a'\r"
      await action({action:'write',id:local.id,text:bellCommand})
      await until(()=>notifications.length===3,'hidden local terminal native bell')
      win.show(); win.focus()
      await until(()=>win.isFocused(),'app focused')
      const foreground = await action({action:'create',kind:'local'})
      await action({action:'write',id:foreground.id,text:bellCommand})
      await until(async()=>(await action({action:'read',id:foreground.id})).output.includes('\x07'),'foreground shell emitted bell')
      assert.equal(notifications.length,3,'focused app suppresses native bells')
      await writeFile(join(root,'result.json'),JSON.stringify({passed:true,notifications,checks:['native inactive-tab bell','cooldown','inactive-tab SSH retry','hidden panel and other-project bell/retry','current-project input guard','cancel retry','close cancels retry','hidden local bell','focused bell suppressed']},null,2))
      await writeFile(join(root,'app.png'),(await win.webContents.capturePage()).toPNG())
      console.log('Full-app background terminal checks passed:',root)
    } catch (error) { console.error(error); throw error } finally {
      await activate(p1.id)
      for (const tab of await action({action:'list'})) await action({action:'close',id:tab.id})
      Notification.prototype.show=originalShow; dialog.showMessageBox=originalDialog
      await ssh.close()
      app.quit()
    }
  }
}
