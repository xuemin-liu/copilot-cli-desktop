import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { MAX_TELEMETRY_TEXT, restorableUrl, sanitizedHeaders, sanitizedText, sanitizedUrl } from './browser-privacy.js'

test('credential header names redact both string and array representations', () => {
  const names = ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-API-Key',
    'X-Auth-Token', 'X-CSRF-Token', 'X-XSRF-Token', 'X-Amz-Security-Token', 'X-GitHub-Token', 'X-Session-ID']
  for (const name of names) {
    assert.equal(sanitizedHeaders({ [name]: 'header-secret' })[name], '[redacted]')
    assert.deepEqual(sanitizedHeaders({ [name]: ['header-secret', 'second-secret'] })[name], ['[redacted]'])
  }
  assert.deepEqual(sanitizedHeaders({ Accept: 'application/json' }), { Accept: 'application/json' })
})

test('URL telemetry redacts duplicate, encoded and signed credentials while keeping ordinary routing', () => {
  const raw = 'https://user:pass@example.test/path?q=search&%61ccess_token=first&access_token=second&X-Amz-Signature=signed&code=oauth&state=state-secret#access_token=hash-secret'
  const result = new URL(sanitizedUrl(raw))
  assert.equal(result.username, '')
  assert.equal(result.password, '')
  assert.equal(result.searchParams.get('q'), 'search')
  assert.deepEqual(result.searchParams.getAll('access_token'), ['[redacted]'])
  for (const name of ['X-Amz-Signature', 'code', 'state']) assert.equal(result.searchParams.get(name), '[redacted]')
  for (const secret of ['first', 'second', 'signed', 'oauth', 'state-secret', 'hash-secret']) assert.ok(!result.href.includes(secret))
  assert.equal(sanitizedUrl('file:///project/main.js'), 'file:///project/main.js')
})

test('URL-bearing response headers handle absolute and relative callback forms', () => {
  const result = sanitizedHeaders({
    Location: ['/callback?code=location-secret'],
    Referer: ['https://example.test/callback?token=referer-secret'],
    Refresh: ['0; url="/callback?code=refresh-secret"'],
    Link: ['</callback?code=link-secret>; rel="next"'],
  })
  assert.ok(!JSON.stringify(result).includes('-secret'))
  assert.ok(result.Location![0]!.startsWith('/callback?'))
  assert.ok(result.Refresh![0]!.startsWith('0; url="/callback?'))
  for (const value of ['callback?code=relative-secret', '../callback?token=parent-secret', '//example.test/?code=host-secret']) {
    for (const name of ['Location', 'Content-Location', 'Referer']) assert.ok(!sanitizedHeaders({ [name]: value })[name]!.includes('-secret'))
    assert.ok(!sanitizedHeaders({ Link: `<${value}>; rel="next"`, Refresh: `0; url=${value}` }).Link!.includes('-secret'))
    assert.ok(!sanitizedHeaders({ Refresh: `0; url=${value}` }).Refresh!.includes('-secret'))
  }
})

test('recognizable console credentials are masked while exception text remains useful', () => {
  const result = sanitizedText('Error: request failed https://example.test/?token=url-secret {"x-api-key":"json-secret"} password=field-secret Bearer bearer-secret')
  assert.ok(!result.includes('-secret'))
  assert.ok(result.startsWith('Error: request failed'))
  assert.equal(sanitizedText('TypeError: fixture exception at main.js:42'), 'TypeError: fixture exception at main.js:42')
})

test('restore strips ordinary queries and rejects auth callbacks and fragment routes', () => {
  assert.equal(restorableUrl('http://localhost:3000/page?q=search'), 'http://localhost:3000/page')
  for (const suffix of ['?code=secret', '?%74oken=secret', '?state=secret', '#/route', '#access_token=secret']) {
    assert.equal(restorableUrl(`https://example.test/callback${suffix}`), null)
  }
  assert.throws(() => restorableUrl('file:///private'), /HTTP or HTTPS/)
})

test('field scanning preserves nested fields and masks escaped or unfinished quoted secrets', () => {
  for (const value of ['token="first secret remainder', "token='first secret remainder",
    'token="first\\" secret remainder" visible', "token='first\\' secret remainder' visible",
    'result={"token":"nested-secret"}', 'safe="ordinary" token="secret remainder"',
    'token":"leaked-secret"', "token':'leaked-secret'", "'token\":'leaked-secret'"]) {
    const result = sanitizedText(value)
    assert.ok(!result.includes('secret'), result)
    assert.ok(result.includes('[redacted]'), result)
  }
  assert.equal(sanitizedText('safe="ordinary value"'), 'safe="ordinary value"')
})

test('input limits preserve redaction when cuts cross credentials and URL userinfo', () => {
  const padding = ' '.repeat(MAX_TELEMETRY_TEXT - 35)
  for (const tail of ['token="boundary-secret with spaces'.repeat(10), "password='boundary-secret with spaces".repeat(10),
    'Bearer boundary-secret'.repeat(10), 'https://user:boundary-secret'.repeat(10) + '@example.test/',
    'https://example.test/?token=boundary-secret'.repeat(10)]) {
    const result = sanitizedText(padding + tail)
    assert.ok(result.length <= MAX_TELEMETRY_TEXT)
    assert.ok(!result.includes('boundary-secret'), result.slice(-100))
  }
  assert.equal(sanitizedUrl(`https://user:${'password-secret'.repeat(1000)}@example.test/`), '[redacted oversized URL]')
  for (const name of ['Location', 'Content-Location', 'Referer', 'Refresh', 'Link', 'X-Diagnostic']) {
    const value = name === 'X-Diagnostic' ? padding + 'https://user:boundary-secret'.repeat(10)
      : '/callback?token=header-secret' + 'a'.repeat(200000)
    const result = sanitizedHeaders({ [name]: [value] })[name]![0]!
    assert.ok(!result.includes('-secret'), name)
    assert.ok(result.length <= MAX_TELEMETRY_TEXT, name)
  }
})

test('large word, base64 and malformed header inputs finish within a bounded child process', () => {
  const moduleUrl = new URL('./browser-privacy.js', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict';
    import { performance } from 'node:perf_hooks';
    import { sanitizedText, sanitizedHeaders, MAX_TELEMETRY_TEXT } from ${JSON.stringify(moduleUrl)};
    const start = performance.now();
    for (const value of ['a'.repeat(200000), 'password'.repeat(25000), 'data:image/png;base64,' + 'A'.repeat(200000)]) {
      assert.ok(sanitizedText(value).length <= MAX_TELEMETRY_TEXT);
      assert.ok(sanitizedHeaders({'X-Diagnostic': value})['X-Diagnostic'].length <= MAX_TELEMETRY_TEXT);
    }
    assert.equal(sanitizedHeaders({Link: '<'.repeat(8192)}).Link.length, 8192);
    assert.ok(sanitizedHeaders({Link: '<'.repeat(200000)}).Link.length <= MAX_TELEMETRY_TEXT);
    assert.ok(performance.now() - start < 1000, 'redaction exceeded its processing budget');
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { timeout: 8000, encoding: 'utf8', windowsHide: true })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
})
