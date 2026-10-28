import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserTestNetwork } from './browser-test-network.js'
import { testRequestMatches } from './browser-test-plan.js'

const rule = { urlPattern: 'http://localhost:3000/api/*', method: 'POST', failure: 'transport' as const, maxRequests: 1, durationMs: 1000 }
test('literal request globs and page/frame/origin/method/count bounds constrain interception', async () => {
  assert.ok(testRequestMatches(rule, 'http://localhost:3000/api/save', 'POST'))
  assert.ok(!testRequestMatches(rule, 'http://localhost:3000/api/save', 'GET'))
  const calls: { method: string; params: any }[] = []
  const network = new BrowserTestNetwork([rule], 'http://localhost:3000', new Set(['top']), async (method, params) => { calls.push({ method, params }) })
  const paused = (frame: string, url = 'http://localhost:3000/api/save', method = 'POST') => network.message('Fetch.requestPaused', { requestId: 'r', frameId: frame, request: { url, method } })
  await network.start()
  await paused('foreign-frame'); await paused('top', 'http://foreign/api/save'); await paused('top', undefined, 'GET')
  assert.equal(calls.filter(call => call.method === 'Fetch.continueRequest').length, 3)
  await paused('top'); await paused('top')
  assert.equal(calls.filter(call => call.method === 'Fetch.failRequest').length, 1)
  await network.stop()
  assert.equal(network.evidence().failureRulesRemoved, true)
  await network.stop()
  assert.throws(() => new BrowserTestNetwork([rule], 'http://foreign', new Set(['top']), async () => {}), /origin/)
})

test('expiry and cancellation restore networking; observed completions are from this run and contain no bodies or credentials', async () => {
  const calls: string[] = []
  const network = new BrowserTestNetwork([{ ...rule, durationMs: 100 }], 'http://localhost:3000', new Set(['top']), async method => { calls.push(method) })
  await network.start()
  await network.message('Network.requestWillBeSent', { requestId: 'one', frameId: 'top', request: { url: 'http://localhost:3000/api/save?token=private', method: 'POST', postData: 'private-body' } })
  assert.equal(network.completed({ ...rule, state: 'finished' }), false)
  await network.message('Network.responseReceived', { requestId: 'one', response: { status: 503 } })
  await network.message('Network.loadingFinished', { requestId: 'one' })
  assert.equal(network.completed({ ...rule, state: 'finished', status: 503 }), true)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(calls.includes('Fetch.disable')); assert.equal(network.evidence().failureRulesRemoved, true)
  assert.ok(!JSON.stringify(network.evidence()).includes('private'))
  await network.stop()
})

test('HTTP interception stays attached until its response finishes, and foreign frame navigation revokes matching', async () => {
  const calls: string[] = []
  const network = new BrowserTestNetwork([{ ...rule, failure: 'http', status: 503 }], 'http://localhost:3000', new Set(['top', 'child']), async method => { calls.push(method) })
  await network.start()
  await network.message('Page.frameNavigated', { frame: { id: 'child', url: 'http://foreign/' } })
  await network.message('Fetch.requestPaused', { requestId: 'foreign', frameId: 'child', request: { url: 'http://localhost:3000/api/save', method: 'POST' } })
  assert.ok(calls.includes('Fetch.continueRequest'))
  await network.message('Network.requestWillBeSent', { requestId: 'network', frameId: 'top', request: { url: 'http://localhost:3000/api/save', method: 'POST' } })
  await network.message('Fetch.requestPaused', { requestId: 'fetch', networkId: 'network', frameId: 'top', request: { url: 'http://localhost:3000/api/save', method: 'POST' } })
  assert.ok(calls.includes('Fetch.fulfillRequest')); assert.ok(!calls.includes('Fetch.disable'))
  await network.message('Network.responseReceived', { requestId: 'network', response: { status: 503 } })
  await network.message('Network.loadingFinished', { requestId: 'network' })
  assert.ok(network.completed({ ...rule, state: 'finished', status: 503 })); assert.ok(calls.includes('Fetch.disable'))
})

test('concurrent interception failures annotate their own request rather than the latest request', async () => {
  const network = new BrowserTestNetwork([{ ...rule, maxRequests: 2 }], 'http://localhost:3000', new Set(['top']), async (method, params) => {
    if (method === 'Fetch.failRequest' && params.requestId === 'one') throw new Error('Lost interception acknowledgement.')
  })
  await network.start()
  await Promise.all(['one', 'two'].map(id => network.message('Fetch.requestPaused', { requestId: id, frameId: 'top', request: { url: `http://localhost:3000/api/${id}`, method: 'POST' } })))
  const affected = network.evidence().affectedRequests as Record<string, unknown>[]
  assert.equal(affected[0]?.delivery, 'uncertain'); assert.equal(affected[1]?.delivery, undefined)
  await network.stop()
})
