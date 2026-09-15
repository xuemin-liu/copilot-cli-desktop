// Real Electron, React and xterm mouse-click regression. Only the desktop bridge
// is a fixture; main-process file resolution is covered by main-lifecycle tests.
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
      import { TerminalPane } from './src/renderer/components/TerminalPane';
      import './src/renderer/styles.css';
      import '@xterm/xterm/css/xterm.css';
      window.calls = [];
      window.mode = 'missing';
      window.unhandled = [];
      window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason)));
      window.copilotDesktop = {
        getTabSnapshot: async () => ({ sequence: 0, data: [
          'https://example.com/',
          'src/missing.txt',
          '\\x60folder with spaces/example.txt\\x60',
        ].join('\\r\\n') }),
        onTabOutput: () => () => {},
        resizeTab: async () => {}, writeTab: async () => {},
        openExternalUrl: async url => { window.calls.push({ type: 'url', text: url }); },
        revealPath: async (tabId, text) => {
          window.calls.push({ type: 'path', tabId, text });
          if (window.mode === 'missing') throw new Error('File or folder not found or inaccessible: ' + text);
          if (window.mode === 'outside') throw new Error('Only paths within the session workspace can be revealed');
          if (window.mode === 'pending') await new Promise((_, reject) => { window.rejectPending = reject; });
        },
      };
      createRoot(document.getElementById('root')).render(<TerminalPane tabId="tab-1" active sessionProcessId={1} />);
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
  const { app, BrowserWindow } = await import('electron')
  app.setPath('userData', join(artifacts, 'user-data'))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const window = new BrowserWindow({ width: 900, height: 500, show: false, webPreferences: { backgroundThrottling: false } })
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
    const alert = () => ui('document.querySelector("[role=alert]")?.textContent ?? null')
    const clickLink = async text => {
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
      assert.deepEqual(await ui('window.calls.pop()'), { type: 'url', text: 'https://example.com/' })
      await clickLink('src/missing.txt')
      assert.match(await until(alert, 'missing-file error'), /Could not reveal file:.*not found/)
      assert.equal(await ui(`(() => {
        const element = document.querySelector('[role=alert]');
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && element.contains(document.elementFromPoint(rect.x + 5, rect.y + 5));
      })()`), true, 'error must be visible above the terminal')
      await delay(250)
      await writeFile(join(artifacts, 'missing-file-error.png'), (await window.webContents.capturePage()).toPNG())
      await ui('document.querySelector(".terminal-link-error button").click()')
      await until(async () => (await alert()) === null, 'dismissed error')
      await ui('window.mode = "outside"')
      await clickLink('src/missing.txt')
      assert.match(await until(alert, 'workspace error'), /within the session workspace/)
      await ui('window.mode = "success"')
      await clickLink('folder with spaces/example.txt')
      assert.deepEqual(await ui('window.calls.pop()'), { type: 'path', tabId: 'tab-1', text: 'folder with spaces/example.txt' })
      assert.equal(await alert(), null)
      await ui('window.mode = "pending"')
      await clickLink('src/missing.txt')
      await clickLink('https://example.com/')
      await ui('window.rejectPending(new Error("stale file error"))')
      await delay(100)
      assert.equal(await alert(), null, 'older failed clicks must not replace newer successful clicks')
      assert.deepEqual(await ui('window.unhandled'), [])
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, checks: ['URL click', 'missing file alert', 'dismiss alert', 'workspace rejection alert', 'backtick path with spaces', 'success clears alert', 'stale rejection ignored', 'no unhandled rejections'] }, null, 2))
      console.log('PASS: Electron terminal link clicks and error feedback')
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    } finally {
      window.destroy()
      app.exit(process.exitCode ?? 0)
    }
  }
}
