// Production React/xterm/preload with synthetic clipboard events; no OS clipboard changes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ui } from './check-helpers.mjs'

const artifacts = resolve('test-results/terminal-paste')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  await mkdir(artifacts, { recursive: true })
  await build({ stdin: { contents: `
    import { createRoot } from 'react-dom/client';
    import { StrictMode } from 'react';
    import { TerminalPane } from './src/renderer/components/TerminalPane';
    import '@xterm/xterm/css/xterm.css';
    createRoot(document.getElementById('root')).render(<StrictMode><TerminalPane tabId="paste" active={true} sessionProcessId={1}/></StrictMode>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(artifacts, 'fixture.js'), platform: 'browser', jsx: 'automatic' })
  await writeFile(join(artifacts, 'index.html'), '<!doctype html><link rel="stylesheet" href="fixture.css"><style>.terminal-viewport{height:400px}</style><div id="root"></div><script src="fixture.js"></script>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timeout) }
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  app.setPath('userData', join(artifacts, 'user-data'))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const writes = []
    ipcMain.handle('desktop:get-tab-snapshot', () => ({ sequence: 0, data: 'ready' }))
    ipcMain.handle('desktop:resize-tab', () => {})
    ipcMain.handle('desktop:write-tab', (_event, tabId, data) => { assert.equal(tabId, 'paste'); writes.push(data) })
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, preload: resolve('src/preload/preload.cjs') } })
    await window.loadFile(join(artifacts, 'index.html'))
    async function until(read, label) {
      const end = Date.now() + 5_000
      while (Date.now() < end) { if (await read()) return; await delay(20) }
      throw new Error(`Timed out: ${label}`)
    }
    const text = () => ui(window, `document.querySelector('.xterm-rows')?.textContent ?? ''`)
    await until(async () => (await text()).includes('ready'), 'mount')
    const paste = async (value, image = false) => {
      writes.length = 0
      await ui(window, `(() => {
        const data = new DataTransfer();
        if (${JSON.stringify(value)} !== null) data.setData('text/plain', ${JSON.stringify(value)});
        if (${image}) data.items.add(new File(['fixture'], 'image.png', { type: 'image/png' }));
        document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      })()`)
      await delay(80)
      return [...writes]
    }
    let sequence = 0
    for (const bracketed of [false, true]) {
      const marker = `mode-${++sequence}`
      window.webContents.send('desktop:tab-output', { tabId: 'paste', sequence, data: `\u001b[?2004${bracketed ? 'h' : 'l'}\r\n${marker}` })
      await until(async () => (await text()).includes(marker), 'mode parsed')
      const frame = value => bracketed ? `\u001b[200~${value}\u001b[201~` : value
      assert.deepEqual(await paste('first\nsecond'), [frame('first\rsecond')])
      assert.deepEqual(await paste(null, true), ['\u001bv'])
      assert.deepEqual(await paste('caption', true), [frame('caption')])
      assert.deepEqual(await paste(null), [])
      assert.deepEqual(await paste(''), [])
      assert.deepEqual(await paste('x'.repeat(1_000_001)), [frame('x'.repeat(1_000_000))])
      assert.deepEqual(await paste('after-large'), [frame('after-large')])
    }
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, checks: ['StrictMode mount', 'bracketed mode on/off', 'image shortcut', 'multiline and mixed text', 'empty paste no-op', 'bounded text with intact framing'] }, null, 2))
    console.log('[terminal-paste] PASS')
    app.quit()
  }
}
