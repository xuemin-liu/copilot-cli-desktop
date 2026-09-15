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
      import './src/renderer/styles.css';
      import '@xterm/xterm/css/xterm.css';
      window.unhandled = [];
      window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason)));
      function Fixture() {
        const [active, setActive] = useState(true);
        window.setActive = setActive;
        return <div className="session-terminal" style={{ height: '100vh' }}>
          <TerminalPane tabId="tab-1" active={active} sessionProcessId={1} />
          <button className="restart-button" onClick={() => { window.restarted = true; }}>Restart this session</button>
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
  const timeout = setTimeout(() => child.kill(), 60_000)
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
    ipcMain.handle('desktop:get-tab-snapshot', () => ({ sequence: 0, data: [
      'https://example.com/', 'src/missing.txt', '`./folder with spaces/example.txt`', '`node dist/src/cli/cli.js`',
    ].join('\r\n') }))
    ipcMain.handle('desktop:resize-tab', () => {})
    ipcMain.handle('desktop:write-tab', () => {})
    ipcMain.handle('desktop:open-external-url', (_event, url) => { calls.push({ type: 'url', text: url }) })
    ipcMain.handle('desktop:reveal-path', async (_event, tabId, text) => {
      calls.push({ type: 'path', tabId, text })
      if (mode === 'missing') return { ok: false, reason: 'missing' }
      if (mode === 'outside') return { ok: false, reason: 'outside-workspace' }
      if (mode === 'throw') throw new Error('Fixture reveal failure')
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
    const clickLink = async text => {
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
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
      await delay(100)
    }
    try {
      window.showInactive()
      await window.loadFile(join(artifacts, 'index.html'))
      await until(() => ui('document.querySelector(".xterm-rows")?.textContent.includes("folder with spaces")'), 'terminal output')
      await clickLink('https://example.com/')
      assert.deepEqual(calls.pop(), { type: 'url', text: 'https://example.com/' })
      await clickLink('src/missing.txt')
      assert.match(await until(notice, 'missing-file notice'), /File or folder not found or inaccessible: src\/missing.txt/)
      assert.equal(await ui('document.querySelector(".terminal-link-error").getAttribute("role")'), 'status')
      assert.equal(await ui(`(() => {
        const element = document.querySelector('.terminal-link-error');
        const rect = element.getBoundingClientRect();
        const terminal = document.querySelector('.terminal-viewport').getBoundingClientRect();
        const restart = document.querySelector('.restart-button');
        const button = restart.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= terminal.top && terminal.height > 0
          && element.contains(document.elementFromPoint(rect.x + 5, rect.y + 5))
          && restart.contains(document.elementFromPoint(button.x + 5, button.y + 5));
      })()`), true, 'notice must reserve space above the terminal and leave restart clickable')
      await delay(250)
      await writeFile(join(artifacts, 'missing-file-error.png'), (await window.webContents.capturePage()).toPNG())
      await ui('document.querySelector(".terminal-link-error button").click()')
      await until(async () => (await notice()) === null, 'dismissed notice')
      mode = 'outside'
      await clickLink('src/missing.txt')
      assert.match(await until(notice, 'workspace error'), /within the session workspace/)
      assert.equal(await ui('document.querySelector(".terminal-link-error").getAttribute("role")'), 'alert')
      mode = 'throw'
      await clickLink('src/missing.txt')
      assert.equal(await until(notice, 'IPC error'), 'Could not reveal file: Fixture reveal failure×')
      mode = 'success'
      await clickLink('./folder with spaces/example.txt')
      assert.deepEqual(calls.pop(), { type: 'path', tabId: 'tab-1', text: './folder with spaces/example.txt' })
      assert.equal(await notice(), null)
      await clickLink('dist/src/cli/cli.js')
      assert.deepEqual(calls.pop(), { type: 'path', tabId: 'tab-1', text: 'dist/src/cli/cli.js' })
      mode = 'pending'
      await clickLink('src/missing.txt')
      assert.equal(await notice(), 'Revealing file…×', 'pending click gives immediate feedback')
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
      assert.deepEqual(await ui('window.unhandled'), [])
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, checks: ['URL click', 'neutral missing file notice', 'non-overlapping terminal/restart layout', 'dismiss notice', 'workspace rejection alert', 'real IPC error formatting', 'backtick path with spaces', 'path inside inline-code command', 'success clears notice', 'pending feedback', 'stale rejection ignored', 'deactivation clears pending and completed notices', 'no unhandled rejections', 'React StrictMode cleanup'] }, null, 2))
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
