import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_RESPONSE_BYTES, readableResponse, redactBrowserValue } from './browser-read-privacy.js'

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
