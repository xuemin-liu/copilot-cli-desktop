// Two real Electron processes share one isolated userData directory and web origin.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
    for (const phase of ['write', 'restore', 'close', 'verify-cleanup']) {
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
    const cleaned = JSON.parse(await readFile(join(profile, 'cleaned.json'), 'utf8'))
    assert.deepEqual(cleaned, { closedUsername: '', closedCookies: 0, retainedUsername: 'second-user', retainedCookie: 'second-user' })
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sameSessionReload: true, processRestart: true, sessionIsolation: true,
      explicitClose: true, orphanPartitionCleanup: true, flushFailure: true }, null, 2))
    console.log('Remembered usernames survive app restart; explicit close clears credentials and startup removes orphan partitions.')
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
    const { clearBrowserStorage, pruneBrowserProfiles, removeBrowserProfileSettings } = await import('../dist/src/main/browser-cleanup.js')
    const phase = process.argv[2]
    if (phase === 'verify-cleanup') {
      const paths = JSON.parse(await readFile(join(profile, 'storage-paths.json'), 'utf8'))
      await pruneBrowserProfiles(profile, [secondId])
      await assert.rejects(access(paths.first))
      await access(paths.second)
    }
    const owner = new BrowserWindow({ show: false })
    const errors = []
    const makeBrowser = id => {
      const paths = browserProfilePaths(profile, id)
      return new BrowserDebug(owner, paths.settings, { partition: paths.partition, endpointPath: join(profile, `${id}-control.json`),
        reportError: message => errors.push(message) })
    }
    const first = makeBrowser(firstId)
    const second = makeBrowser(secondId)
    const username = browser => browser.view.webContents.executeJavaScript("document.getElementById('username').value")
    try {
      if (phase === 'write') {
        await writeFile(join(profile, 'storage-paths.json'), JSON.stringify({ first: first.view.webContents.session.getStoragePath(),
          second: second.view.webContents.session.getStoragePath() }))
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
      } else if (phase === 'restore') {
        await first.open()
        assert.equal(first.view.webContents.getURL(), url, 'Restored browser reopens its saved page')
        await second.navigate(url)
        const cookies = await first.view.webContents.session.cookies.get({ name: 'rememberedUsername' })
        await writeFile(join(profile, 'restored.json'), JSON.stringify({
          rememberedUsername: await username(first), rememberedCookie: cookies[0]?.value,
          otherUsername: await username(second), otherCookies: (await second.view.webContents.session.cookies.get({ name: 'rememberedUsername' })).length,
        }))
      } else if (phase === 'close') {
        await first.open()
        await second.navigate(url)
        await second.view.webContents.executeJavaScript(`
          localStorage.setItem('rememberedUsername', 'second-user');
          document.cookie = 'rememberedUsername=second-user; Max-Age=3600; Path=/; SameSite=Lax';
        `)
        const storage = first.view.webContents.session
        const originalFlush = storage.cookies.flushStore
        storage.cookies.flushStore = async () => { throw new Error('fixture flush failure') }
        try { await first.dispose() } finally { storage.cookies.flushStore = originalFlush }
        assert.equal(errors.length, 1)
        assert.match(errors[0], /fixture flush failure/)
        await clearBrowserStorage(storage, message => errors.push(message))
        assert.equal(errors.length, 1, 'Native storage cleanup must succeed')
        assert.deepEqual(await storage.cookies.get({}), [])
        await removeBrowserProfileSettings(profile, firstId)
        await assert.rejects(access(browserProfilePaths(profile, firstId).settings))
      } else {
        await first.navigate(url)
        await second.open()
        await writeFile(join(profile, 'cleaned.json'), JSON.stringify({
          closedUsername: await username(first), closedCookies: (await first.view.webContents.session.cookies.get({})).length,
          retainedUsername: await username(second), retainedCookie: (await second.view.webContents.session.cookies.get({ name: 'rememberedUsername' }))[0]?.value,
        }))
      }
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
      owner.destroy()
    }
    app.quit()
  }
}
