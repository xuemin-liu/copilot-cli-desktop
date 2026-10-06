import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBrowserContext } from './browser-context-format.js'
import type { BrowserConsoleEntry, BrowserNetworkEntry } from './browser-debug-types.js'

const log = (id: number, level: string, message: string, pageId = 1): BrowserConsoleEntry => ({ id, pageId, timestamp: '2026-01-01T00:00:00Z', level, message, source: 'http://localhost:3000/app.js', line: id })
const request = (id: string, status: number | null, error: string | null = null, pageId = 1): BrowserNetworkEntry => ({ id, pageId, timestamp: '2026-01-01T00:00:00Z', method: 'GET',
  url: `http://localhost:3000/api/${id}`, resourceType: 'xhr', status, durationMs: 5, error, requestHeaders: {}, responseHeaders: {}, redirects: [] })

test('errors, warnings and failed requests of the selected page become prompt text', () => {
  const text = formatBrowserContext({ url: 'http://localhost:3000/', pageId: 1,
    console: [log(1, 'info', 'started'), log(2, 'error', 'Uncaught TypeError: x is undefined'), log(3, 'warning', 'Deprecated call'), log(4, 'error', 'other page', 2)],
    network: [request('a', 200), request('b', 500), request('c', null, 'net::ERR_CONNECTION_REFUSED'), request('d', 404, null, 2)] })!
  assert.ok(text.startsWith('[Browser console] http://localhost:3000/'))
  assert.ok(text.includes('- error: Uncaught TypeError: x is undefined (http://localhost:3000/app.js:2)'))
  assert.ok(text.includes('- warning: Deprecated call'))
  assert.ok(!text.includes('started') && !text.includes('other page'))
  assert.ok(text.includes('GET http://localhost:3000/api/b → 500') && text.includes('→ net::ERR_CONNECTION_REFUSED'))
  assert.ok(!text.includes('/api/a') && !text.includes('/api/d'))
})

test('without problems the latest messages are used, and an empty page gives nothing', () => {
  const quiet = formatBrowserContext({ url: 'http://localhost:3000/', pageId: 1, console: [log(1, 'info', 'ready')], network: [request('a', 200)] })!
  assert.ok(quiet.includes('No errors or warnings; latest console messages:') && quiet.includes('- info: ready'))
  assert.equal(formatBrowserContext({ url: 'http://localhost:3000/', pageId: 1, console: [], network: [request('a', 200)] }), null)
})

test('prompt text is bounded and cannot contain line breaks inside an entry', () => {
  const entries = Array.from({ length: 80 }, (_item, index) => log(index + 1, 'error', `line one\nline two ${'x'.repeat(2000)}`))
  const text = formatBrowserContext({ url: `http://localhost:3000/${'p'.repeat(2000)}`, pageId: 1, console: entries, network: [] })!
  assert.ok(text.length <= 4000)
  assert.ok(text.split('\n').every(item => item === '' || item.startsWith('- ') || item.startsWith('[Browser console]') || item.startsWith('Console errors')))
  assert.ok(text.includes('latest 25 of 80') || text.length === 4000)
})
