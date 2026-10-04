// Two real Electron processes share one isolated userData directory and web origin.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-persistence')
const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const profile = await mkdtemp(join(artifacts, 'profile-'))
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><input id="username"><script>
      document.getElementById('username').value = localStorage.getItem('rememberedUsername') || '';
    </script>`)
  })
  await new Promise(accept => site.listen(0, '127.0.0.1', accept))
  const origin = `http://127.0.0.1:${site.address().port}/login`
  try {
    for (const phase of ['write', 'restore']) {
      const env = { ...process.env, BROWSER_PERSISTENCE_PROFILE: profile, BROWSER_PERSISTENCE_URL: origin }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), phase], { env, stdio: 'inherit', windowsHide: true })
      const timer = setTimeout(() => child.kill(), 30000)
      try {
        const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
        assert.equal(code, 0, `Browser persistence ${phase} failed`)
      } finally { clearTimeout(timer) }
    }
    const restored = JSON.parse(await readFile(join(profile, 'restored.json'), 'utf8'))
    assert.deepEqual(restored, { rememberedUsername: 'remembered-user', rememberedCookie: 'remembered-user', otherUsername: '', otherCookies: 0 })
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sameSessionReload: true, processRestart: true, sessionIsolation: true }, null, 2))
    console.log('Remembered username survives page reload and Electron restart; other session stays isolated.')
  } finally { site.closeAllConnections(); site.close() }
} else {
  const { app, BrowserWindow } = await import('electron')
  const profile = process.env.BROWSER_PERSISTENCE_PROFILE
  const url = process.env.BROWSER_PERSISTENCE_URL
  app.setPath('userData', profile)
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserProfilePaths } = await import('../dist/src/main/browser-profile.js')
    const owner = new BrowserWindow({ show: false })
    const makeBrowser = id => {
      const paths = browserProfilePaths(profile, id)
      return new BrowserDebug(owner, paths.settings, { partition: paths.partition, endpointPath: join(profile, `${id}-control.json`) })
    }
    const first = makeBrowser(firstId)
    const second = makeBrowser(secondId)
    const username = browser => browser.view.webContents.executeJavaScript("document.getElementById('username').value")
    try {
      if (process.argv[2] === 'write') {
        await first.navigate(url)
        await second.navigate(url)
        assert.equal(await username(first), '')
        await first.view.webContents.executeJavaScript(`
          localStorage.setItem('rememberedUsername', 'remembered-user');
          document.cookie = 'rememberedUsername=remembered-user; Max-Age=3600; Path=/; SameSite=Lax';
        `)
        const loaded = new Promise(accept => first.view.webContents.once('did-finish-load', accept))
        first.action('reload')
        await loaded
        assert.equal(await username(first), 'remembered-user')
        first.setBounds(null)
        assert.equal(await username(first), 'remembered-user')
        assert.equal(await username(second), '')
        assert.deepEqual(await second.view.webContents.session.cookies.get({ name: 'rememberedUsername' }), [])
      } else {
        await first.open()
        assert.equal(first.view.webContents.getURL(), url, 'Restored browser reopens its saved page')
        await second.navigate(url)
        const cookies = await first.view.webContents.session.cookies.get({ name: 'rememberedUsername' })
        await writeFile(join(profile, 'restored.json'), JSON.stringify({
          rememberedUsername: await username(first), rememberedCookie: cookies[0]?.value,
          otherUsername: await username(second), otherCookies: (await second.view.webContents.session.cookies.get({ name: 'rememberedUsername' })).length,
        }))
      }
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
      owner.destroy()
    }
    app.quit()
  }
}
