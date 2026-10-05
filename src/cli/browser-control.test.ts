import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { browserCommand, browserControlPath, readBrowserControl, validateBrowserScreenshotPath } from './browser-control.js'

test('browser endpoint uses configured state location', () => {
  assert.equal(browserControlPath({ COPILOT_DESKTOP_BROWSER_STATE: 'custom.json' }), 'custom.json')
  assert.equal(browserControlPath({ COPILOT_DESKTOP_CLI_HOME: 'custom-home' }), join('custom-home', 'browser.json'))
})

test('endpoint validation rejects malformed, stale and invalid state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-control-'))
  const path = join(directory, 'browser.json')
  const valid = { pid: process.pid, port: 1234, token: 'a'.repeat(64) }
  try {
    await assert.rejects(readBrowserControl(path), /Open the Browser pane/)
    await writeFile(path, '{bad JSON')
    await assert.rejects(readBrowserControl(path), /Open the Browser pane/)
    for (const invalid of [null, { ...valid, pid: 0 }, { ...valid, pid: 2147483647 },
      { ...valid, port: 65536 }, { ...valid, port: 1.5 }, { ...valid, token: 'bad' }]) {
      await writeFile(path, JSON.stringify(invalid))
      await assert.rejects(readBrowserControl(path), /stale or invalid/)
    }
    await writeFile(path, JSON.stringify(valid))
    assert.deepEqual(await readBrowserControl(path), valid)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('command arguments reject invalid request IDs and extra arguments before contacting the app', async () => {
  for (const args of [['request', 'abc'], ['request'], ['request', '-1'], ['status', 'extra'], ['console', 'a', 'b']]) {
    await assert.rejects(browserCommand(args), /Usage/)
  }
  await assert.rejects(browserCommand(['navigate']), /Use browser/)
})

test('screenshots reject network, device, relative and non-PNG output paths before contacting the app', async () => {
  const invalid = ['ticket.png', '\\\\host\\share\\ticket.png', '//host/share/ticket.png', '\\\\?\\C:\\ticket.png', '\\\\.\\pipe\\ticket.png', 'C:ticket.png', join(tmpdir(), 'ticket.exe'), '']
  if (process.platform === 'win32') invalid.push('C:\\Temp\\CON.png', 'C:\\Temp\\ticket.png:stream.png', 'C:\\Temp\\bad?.png')
  for (const path of invalid) {
    assert.throws(() => validateBrowserScreenshotPath(path), /local absolute .png/)
    await assert.rejects(browserCommand(['screenshot', '123', path]), /local absolute .png/)
  }
  validateBrowserScreenshotPath(join(tmpdir(), 'ticket.PNG'))
})

test('CLI routes, authentication and friendly errors use a real loopback endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-command-'))
  const path = join(directory, 'browser.json')
  const previous = process.env.COPILOT_DESKTOP_BROWSER_STATE
  const token = 'b'.repeat(64)
  let mode = 'json'
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    if (mode === 'html') { response.end('<html>unavailable</html>'); return }
    if (mode === 'error') { response.writeHead(404); response.end(JSON.stringify({ message: 'Request not found' })); return }
    if (mode === 'null') { response.writeHead(500); response.end('null'); return }
    if (mode === 'image') { response.end(JSON.stringify({ state: 'available', imageBase64: Buffer.from('fixture-png').toString('base64') })); return }
    response.end(JSON.stringify({ route: request.url }))
  })
  try {
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
    const port = (server.address() as { port: number }).port
    await writeFile(path, JSON.stringify({ pid: process.pid, port, token }))
    process.env.COPILOT_DESKTOP_BROWSER_STATE = path
    for (const command of ['status', 'console', 'network']) assert.deepEqual(await browserCommand([command]), { route: `/${command}` })
    assert.deepEqual(await browserCommand(['request', '123']), { route: '/request/123' })
    assert.deepEqual(await browserCommand(['snapshot', '123', 'FRAME']), { route: '/read/snapshot?arg=123&arg=FRAME' })
    assert.deepEqual(await browserCommand(['scroll', '123', 'FRAME', '-100']), { route: '/read/scroll?arg=123&arg=FRAME&arg=-100' })
    mode = 'image'
    const imagePath = join(directory, 'ticket.png')
    assert.deepEqual(await browserCommand(['screenshot', '123', imagePath]), { state: 'available', path: imagePath })
    assert.equal(await readFile(imagePath, 'utf8'), 'fixture-png')
    await assert.rejects(browserCommand(['screenshot', '123', imagePath]), /EEXIST/)
    mode = 'error'; await assert.rejects(browserCommand(['request', '999']), /Request not found/)
    mode = 'null'; await assert.rejects(browserCommand(['status']), /Browser request failed \(500\)/)
    mode = 'html'; await assert.rejects(browserCommand(['status']), /Browser control is not responding/)
    server.closeAllConnections()
    await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))
    await assert.rejects(browserCommand(['status']), /Browser control is not responding/)
    assert.equal((await readBrowserControl(path)).token, token, 'a transient failure must not remove the live endpoint')
  } finally {
    server.closeAllConnections(); server.close()
    if (previous === undefined) delete process.env.COPILOT_DESKTOP_BROWSER_STATE
    else process.env.COPILOT_DESKTOP_BROWSER_STATE = previous
    await rm(directory, { recursive: true, force: true })
  }
})
