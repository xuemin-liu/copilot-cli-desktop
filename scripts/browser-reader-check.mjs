// Authenticated ticket-style fixture. Uses isolated Electron profiles, no model calls.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const artifacts = resolve('test-results/browser-reader')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (read, name) => {
  const end = Date.now() + 20000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100) }
  throw new Error(`Timed out: ${name}`)
}
if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), '{"passed":false}')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 150000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, nativeImage } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserCommand } = await import('../dist/src/cli/browser-control.js')
    const { prepareBrowserSessionEnvironment } = await import('../dist/src/main/browser-session.js')
    let writes = 0; let approval = false; let approvals = 0; let duringApproval = async () => {}; let approvalDescription = ''
    const site = createServer((request, response) => {
      if (request.url === '/write') { writes++; response.end('modified'); return }
      if (request.url === '/ticket.json') {
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'jiraSession=private-cookie; HttpOnly' })
        response.end(JSON.stringify({ key: 'APP-123', fields: { description: 'Captured ticket description', token: 'private-response-token', comment: ['Captured comment'] } })); return
      }
      if (request.url === '/frame') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h2>Attachment preview</h2><p>Frame attachment content</p><input value="private-frame-form">'); return }
      if (request.url === '/child') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>Linked issue APP-456</h1>'); return }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><title>APP-123</title><style>body{font:16px sans-serif}section{height:1500px}</style>
        <h1>APP-123: Broken layout</h1><p>Description: verify dynamic ticket reading</p>
        <input type="password" value="private-password"><input type="text" value="private-username">
        <input type="hidden" value="private-hidden"><div hidden>private-hidden-text</div>
        <div data-private>private-marked</div><p>Authorization: Bearer private-inline</p>
        <p id="provider-token">ghp_abcdefghijklmnopqrstuvwxyz0123456789</p>
        <p id="api-token">Use API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for access</p>
        <p id="custom-auth">Authorization: Token opaque-private-token</p>
        <button role="tab" id="comments" onclick="document.getElementById('result').textContent='Comment by Alice: reproduced'">Comments</button>
        <a id="approval-link" href="/write?atl_token=private-link-token">Next</a>
        <button id="write" onclick="fetch('/write',{method:'POST'})">Delete issue</button>
        <a href="/child" target="_blank">Linked issue</a>
        <details><summary>Activity</summary><p>Activity: issue opened</p></details>
        <div id="result"></div><div id="dynamic"></div><iframe src="/frame"></iframe>
        <iframe src="http://localhost:${site.address().port}/frame"></iframe>
        <section>Scroll to more fields</section><p>Last field: priority high</p>
        <script>localStorage.setItem('token','private-storage');fetch('/ticket.json');setTimeout(()=>document.getElementById('dynamic').textContent='Dynamic linked issue APP-789',80)</script>`)
    })
    await new Promise(accept => site.listen(0, accept))
    const window = new BrowserWindow({ show: false, width: 1000, height: 900 })
    await window.loadURL('data:text/html,<title>Browser reader fixture</title>')
    const endpoint = join(artifacts, 'control.json')
    const environment = await prepareBrowserSessionEnvironment(join(artifacts, 'helpers'), 'tab-1', process.env)
    Object.assign(process.env, environment, { COPILOT_DESKTOP_BROWSER_STATE: endpoint })
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint,
      approveInteraction: async description => {
        approvalDescription = description; approvals++
        assert.equal(window.isVisible(), true, 'hidden owner must be shown before approval')
        assert.equal(window.isMinimized(), false, 'minimized owner must be restored before approval')
        await duringApproval(); return approval
      } })
    const second = new BrowserDebug(window, join(artifacts, `second-settings-${Date.now()}.json`), { endpointPath: join(artifacts, 'second-control.json') })
    try {
      browser.setBounds({ x: 0, y: 0, width: 900, height: 750 })
      window.showInactive()
      await browser.open(); await second.open()
      await browser.navigate(`http://127.0.0.1:${site.address().port}/`)
      const page = String(browser.view.webContents.id)
      await until(async () => (await browserCommand(['snapshot', page])).text?.includes('Dynamic linked issue'), 'dynamic page snapshot')
      const snapshot = await browserCommand(['snapshot', page])
      const all = JSON.stringify(snapshot)
      for (const secret of ['private-password', 'private-username', 'private-hidden', 'private-hidden-text', 'private-marked', 'private-inline', 'private-storage',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'opaque-private-token', 'private-link-token']) assert.ok(!all.includes(secret), secret)
      assert.ok(snapshot.text.includes('Description: verify'))
      const shellSnapshot = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', environment.COPILOT_DESKTOP_BROWSER_HELPER, 'snapshot', page], {
        env: process.env, windowsHide: true, timeout: 60000,
      })
      assert.ok(JSON.parse(shellSnapshot.stdout).text.includes('Description: verify'), 'installed-app helper can read the live authenticated page')
      assert.ok(!snapshot.text.includes('Activity: issue opened'), 'collapsed content is not invented')
      const frames = await browserCommand(['frames', page])
      assert.equal(frames.frames.length, 3, 'main frame and same/cross-origin child frames')
      for (const frame of frames.frames.slice(1)) {
        const child = await browserCommand(['snapshot', page, frame.id])
        assert.ok(child.text.includes('Frame attachment content'), JSON.stringify(child))
        assert.ok(!JSON.stringify(child).includes('private-frame-form'))
      }
      const bodyList = await until(async () => {
        const data = await browserCommand(['responses', page]);
        await writeFile(join(artifacts, 'responses.json'), JSON.stringify(data, null, 2))
        return data.responses.some(record => record.url.endsWith('/ticket.json') && record.state === 'available') && data
      }, 'captured JSON body')
      const record = bodyList.responses.find(record => record.url.endsWith('/ticket.json'))
      const body = await browserCommand(['response', record.id])
      assert.ok(JSON.stringify(body).includes('Captured ticket description'))
      assert.ok(!JSON.stringify(body).includes('private-response-token'))
      const frameId = snapshot.frameId
      await browser.view.webContents.executeJavaScript(`(() => {
        const section = document.createElement('section');
        for (let i = 0; i < 700; i++) { const p = document.createElement('p'); p.textContent = 'Bulk field ' + i; section.append(p); }
        document.body.append(section);
      })()`)
      const seenFields = new Set()
      let offset = 0
      for (let chunk = 0; chunk < 25; chunk++) {
        const part = await browserCommand(['snapshot', page, frameId, String(offset)])
        for (const match of part.text.matchAll(/Bulk field (\d+)/g)) seenFields.add(Number(match[1]))
        if (part.nextOffset === null) break
        assert.ok(part.nextOffset > offset, 'snapshot pagination must make progress')
        offset = part.nextOffset
      }
      assert.equal(seenFields.size, 700, 'all fields on a large ticket are readable across bounded snapshots')
      const find = (snap, label) => snap.dom.find(node => node.tag === '#text' && node.text === label)?.parent
      const comments = find(snapshot, 'Comments')
      assert.ok(comments)
      const beforeApproval = await browserCommand(['snapshot', page])
      const firstChunkControl = find(beforeApproval, 'Comments')
      await browserCommand(['snapshot', page, frameId, String(beforeApproval.nextOffset)])
      await assert.rejects(browserCommand(['activate', page, frameId, beforeApproval.snapshotId, firstChunkControl]), /stale|unavailable/)
      await browser.view.webContents.executeJavaScript(`document.getElementById('approval-link').setAttribute('aria-label', 'Next\\n\\n' + 'misleading '.repeat(100))`)
      let linkSnapshot = await browserCommand(['snapshot', page])
      window.hide()
      const deniedLink = await browserCommand(['activate', page, frameId, linkSnapshot.snapshotId, find(linkSnapshot, 'Next')])
      assert.equal(deniedLink.state, 'denied')
      assert.ok(approvalDescription.includes('Link destination: http://127.0.0.1:'))
      assert.ok(approvalDescription.includes('/write?atl_token=%5Bredacted%5D'))
      assert.ok(!approvalDescription.includes('private-link-token'))
      const dialogLabel = approvalDescription.match(/“([^”]*)”/)?.[1]
      assert.ok(dialogLabel && dialogLabel.length <= 200 && !/[\r\n]/.test(dialogLabel))
      window.minimize()
      await until(() => window.isMinimized(), 'fixture owner minimized')
      linkSnapshot = await browserCommand(['snapshot', page])
      await browserCommand(['activate', page, frameId, linkSnapshot.snapshotId, find(linkSnapshot, 'Next')])
      const restoredSnapshot = await browserCommand(['snapshot', page])
      let activation = await browserCommand(['activate', page, frameId, restoredSnapshot.snapshotId, find(restoredSnapshot, 'Comments')])
      assert.equal(activation.state, 'denied'); assert.equal(writes, 0)
      assert.ok(!(await browserCommand(['snapshot', page])).text.includes('Comment by Alice'))
      approval = true
      let current = await browserCommand(['snapshot', page])
      activation = await browserCommand(['activate', page, frameId, current.snapshotId, find(current, 'Comments')])
      assert.equal(activation.state, 'activated')
      current = await browserCommand(['snapshot', page]); assert.ok(current.text.includes('Comment by Alice'))
      await browserCommand(['activate', page, frameId, current.snapshotId, find(current, 'Activity')])
      current = await browserCommand(['snapshot', page]); assert.ok(current.text.includes('Activity: issue opened'))
      const beforeScroll = current.viewport.scrollY
      await browserCommand(['scroll', page, frameId, '700'])
      current = await browserCommand(['snapshot', page]); assert.ok(current.viewport.scrollY > beforeScroll)
      await browserCommand(['scroll', page, frameId, '-700'])
      const divCount = await browser.view.webContents.executeJavaScript('document.querySelectorAll("div").length')
      const protectedBoxes = await browser.view.webContents.executeJavaScript(`['provider-token','api-token','custom-auth'].map(id => {
        const box = document.getElementById(id).getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
      })`)
      const screenshotPath = join(artifacts, `ticket-${Date.now()}.png`)
      const screenshot = await browserCommand(['screenshot', page, screenshotPath])
      assert.equal(screenshot.state, 'available', JSON.stringify(screenshot)); assert.equal(screenshot.redacted, true)
      assert.ok((await readFile(screenshotPath)).length > 100)
      const pixels = nativeImage.createFromBuffer(await readFile(screenshotPath))
      const bitmap = pixels.toBitmap(); const pixelSize = pixels.getSize()
      for (const box of protectedBoxes) {
        const x = Math.floor(box.x + box.width - 3); const y = Math.floor(box.y + 3)
        assert.ok(y >= 0 && y < pixelSize.height && x >= 0 && x < pixelSize.width, 'credential masking is tested inside the viewport')
        const index = (y * pixelSize.width + x) * 4
        assert.deepEqual([...bitmap.subarray(index, index + 3)], [17, 17, 17], 'pasted credentials must be covered in the actual PNG')
      }
      assert.equal(await browser.view.webContents.executeJavaScript('document.querySelectorAll("div").length'), divCount, 'screenshot masks removed')
      // Approval cannot be reused for a stale snapshot or a control changed during the dialog.
      current = await browserCommand(['snapshot', page])
      duringApproval = () => browser.view.webContents.executeJavaScript('document.getElementById("comments").textContent="Changed control"')
      await assert.rejects(browserCommand(['activate', page, frameId, current.snapshotId, find(current, 'Comments')]), /stale|unavailable/)
      duringApproval = async () => {}
      approval = false
      current = await browserCommand(['snapshot', page])
      await browserCommand(['activate', page, frameId, current.snapshotId, find(current, 'Delete issue')])
      assert.equal(writes, 0, 'no unapproved ticket write')
      // An approval arriving after the caller disconnects cannot activate a control.
      const cancellationControl = JSON.parse(await readFile(endpoint, 'utf8'))
      let releaseApproval; let approvalEntered = false
      duringApproval = () => { approvalEntered = true; return new Promise(resolve => { releaseApproval = resolve }) }
      approval = true
      current = await browserCommand(['snapshot', page])
      const cancel = new AbortController()
      const cancelArgs = new URLSearchParams()
      for (const arg of [page, frameId, current.snapshotId, find(current, 'Delete issue')]) cancelArgs.append('arg', arg)
      const pendingActivation = fetch(`http://127.0.0.1:${cancellationControl.port}/read/activate?${cancelArgs}`, {
        method: 'POST', headers: { authorization: `Bearer ${cancellationControl.token}` }, signal: cancel.signal,
      }).catch(error => error)
      await until(() => approvalEntered, 'approval entered before disconnect')
      cancel.abort(); await pendingActivation
      await delay(100); releaseApproval()
      duringApproval = async () => {}
      await until(async () => { try { return Boolean(await browserCommand(['tabs'])) } catch { return false } }, 'cancelled activation completes')
      assert.equal(writes, 0, 'disconnected approval cannot write')
      current = await browserCommand(['snapshot', page]); approval = true
      await browserCommand(['activate', page, frameId, current.snapshotId, find(current, 'Linked issue')])
      const tabs = await until(async () => { const list = await browserCommand(['tabs']); return list.tabs.length === 2 && list }, 'linked issue new tab')
      await browserCommand(['select', page]); assert.equal(browser.snapshot.activePageId, Number(page))
      const otherPage = String(tabs.tabs.find(tab => tab.id !== Number(page)).id)
      assert.ok((await browserCommand(['snapshot', otherPage])).text.includes('Linked issue APP-456'))
      await assert.rejects(browserCommand(['snapshot', String(second.view.webContents.id)]), /unavailable in this session/)
      const control = JSON.parse(await readFile(endpoint, 'utf8'))
      const route = `http://127.0.0.1:${control.port}/read/snapshot?arg=${page}`
      assert.equal((await fetch(route)).status, 401)
      assert.equal((await fetch(route, { headers: { authorization: `Bearer ${control.token}`, origin: 'https://jira.test' } })).status, 403)
      assert.equal((await fetch(route, { method: 'POST', headers: { authorization: `Bearer ${control.token}` } })).status, 405)
      // Native tools must remain usable, and diagnostics must not depend on CDP.
      await browserCommand(['select', page]); browser.action('view:network')
      await until(() => browser.view.webContents.devToolsWebContents?.getURL().startsWith('devtools://'), 'native DevTools')
      assert.ok((await browserCommand(['snapshot', page])).text.includes('APP-123'))
      assert.equal((await browserCommand(['screenshot', page])).state, 'unavailable', 'hidden Page surface is not returned as a stale screenshot')
      await browser.view.webContents.executeJavaScript('fetch("/ticket.json?after-tools")')
      await until(async () => (await browserCommand(['responses', page])).responses.some(record => record.url.includes('after-tools')), 'capture with native DevTools')
      browser.action('clear-network')
      assert.equal((await browserCommand(['responses'])).responses.length, 0)
      assert.equal((await browserCommand(['response', record.id])).state, 'unavailable')
      await writeFile(join(artifacts, 'snapshot.json'), JSON.stringify(snapshot, null, 2))
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, dynamicContent: true, frames: true,
        responses: true, privacy: true, approvalCancellation: true, disconnectedApproval: true, staleApproval: true,
        installedHelper: true, pagination: true, stalePaginatedControl: true, approvalDestination: true, restoredApprovalOwner: true,
        providerTokenMasking: true, tabs: true, isolation: true, nativeDevTools: true, approvals }, null, 2))
      console.log('Browser reader check passed: dynamic tickets, frames, bodies, masked screenshots, approvals, isolation and native tools.')
    } finally { await browser.dispose(); await second.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit() }
  }
}
