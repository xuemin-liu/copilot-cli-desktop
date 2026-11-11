// The notice over a terminal whose session has no process, in real Electron with the real SessionWorkspace, xterm
// and styles. Only the desktop API is a stand-in. It covers what a static render cannot: who has the keyboard, Enter
// on the button, the split view, and the bar that leaves old output in view.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/stopped-notice')
const delay = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  await build({
    stdin: { contents: `
      import { createRoot } from 'react-dom/client';
      import { useState } from 'react';
      import { SessionWorkspace } from './src/renderer/components/SessionWorkspace';
      import './src/renderer/styles.css';
      import '@xterm/xterm/css/xterm.css';
      const outputListeners = new Set();
      window.calls = [];
      window.pushOutput = (tabId, data) => outputListeners.forEach(listener => listener({ tabId, data, sequence: Date.now() }));
      const api = {
        getTabSnapshot: async () => ({ data: '', sequence: 0 }),
        onTabOutput: listener => { outputListeners.add(listener); return () => outputListeners.delete(listener); },
        resizeTab: async () => {},
        writeTab: async (tabId, data) => { window.calls.push({ type: 'write', tabId, data }); return {}; },
      };
      window.copilotDesktop = new Proxy(api, { get: (target, name) => target[name]
        ?? (String(name).startsWith('on') ? () => () => {} : () => new Promise(() => {})) });
      const tab = (id, status, extra = {}) => ({ id, title: id, status, processId: status === 'running' ? 1 : null, remote: false, ...extra });
      function Fixture() {
        const [state, setState] = useState({ tabs: [tab('one', 'dormant'), tab('two', 'dormant')], activeTabId: 'one', poppedOut: [] });
        window.setFixture = change => setState(current => ({ ...current, ...change }));
        window.setStatus = (id, status, extra) => setState(current => ({ ...current, tabs: current.tabs.map(item => item.id === id ? tab(id, status, { ...item, ...extra, status, processId: status === 'running' ? 1 : null }) : item) }));
        window.addTab = (id, status, extra) => setState(current => ({ ...current, tabs: [...current.tabs, tab(id, status, extra)] }));
        return <>
          <input id="outside" aria-label="A field outside the session" style={{ position: 'fixed', top: 4, right: 140, zIndex: 50, width: 120 }} />
          <SessionWorkspace tabs={state.tabs} activeTabId={state.activeTabId} canOpenTab poppedOutTabIds={state.poppedOut}
            onActivate={activeTabId => setState(current => ({ ...current, activeTabId }))} onCreate={() => {}} onFork={() => {}} onClose={() => {}}
            onRestart={tabId => window.calls.push({ type: 'restart', tabId })} onShowLog={tabId => window.calls.push({ type: 'log', tabId })} />
        </>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, outfile: join(artifacts, 'fixture.js'), platform: 'browser', jsx: 'automatic',
  })
  await writeFile(join(artifacts, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root" style="display:flex;height:100vh"></div><script src="fixture.js"></script></body></html>')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
    assert.equal(code, 0, 'Electron stopped-notice check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true, 'Every check must finish before Electron exits')
  } finally { clearTimeout(timeout) }
} else {
  const { app, BrowserWindow } = await import('electron')
  app.setPath('userData', join(artifacts, 'user-data'))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const window = new BrowserWindow({ width: 1000, height: 560, show: false, webPreferences: { backgroundThrottling: false } })
    window.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message) })
    const ui = code => window.webContents.executeJavaScript(code)
    const until = async (read, label) => {
      const end = Date.now() + 5_000
      while (Date.now() < end) {
        const value = await read()
        if (value) return value
        await delay(50)
      }
      throw new Error('Timed out: ' + label)
    }
    const shot = async name => { await delay(200); await writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG()) }
    const key = async keyCode => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      if (keyCode.length === 1 || keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      await delay(100)
    }
    // What the pane of one tab shows, and where the keyboard is.
    const pane = id => ui(`(() => {
      const pane = document.querySelector('section[aria-label$=": ${id}"]');
      const notice = pane.querySelector('.session-stopped-notice');
      const active = document.activeElement;
      const box = element => { const rect = element?.getBoundingClientRect(); return rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) } : null; };
      return {
        heading: notice?.querySelector('.session-stopped-heading')?.textContent ?? null,
        layout: notice ? (notice.classList.contains('session-stopped-bar') ? 'bar' : 'card') : null,
        buttons: Array.from(notice?.querySelectorAll('button') ?? []).map(button => button.textContent),
        focus: !pane.contains(active) ? 'elsewhere' : active.closest('.session-stopped-notice') ? 'notice:' + active.textContent : active.closest('.xterm') ? 'terminal' : 'pane',
        notice: box(notice), terminal: box(pane.querySelector('.terminal-pane')),
        placeholder: pane.querySelector('.empty-state')?.textContent ?? null,
      };
    })()`)
    const calls = () => ui('window.calls.splice(0)')
    const done = []
    try {
      window.show()
      window.focus()
      await window.loadFile(join(artifacts, 'index.html'))
      await until(() => ui('document.querySelectorAll(".xterm").length === 2'), 'terminals')

      // 1. A not-running session selected at launch: a card over the empty terminal, and Enter resumes.
      let one = await until(async () => { const view = await pane('one'); return view.focus.startsWith('notice') && view }, 'Resume has the keyboard')
      assert.equal(one.heading, 'This session is not running')
      assert.equal(one.layout, 'card')
      assert.deepEqual(one.buttons, ['Resume session'])
      assert.equal(one.focus, 'notice:Resume session')
      await shot('01-not-running')
      await key('Enter')
      assert.deepEqual(await calls(), [{ type: 'restart', tabId: 'one' }], 'Enter on the notice resumes the session')
      done.push('not-running card, Enter resumes')

      // 2. Starting says so without a button; once it runs the notice goes and the terminal has the keyboard.
      await ui('window.setStatus("one", "starting")')
      one = await until(async () => { const view = await pane('one'); return view.heading === 'Starting…' && view }, 'starting')
      assert.deepEqual(one.buttons, [])
      await shot('02-starting')
      await ui('window.setStatus("one", "running")')
      await ui('window.pushOutput("one", "first line of output\\r\\nsecond line\\r\\n")')
      one = await until(async () => { const view = await pane('one'); return view.heading === null && view.focus === 'terminal' && view }, 'running terminal has the keyboard')
      await key('a')
      assert.deepEqual(await calls(), [{ type: 'write', tabId: 'one', data: 'a' }], 'typing reaches the session without another click')
      const fullHeight = one.terminal.height
      done.push('starting, then the terminal takes the keyboard')

      // 3. It crashes while the person is in its terminal: a bar under the output, which stays whole.
      await ui('window.setStatus("one", "crashed")')
      one = await until(async () => { const view = await pane('one'); return view.layout === 'bar' && view.focus.startsWith('notice') && view }, 'crashed bar')
      assert.equal(one.heading, 'This session stopped unexpectedly')
      assert.deepEqual(one.buttons, ['Restart session', 'Show log'])
      assert.equal(one.terminal.bottom, one.notice.top, 'the terminal ends where the bar begins, so no output is covered')
      assert.equal(one.terminal.height, fullHeight - one.notice.height)
      assert.equal(await ui('document.querySelector(\'section[aria-label$=": one"] .xterm-rows\').textContent.includes("second line")'), true)
      await shot('03-crashed-with-output')
      await key('a')
      assert.deepEqual(await calls(), [], 'typing does not reach a stopped session')
      await ui('Array.from(document.querySelectorAll(\'section[aria-label$=": one"] .session-stopped-notice button\')).find(button => button.textContent === "Show log").click()')
      assert.deepEqual(await calls(), [{ type: 'log', tabId: 'one' }])
      // A start that fails goes from starting back to crashed.
      await ui('window.setStatus("one", "starting")')
      await until(async () => (await pane('one')).heading === null, 'a restarting session with output shows no bar')
      await ui('window.setStatus("one", "crashed")')
      await until(async () => (await pane('one')).heading === 'This session stopped unexpectedly', 'failed start')
      done.push('crashed bar under kept output, Show log, failed start')

      // 4. A session that stops while the person types somewhere else does not take the keyboard from them.
      await ui('window.setStatus("one", "running")')
      await until(async () => (await pane('one')).focus === 'terminal', 'running again')
      await ui('document.getElementById("outside").focus()')
      await ui('window.setStatus("one", "completed")')
      one = await until(async () => { const view = await pane('one'); return view.heading === 'This session has ended' && view }, 'completed')
      assert.deepEqual(one.buttons, ['Restart session'])
      assert.equal(one.focus, 'elsewhere')
      assert.equal(await ui('document.activeElement.id'), 'outside')
      done.push('no focus taken from another field')

      // 5. Selecting another not-running tab gives its button the keyboard.
      await ui('window.setFixture({ activeTabId: "two" })')
      const two = await until(async () => { const view = await pane('two'); return view.focus === 'notice:Resume session' && view }, 'selected tab')
      assert.equal(two.layout, 'card')
      done.push('selecting a tab focuses its button')

      // 6. Split view: only the focused pane's button has the keyboard, and a running pane keeps its terminal.
      await ui('window.addTab("side", "dormant", { sideChat: true, sideParentTabId: "two" })')
      await until(async () => (await pane('side')).heading === 'This session is not running', 'side chat notice')
      assert.equal((await pane('two')).focus, 'notice:Resume session')
      assert.equal((await pane('side')).focus, 'elsewhere')
      await shot('04-split-both-stopped')
      await ui('window.setStatus("two", "running")')
      await until(async () => (await pane('two')).focus === 'terminal', 'running main pane beside a stopped side chat')
      assert.equal((await pane('side')).focus, 'elsewhere')
      await ui('window.setFixture({ activeTabId: "side" })')
      await until(async () => (await pane('side')).focus === 'notice:Resume session', 'focused side chat')
      await shot('05-split-side-focused')
      done.push('split view focus')

      // 7. A remote session whose connection ended has nothing to press; one that is connecting says Starting.
      await ui('window.setFixture({ activeTabId: "one" })')
      await ui('window.setStatus("one", "crashed", { remote: true })')
      one = await until(async () => { const view = await pane('one'); return view.heading === 'The connection to this remote session ended' && view }, 'remote')
      assert.deepEqual(one.buttons, [])
      await shot('06-remote')
      done.push('remote connection ended')

      // 8. A popped-out session shows no notice in the main window, whatever its status.
      await ui('window.setFixture({ poppedOut: ["one"] })')
      for (const status of ['dormant', 'crashed', 'completed', 'starting']) {
        await ui(`window.setStatus("one", "${status}", { remote: false })`)
        one = await until(async () => { const view = await pane('one'); return view.placeholder && view }, 'popped-out placeholder')
        assert.equal(one.heading, null, `no notice for a popped-out ${status} session`)
        assert.match(one.placeholder, /open in another window/)
      }
      done.push('popped-out sessions have no notice')

      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, checks: done }, null, 2))
      console.log('PASS: stopped-session notice (' + done.join('; ') + ')')
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ done, one: await pane('one').catch(() => null) }))
      await writeFile(join(artifacts, 'failure.png'), (await window.webContents.capturePage()).toPNG())
      process.exitCode = 1
    } finally {
      window.destroy()
      app.exit(process.exitCode ?? 0)
    }
  }
}
