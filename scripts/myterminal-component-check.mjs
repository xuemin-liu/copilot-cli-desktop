import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/myterminal-component')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'fixture.jsx'), `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import TerminalTab from '../../vendor/myterminal/renderer.mjs';
    const writes=[]; const sizes=[]; let term;
    const store=Object.assign(()=>({settings:{defaultFontSize:14,defaultScrollback:1000,colorizeByDefault:true,osc52ClipboardEnabled:true}}),{getState:()=>({broadcastMode:false})});
    const api={platform:'linux',local:{spawn:async()=>({}),write:(_id,text)=>writes.push(text),resize:(_id,cols,rows)=>sizes.push({cols,rows}),disconnect(){}},
      ssh:{onData:()=>()=>{},onClose:()=>()=>{},onError:()=>()=>{}},filterPresets:{getAll:async()=>[]},
      clipboard:{writeText:text=>navigator.clipboard.writeText(text)},tunnel:{stopByChannel(){}},notify:{send(){}}};
    const host={api,store,isActive:()=>true,onTerminal:t=>{term=t}};
    createRoot(document.getElementById('root')).render(<TerminalTab tab={{id:'test',channelId:'test',isLocal:true,label:'test'}} isActive host={host}/>);
    window.fixture={writes,sizes,get term(){return term}};
  `)
  await build({ entryPoints: [join(out, 'fixture.jsx')], outfile: join(out, 'fixture.js'), bundle: true, platform: 'browser', jsx: 'automatic' })
  await writeFile(join(out, 'index.html'), '<link rel="stylesheet" href="fixture.css"><link rel="stylesheet" href="../../dist/src/renderer/myterminal.css"><style>html,body,#root{height:100%;margin:0}#root{width:600px}</style><div id="root" class="myterminal-embedded"></div><script src="fixture.js"></script>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 60_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }), 0) }
  finally { clearTimeout(timer) }
} else {
  void run()
  async function run() {
  const { app, BrowserWindow, clipboard } = await import('electron')
  app.setPath('userData', join(out, `profile-${Date.now()}`))
  await app.whenReady()
  const win = new BrowserWindow({ width: 700, height: 500, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const prior = await clipboard.readText()
  try {
    await win.loadFile(join(out, 'index.html'))
    win.focus()
    const ui = code => Promise.race([win.webContents.executeJavaScript(code, true), delay(5000).then(()=>{throw new Error('Timed out: '+code)})])
    for (let i = 0; i < 100 && !await ui('Boolean(window.fixture?.term)'); i++) await delay(25)
    assert.ok(await ui('Boolean(window.fixture?.term)'))
    await ui(`fixture.term.input('??');`)
    assert.deepEqual(await ui('fixture.writes.splice(0)'), ['??'], 'question marks reach the channel without AI interception')
    await ui(`new Promise(resolve=>fixture.term.write('\x1b[?2004h',resolve))`)
    await clipboard.writeText('first line\nsecond line')
    await ui(`document.querySelector('.terminal-wrapper > div').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:50,clientY:50}));`)
    await delay(50)
    await ui(`[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent==='Paste').click()`)
    await delay(150)
    assert.deepEqual(await ui('fixture.writes.splice(0)'), ['\x1b[200~first line\rsecond line\x1b[201~'], 'context menu uses xterm bracketed paste')
    assert.ok(await ui(`document.activeElement===fixture.term.textarea`), 'paste restores terminal focus')
    await ui(`new Promise(resolve=>fixture.term.write('\x1b]52;c;T1NDNTJfT0s=\x07',resolve))`)
    await delay(100)
    assert.equal(await clipboard.readText(), 'OSC52_OK', 'upstream opt-in OSC52 handler writes decoded clipboard text')
    const cols = await ui('fixture.term.cols')
    await ui(`document.getElementById('root').style.display='none'`); await delay(100)
    assert.equal(await ui('fixture.term.cols'), cols, 'hidden container cannot collapse terminal columns')
    await ui(`document.getElementById('root').style.display=''`); await delay(100)
    assert.ok((await ui('fixture.sizes')).every(size => size.cols > 2), 'no zero-size PTY resize')
    console.log('MyTerminal component regression check passed: question marks, bracketed paste, focus, OSC52, hidden resize.')
    await clipboard.writeText(prior); app.exit(0)
  } catch (error) { console.error(error); await clipboard.writeText(prior); app.exit(1) }
  }
}
