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
    const describe = node => node instanceof Element ? node.getAttribute('aria-label') || node.getAttribute('class') || node.tagName : null;
    window.fixture.events = [];
    window.fixture.lastResizeAt = performance.now();
    for (const type of ['pointerdown', 'click', 'focusin', 'focusout']) document.addEventListener(type, event => {
      window.fixture.events.push({type, target:describe(event.target), related:describe(event.relatedTarget), focused:document.hasFocus(),connected:event.target.isConnected});
      if (window.fixture.events.length > 50) window.fixture.events.shift();
    }, true);
    window.addEventListener('resize', () => {
      window.fixture.lastResizeAt = performance.now();
      window.fixture.events.push({type:'resize',width:innerWidth,height:innerHeight});
      if (window.fixture.events.length > 50) window.fixture.events.shift();
    });
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
  const { app, BrowserWindow, Menu } = await import('electron')
  // Do not await app readiness at module scope: Electron waits for ESM
  // evaluation to finish before emitting ready.
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    const profile = await mkdtemp(join(tmpdir(), 'sidebar-projects-check-'))
    app.setPath('userData', profile)
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    let window
    let lastCommand
    const checks = []
    try {
      await app.whenReady()
      // Electron's default application menu can otherwise arrive after the
      // first render and resize the client viewport during pointer assertions.
      Menu.setApplicationMenu(null)
      window = new BrowserWindow({ width: 800, height: 600, show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
      await window.loadFile(join(artifacts, 'index.html'))
      const ui = code => { lastCommand = code; return window.webContents.executeJavaScript(code) }
      const until = async (code, label) => {
        const end = Date.now() + 10000
        while (Date.now() < end) { const value = await ui(code); if (value) return value; await delay(25) }
        const state = await ui('({focus:document.activeElement.outerHTML.slice(0,300),hasFocus:document.hasFocus(),open:!!document.querySelector(".sidebar-projects-popover"),fixture:window.fixture})')
        throw new Error(`Timed out: ${label}: ${JSON.stringify(state)}`)
      }
      const assertStable = async (code, label) => {
        // Verify settled input continuously; a close is never retried or reopened.
        const end = Date.now() + 300
        do {
          assert.equal(await ui(code), true, label)
          await delay(25)
        } while (Date.now() < end)
      }
      const click = async (selector, leftInset = null) => {
        const point = await ui(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error('Missing click target');
          element.scrollIntoView({block:'nearest'});
          const rect = element.getBoundingClientRect();
          return {x:Math.round(rect.left + (${JSON.stringify(leftInset)} ?? rect.width / 2)), y:Math.round(rect.top + rect.height / 2)};
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
      window.webContents.focus()
      await click('#outside')
      // Initial Chromium viewport delivery can lag loadFile and React mounting,
      // especially with display scaling. Flush layout while the flyout is closed
      // and wait for its client dimensions and resize events to settle.
      await ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const [initialWidth, initialHeight] = window.getContentSize()
      await until(`innerWidth === ${initialWidth} && innerHeight === ${initialHeight} && performance.now() - window.fixture.lastResizeAt >= 300`, 'initial viewport settled')
      assert.equal(await ui('document.querySelectorAll(".sidebar-projects-button").length'), 1)
      assert.equal(await ui('!!document.querySelector(".sidebar-projects-popover")'), false)

      await open()
      for (const [selector, leftInset] of [['.sidebar-projects-header strong', null], ['.sidebar-projects-popover', 3]]) {
        // Start from a focused row so the click must transfer focus safely.
        await ui('document.querySelector(".sidebar-project-choice[aria-current=true]").focus()')
        await click(selector, leftInset)
        await until('document.activeElement === document.querySelector(".sidebar-projects-popover")', `${selector} click focuses flyout`)
        await assertStable('!!document.querySelector(".sidebar-projects-popover") && window.fixture.openChanges.at(-1) === true', `${selector} click must keep flyout open`)
      }
      key('Escape')
      await closed()
      checks.push('Heading and padding clicks keep flyout open and browser obscured')

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
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, checks, bounds, electron: process.versions.electron }, null, 2))
      console.log(`Sidebar projects check passed (${checks.length} checks)`)
      window.destroy()
      await rm(profile, { recursive: true, force: true }).catch(() => {})
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error('Last renderer command:', lastCommand)
      if (window && !window.isDestroyed()) {
        const diagnostic = await window.webContents.executeJavaScript('({fixture:window.fixture, focus:document.activeElement.outerHTML.slice(0,300), hasFocus:document.hasFocus(), open:!!document.querySelector(".sidebar-projects-popover")})').catch(() => null)
        await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false, electron: process.versions.electron, error: String(error), lastCommand, diagnostic }, null, 2))
        console.error(JSON.stringify(diagnostic))
      }
      window?.destroy()
      app.exit(1)
    }
  }
}
