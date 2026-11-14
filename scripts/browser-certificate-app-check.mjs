// Production Electron + live CLI: a refused certificate warns in the session's browser, follows it to its own window, and Proceed loads the page.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:https'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow } from 'electron'
import { ui } from './check-helpers.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label) {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) { const result = await action(); if (result) { console.log(`[browser-certificate] ${label}`); return result }; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
export async function runBrowserCertificateCheck() {
  await app.whenReady()
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const key = join(artifacts, 'site.key')
  const cert = join(artifacts, 'site.crt')
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30',
    '-subj', '/CN=site.invalid', '-addext', 'subjectAltName=DNS:site.invalid'], { windowsHide: true })
  const requests = []
  const site = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    requests.push(request.url)
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Certificate page</title><h1>certificate-page</h1>')
  })
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
  const siteUrl = `https://127.0.0.1:${site.address().port}/`
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'main window')
  const state = (window = main) => ui(window, 'window.copilotDesktop.getState()')
  const screenshot = async (window, name) => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  const click = (window, selector) => ui(window, `setTimeout(() => document.querySelector(${JSON.stringify(selector)}).click(), 50); true`)
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const source = await until(async () => (await state()).tabs.find(tab => tab.status === 'running' && tab.activity === 'idle'), 'session idle')
    const id = JSON.stringify(source.id)
    await click(main, '.session-pane-visible .session-browser-toggle')
    await until(() => ui(main, `document.querySelector('.workspace-tools .browser-panel') !== null`), 'browser beside terminal')

    // Through the real IPC: the refused certificate answers with a warning, not a failed address.
    const answered = await ui(main, `window.copilotDesktop.browserNavigate(${id}, ${JSON.stringify(siteUrl)})`)
    assert.equal(answered.certificateWarning?.error, 'ERR_CERT_AUTHORITY_INVALID')
    assert.equal(answered.url, siteUrl)
    assert.deepEqual(requests, [], 'a refused certificate sends no request')
    await until(() => ui(main, `document.querySelector('.workspace-tools .browser-viewport .browser-certificate') !== null`), 'warning in the page area')
    assert.equal(await ui(main, `document.querySelector('.workspace-tools .browser-error')`), null)
    assert.ok(!main.contentView.children.some(child => child.webContents?.getURL() === siteUrl && child.getVisible()), 'the page is hidden behind the warning')
    await screenshot(main, '01-warning')

    // The warning follows the browser to its own window and is answered there.
    await click(main, '.workspace-tools button[aria-label="Open browser in new window"]')
    const popout = await until(async () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window === main || window.isDestroyed() || !window.webContents.getURL().endsWith('/index.html')) continue
        if ((await state(window)).windowBrowserId === source.id) return window
      }
    }, 'browser window')
    await until(() => ui(popout, `document.querySelector('.browser-only-window .browser-viewport .browser-certificate') !== null`), 'warning in the browser window')
    assert.ok(!popout.contentView.children.some(child => child.webContents?.getURL() === siteUrl && child.getVisible()), 'the page stays hidden in the browser window')
    await click(popout, '.browser-certificate summary')
    await until(() => ui(popout, `document.querySelector('.browser-certificate details').open`), 'Advanced open')
    await delay(300)
    await screenshot(popout, '02-advanced-in-browser-window')
    await click(popout, '.browser-certificate-proceed')
    await until(() => requests.includes('/'), 'Proceed reaches the site')
    await until(() => ui(popout, `document.querySelector('.browser-certificate') === null && document.querySelector('.browser-not-secure') !== null`), 'page shown as not secure')
    const view = await until(() => popout.contentView.children.find(child => child.webContents?.getURL() === siteUrl && child.getVisible()), 'page visible in the browser window')
    await until(() => view.webContents.getTitle() === 'Certificate page', 'page loaded')
    assert.equal((await ui(popout, `window.copilotDesktop.browserState(${id})`)).error, null)
    await screenshot(popout, '03-proceeded')

    await click(popout, '.browser-only-window .session-pane-header button')
    await until(() => popout.isDestroyed(), 'browser returned to the session')
    await until(() => ui(main, `document.querySelector('.workspace-tools .browser-not-secure') !== null`), 'not secure beside the terminal')

    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: source.lastSessionId, checks: ['warning through real IPC', 'page hidden', 'warning follows the browser window', 'Proceed loads the page', 'not secure indicator'] }, null, 2))
    console.log('[browser-certificate] PASS: the warning is answered in the page area and Proceed loads the page')
  } catch (error) {
    for (const [index, window] of BrowserWindow.getAllWindows().entries()) await screenshot(window, `failure-${index}`).catch(() => {})
    throw error
  } finally { site.close(); app.quit() }
}
