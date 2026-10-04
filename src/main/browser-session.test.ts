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
  } finally { await rm(root, { recursive: true, force: true }) }
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
      const result = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, 'console'], { env, windowsHide: true, timeout: 15000 })
      assert.deepEqual(JSON.parse(result.stdout), [{ level: 'error', message, source: 'app.js', line: 12 }])
      assert.equal(result.stderr, '')
      assert.ok(!result.stdout.includes(token))
      await rm(paths.endpoint)
      await assert.rejects(exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, 'console'], { env, windowsHide: true, timeout: 15000 }), /Open the Browser pane for this session/)
    }
  } finally {
    for (const server of servers) { server.closeAllConnections(); server.close() }
    await rm(root, { recursive: true, force: true })
  }
})
