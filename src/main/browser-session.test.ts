import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { browserSessionPaths, prepareBrowserSessionEnvironment } from './browser-session.js'

test('each terminal gets its own endpoint and additive browser instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-sessions-'))
  try {
    const original = { ...process.env, COPILOT_CUSTOM_INSTRUCTIONS_DIRS: 'user-instructions' }
    const first = await prepareBrowserSessionEnvironment(root, 'tab-1', original)
    const second = await prepareBrowserSessionEnvironment(root, 'tab-2', original)
    assert.notEqual(first.COPILOT_DESKTOP_BROWSER_STATE, second.COPILOT_DESKTOP_BROWSER_STATE)
    assert.equal(first.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, `user-instructions,${join(root, 'tab-1')}`)
    assert.equal(original.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, 'user-instructions')
    const restarted = await prepareBrowserSessionEnvironment(root, 'tab-1', first)
    assert.deepEqual(restarted, first)
    assert.throws(() => browserSessionPaths(root, '../tab-1'), /Invalid browser session/)
    const instructions = await readFile(join(root, 'tab-1', '.github', 'instructions', 'browser.instructions.md'), 'utf8')
    assert.match(instructions, /find exceptions/)
    assert.match(instructions, /COPILOT_DESKTOP_BROWSER_HELPER.*console/)
    assert.match(instructions, /Run status first before each console or network inspection/)
    assert.match(instructions, /For console, check\s+recordingConsole and preserveConsole; for network, check recordingNetwork and\s+preserveNetwork/)
    assert.match(instructions, /capture is paused and new events are not being recorded/)
    assert.match(instructions, /history is incomplete because a page's entries are discarded on navigation/)
    assert.match(instructions, /An empty log only means\s+no matching entries were captured in the retained log; do not claim the web app\s+has no exceptions or failed requests/)
    assert.match(instructions, /When asked to inspect the web app or a Jira ticket/)
    assert.match(instructions, /Every application activation requires approval/)
    assert.match(instructions, /Do not simulate approval, bypass the dialog/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('PowerShell page-reading commands preserve scoped arguments, method and screenshot output without credentials', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-reader-helper-'))
  const exec = promisify(execFile)
  const token = 'c'.repeat(64)
  const seen: { method: string | undefined; url: string | undefined }[] = []
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    seen.push({ method: request.method, url: request.url })
    response.setHeader('content-type', 'application/json')
    response.end(request.url?.startsWith('/read/screenshot') ? JSON.stringify({ state: 'available', imageBase64: Buffer.from('fixture-png').toString('base64'), redacted: true }) : JSON.stringify({ state: 'available' }))
  })
  try {
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
    const env = await prepareBrowserSessionEnvironment(root, 'tab-1', process.env)
    const paths = browserSessionPaths(root, 'tab-1')
    await writeFile(paths.endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token }))
    for (const args of [['snapshot', '123', 'FRAME'], ['select', '123'], ['scroll', '123', 'FRAME', '-700'],
      ['activate', '123', 'FRAME', 'a'.repeat(32), 'n3'], ['response', 'b123-7'], ['screenshot', '123', '-OutputPath', join(root, 'image.png')]]) {
      const result = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, ...args], { env, windowsHide: true, timeout: 60000 })
      assert.ok(!result.stdout.includes(token)); assert.ok(!result.stdout.includes('imageBase64'))
      assert.equal(JSON.parse(result.stdout).state, 'available')
    }
    assert.deepEqual(seen.slice(0, 3), [
      { method: 'GET', url: '/read/snapshot?arg=123&arg=FRAME' },
      { method: 'POST', url: '/read/select?arg=123' },
      { method: 'POST', url: '/read/scroll?arg=123&arg=FRAME&arg=-700' },
    ])
    assert.equal(seen[3]?.method, 'POST')
    assert.equal(seen[4]?.url, '/read/response?arg=b123-7')
    assert.equal(await readFile(join(root, 'image.png'), 'utf8'), 'fixture-png')
    for (const command of ['tabs', 'snapshot', 'frames', 'responses']) {
      const result = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, command], { env, windowsHide: true, timeout: 60000 })
      assert.equal(JSON.parse(result.stdout).state, 'available')
      assert.equal(seen.at(-1)?.url, `/read/${command}`)
    }
    const currentPageImage = join(root, 'current-page.png')
    await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, 'screenshot', '-OutputPath', currentPageImage], { env, windowsHide: true, timeout: 60000 })
    assert.equal(seen.at(-1)?.url, '/read/screenshot')
    assert.equal(await readFile(currentPageImage, 'utf8'), 'fixture-png')
    await assert.rejects(exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, 'screenshot', '123', '-OutputPath', join(root, 'image.png')], { env, windowsHide: true, timeout: 60000 }))
    assert.equal(await readFile(join(root, 'image.png'), 'utf8'), 'fixture-png', 'screenshots cannot overwrite a file')
    const requestCount = seen.length
    for (const invalid of ['ticket.png', '\\\\host\\share\\ticket.png', '\\\\?\\C:\\ticket.png', '\\\\.\\pipe\\ticket.png', 'C:ticket.png',
      join(root, 'ticket.exe'), 'C:\\Temp\\CON.png', 'C:\\Temp\\ticket.png:stream.png', '']) {
      await assert.rejects(exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, 'screenshot', '123', '-OutputPath', invalid],
        { env, windowsHide: true, timeout: 60000 }), /local absolute .png/)
    }
    assert.equal(seen.length, requestCount, 'invalid paths never contact the browser endpoint')
  } finally { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }) }
})

test('the installed-app PowerShell helper reads only its assigned session without Node or desktop CLI', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-helper-'))
  const exec = promisify(execFile)
  const servers: ReturnType<typeof createServer>[] = []
  try {
    for (const [tabId, message] of [['tab-1', 'Uncaught Error: first-session'], ['tab-2', 'Uncaught Error: second-session']] as const) {
      const token = tabId === 'tab-1' ? 'a'.repeat(64) : 'b'.repeat(64)
      const server = createServer((request, response) => {
        assert.equal(request.method, 'GET')
        assert.equal(request.url, '/console')
        assert.equal(request.headers.authorization, `Bearer ${token}`)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify([{ level: 'error', message, source: 'app.js', line: 12 }]))
      })
      servers.push(server)
      await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
      const env = await prepareBrowserSessionEnvironment(root, tabId, process.env)
      const paths = browserSessionPaths(root, tabId)
      await writeFile(paths.endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token }))
      const result = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, 'console'], { env, windowsHide: true, timeout: 60000 })
      assert.deepEqual(JSON.parse(result.stdout), [{ level: 'error', message, source: 'app.js', line: 12 }])
      assert.equal(result.stderr, '')
      assert.ok(!result.stdout.includes(token))
      await rm(paths.endpoint)
      await assert.rejects(exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, 'console'], { env, windowsHide: true, timeout: 60000 }), /Open the Browser pane for this session/)
    }
  } finally {
    for (const server of servers) { server.closeAllConnections(); server.close() }
    await rm(root, { recursive: true, force: true })
  }
})
