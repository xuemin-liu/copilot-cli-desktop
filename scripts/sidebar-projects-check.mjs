// Exercise the real Sidebar with isolated Electron windows and native input.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/sidebar-projects-check')
const delay = ms => new Promise(accept => setTimeout(accept, ms))

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  await build({ stdin: { contents: `
    import { createRoot } from 'react-dom/client';
    import { useState } from 'react';
    import { Sidebar } from './src/renderer/components/Sidebar';
    import './src/renderer/styles.css';
    const profiles = Array.from({length: 25}, (_, index) => ({
      id: 'project-' + index, name: 'Project ' + index, path: 'D:/projects/project-' + index,
      permissionPreset: 'default', defaultResumeMode: 'new', launch: {}, tabs: []
    }));
    const noop = () => {};
    window.fixture = { calls: [], openChanges: [], errors: [] };
    window.addEventListener('error', event => window.fixture.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.fixture.errors.push(String(event.reason)));
    const recordOpen = open => window.fixture.openChanges.push(open);
    function Fixture() {
      const [collapsed, setCollapsed] = useState(true);
      window.setCollapsed = setCollapsed;
      return <>
        <Sidebar profiles={profiles} tabs={[]} activeProfileId="project-1" activeTabId={null}
          installedCliVersion={null} canOpenTab collapsed={collapsed}
          onProjectsOpenChange={recordOpen} onToggleCollapsed={() => setCollapsed(value => !value)}
          onSelectWorkspace={() => window.fixture.calls.push('add')}
          onActivateProfile={id => window.fixture.calls.push('activate:' + id)}
          onCreateTab={id => window.fixture.calls.push('create:' + id)}
          onActivateTab={noop} onPopOutTab={noop} onRenameTab={noop} onCloseTab={noop}
          onRestartTab={noop} onCreateTabWithAttachments={noop} onResumePicker={noop}
          onConnectRemote={noop} onOpenSettings={noop} />
        <button id="outside" style={{position:'fixed',left:500,top:20}}>Outside</button>
      </>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', jsx: 'automatic',
    outfile: join(artifacts, 'fixture.js') })
  await writeFile(join(artifacts, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root" style="display:flex;height:100vh"></div><script src="fixture.js"></script></body></html>')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 90000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Sidebar integration check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow } = await import('electron')
  // Do not await app readiness at module scope: Electron waits for ESM
  // evaluation to finish before emitting ready.
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    const profile = await mkdtemp(join(tmpdir(), 'sidebar-projects-check-'))
    app.setPath('userData', profile)
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    let window
    const checks = []
    try {
      await app.whenReady()
      window = new BrowserWindow({ width: 800, height: 600, show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
      await window.loadFile(join(artifacts, 'index.html'))
      // A hidden renderer needs focus for native Tab traversal to emit focus events.
      window.webContents.focus()
      const ui = code => window.webContents.executeJavaScript(code)
      const until = async (code, label) => {
        const end = Date.now() + 10000
        while (Date.now() < end) { const value = await ui(code); if (value) return value; await delay(25) }
        const state = await ui('({focus:document.activeElement.outerHTML.slice(0,300),hasFocus:document.hasFocus(),open:!!document.querySelector(".sidebar-projects-popover"),fixture:window.fixture})')
        throw new Error(`Timed out: ${label}: ${JSON.stringify(state)}`)
      }
      const click = async selector => {
        const point = await ui(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error('Missing click target');
          element.scrollIntoView({block:'nearest'});
          const rect = element.getBoundingClientRect();
          return {x:Math.round(rect.left + rect.width / 2), y:Math.round(rect.top + rect.height / 2)};
        })()`)
        window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
      }
      const key = (keyCode, modifiers = []) => {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        if (keyCode === 'Tab') window.webContents.sendInputEvent({ type: 'char', keyCode: '\t', modifiers })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      }
      const open = async () => {
        await click('.sidebar-projects-button')
        await until('!!document.querySelector(".sidebar-projects-popover") && window.fixture.openChanges.at(-1) === true && document.activeElement.getAttribute("aria-label") === "Project 1"', 'flyout open and active project focused')
      }
      const closed = async () => {
        await until('!document.querySelector(".sidebar-projects-popover") && window.fixture.openChanges.at(-1) === false', 'flyout closed and unobscured callback reported')
      }
      await until('!!document.querySelector(".sidebar-projects-button")', 'fixture ready')
      assert.equal(await ui('document.querySelectorAll(".sidebar-projects-button").length'), 1)
      assert.equal(await ui('!!document.querySelector(".sidebar-projects-popover")'), false)

      await open()
      key('Escape')
      await closed()
      assert.equal(await ui('document.activeElement.classList.contains("sidebar-projects-button")'), true)
      checks.push('Escape closes and restores trigger focus')

      await open()
      await click('#outside')
      await closed()
      checks.push('Outside pointer closes and reports unobscured')

      for (const [selector, call] of [
        ['.sidebar-project-choice[aria-label="Project 2"]', 'activate:project-2'],
        ['.sidebar-project-row button[aria-label="New session in Project 2"]', 'create:project-2'],
        ['.sidebar-project-add', 'add'],
      ]) {
        await ui('window.fixture.calls.length = 0')
        await open()
        await click(selector)
        await closed()
        assert.deepEqual(await ui('window.fixture.calls'), [call])
      }
      checks.push('Project, new-session and add actions fire once and close')

      await open()
      // Moving within the flyout or back to the trigger must not close it.
      await ui('document.querySelector(".sidebar-projects-button").focus()')
      assert.equal(await ui('!!document.querySelector(".sidebar-projects-popover")'), true)
      await ui('document.querySelector(".sidebar-project-add").focus()')
      key('Tab')
      await closed()
      assert.equal(await ui('!!document.activeElement.closest(".sidebar-projects-popover")'), false)
      checks.push('Tab leaving flyout dismisses it without stealing focus')

      await open()
      await ui('document.querySelector(".sidebar-projects-header button").focus()')
      key('Tab', ['shift'])
      await closed()
      checks.push('Shift+Tab leaving flyout dismisses it')

      await open()
      window.setSize(800, 300)
      await closed()
      checks.push('Resize dismisses flyout')
      await open()
      const bounds = await ui(`(() => {
        const popover = document.querySelector('.sidebar-projects-popover').getBoundingClientRect();
        const add = document.querySelector('.sidebar-project-add').getBoundingClientRect();
        const list = document.querySelector('.sidebar-projects-list');
        return {left:popover.left,right:popover.right,top:popover.top,bottom:popover.bottom,
          addBottom:add.bottom,width:innerWidth,height:innerHeight,scrolls:list.scrollHeight > list.clientHeight};
      })()`)
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height)
      assert.ok(bounds.addBottom <= bounds.height && bounds.scrolls)
      await ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await writeFile(join(artifacts, 'small-viewport.png'), (await window.webContents.capturePage()).toPNG())
      checks.push('Small viewport keeps flyout and Add project visible with scrolling')

      await ui('window.setCollapsed(false)')
      await closed()
      assert.equal(await ui('document.querySelectorAll(".sidebar-projects-button").length'), 0)
      checks.push('Expanding sidebar dismisses flyout and reports unobscured')
      assert.deepEqual(await ui('window.fixture.errors'), [])
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, checks, bounds }, null, 2))
      console.log(`Sidebar projects check passed (${checks.length} checks)`)
      window.destroy()
      await rm(profile, { recursive: true, force: true }).catch(() => {})
      app.exit(0)
    } catch (error) {
      console.error(error)
      window?.destroy()
      app.exit(1)
    }
  }
}
