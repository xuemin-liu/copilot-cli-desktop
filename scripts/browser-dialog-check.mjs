// JavaScript dialogs (alert, confirm, beforeunload): the user answers them in the pane, and Testing mode handles
// them only where a step says so. A dialog must never leave the page, the assistant or a test hanging.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-dialog')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (read, name) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100) }
  throw new Error(`Timed out: ${name}`)
}
if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), '{"passed":false}')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 120000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const site = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><title>Dialog fixture</title><style>button{display:block;margin:6px;padding:6px}</style>
        <button id="confirm" onclick="out.textContent = confirm('Delete item 42?') ? 'confirmed' : 'cancelled'">Delete</button>
        <button id="alert" onclick="alert('Saved 3 changes'); out.textContent = 'after alert'">Save</button>
        <button id="plain" onclick="out.textContent = 'plain click'">Plain</button>
        <button id="late" onclick="setTimeout(() => { alert('Surprise'); out.textContent = 'surprised' }, 300)">Late</button>
        <button id="credential" onclick="alert('token: private-dialog-token'); out.textContent = 'shown'">Credential</button>
        <p id="out">idle</p>`)
    })
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
    const window = new BrowserWindow({ show: false, width: 900, height: 700 })
    await window.loadURL('data:text/html,<title>Dialog host</title>')
    const endpoint = join(artifacts, 'control.json')
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint })
    try {
      browser.setBounds({ x: 0, y: 0, width: 800, height: 600 }); window.showInactive()
      await browser.open(); await browser.navigate(`http://127.0.0.1:${site.address().port}/`)
      const contents = browser.view.webContents
      await until(async () => !contents.isLoading() && await contents.executeJavaScript('document.readyState') === 'complete', 'page loaded')
      const control = JSON.parse(await readFile(endpoint, 'utf8'))
      const call = (path, init = {}) => fetch(`http://127.0.0.1:${control.port}${path}`, { ...init, headers: { authorization: `Bearer ${control.token}`, ...(init.headers ?? {}) } })
      const out = () => contents.executeJavaScript('document.getElementById("out").textContent')
      const step = (action, label, rest = {}) => ({ action, label, ...rest })
      const plan = (steps, expected = 'idle') => ({ description: 'Dialog handling', expected: 'Dialogs are answered as planned', steps: [...steps, step('assert', 'Final text', { selector: '#out', condition: 'text', expected, timeoutMs: 2000 })] })
      const test = async steps => (await call('/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(steps) })).json()

      // The user answers a dialog in the pane. Until then the page is held, and the assistant is told why instead of timing out.
      void contents.executeJavaScript("document.getElementById('confirm').click()")
      const state = await until(() => browser.snapshot.dialog && browser.snapshot, 'dialog state')
      assert.deepEqual([state.dialog.type, state.dialog.message], ['confirm', 'Delete item 42?'])
      const read = await call('/read/snapshot')
      assert.equal(read.status, 400)
      assert.match((await read.json()).message, /page dialog is waiting for the user: confirm “Delete item 42\?”/)
      await browser.answerDialog(true)
      assert.equal(browser.snapshot.dialog, undefined)
      await until(async () => await out() === 'confirmed', 'user accepted confirm')
      await assert.rejects(browser.answerDialog(true), /No page dialog is waiting/)
      void contents.executeJavaScript("document.getElementById('credential').click()")
      const secret = await until(() => browser.snapshot.dialog && browser.snapshot, 'credential dialog')
      assert.ok(!secret.dialog.message.includes('private-dialog-token'), 'credentials in a dialog are filtered')
      await browser.answerDialog(true)
      await until(async () => await out() === 'shown', 'credential dialog answered')

      // Testing mode: a step that expects a dialog answers it; any other dialog is dismissed and reported.
      browser.action('testing:on')
      let report = await test(plan([step('click', 'Accept delete', { selector: '#confirm', dialog: { accept: true, message: 'Delete item' } })], 'confirmed'))
      assert.equal(report.status, 'passed', JSON.stringify(report.steps))
      assert.match(report.steps[0].detail, /confirm dialog “Delete item 42\?” was accepted/)
      report = await test(plan([step('click', 'Cancel delete', { selector: '#confirm', dialog: { accept: false } })], 'cancelled'))
      assert.equal(report.status, 'passed', JSON.stringify(report.steps))
      assert.match(report.steps[0].detail, /dismissed/)
      report = await test(plan([step('click', 'Accept alert', { selector: '#alert', dialog: { accept: true, message: 'Saved' } })], 'after alert'))
      assert.equal(report.status, 'passed', JSON.stringify(report.steps))
      assert.match(report.steps[0].detail, /alert dialog “Saved 3 changes”/)

      report = await test(plan([step('click', 'Delete without expecting a dialog', { selector: '#confirm' })], 'cancelled'))
      assert.equal(report.status, 'failed')
      assert.match(report.steps[0].reason, /confirm dialog \(“Delete item 42\?”\) that no step expected, so it was dismissed/)
      assert.equal(await out(), 'cancelled', 'the page keeps running after an unexpected dialog')
      assert.equal(browser.snapshot.dialog, undefined)
      report = await test(plan([step('click', 'Wrong text', { selector: '#confirm', dialog: { accept: true, message: 'Something else' } })], 'confirmed'))
      assert.equal(report.status, 'failed')
      assert.match(report.steps[0].reason, /does not contain the expected message/)
      report = await test(plan([step('click', 'No dialog appears', { selector: '#plain', dialog: { accept: true } })], 'plain click'))
      assert.equal(report.status, 'failed')
      assert.match(report.steps[0].reason, /none opened within 1\.5 seconds/)
      report = await test(plan([step('click', 'Starts a timer', { selector: '#late' }), step('assert', 'Page still idle', { selector: '#out', condition: 'visible', timeoutMs: 1500 }),
        step('waitFor', 'Wait for the timer', { selector: '#out', condition: 'text', expected: 'never happens', timeoutMs: 1500 })], 'never happens'))
      assert.equal(report.status, 'failed')
      assert.ok(report.steps.some(item => /that no step expected/.test(item.reason ?? '')), JSON.stringify(report.steps))
      assert.equal(browser.snapshot.dialog, undefined)

      // The plan rejects malformed dialog fields.
      for (const dialog of [{}, { accept: 'yes' }, { accept: true, value: 'x' }, { accept: true, message: '' }]) {
        const response = await call('/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan([step('click', 'Bad', { selector: '#plain', dialog })])) })
        assert.equal(response.status, 400, JSON.stringify(dialog))
      }
      assert.equal((await call('/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan([step('hover', 'Bad', { selector: '#plain', dialog: { accept: true } })])) })).status, 400)
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true }, null, 2))
    } finally { await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit() }
  }
}
