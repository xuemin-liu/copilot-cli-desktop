import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { executeBrowserTest, loadBrowserTest, validateTestPath } from './browser-test-client.js'
import { browserCommand } from './browser-control.js'
import { browserSessionPaths, prepareBrowserSessionEnvironment } from '../main/browser-session.js'

const plan = { description: 'Test app', expected: 'Result visible', steps: [
  { action: 'fill', label: 'Enter password', selector: '#password', valueFromEnv: 'COPILOT_TEST_PASSWORD' },
  { action: 'assert', label: 'Result', selector: '#result', condition: 'visible' }, { action: 'screenshot', label: 'Evidence' },
] }
const reply = { status: 'passed', steps: [{ status: 'passed' }], screenshots: [{ step: 3, redacted: true, imageBase64: Buffer.from('fixture-png').toString('base64') }] }

test('test client resolves explicit input references, rejects invalid plans and cannot overwrite artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-test-client-'))
  const input = join(root, 'plan.json'); const output = join(root, 'report.json')
  try {
    for (const invalid of ['plan.json', '\\\\host\\share\\plan.json', '\\\\?\\C:\\plan.json', 'C:plan.json', join(root, 'plan.exe')]) assert.throws(() => validateTestPath(invalid))
    await writeFile(input, JSON.stringify(plan))
    await assert.rejects(loadBrowserTest(input, {}), /not set/)
    const loaded = await loadBrowserTest(input, { COPILOT_TEST_PASSWORD: 'private-value' })
    assert.equal(loaded.steps[0]!.value, 'private-value'); assert.ok(!('valueFromEnv' in loaded.steps[0]!))
    for (const name of ['UNRELATED_SECRET_FOR_TEST', 'GH_TOKEN', 'COPILOT_TEST_', 'copilot_test_PASSWORD']) {
      await writeFile(input, JSON.stringify({ ...plan, steps: [{ ...plan.steps[0], valueFromEnv: name }, plan.steps[1]] }))
      await assert.rejects(loadBrowserTest(input, { [name]: 'unrelated-secret' }), /COPILOT_TEST_/)
    }
    let calls = 0
    const result = await executeBrowserTest(loaded, input, output, async () => { calls++; return structuredClone(reply) })
    assert.equal(result.status, 'passed'); assert.ok(!JSON.stringify(result).includes('imageBase64'))
    assert.equal(await readFile(result.screenshots[0]!.path!, 'utf8'), 'fixture-png')
    await assert.rejects(executeBrowserTest(loaded, input, output, async () => { calls++; return reply }), /EEXIST/)
    assert.equal(calls, 1, 'existing output is rejected before performing actions')
    await writeFile(input, JSON.stringify({ ...plan, steps: [{ ...plan.steps[0], value: 'conflicting' }, plan.steps[1]] }))
    await assert.rejects(loadBrowserTest(input, { COPILOT_TEST_PASSWORD: 'private-value' }), /valueFromEnv/)
    await writeFile(input, 'x'.repeat(131073)); await assert.rejects(loadBrowserTest(input), /128 KiB/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI and installed PowerShell test transports send credentials only in the private POST body and save evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-test-transport-'))
  const input = join(root, 'plan.json'); const endpoint = join(root, 'control.json')
  const savedEndpoint = process.env.COPILOT_DESKTOP_BROWSER_STATE; const savedPassword = process.env.COPILOT_TEST_PASSWORD
  const token = 'a'.repeat(64); const seen: unknown[] = []
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/test'); assert.equal(request.method, 'POST'); assert.equal(request.headers.authorization, `Bearer ${token}`)
    let body = ''; for await (const chunk of request) body += chunk
    const data = JSON.parse(body); seen.push(data)
    assert.equal(data.steps[0].value, 'fixture-private-value'); assert.equal(data.steps[0].valueFromEnv, undefined)
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reply))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    await writeFile(endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token }))
    await writeFile(input, JSON.stringify(plan))
    process.env.COPILOT_DESKTOP_BROWSER_STATE = endpoint; process.env.COPILOT_TEST_PASSWORD = 'fixture-private-value'
    const result = await browserCommand(['test', input, join(root, 'cli-report.json')])
    assert.ok(!JSON.stringify(result).includes('fixture-private-value')); assert.ok(!JSON.stringify(result).includes(token))
    if (process.platform === 'win32') {
      const env = await prepareBrowserSessionEnvironment(root, 'tab-1', process.env)
      env.COPILOT_DESKTOP_BROWSER_STATE = endpoint
      const helper = browserSessionPaths(root, 'tab-1').helper; const output = join(root, 'shell-report.json')
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, 'test', input, '-OutputPath', output]
      const shell = await promisify(execFile)('powershell.exe', args, { env, windowsHide: true, timeout: 60000 })
      const report = JSON.parse(shell.stdout)
      assert.equal(report.status, 'passed'); assert.ok(!shell.stdout.includes('fixture-private-value')); assert.ok(!shell.stdout.includes('imageBase64'))
      assert.equal(await readFile(report.screenshots[0].path, 'utf8'), 'fixture-png')
      const count = seen.length
      await assert.rejects(promisify(execFile)('powershell.exe', args, { env, windowsHide: true, timeout: 60000 }))
      assert.equal(seen.length, count, 'PowerShell rejects an existing report before actions')
      for (const name of ['UNRELATED_SECRET_FOR_TEST', 'GH_TOKEN', 'COPILOT_TEST_', 'copilot_test_PASSWORD']) {
        await writeFile(input, JSON.stringify({ ...plan, steps: [{ ...plan.steps[0], valueFromEnv: name }, plan.steps[1]] }))
        const rejection = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, 'test', input,
          '-OutputPath', join(root, `rejected-${name}.json`)], { env: { ...env, [name]: 'unrelated-secret' }, windowsHide: true, timeout: 60000 }).then(() => null, error => error)
        assert.ok(rejection); assert.match(rejection.stderr, /COPILOT_TEST_/)
        assert.equal(seen.length, count, 'PowerShell rejects unrelated environment variables before any request')
      }
    }
  } finally {
    if (savedEndpoint === undefined) delete process.env.COPILOT_DESKTOP_BROWSER_STATE; else process.env.COPILOT_DESKTOP_BROWSER_STATE = savedEndpoint
    if (savedPassword === undefined) delete process.env.COPILOT_TEST_PASSWORD; else process.env.COPILOT_TEST_PASSWORD = savedPassword
    server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true })
  }
})
