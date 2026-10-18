import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_RESPONSE_BYTES, capturableBody, readableResponse, redactBrowserValue } from './browser-read-privacy.js'

test('ticket JSON preserves fields, ADF and comments while credentials are withheld at every depth', () => {
  const body = JSON.stringify({ key: 'APP-123', fields: { summary: 'Broken layout', description: { type: 'doc', content: [{ text: 'Steps to reproduce' }] },
    comment: [{ author: { displayName: 'Alice Reviewer' }, body: 'Uncaught Error: failed' }], authorization: 'private-authorization', accessToken: 'private-access', sessionId: 'private-session', nested: [{ cookies: 'private-cookie',
      text: 'Authorization: Bearer private-bearer', link: 'https://user:private-password@jira.test/browse/APP-123?token=private-query#private-hash' }] } })
  const result = readableResponse(body, 'application/json')
  const output = JSON.stringify(result)
  assert.equal(result.state, 'available')
  for (const text of ['APP-123', 'Steps to reproduce', 'Uncaught Error: failed', 'Alice Reviewer']) assert.ok(output.includes(text))
  for (const text of ['private-authorization', 'private-access', 'private-session', 'private-cookie', 'private-bearer', 'private-password', 'private-query', 'private-hash']) assert.ok(!output.includes(text), text)
  assert.equal(result.redacted, true)
})

test('invalid, unstructured and oversized response bodies never leak partially parsed credentials', () => {
  for (const mime of ['text/html', 'text/plain', 'application/javascript', 'application/octet-stream']) {
    const result = readableResponse('secret-without-label', mime)
    assert.equal(result.state, 'unavailable')
    assert.equal(result.data, undefined)
  }
  assert.equal(readableResponse('{"token":"unfinished-secret', 'application/json').data, undefined)
  assert.equal(readableResponse('"unlabelled-credential"', 'application/json').data, undefined)
  const result = readableResponse(JSON.stringify({ description: 'x'.repeat(MAX_RESPONSE_BYTES), token: 'never-export' }), 'application/json')
  assert.equal(result.state, 'unavailable'); assert.equal(result.truncated, true)
  assert.ok(!JSON.stringify(result).includes('never-export'))
})

test('bounded tree output reports truncation and handles hostile property names without prototype mutation', () => {
  const result = redactBrowserValue(JSON.parse('{"__proto__":{"password":"private"},"text":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"}') as unknown)
  assert.equal(Object.getPrototypeOf(result.value), null)
  assert.ok(!JSON.stringify(result).includes('private'))
  assert.ok(!JSON.stringify(result).includes('eyJhbGci'))
  assert.equal(redactBrowserValue(Array.from({ length: 5000 }, () => 'row')).truncated, true)
  assert.equal(redactBrowserValue('x'.repeat(9000)).truncated, true)
  const prose = redactBrowserValue(['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'API key: private-key', 'Client secret: private-client'])
  assert.ok(!JSON.stringify(prose).includes('dXNlcjpwYXNzd29yZA'))
  assert.ok(!JSON.stringify(prose).includes('private-key'))
  assert.ok(!JSON.stringify(prose).includes('private-client'))
})

test('pasted provider tokens and arbitrary authorization schemes are withheld in ticket text', () => {
  const secrets = ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_abcdefghijklmnopqrstuvwxyz0123456789',
    'gho_abcdefghijklmnopqrstuvwxyz0123456789', 'glpat-abcdefghijklmnopqrstuvwxyz0123456789',
    ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'), 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'AKIA1234567890ABCDEF']
  const result = redactBrowserValue({ comments: secrets.map(secret => `Use API key ${secret} for access`),
    header: 'Authorization: Token opaque-private-token', otherHeader: 'Proxy-Authorization: CustomScheme opaque-private-proxy',
    multiline: 'Authorization: Digest opaque-private-digest\nTicket description remains readable', normal: 'Skip the next step' })
  const output = JSON.stringify(result.value)
  for (const secret of [...secrets, 'opaque-private-token', 'opaque-private-proxy', 'opaque-private-digest']) assert.ok(!output.includes(secret), secret)
  assert.ok(output.includes('Ticket description remains readable')); assert.ok(output.includes('Skip the next step'))
  assert.equal(result.redacted, true)
})

test('XHR/fetch API replies sent as script or text are exported when they are JSON or JSONP, with the same redaction', () => {
  const info = { Rows: 512, Columns: 512, Modality: 'CT', accessToken: 'private-access', note: 'Authorization: Bearer private-bearer' }
  for (const [body, mime, type] of <[string, string, string][]>[[`jQuery1123_456(${JSON.stringify(info)});`, 'application/javascript', 'XHR'],
    [`/**/ angular.callbacks._0(${JSON.stringify(info)})`, 'text/javascript; charset=utf-8', 'Fetch'],
    [`\n${JSON.stringify(info)}\n`, 'text/plain', 'XHR'], [JSON.stringify(info), 'application/x-javascript', 'Fetch']]) {
    const result = readableResponse(body, mime, type)
    const output = JSON.stringify(result)
    assert.equal(result.state, 'available', `${mime} ${type}`)
    assert.deepEqual({ ...result.data as object }, { Rows: 512, Columns: 512, Modality: 'CT', accessToken: '[redacted]', note: '[redacted]' })
    for (const text of ['private-access', 'private-bearer']) assert.ok(!output.includes(text), text)
    assert.equal(result.redacted, true)
  }
})

test('page scripts, raw text, HTML and oversized script replies stay withheld', () => {
  const json = JSON.stringify({ token: 'never-export', value: 1 })
  // Page scripts and other resource types never qualify, even when they look like JSONP.
  for (const type of ['Script', 'Document', 'Other', '']) assert.equal(readableResponse(`cb(${json})`, 'application/javascript', type).data, undefined)
  assert.equal(readableResponse('<html>secret</html>', 'text/html', 'XHR').state, 'unavailable')
  assert.equal(readableResponse('AAAA', 'application/octet-stream', 'Fetch').state, 'unavailable')
  for (const body of ['var token = "never-export";', 'plain secret-without-label', `cb(${json}); stealCookies()`, `cb(${json}, 200)`, 'cb("never-export")', `alert(1);cb(${json})`]) {
    const result = readableResponse(body, 'application/javascript', 'XHR')
    assert.equal(result.state, 'unavailable', body); assert.equal(result.data, undefined)
    assert.ok(!JSON.stringify(result).includes('never-export'), body)
  }
  const big = readableResponse(`cb(${JSON.stringify({ description: 'x'.repeat(MAX_RESPONSE_BYTES), token: 'never-export' })})`, 'text/javascript', 'XHR')
  assert.equal(big.state, 'unavailable'); assert.equal(big.truncated, true)
  assert.ok(!JSON.stringify(big).includes('never-export'))
})

test('only JSON, or script and text replies to XHR/fetch, are worth retrieving', () => {
  assert.equal(capturableBody('application/json'), true)
  assert.equal(capturableBody('application/vnd.api+json', 'Script'), true)
  for (const mime of ['application/javascript', 'text/javascript', 'application/x-javascript', 'text/plain; charset=utf-8']) {
    assert.equal(capturableBody(mime, 'XHR'), true, mime); assert.equal(capturableBody(mime, 'Fetch'), true, mime)
    assert.equal(capturableBody(mime, 'Script'), false, mime); assert.equal(capturableBody(mime), false, mime)
  }
  for (const mime of ['text/html', 'application/octet-stream', 'image/png', 'text/css']) assert.equal(capturableBody(mime, 'XHR'), false, mime)
})
