import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBrowserAddress } from './browser-url.js'

test('browser addresses accept bare domains and paths with HTTPS', () => {
  assert.equal(parseBrowserAddress(' localhost.kmha.dev ').href, 'https://localhost.kmha.dev/')
  assert.equal(parseBrowserAddress('localhost.kmha.dev/MC/login').href, 'https://localhost.kmha.dev/MC/login')
  assert.equal(parseBrowserAddress('example.com:8443/path?q=1#section').href, 'https://example.com:8443/path?q=1#section')
})

test('bare loopback addresses use HTTP while explicit protocols are preserved', () => {
  for (const address of ['localhost:3000', 'localhost:443', '127.0.0.1:3000', '[::1]:3000']) {
    assert.equal(parseBrowserAddress(address).href, `http://${address}/`)
  }
  assert.equal(parseBrowserAddress('https://localhost/MC/login').href, 'https://localhost/MC/login')
  assert.equal(parseBrowserAddress('http://localhost.kmha.dev/MC/login').href, 'http://localhost.kmha.dev/MC/login')
})

test('browser input retains protocol and credential restrictions', () => {
  for (const address of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com']) {
    assert.throws(() => parseBrowserAddress(address), /HTTP or HTTPS/)
  }
  for (const address of ['user:password@example.com', 'https://user:password@example.com', 'user@example.com']) {
    assert.throws(() => parseBrowserAddress(address))
  }
  for (const address of ['', '   ', 'not a hostname', 'localhost:99999']) assert.throws(() => parseBrowserAddress(address))
})
