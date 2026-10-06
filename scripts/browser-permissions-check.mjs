// Site permissions: a few can be granted after a native prompt; everything else stays blocked.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-permissions')
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
  const timer = setTimeout(() => child.kill(), 90000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow, clipboard } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const site = createServer((request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(request.url === '/frame' ? '<p>frame</p>' : '<!doctype html><title>Permissions fixture</title><button id="b">Copy</button>')
    })
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
    const port = site.address().port
    const origins = { allowed: `http://127.0.0.1:${port}`, blocked: `http://localhost:${port}` }
    const window = new BrowserWindow({ show: false, width: 900, height: 700 })
    await window.loadURL('data:text/html,<title>Permissions host</title>')
    const endpoint = join(artifacts, 'control.json')
    const prompts = []
    let answer = origin => origin.startsWith(origins.allowed)
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint,
      approvePermission: async description => { prompts.push(description); return answer(description) } })
    const savedClipboard = await clipboard.readText()
    try {
      browser.setBounds({ x: 0, y: 0, width: 800, height: 600 }); window.showInactive()
      await browser.open()
      const contents = browser.view.webContents
      const go = async origin => {
        await browser.navigate(`${origin}/`)
        await until(async () => !contents.isLoading() && await contents.executeJavaScript('document.readyState') === 'complete', `loaded ${origin}`)
      }
      const run = (code, gesture = true) => contents.executeJavaScript(code, gesture)
      const settle = async code => run(`(async () => { try { return String(await (${code})) } catch (error) { return 'rejected:' + error.name } })()`)

      // Allowed site: asked once, then remembered, and the page sees it as granted.
      await go(origins.allowed)
      assert.notEqual(await run('Notification.permission'), 'granted')
      assert.equal(await settle('Notification.requestPermission()'), 'granted')
      assert.equal(prompts.length, 1)
      assert.match(prompts[0], new RegExp(`^${origins.allowed.replaceAll('.', '\\.')} wants to show desktop notifications\\.`))
      assert.equal(await run('Notification.permission'), 'granted')
      assert.equal(await settle('Notification.requestPermission()'), 'granted')
      assert.equal(prompts.length, 1, 'a remembered answer is not asked again')
      contents.focus()
      // The system clipboard is shared with other programs (clipboard managers, the user), which can replace it at any moment.
      // Retry the round trip a few times so an unrelated write cannot fail the check; a blocked page never gets this right.
      const roundTrip = async (name, attempt) => {
        for (let tries = 0; tries < 5; tries++) { if (await attempt(`${name} ${tries}`)) return true; await delay(100) }
        return false
      }
      assert.equal(await roundTrip('write', async text => {
        assert.equal(await settle(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => 'written')`), 'written')
        const seen = []; for (let poll = 0; poll < 10; poll++) { const value = await clipboard.readText(); seen.push(value); if (value === text) return true; await delay(50) }
        console.log('clipboard saw', JSON.stringify([...new Set(seen)])); return false
      }), true, 'the allowed page can copy to the clipboard')
      assert.equal(prompts.length, 2, 'the answer to the first copy is remembered')
      assert.match(prompts[1], /copy text to your clipboard/)
      assert.deepEqual(browser.snapshot.sitePermissions.map(entry => [entry.origin, entry.permission, entry.decision]),
        [[origins.allowed, 'notifications', 'allow'], [origins.allowed, 'clipboard-sanitized-write', 'allow']])

      // Permissions that are never promptable stay blocked without any prompt.
      assert.match(await settle('navigator.mediaDevices.getUserMedia({ video: true })'), /^rejected:/)
      assert.match(await settle("new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('granted'), error => resolve('code ' + error.code)))"), /^code 1$/)
      const readsBefore = prompts.length
      assert.equal(await roundTrip('read', async text => {
        await clipboard.writeText(text)
        return await settle('navigator.clipboard.readText().then(text => text)') === text
      }), true, 'the allowed page can read the clipboard')
      assert.equal(prompts.length, readsBefore + 1)
      assert.match(prompts.at(-1), /read text from your clipboard/)
      const afterBlocked = prompts.length

      // A frame is never asked, even on a site that was allowed.
      await run("(() => { const frame = document.createElement('iframe'); frame.src = '/frame'; document.body.append(frame) })()")
      await until(async () => await run('document.querySelector("iframe")?.contentDocument?.readyState') === 'complete', 'frame loaded')
      assert.equal(await settle("document.querySelector('iframe').contentWindow.Notification.requestPermission()"), 'denied')
      assert.equal(prompts.length, afterBlocked, 'a frame cannot trigger a prompt')

      // Another origin is separate, can be refused, and a refusal is remembered too.
      await go(origins.blocked)
      const before = prompts.length
      assert.equal(await settle('Notification.requestPermission()'), 'denied')
      assert.equal(prompts.length, before + 1)
      assert.equal(await settle('Notification.requestPermission()'), 'denied')
      assert.equal(prompts.length, before + 1, 'a remembered refusal is not asked again')
      await clipboard.writeText('sentinel')
      assert.equal(await settle("navigator.clipboard.writeText('x').then(() => 'written')"), 'rejected:NotAllowedError')
      assert.equal(await settle("navigator.clipboard.readText().then(() => 'read')"), 'rejected:NotAllowedError')
      assert.notEqual(await clipboard.readText(), 'x', 'the other origin could not replace the clipboard')
      assert.ok(browser.snapshot.sitePermissions.some(entry => entry.origin === origins.blocked && entry.decision === 'block'))

      // Removing an answer asks again; the control server does not expose the list.
      const entry = browser.snapshot.sitePermissions.find(item => item.origin === origins.blocked && item.permission === 'notifications')
      browser.action(`forget-permission:${entry.id}`)
      assert.equal(browser.snapshot.sitePermissions.some(item => item.id === entry.id), false)
      answer = () => true
      const asked = prompts.length
      assert.equal(await settle('Notification.requestPermission()'), 'granted')
      assert.equal(prompts.length, asked + 1)
      const control = JSON.parse(await readFile(endpoint, 'utf8'))
      const status = await (await fetch(`http://127.0.0.1:${control.port}/status`, { headers: { authorization: `Bearer ${control.token}` } })).json()
      assert.equal('sitePermissions' in status, false)
      assert.ok(!JSON.stringify(status).includes('Notification'))
      browser.action('forget-permissions')
      assert.deepEqual(browser.snapshot.sitePermissions, [])
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, prompts }, null, 2))
    } finally {
      try { await clipboard.writeText(String(savedClipboard ?? '')) } catch {}
      await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit()
    }
  }
}
