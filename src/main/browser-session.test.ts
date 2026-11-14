import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { browserSessionPaths, prepareBrowserSessionEnvironment } from './browser-session.js'
import { isFormType, parseFormFields } from './form-body.js'

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

test('the sh helper sends the same requests, names a new screenshot file, and uploads a test plan with its inputs', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-sh-helper-'))
  const exec = promisify(execFile)
  const token = 'd'.repeat(64)
  const seen: { method: string | undefined; url: string | undefined; form?: Map<string, string> }[] = []
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => void (async () => {
      const type = request.headers['content-type']
      const form = isFormType(type) ? await parseFormFields(Buffer.concat(chunks), type!) ?? undefined : undefined
      seen.push({ method: request.method, url: request.url, ...(form ? { form } : {}) })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/console') { response.statusCode = 400; response.end(JSON.stringify({ message: 'Capture "paused"' })); return }
      response.end(JSON.stringify({ state: 'available' }))
    })())
  })
  try {
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
    const env = await prepareBrowserSessionEnvironment(root, 'tab-1', { ...process.env, COPILOT_TEST_PASSWORD: 'pa"ss\\word', OTHER_SECRET: 'nope' })
    const paths = browserSessionPaths(root, 'tab-1')
    assert.match(paths.helper, /browser\.sh$/)
    await writeFile(paths.endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token }))
    const run = (...args: string[]) => exec('sh', [paths.helper, ...args], { env, timeout: 60000 })
    for (const args of [['snapshot', '123', 'FRAME'], ['select', '123'], ['scroll', '123', 'FRAME', '-700'], ['response', 'b123-7'], ['status']]) {
      const result = await run(...args)
      assert.equal(JSON.parse(result.stdout).state, 'available')
      assert.ok(!result.stdout.includes(token))
    }
    // The sh helper percent-encodes every byte of an argument; the server reads the same values.
    assert.deepEqual(seen.map(({ method, url }) => ({ method, url: decodeURIComponent(url!) })), [
      { method: 'GET', url: '/read/snapshot?arg=123&arg=FRAME' },
      { method: 'POST', url: '/read/select?arg=123' },
      { method: 'POST', url: '/read/scroll?arg=123&arg=FRAME&arg=-700' },
      { method: 'GET', url: '/read/response?arg=b123-7' },
      { method: 'GET', url: '/status' },
    ])
    const image = join(root, 'shot one.png')
    await run('screenshot', '-OutputPath', image)
    const shot = new URL(seen.at(-1)!.url!, 'http://127.0.0.1')
    assert.equal(shot.pathname, '/read/screenshot')
    assert.equal(shot.searchParams.get('save'), image, 'the desktop is told which new file to write')
    const count = seen.length
    for (const invalid of ['ticket.png', join(root, 'ticket.exe'), '//host/share/ticket.png', '']) {
      await assert.rejects(run('screenshot', '-OutputPath', invalid), /local absolute .png/)
    }
    await assert.rejects(run('status', '-OutputPath', image), /only supported for screenshots/)
    assert.equal(seen.length, count, 'invalid paths never contact the browser endpoint')
    await assert.rejects(run('console'), /Browser diagnostics failed: Capture "paused"/)
    const plan = join(root, 'plan.json')
    await writeFile(plan, '{"description":"x","steps":[{"action":"fill","selector":"#p","valueFromEnv":"COPILOT_TEST_PASSWORD"}]}')
    const report = join(root, 'report.json')
    await run('test', plan, '-OutputPath', report)
    const sent = seen.at(-1)!
    assert.equal(sent.url, '/test')
    assert.equal(sent.form?.get('plan'), await readFile(plan, 'utf8'))
    assert.equal(sent.form?.get('output'), report)
    assert.equal(sent.form?.get('env:COPILOT_TEST_PASSWORD'), 'pa"ss\\word')
    assert.ok(![...sent.form!.keys()].some((key) => key.includes('OTHER_SECRET')), 'only COPILOT_TEST_ inputs are sent')
    await run('test', plan)
    assert.match(seen.at(-1)!.form!.get('output')!, /plan\.report-[0-9a-f]{16}\.json$/)
    await rm(paths.endpoint)
    await assert.rejects(run('console'), /Open a Browser tab and connect it to this session/)
  } finally { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }) }
})

test('the PowerShell helper prints the desktop message once, on one line', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-helper-error-'))
  const exec = promisify(execFile)
  let reply = { status: 400, body: '' }
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.statusCode = reply.status
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(reply.body)
    })
  })
  try {
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
    const env = await prepareBrowserSessionEnvironment(root, 'tab-1', process.env)
    const paths = browserSessionPaths(root, 'tab-1')
    await writeFile(paths.endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token: 'e'.repeat(64) }))
    const failure = (args: string[]) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, ...args], { env, windowsHide: true, timeout: 60000 })
      .then(() => '', (error: { stderr?: string }) => error.stderr ?? '')
    // Page-authored dialog text must not turn into extra helper output that looks like a result.
    reply = { status: 400, body: JSON.stringify({ message: 'Blocked by a page dialog.\n\nPress Resume in the browser pane.' }) }
    assert.match(await failure(['console']), /^Browser diagnostics failed: Blocked by a page dialog\. Press Resume in the browser pane\.\r?\n$/)
    // C1 controls, line/paragraph separators and a terminal sequence stay off the line too.
    reply = { status: 400, body: JSON.stringify({ message: 'one\u0085two\u2028three\u2029four\u009b31mfive' }) }
    assert.match(await failure(['console']), /^Browser diagnostics failed: one two three four 31mfive\r?\n$/)
    // Windows PowerShell captures an error body through ErrorDetails, which leaves one line.
    reply = { status: 400, body: JSON.stringify({ message: 'Usage: browser.ps1 status|console|network|request 123' }) }
    assert.match(await failure(['snapshot', '123', 'FRAME']), /^Browser diagnostics failed: Usage: browser\.ps1 status\|console\|network\|request 123\r?\n$/)
    // A body that is not JSON still reports one line instead of the raw page.
    reply = { status: 500, body: '<html>gateway down</html>' }
    const fallback = await failure(['console'])
    assert.match(fallback, /^Browser diagnostics failed: [^\r\n]+\r?\n$/)
    assert.ok(!fallback.includes('gateway'), 'a non-JSON body is not echoed as the message')
  } finally {
    server.closeAllConnections(); server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('the PowerShell test helper reports missing pane guidance and keeps evidence only for a started run', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-test-helper-'))
  const exec = promisify(execFile)
  let reply = { status: 400, body: '' }
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.statusCode = reply.status
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(reply.body)
    })
  })
  try {
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
    const env = await prepareBrowserSessionEnvironment(root, 'tab-1', process.env)
    const paths = browserSessionPaths(root, 'tab-1')
    const plan = join(root, 'plan.json')
    await writeFile(plan, JSON.stringify({ description: 'x', steps: [{ action: 'screenshot' }] }))
    const run = (args: string[], environment: NodeJS.ProcessEnv = env) =>
      exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, ...args], { env: environment, windowsHide: true, timeout: 60000 })
    const failure = (args: string[], environment: NodeJS.ProcessEnv = env) => run(args, environment).then(() => '', (error: { stderr?: string }) => error.stderr ?? '')
    const reserved = async (base: string) => (await readdir(root)).filter(name => name.startsWith(base))
    // The pane check comes before the hand-off, so a missing pane names the pane.
    const report = join(root, 'missing.json')
    assert.match(await failure(['test', plan, '-OutputPath', report], { ...env, COPILOT_DESKTOP_BROWSER_STATE: '' }), /^Browser diagnostics failed: Open a Browser tab and connect it to this session; reconnect after Resume\.\r?\n$/)
    assert.deepEqual(await reserved('missing'), [], 'a missing pane reserves nothing')
    await writeFile(paths.endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token: 'e'.repeat(64) }))
    // A payload that arrived but failed validation keeps its evidence, minus the base64 images.
    reply = { status: 200, body: JSON.stringify({ status: 'ok', steps: [], screenshots: [{ imageBase64: 'Zml4dHVyZQ==' }] }) }
    const invalid = join(root, 'invalid.json')
    assert.match(await failure(['test', plan, '-OutputPath', invalid]), /Browser test failed\. Invalid test response/)
    const evidence = await readFile(invalid, 'utf8')
    assert.equal(JSON.parse(evidence).status, 'unavailable')
    assert.equal(JSON.parse(evidence).screenshots[0].imageBase64, undefined)
    assert.ok(!evidence.includes('Zml4dHVyZQ'), 'a preserved payload never holds base64 images')
    // A rejected request the desktop had not started leaves no evidence at all.
    reply = { status: 400, body: JSON.stringify({ message: 'Enable Testing mode in the selected browser page first.' }) }
    assert.match(await failure(['test', plan, '-OutputPath', join(root, 'rejected.json')]), /^Browser test failed\. Enable Testing mode/)
    assert.deepEqual(await reserved('rejected'), [])
    // A run the desktop had started keeps its report so the next step is inspection, not a rerun.
    reply = { status: 400, body: JSON.stringify({ message: 'Stopped: the page changed.\n\nInspect Last test.', executionStarted: true }) }
    assert.match(await failure(['test', plan, '-OutputPath', join(root, 'interrupted.json')]), /^Browser test failed\. Stopped: the page changed\. Inspect Last test\.\r?\n$/)
    const interrupted = JSON.parse(await readFile(join(root, 'interrupted.json'), 'utf8'))
    assert.equal(interrupted.status, 'unavailable')
    assert.equal(interrupted.message, 'Inspect Last test in the browser before rerunning actions.')
    // Nothing reached the desktop, so nothing can have run and nothing is kept.
    const closed = createServer()
    await new Promise<void>(accept => closed.listen(0, '127.0.0.1', accept))
    const closedPort = (closed.address() as { port: number }).port
    await new Promise<void>(accept => closed.close(() => accept()))
    await writeFile(paths.endpoint, JSON.stringify({ pid: process.pid, port: closedPort, token: 'e'.repeat(64) }))
    assert.match(await failure(['test', plan, '-OutputPath', join(root, 'offline.json')]), /Browser test failed\. The desktop did not answer\./)
    assert.deepEqual(await reserved('offline'), [])
  } finally {
    server.closeAllConnections(); server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('the browser session folder stops inheriting profile access to its tokens', { skip: process.platform !== 'win32' }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'browser-dacl-'))
  const root = join(parent, 'browser-sessions')
  const exec = promisify(execFile)
  // .NET types only: the Security module that owns Get-Acl does not autoload under every console host.
  const acl = async (path: string) => {
    const script = [
      '$path = $env:COPILOT_TEST_ACL_PATH',
      '$info = if ([System.IO.Directory]::Exists($path)) { [System.IO.DirectoryInfo]::new($path) } else { [System.IO.FileInfo]::new($path) }',
      '$acl = $info.GetAccessControl()',
      `'protected=' + $acl.AreAccessRulesProtected`,
      `$acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value + '|' + $_.IsInherited }`,
    ].join('\n')
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 60000, env: { ...process.env, COPILOT_TEST_ACL_PATH: path } })
    const [head, ...rules] = stdout.trim().split(/\r?\n/)
    return { protected: (head ?? '').trim() === 'protected=True',
      rules: rules.map(line => { const [sid, inherited] = line.split('|'); return { sid: (sid ?? '').trim(), inherited: (inherited ?? '').trim() === 'True' } }) }
  }
  try {
    await mkdir(root, { recursive: true })
    // A machine-wide group ACE stands in for the profile access a sandbox account group inherits.
    await exec('icacls', [root, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true, timeout: 60000 })
    assert.ok((await acl(root)).rules.some(rule => rule.sid === 'S-1-1-0'))
    await prepareBrowserSessionEnvironment(root, 'tab-1', process.env)
    const protectedRoot = await acl(root)
    assert.ok(protectedRoot.protected, 'the session folder no longer inherits profile access')
    assert.ok(!protectedRoot.rules.some(rule => rule.sid === 'S-1-1-0'), 'a machine-wide group loses the token folder')
    assert.ok(protectedRoot.rules.every(rule => !rule.inherited))
    const endpoint = join(root, 'tab-1', 'control.json')
    await writeFile(endpoint, JSON.stringify({ pid: process.pid, port: 1, token: 'f'.repeat(64) }))
    assert.ok(!(await acl(endpoint)).rules.some(rule => rule.sid === 'S-1-1-0'), 'the token file does not regain the group ACE')
    assert.match(await readFile(join(root, 'tab-1', 'browser.ps1'), 'utf8'), /NoProxy/)
    assert.match(await readFile(join(root, 'tab-1', 'browser-test.ps1'), 'utf8'), /NoProxy/)
    // A typographic apostrophe, which PowerShell also reads as a quote, must not end the script early.
    const quoted = join(parent, 'O’Brien', 'browser-sessions')
    const errors: string[] = []
    const warned: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warned.push(args) }
    try { await prepareBrowserSessionEnvironment(quoted, 'tab-1', process.env, message => errors.push(message)) }
    finally { console.warn = originalWarn }
    assert.deepEqual(errors, [], 'a path with a typographic apostrophe is still protected')
    assert.deepEqual(warned, [], 'the caller reports the failure, not a console nobody sees')
    const quotedRoot = await acl(quoted)
    assert.ok(quotedRoot.protected, 'the protected folder is the one the caller asked for')
    assert.ok(!quotedRoot.rules.some(rule => rule.sid === 'S-1-1-0'), 'a machine-wide group loses this folder too')
  } finally { await rm(parent, { recursive: true, force: true }) }
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
      await assert.rejects(exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, 'console'], { env, windowsHide: true, timeout: 60000 }), /Open a Browser tab and connect it to this session/)
    }
  } finally {
    for (const server of servers) { server.closeAllConnections(); server.close() }
    await rm(root, { recursive: true, force: true })
  }
})
