// Real Electron IPC/preload, React and xterm mouse-click regression. Only the
// main handlers are fixtures; file resolution is covered by main-lifecycle tests.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/terminal-links')
const delay = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  await build({
    stdin: { contents: `
      import { createRoot } from 'react-dom/client';
      import { StrictMode, useState } from 'react';
      import { TerminalPane } from './src/renderer/components/TerminalPane';
      import { SessionStoppedNotice } from './src/renderer/components/SessionStoppedNotice';
      import './src/renderer/styles.css';
      import '@xterm/xterm/css/xterm.css';
      window.unhandled = [];
      window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason)));
      function Fixture() {
        const [active, setActive] = useState(true);
        window.setActive = setActive;
        return <div className="session-terminal session-terminal-with-bar" style={{ height: '100vh' }}>
          <TerminalPane tabId="tab-1" active={active} sessionProcessId={1} />
          <SessionStoppedNotice tab={{ status: 'crashed', remote: false }} hasText focused={false} onRestart={() => { window.restarted = true; }} onShowLog={() => {}} />
        </div>;
      }
      createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, outfile: join(artifacts, 'fixture.js'), platform: 'browser', jsx: 'automatic',
  })
  await writeFile(join(artifacts, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timeout = setTimeout(() => child.kill(), 120_000)
  try {
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
    assert.equal(code, 0, 'Electron link check failed')
  } finally { clearTimeout(timeout) }
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  app.setPath('userData', join(artifacts, 'user-data'))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const calls = []
    let mode = 'missing'
    let rejectPending
    // What the terminal sent to the session process. The history turns mouse reporting on, as Copilot does.
    const written = []
    const leftButton = data => { const report = /^\u001b\[<(\d+);\d+;\d+[Mm]$/.exec(data); return Boolean(report) && (Number(report[1]) & 99) === 0 }
    ipcMain.handle('desktop:get-tab-snapshot', () => ({ sequence: 0, data: '\u001b[?1003h\u001b[?1006h' + [
      'https://example.com/', 'src/missing.txt', '`./folder with spaces/example.txt`', '`node dist/src/cli/cli.js`', 'src/app.ts:42:7 - error', String.raw`"C:\My Repo\lib\file.ts:9:3" failed`,
    ].join('\r\n') }))
    // Every size the terminal reported to the session process. A size change makes the CLI redraw its whole screen.
    const sizes = []
    ipcMain.handle('desktop:resize-tab', (_event, _tabId, cols, rows) => { sizes.push(`${cols}x${rows}`) })
    ipcMain.handle('desktop:write-tab', (_event, _tabId, data) => { written.push(data); return { gitCursorContextAttached: false } })
    ipcMain.handle('desktop:open-external-url', (_event, url) => { calls.push({ type: 'url', text: url }) })
    ipcMain.handle('desktop:open-file', async (_event, source, text, location) => {
      calls.push({ type: 'path', tabId: source.tabId, text, ...(location && Object.keys(location).length ? { location } : {}) })
      if (mode === 'missing') return { ok: false, reason: 'missing' }
      if (mode === 'outside') return { ok: false, reason: 'outside-workspace' }
      if (mode === 'throw') throw new Error('Fixture reveal failure')
      // An answered error whose text happens to end the way a progress notice does.
      if (mode === 'throw-ellipsis') throw new Error('Still waiting…')
      if (mode === 'pending') await new Promise((_, reject) => { rejectPending = reject })
      return { ok: true }
    })
    const window = new BrowserWindow({ width: 900, height: 500, show: false, webPreferences: {
      backgroundThrottling: false, preload: resolve('src/preload/preload.cjs'),
    } })
    window.webContents.on('console-message', details => {
      if (details.level === 'error') console.error(details.message)
    })
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
    const notice = () => ui('document.querySelector(".terminal-link-error")?.textContent ?? null')
    const locate = async text => {
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 })
      await delay(100)
      const point = await ui(`(() => {
        const text = ${JSON.stringify(text)};
        const row = Array.from(document.querySelectorAll('.xterm-rows > div')).find(row => row.textContent.includes(text));
        if (!row) throw new Error('Missing row: ' + text);
        let offset = row.textContent.indexOf(text) + 3;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (offset < node.length) {
            const range = document.createRange();
            range.setStart(node, offset); range.setEnd(node, offset + 1);
            const box = range.getBoundingClientRect();
            return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
          }
          offset -= node.length;
        }
        throw new Error('No link coordinates');
      })()`)
      // Cross a cell boundary, like a physical pointer, after a notice resize.
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 12, y: point.y })
      await delay(50)
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      await delay(150)
      return point
    }
    const clickLink = async (text, modifiers = []) => {
      const point = await locate(text)
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, modifiers, ...point })
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, modifiers, ...point })
      await delay(100)
    }
    try {
      window.showInactive()
      await window.loadFile(join(artifacts, 'index.html'))
      await until(() => ui('document.querySelector(".xterm-rows")?.textContent.includes("folder with spaces")'), 'terminal output')
      await delay(300)
      // From here on nothing changes the window, so nothing may change the terminal's size: not a click, not a notice.
      const size = sizes.at(-1)
      assert.ok(size, 'the terminal reported its size once it was laid out')
      const terminalBox = () => ui('(() => { const r = document.querySelector(".terminal-viewport").getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height), Math.round(r.width)].join() })()')
      const box = await terminalBox()
      sizes.length = 0
      await clickLink('https://example.com/')
      assert.deepEqual(calls.pop(), { type: 'url', text: 'https://example.com/' })
      await clickLink('src/missing.txt')
      assert.match(await until(notice, 'missing-file notice'), /File or folder not found or inaccessible: src\/missing.txt/)
      assert.equal(await ui('document.querySelector(".terminal-link-error").getAttribute("role")'), 'status')
      assert.equal(await ui(`(() => {
        const element = document.querySelector('.terminal-link-error');
        const rect = element.getBoundingClientRect();
        const terminal = document.querySelector('.terminal-viewport').getBoundingClientRect();
        const restart = document.querySelector('.session-stopped-actions .primary-button');
        const button = restart.getBoundingClientRect();
        const dismiss = element.querySelector('button').getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && Math.abs(rect.top - terminal.top) <= 1 && rect.bottom < terminal.bottom && terminal.height > 0
          && element.contains(document.elementFromPoint(dismiss.x + dismiss.width / 2, dismiss.y + dismiss.height / 2))
          && !element.contains(document.elementFromPoint(rect.x + 5, rect.y + 5))
          && restart.contains(document.elementFromPoint(button.x + 5, button.y + 5));
      })()`), true, 'notice must lie over the top of the terminal, take the pointer only on its dismiss button, and leave restart clickable')
      assert.equal(await terminalBox(), box, 'a notice takes no space from the terminal')
      await delay(250)
      await writeFile(join(artifacts, 'missing-file-error.png'), (await window.webContents.capturePage()).toPNG())
      await ui('document.querySelector(".terminal-link-error button").click()')
      await until(async () => (await notice()) === null, 'dismissed notice')
      mode = 'outside'
      await clickLink('src/missing.txt')
      assert.match(await until(notice, 'workspace error'), /within the session workspace/)
      assert.equal(await ui('document.querySelector(".terminal-link-error").getAttribute("role")'), 'alert')
      // The notice lies over the first rows, so it leaves by itself: the link under it can be clicked again.
      await delay(6500)
      assert.match(await notice(), /within the session workspace/, 'still shown after a few seconds')
      await until(async () => (await notice()) === null, 'the notice leaves by itself')
      mode = 'throw'
      await clickLink('src/missing.txt')
      assert.equal(await until(notice, 'IPC error'), 'Could not open file: Fixture reveal failure×')
      // An answered error leaves by itself whatever its text ends with; only a pending open stays.
      mode = 'throw-ellipsis'
      await clickLink('src/missing.txt')
      assert.equal(await until(notice, 'IPC error ending in an ellipsis'), 'Could not open file: Still waiting…×')
      await delay(6500)
      await until(async () => (await notice()) === null, 'an answered error ending in an ellipsis still leaves by itself')
      mode = 'success'
      await clickLink('./folder with spaces/example.txt')
      assert.deepEqual(calls.pop(), { type: 'path', tabId: 'tab-1', text: './folder with spaces/example.txt' })
      assert.equal(await notice(), null)
      await clickLink('dist/src/cli/cli.js')
      assert.deepEqual(calls.pop(), { type: 'path', tabId: 'tab-1', text: 'dist/src/cli/cli.js' })
      // A plain click opens the file where the link points; with Ctrl it asks for the file manager instead.
      await clickLink('src/app.ts')
      assert.deepEqual(calls.pop(), { type: 'path', tabId: 'tab-1', text: 'src/app.ts', location: { line: 42, column: 7 } })
      await clickLink('My Repo')
      assert.deepEqual(calls.pop(), { type: 'path', tabId: 'tab-1', text: String.raw`C:\My Repo\lib\file.ts`, location: { line: 9, column: 3 } })
      await clickLink('src/app.ts', ['control'])
      assert.deepEqual(calls.pop(), { type: 'path', tabId: 'tab-1', text: 'src/app.ts', location: { line: 42, column: 7, reveal: true } })
      mode = 'pending'
      await clickLink('src/app.ts', ['control'])
      assert.equal(await notice(), null, 'nothing is shown for an open that may answer at once')
      assert.equal(await until(notice, 'slow reveal notice'), 'Revealing file…×', 'a Ctrl click that takes a while says it reveals')
      rejectPending(new Error('done'))
      await delay(100)
      await ui('document.querySelector(".terminal-link-error button")?.click()')
      mode = 'pending'
      await clickLink('src/missing.txt')
      assert.equal(await until(notice, 'slow open notice'), 'Opening file…×', 'a click that takes a while says it is opening')
      assert.equal(await terminalBox(), box, 'the progress notice takes no space from the terminal either')
      await clickLink('https://example.com/')
      rejectPending(new Error('stale file error'))
      await delay(100)
      assert.equal(await notice(), null, 'older failed clicks must not replace newer successful clicks')
      await clickLink('src/missing.txt')
      await ui('window.setActive(false)')
      await until(async () => (await notice()) === null, 'deactivation clears pending notice')
      rejectPending(new Error('inactive file error'))
      await delay(100)
      await ui('window.setActive(true)')
      await delay(100)
      assert.equal(await notice(), null, 'tab activation must not resurrect an old notice')
      mode = 'missing'
      await clickLink('src/missing.txt')
      await ui('window.setActive(false)')
      await until(async () => (await notice()) === null, 'deactivation clears completed notice')
      await ui('window.setActive(true)')
      await delay(100)
      assert.equal(await notice(), null)
      // The click that opens a link is not also reported to the session process; a click beside the link is.
      mode = 'ok'; calls.length = 0; written.length = 0
      await clickLink('src/app.ts:42:7')
      assert.deepEqual(calls.pop(), { type: 'path', tabId: 'tab-1', text: 'src/app.ts', location: { line: 42, column: 7 } })
      await delay(150)
      assert.deepEqual(written.filter(leftButton), [], 'a link click reaches the session process as a mouse click too')
      await clickLink('- error')
      await delay(150)
      assert.equal(written.filter(leftButton).length, 2, 'a click away from a link is still reported: press and release')
      assert.equal(calls.length, 0)
      // Press, move and release all inside one link: a drag. It is the session's alone and does not open the link.
      {
        written.length = 0
        const point = await locate('src/app.ts:42:7')
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
        await delay(50)
        window.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: point.x + 16, y: point.y })
        await delay(50)
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 16, y: point.y })
        await delay(250)
        assert.equal(calls.length, 0, 'a drag inside a link does not open it')
        const reports = written.filter(data => /^\u001b\[<\d+;\d+;\d+[Mm]$/.test(data))
        const pressAt = reports.findIndex(data => /^\u001b\[<0;\d+;\d+M$/.test(data))
        assert.ok(pressAt >= 0 && /^\u001b\[<32;/.test(reports[pressAt + 1]) && /^\u001b\[<0;\d+;\d+m$/.test(reports.at(-1)), `press, drag, release reach the session in order: ${JSON.stringify(reports)}`)
      }
      // A press on a link whose release never comes (the tab is switched away) is not sent with a later hover.
      {
        const point = await locate('src/app.ts:42:7')
        written.length = 0
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
        await delay(50)
        await ui('window.setActive(false)'); await delay(100)
        await ui('window.setActive(true)'); await delay(100)
        window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 200, y: point.y })
        await delay(200)
        assert.deepEqual(written.filter(leftButton), [], 'a press held across a tab switch is not sent later')
        assert.ok(written.some(data => /^\u001b\[<35;/.test(data)), 'the hover itself is reported')
        assert.equal(calls.length, 0)
        // Leave the fixture with no button down.
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 200, y: point.y })
        await delay(100)
      }
      assert.deepEqual(await ui('window.unhandled'), [])
      // Through every click, notice, dismissal and tab switch above, the session process was never told a new size.
      assert.equal(await terminalBox(), box)
      assert.deepEqual([...new Set(sizes)].filter(reported => reported !== size), [], `the terminal changed size: ${sizes.join(' ')}`)
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, checks: ['URL click', 'neutral missing file notice', 'notice over the terminal without resizing it', 'dismiss notice', 'workspace rejection alert', 'real IPC error formatting', 'backtick path with spaces', 'path inside inline-code command', 'line and column passed on', 'Ctrl click reveals', 'success clears notice', 'pending feedback', 'stale rejection ignored', 'deactivation clears pending and completed notices', 'no unhandled rejections', 'React StrictMode cleanup'] }, null, 2))
      console.log('PASS: Electron terminal link clicks and error feedback')
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ mode, calls, notice: await notice() }))
      await writeFile(join(artifacts, 'failure.png'), (await window.webContents.capturePage()).toPNG())
      process.exitCode = 1
    } finally {
      window.destroy()
      app.exit(process.exitCode ?? 0)
    }
  }
}
