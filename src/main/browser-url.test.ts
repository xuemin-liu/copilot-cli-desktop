import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBrowserAddress } from './browser-url.js'

test('browser addresses accept bare domains and paths with HTTPS', () => {
  assert.equal(parseBrowserAddress(' localhost.kmha.dev ').href, 'https://localhost.kmha.dev/')
  assert.equal(parseBrowserAddress('localhost.kmha.dev/MC/login').href, 'https://localhost.kmha.dev/MC/login')
  assert.equal(parseBrowserAddress('example.com:8443/path?q=1#section').href, 'https://example.com:8443/path?q=1#section')
})

test('bare loopback addresses use HTTP while explicit protocols are preserved', () => {
  for (const address of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
    assert.equal(parseBrowserAddress(address).href, `http://${address}/`)
  }
  assert.equal(parseBrowserAddress('https://localhost/MC/login').href, 'https://localhost/MC/login')
  assert.equal(parseBrowserAddress('http://localhost.kmha.dev/MC/login').href, 'http://localhost.kmha.dev/MC/login')
})

test('LAN and development hosts use HTTP with HTTPS ports and explicit schemes taking precedence', () => {
  for (const host of ['192.168.1.20', '10.1.2.3', '172.16.0.1', '172.31.255.1', '169.254.1.2',
    'host.docker.internal', 'devbox', 'app.local', 'app.test', 'app.internal', '[fd12::1]', '[fe80::1]']) {
    assert.equal(parseBrowserAddress(`${host}:3000/login`).href, `http://${host}:3000/login`)
    assert.equal(parseBrowserAddress(`${host}:443/login`).href, `https://${host}/login`)
    assert.equal(parseBrowserAddress(`${host}:8443/login`).href, `https://${host}:8443/login`)
    assert.equal(parseBrowserAddress(`https://${host}:3000/login`).href, `https://${host}:3000/login`)
  }
  assert.equal(parseBrowserAddress('localhost:443').href, 'https://localhost/')
  assert.equal(parseBrowserAddress('localhost:8443').href, 'https://localhost:8443/')
  for (const address of ['172.15.0.1', '172.32.0.1', '192.169.1.1', '8.8.8.8', 'localhost.kmha.dev']) {
    assert.equal(parseBrowserAddress(`${address}:3000`).href, `https://${address}:3000/`)
  }
  assert.equal(parseBrowserAddress('http://localhost:443').href, 'http://localhost:443/')
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
