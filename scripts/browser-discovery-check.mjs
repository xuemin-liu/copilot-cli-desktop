import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/browser-discovery')
const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'all'
assert.ok(['all', 'privacy', 'large', 'opacity', 'numeric'].includes(selected))
if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), `--case=${selected}`], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 180000)
  try {
    assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0)
    assert.equal(JSON.parse(await readFile(join(artifacts, `result-${selected}.json`), 'utf8')).passed, true)
  } finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.setPath('userData', join(artifacts, `profile-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { BrowserDebug } = await import('../dist/src/main/browser-debug.js')
    const { browserCommand } = await import('../dist/src/cli/browser-control.js')
    const { prepareBrowserSessionEnvironment } = await import('../dist/src/main/browser-session.js')
    const confidential = ['ConfidentialDirect739', 'ConfidentialAncestor739', 'ConfidentialShadow739']
    const privacy = `<button id="public" title="Public tool">Public</button>
      <button id="direct" data-private title="${confidential[0]}" aria-label="${confidential[0]}">${confidential[0]}</button>
      <div data-private><button id="nested" title="${confidential[1]}" aria-label="${confidential[1]}">${confidential[1]}</button></div>
      <div id="shadow" data-private></div><script>shadow.attachShadow({mode:'open'}).innerHTML='<button id="shadow-button" title="${confidential[2]}">${confidential[2]}</button>'</script>`
    const numeric = `<input id="public-number" type="number" value="42.5">
      <input id="password" type="password" value="123456">
      <input id="otp" autocomplete="section-login one-time-code" value="123456">
      <input id="card" autocomplete="billing cc-number" value="123456">
      <input id="new-password" autocomplete="new-password" value="123456">
      <input id="direct" data-private value="123456">
      <div data-private><input id="nested" type="number" value="123456"><span id="private-text">123456</span></div>
      <div id="aggregate"><span data-private>123456</span></div>
      <div id="shadow" data-private></div><script>shadow.attachShadow({mode:'open'}).innerHTML='<input id="shadow-number" type="number" value="123456">'</script>`
    const site = createServer((request, response) => {
      const route = new URL(request.url, 'http://localhost')
      response.setHeader('content-type', 'text/html')
      const body = route.pathname === '/privacy' ? privacy : route.pathname === '/numeric' ? numeric
        : route.pathname === '/opacity' ? `<label style="display:block;position:relative;width:100px;height:30px"><input id="toggle" type="checkbox" checked style="opacity:0;position:absolute;inset:0;width:24px;height:24px;z-index:1"><span>Accept</span></label>`
          : `<button id="early">Early</button>${'<div>row</div>'.repeat(Number(route.searchParams.get('count') ?? 12000))}<button id="late" onclick="result.textContent=event.isTrusted?'clicked':'untrusted'">Late</button><p id="result">idle</p>`
      response.end(`<!doctype html><title>Discovery regression fixture</title><body>${body}</body>`)
    })
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${site.address().port}`
    const window = new BrowserWindow({ show: false, width: 1100, height: 850 })
    await window.loadURL('data:text/html,Discovery regression host')
    const endpoint = join(artifacts, 'control.json')
    Object.assign(process.env, await prepareBrowserSessionEnvironment(join(artifacts, 'helpers'), 'tab-1', process.env), { COPILOT_DESKTOP_BROWSER_STATE: endpoint })
    const browser = new BrowserDebug(window, join(artifacts, `settings-${Date.now()}.json`), { endpointPath: endpoint })
    let sequence = 0
    const observations = [], failures = []
    const execute = async steps => {
      const stem = join(artifacts, `${Date.now()}-${++sequence}`)
      await writeFile(stem + '.plan.json', JSON.stringify({ description: 'Discovery regression', expected: 'Public controls work and protected content is withheld', steps }))
      const report = await browserCommand(['test', stem + '.plan.json', stem + '.report.json'])
      observations.push({ path: report.path, status: report.status })
      return report
    }
    const check = async (name, work) => {
      if (selected !== 'all' && selected !== name) return
      try { await work(); observations.push({ name, outcome: 'passed' }) }
      catch (error) { failures.push({ name, reason: error.message }); console.error(`${name}: ${error.message}`) }
    }
    const passed = report => assert.equal(report.status, 'passed', JSON.stringify(report.steps))
    try {
      browser.setBounds({ x: 0, y: 0, width: 1000, height: 700 }); window.showInactive(); await browser.open()
      await browser.navigate(url + '/privacy'); browser.action('testing:on')
      await check('privacy', async () => {
        const discovery = await browserCommand(['test-targets'])
        const plan = await execute([{ action: 'discover' }, { action: 'assert', selector: '#public', condition: 'visible' }])
        passed(plan)
        for (const value of [discovery, plan.steps[0].data.discovery]) {
          assert.ok(confidential.every(text => !JSON.stringify(value).includes(text)), 'private tooltip or name escaped discovery')
          assert.equal(value.targets.find(target => target.selector === '#public').title, 'Public tool')
          for (const id of ['direct', 'nested', 'shadow-button']) {
            const target = value.targets.find(target => target.selector === '#' + id)
            assert.equal(target.name, '[private]'); assert.equal(target.title, '[private]')
          }
        }
      })
      await check('large', async () => {
        for (const count of [8000, 12000]) {
          await browser.navigate(url + '/large?count=' + count)
          const started = Date.now(), discovery = await browserCommand(['test-targets'])
          observations.push({ count, discoveryMs: Date.now() - started, inspection: discovery.inspection })
          assert.ok(discovery.targets.some(target => target.selector === '#late'), 'late explicit control was crowded out by leaf divs')
          assert.equal(discovery.targets.find(target => target.selector === '#late').selectorUnique, true)
          assert.equal(discovery.targets.find(target => target.selector === 'div').selectorUnique, false)
          assert.ok(discovery.targets.length <= 200 && discovery.unavailable.length <= 50)
          passed(await execute([{ action: 'discover' }, { action: 'reload' }, { action: 'click', selector: '#late' }, { action: 'assert', selector: '#result', condition: 'text', expected: 'clicked' }]))
        }
        await browser.navigate(url + '/large?count=32000')
        const limited = await browserCommand(['test-targets'])
        assert.equal(limited.truncated, true); assert.equal(limited.inspection.complete, false)
        assert.ok(limited.inspection.visited <= 30000)
        assert.equal(limited.targets.find(target => target.selector === '#early').selectorUnique, false, 'partial traversal must not claim unique selectors')
      })
      await check('opacity', async () => {
        await browser.navigate(url + '/opacity')
        passed(await execute([{ action: 'assert', selector: '#toggle', condition: 'checked', expected: true },
          { action: 'click', selector: '#toggle' }, { action: 'assert', selector: '#toggle', condition: 'checked', expected: false }]))
        const target = (await browserCommand(['test-targets'])).targets.find(target => target.selector === '#toggle')
        assert.equal(target.reason, 'transparent; may still receive input')
      })
      await check('numeric', async () => {
        await browser.navigate(url + '/numeric')
        passed(await execute([{ action: 'assert', selector: '#public-number', condition: 'numericValue', expected: 42.5, tolerance: 0.01 }]))
        for (const id of ['password', 'otp', 'card', 'new-password', 'direct', 'nested', 'shadow-number']) for (const condition of ['numericValue', 'value', 'text']) {
          const report = await execute([{ action: 'assert', selector: '#' + id, condition, expected: condition === 'numericValue' ? 123456 : '123456', timeoutMs: 100,
            ...(condition === 'numericValue' ? { tolerance: 999999 } : {}) }])
          assert.equal(report.status, 'failed', `${id}/${condition} exposed a sensitive value`)
          assert.match(report.steps[0].reason, /private|sensitive/i, `${id}/${condition} must report the privacy restriction`)
        }
        for (const id of ['private-text', 'aggregate']) for (const condition of ['text', 'numericValue']) {
          const report = await execute([{ action: 'assert', selector: '#' + id, condition, expected: condition === 'text' ? '123456' : 123456, timeoutMs: 100 }])
          assert.equal(report.status, 'failed'); assert.match(report.steps[0].reason, /private|sensitive/i)
        }
      })
      await writeFile(join(artifacts, `result-${selected}.json`), JSON.stringify({ passed: failures.length === 0, failures, observations }, null, 2))
      assert.equal(failures.length, 0, JSON.stringify(failures))
      console.log(`Browser discovery regressions passed (${selected}). Evidence: ${artifacts}`)
    } finally { await browser.dispose(); window.destroy(); site.closeAllConnections(); site.close(); app.quit() }
  }
}
