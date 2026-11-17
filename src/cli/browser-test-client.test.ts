import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { executeBrowserTest, loadBrowserTest, parseTestForm, testBaselinePaths, validateTestPath } from './browser-test-client.js'
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
    if (data.description === 'Reject app') {
      response.statusCode = 400; response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ message: 'Invalid browser test: fixture rejection.' })); return
    }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reply))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    await writeFile(endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token }))
    await writeFile(input, JSON.stringify(plan))
    process.env.COPILOT_DESKTOP_BROWSER_STATE = endpoint; process.env.COPILOT_TEST_PASSWORD = 'fixture-private-value'
    const result = await browserCommand(['test', input, join(root, 'cli-report.json')])
    assert.ok(!JSON.stringify(result).includes('fixture-private-value')); assert.ok(!JSON.stringify(result).includes(token))
    const rejectedPlan = { ...plan, description: 'Reject app', steps: [...plan.steps, { action: 'screenshot', label: 'Second evidence' }] }
    const missing = async (paths: string[]) => {
      for (const path of paths) await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    }
    const cliRejected = join(root, 'cli-server-rejected.json')
    await writeFile(input, JSON.stringify(rejectedPlan))
    await assert.rejects(browserCommand(['test', input, cliRejected]), /Invalid browser test: fixture rejection/)
    await missing([cliRejected, join(root, 'cli-server-rejected.image-1.png'), join(root, 'cli-server-rejected.image-2.png')])
    await writeFile(input, JSON.stringify(plan))
    assert.equal((await browserCommand(['test', input, cliRejected]) as { status: string }).status, 'passed', 'Node CLI reuses a rejected plan output path')
    if (process.platform === 'win32') {
      const env = await prepareBrowserSessionEnvironment(root, 'tab-1', process.env)
      env.COPILOT_DESKTOP_BROWSER_STATE = endpoint
      const helper = browserSessionPaths(root, 'tab-1').helper; const output = join(root, 'shell-report.json')
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, 'test', input, '-OutputPath', output]
      const shell = await promisify(execFile)('powershell.exe', args, { env, windowsHide: true, timeout: 60000 })
      const report = JSON.parse(shell.stdout)
      assert.equal(report.status, 'passed'); assert.ok(!shell.stdout.includes('fixture-private-value')); assert.ok(!shell.stdout.includes('imageBase64'))
      assert.equal(await readFile(report.screenshots[0].path, 'utf8'), 'fixture-png')
      const rejectedOutput = join(root, 'server-rejected.json')
      await writeFile(input, JSON.stringify(rejectedPlan))
      const rejected = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, 'test', input,
        '-OutputPath', rejectedOutput], { env, windowsHide: true, timeout: 60000 }).then(() => null, error => error)
      assert.ok(rejected); assert.match(rejected.stderr, /Invalid browser test: fixture rejection/)
      await missing([rejectedOutput, join(root, 'server-rejected.image-1.png'), join(root, 'server-rejected.image-2.png')])
      await writeFile(input, JSON.stringify(plan))
      const reused = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, 'test', input,
        '-OutputPath', rejectedOutput], { env, windowsHide: true, timeout: 60000 })
      assert.equal(JSON.parse(reused.stdout).status, 'passed', 'PowerShell reuses a rejected plan output path')
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

test('a comparison baseline is read by the caller, sent with the plan, and its capture and diff are saved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-test-baseline-'))
  const input = join(root, 'plan.json'); const baseline = join(root, 'cell one.png')
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1, 2])
  const savedEndpoint = process.env.COPILOT_DESKTOP_BROWSER_STATE
  const token = 'b'.repeat(64); const seen: any[] = []
  const comparePlan = { description: 'Compare', expected: 'Matches', steps: [{ action: 'compareScreenshot', selector: '#cell', baseline }] }
  const compareReply = { status: 'failed', steps: [{ status: 'failed' }], screenshots: [
    { step: 1, redacted: false, kind: 'capture', imageBase64: Buffer.from('capture-png').toString('base64') },
    { step: 1, redacted: false, kind: 'diff', imageBase64: Buffer.from('diff-png').toString('base64') }] }
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    seen.push(JSON.parse(body))
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(compareReply))
  })
  try {
    await writeFile(baseline, bytes)
    await writeFile(input, JSON.stringify(comparePlan))
    const loaded = await loadBrowserTest(input, {})
    assert.equal(loaded.steps[0]!.baselineImage, bytes.toString('base64'))
    assert.equal(loaded.steps[0]!.baseline, baseline, 'the path stays in the plan for the report')
    const result = await executeBrowserTest(loaded, input, join(root, 'report.json'), async () => structuredClone(compareReply))
    assert.deepEqual(result.screenshots.map(image => image.kind), ['capture', 'diff'])
    assert.equal(await readFile(result.screenshots[1]!.path!, 'utf8'), 'diff-png')
    await assert.rejects(executeBrowserTest(loaded, input, join(root, 'too-many.json'), async () => ({ ...compareReply, screenshots: [...compareReply.screenshots, compareReply.screenshots[0]] })), /Invalid browser test response/)
    await writeFile(input, JSON.stringify({ ...comparePlan, steps: [{ ...comparePlan.steps[0], baselineImage: 'AAAA' }] }))
    await assert.rejects(loadBrowserTest(input, {}), /attached by the helper/)
    await writeFile(input, JSON.stringify({ ...comparePlan, steps: [{ ...comparePlan.steps[0], baseline: join(root, 'missing.png') }] }))
    await assert.rejects(loadBrowserTest(input, {}), /does not exist/)
    await writeFile(join(root, 'large.png'), Buffer.alloc(2 * 1024 * 1024 + 1))
    await writeFile(input, JSON.stringify({ ...comparePlan, steps: [{ ...comparePlan.steps[0], baseline: join(root, 'large.png') }] }))
    await assert.rejects(loadBrowserTest(input, {}), /exceeds 2 MiB/)
    await writeFile(input, JSON.stringify({ ...comparePlan, steps: [{ ...comparePlan.steps[0], baseline: 'cell.png' }] }))
    await assert.rejects(loadBrowserTest(input, {}), /local absolute .png/)

    // The macOS and Linux helper sends the file's bytes in form fields; the desktop matches them to the plan by path.
    const form = new Map([['plan', JSON.stringify(comparePlan)], ['output', join(root, 'form-report.json')], ['baseline-1', bytes.toString('base64')], ['baselinePath-1', baseline]])
    assert.equal(parseTestForm(form).plan.steps[0]!.baselineImage, bytes.toString('base64'))
    assert.throws(() => parseTestForm(new Map([...form].filter(([name]) => name !== 'baseline-1'))), /reference image was not attached/)
    assert.throws(() => parseTestForm(new Map([...form, ['baselinePath-1', join(root, 'other.png')]])), /reference image was not attached/)

    if (process.platform === 'win32') {
      const endpoint = join(root, 'control.json')
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      await writeFile(endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token }))
      const env = await prepareBrowserSessionEnvironment(root, 'tab-1', process.env)
      env.COPILOT_DESKTOP_BROWSER_STATE = endpoint
      const helper = browserSessionPaths(root, 'tab-1').helper
      const run = (output: string) => promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, 'test', input, '-OutputPath', output], { env, windowsHide: true, timeout: 60000 })
      await writeFile(input, JSON.stringify(comparePlan))
      const report = JSON.parse((await run(join(root, 'shell-report.json'))).stdout)
      assert.equal(seen.at(-1).steps[0].baselineImage, bytes.toString('base64'), 'PowerShell reads the baseline and sends it as base64')
      assert.deepEqual(report.screenshots.map((image: { kind: string }) => image.kind), ['capture', 'diff'])
      assert.equal(await readFile(report.screenshots[0].path, 'utf8'), 'capture-png')
      const count = seen.length
      for (const [steps, message] of [[[{ ...comparePlan.steps[0], baselineImage: 'AAAA' }], /attached by the helper/], [[{ ...comparePlan.steps[0], baseline: join(root, 'missing.png') }], /does not exist/],
        [[{ ...comparePlan.steps[0], baseline: join(root, 'large.png') }], /exceeds 2 MiB/], [[{ ...comparePlan.steps[0], baseline: '\\\\host\\share\\cell.png' }], /local absolute .png/]] as const) {
        await writeFile(input, JSON.stringify({ ...comparePlan, steps }))
        const failure = await run(join(root, `rejected-${seen.length}-${String(message).length}.json`)).then(() => null, error => error)
        assert.ok(failure); assert.match(failure.stderr, message)
      }
      assert.equal(seen.length, count, 'an invalid baseline is refused before any request')
    }
  } finally {
    if (savedEndpoint === undefined) delete process.env.COPILOT_DESKTOP_BROWSER_STATE; else process.env.COPILOT_DESKTOP_BROWSER_STATE = savedEndpoint
    if (server.listening) { server.closeAllConnections(); server.close() } await rm(root, { recursive: true, force: true })
  }
})

test('the baseline paths a plan names are decoded from its JSON, once each, whatever the spelling', () => {
  const path = process.platform === 'win32' ? 'C:/tests/cell ' + String.fromCharCode(0x4e2d) + '.png' : '/tmp/tests/cell ' + String.fromCharCode(0x4e2d) + '.png'
  const escaped = JSON.stringify(path).replaceAll('/', '\\/').replace(String.fromCharCode(0x4e2d), '\\u4e2d')
  const text = `{ "steps" : [ { "action" : "compareScreenshot", "baseline" :\n ${escaped} }, { "action": "compare\\u0053creenshot", "baseline": ${JSON.stringify(path)} },
    { "action": "screenshot", "baseline": "/elsewhere.png" }, { "action": "assert", "label": "\\"baseline \\": \\"/tmp/fake.png \\"" } ] }`
  assert.deepEqual(testBaselinePaths(text), [path], 'escaped and literal spellings name one file; other steps and strings name none')
  assert.deepEqual(testBaselinePaths('not json'), [], 'a plan that is not JSON names none; its run reports the error')
  assert.deepEqual(testBaselinePaths('\uFEFF' + JSON.stringify({ steps: [] })), [])
  assert.throws(() => testBaselinePaths(JSON.stringify({ steps: [{ action: 'compareScreenshot', baseline: 'cell.png' }] })), /local absolute .png/)
  const many = Array.from({ length: 6 }, (_, index) => ({ action: 'compareScreenshot', baseline: path.replace('.png', `${index}.png`) }))
  assert.throws(() => testBaselinePaths(JSON.stringify({ steps: many })), /five screenshots and comparisons/)
})
