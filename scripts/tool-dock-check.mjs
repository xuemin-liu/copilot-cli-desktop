// Real React/xterm lifecycle and DOM layout, deterministic browser IPC boundary.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/tool-dock')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false }))
  await (await import('esbuild')).build({ entryPoints: ['scripts/fixtures/tool-dock.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: join(out, 'fixture.js') })
  await writeFile(join(out, 'index.html'), '<html><head><link rel="stylesheet" href="../../src/renderer/styles.css"><link rel="stylesheet" href="../../node_modules/@xterm/xterm/css/xterm.css"><style>#root{display:flex;height:100vh}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 90_000)
  try {
    assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) }), 0)
    assert.equal(JSON.parse(await readFile(join(out, 'result.json'), 'utf8')).passed, true)
  }
  finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow } = await import('electron')
  app.setPath('userData', join(out, 'userdata'))
  void run()
  async function run() {
  try {
    await app.whenReady()
    const win = new BrowserWindow({ width: 1500, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    await win.loadFile(join(out, 'index.html'))
    const ui = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(`${error}\nScript: ${code}`) })
    const until = async (code, label) => {
      const end = Date.now() + 10_000
      while (Date.now() < end) { if (await ui(code)) return; await delay(30) }
      throw new Error(`Timed out: ${label}\n${await ui('document.body.innerText')}`)
    }
    const click = selector => ui(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const type = (selector, text) => ui(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await until('dockTest.calls.some(c=>c.name==="bounds" && c.value)', 'browser visible')
    await ui('window.originalTerminal=document.querySelector(".xterm");window.originalBrowser=document.querySelector(".browser-panel");true')
    await type('[aria-label="Web app URL"]', 'unsubmitted address')
    await click('.browser-testing button')
    await until('document.querySelector(".browser-testing button").textContent === "Stop testing"', 'testing enabled')
    await ui('document.querySelector(".browser-pick").dispatchEvent(new MouseEvent("click",{bubbles:true,shiftKey:true}))')
    await ui('dockTest.pick("main","selected element")')
    await until('!!document.querySelector(".browser-selection input")', 'selection collected')
    await type('.browser-selection input', 'keep my note')
    await click('[data-tool="git"]')
    await until('dockTest.calls.filter(c=>c.name==="bounds").at(-1).value===null', 'browser hidden')
    const pollCount = await ui('dockTest.calls.filter(c=>c.name==="poll").length')
    await delay(1200)
    assert.equal(await ui('dockTest.calls.filter(c=>c.name==="poll").length'), pollCount, 'inactive browser does not poll')
    await type('[aria-label="Retained Git draft"]', 'draft')
    await click('[data-tool="browser"]')
    await until('dockTest.calls.filter(c=>c.name==="bounds").at(-1).value!==null', 'browser restored')
    assert.equal(await ui('document.querySelector(".browser-panel")===window.originalBrowser'), true)
    assert.equal(await ui('document.querySelector(".xterm")===window.originalTerminal'), true)
    assert.equal(await ui('document.querySelector("[aria-label=\\"Web app URL\\"]").value'), 'unsubmitted address')
    assert.equal(await ui('document.querySelector(".browser-selection input").value'), 'keep my note')
    assert.match(await ui('document.querySelector(".browser-notice").textContent'), /main: Testing stopped; Element picking stopped because the browser was hidden/)
    await until('document.querySelector(".browser-testing button").textContent === "Testing mode"', 'Testing stays disabled')
    assert.equal(await ui('dockTest.calls.filter(c=>c.name==="open"&&c.id==="main").length'), 1)
    await ui('dockTest.setObscured(true)')
    await until('dockTest.calls.filter(c=>c.name==="bounds").at(-1).value===null', 'overlay hides surface')
    await ui('dockTest.setObscured(false)')
    await until('dockTest.calls.filter(c=>c.name==="bounds").at(-1).value!==null', 'overlay dismissed')
    await click('[data-tool="git"]')
    assert.equal(await ui('document.querySelector("[aria-label=\\"Retained Git draft\\"]").value'), 'draft')
    await click('.workspace-tools-close')
    win.setContentSize(700, 700)
    await until('getComputedStyle(document.querySelector(".project-dock-main")).display!=="none"', 'collapsed dock leaves CLI visible')
    assert.equal(await ui('document.querySelector(".xterm")===window.originalTerminal'), true)
    await ui('dockTest.setPrefs({...dockTest.prefs,open:true})')
    await until('!!document.querySelector("[aria-label=\\"Back to CLI\\"]")', 'takeover has shared back button')
    await click('[aria-label="Back to CLI"]')
    await ui('localStorage.setItem("side-chat-split","25");dockTest.setPair(true)')
    await until('!!document.querySelector(".compact-session-switch")', 'single terminal fallback')
    await click('.compact-session-switch button:last-child')
    await until('document.querySelector(".session-pane-visible").getAttribute("aria-label").includes("side")', 'switch selects side terminal')
    win.setContentSize(1450, 900)
    await until('document.querySelectorAll(".session-pane-visible").length===2', 'pair restored')
    assert.equal(await ui('localStorage.getItem("side-chat-split")'), '25', 'render clamp never changes preference')
    await ui('dockTest.setActive("main");dockTest.setPrefs({...dockTest.prefs,open:true,tool:"browser"})')
    await until('document.querySelector("[aria-label=\\"Browser session\\"]").value==="main"', 'browser on main')
    await ui('dockTest.setActive("side")')
    await delay(100)
    assert.equal(await ui('document.querySelector("[aria-label=\\"Browser session\\"]").value'), 'main', 'side focus does not change browser')
    await ui('dockTest.setPopouts(["main"])')
    await until('dockTest.calls.filter(c=>c.name==="bounds").at(-1).value===null', 'pop-out releases dock surface')
    await ui('dockTest.setPopouts([]);dockTest.setActive("other")')
    await until('dockTest.calls.some(c=>c.name==="bounds"&&c.id==="other"&&c.value)', 'other session browser')
    await ui('dockTest.setActive("main")')
    await until('document.querySelector("[aria-label=\\"Browser session\\"]").value==="main"', 'main browser restored')
    assert.equal(await ui('dockTest.calls.filter(c=>c.name==="open"&&c.id==="main").length'), 1)
    await ui('dockTest.setProfile("general");dockTest.setPrefs({...dockTest.prefs,tool:"git"})')
    await until('document.querySelector("[data-tool=git]").disabled', 'Git disabled in general workspace')
    assert.match(await ui('document.body.innerText'), /Git is unavailable/)
    await writeFile(join(out, 'layout.png'), (await win.webContents.capturePage()).toPNG())
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, calls: await ui('dockTest.calls') }, null, 2))
    console.log('Tool dock: terminal/browser lifetime, drafts, cancellation notices, overlays, focus, narrow layout, disabled tools passed.')
    app.quit()
  } catch (error) { console.error(error); app.exit(1) }
  }
}
