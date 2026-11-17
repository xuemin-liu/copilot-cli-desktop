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
  assert.equal(network.completed({ ...rule, state: 'finished' }), 0)
  await network.message('Network.responseReceived', { requestId: 'one', response: { status: 503 } })
  await network.message('Network.loadingFinished', { requestId: 'one' })
  assert.equal(network.completed({ ...rule, state: 'finished', status: 503 }), 1)
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

test('a delay rule holds matching requests for delayMs and then lets them through unchanged', async () => {
  const calls: { method: string; params: any; at: number }[] = []
  const delay = { ...rule, failure: 'delay' as const, delayMs: 150, maxRequests: 2 }
  const network = new BrowserTestNetwork([delay], 'http://localhost:3000', new Set(['top']), async (method, params) => { calls.push({ method, params, at: Date.now() }) })
  await network.start()
  const started = Date.now()
  for (const id of ['one', 'two', 'three']) await network.message('Fetch.requestPaused', { requestId: id, frameId: 'top', request: { url: `http://localhost:3000/api/${id}`, method: 'POST' } })
  const continued = () => calls.filter(call => call.method === 'Fetch.continueRequest').map(call => call.params.requestId)
  assert.deepEqual(continued(), ['three'], 'only maxRequests are held; the rest continue at once')
  assert.ok(!calls.some(call => ['Fetch.failRequest', 'Fetch.fulfillRequest'].includes(call.method)), 'a delay never fails or answers a request')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepEqual(continued().sort(), ['one', 'three', 'two'])
  for (const call of calls.filter(call => ['one', 'two'].includes(call.params.requestId))) assert.ok(call.at - started >= 140, `held for the delay (${call.at - started} ms)`)
  const affected = network.evidence().affectedRequests as Record<string, unknown>[]
  assert.deepEqual(affected.map(item => [item.failure, item.delayMs, item.released]), [['delay', 150, 'after delay'], ['delay', 150, 'after delay']])
  await network.stop()
})

test('the end of a run lets held requests go at once and removes interception', async () => {
  const calls: { method: string; params: any }[] = []
  const network = new BrowserTestNetwork([{ ...rule, failure: 'delay', delayMs: 30000, maxRequests: 5, durationMs: 60000 }], 'http://localhost:3000', new Set(['top']),
    async (method, params) => { calls.push({ method, params }) })
  await network.start()
  await network.message('Fetch.requestPaused', { requestId: 'held', frameId: 'top', request: { url: 'http://localhost:3000/api/frame', method: 'POST' } })
  assert.ok(!calls.some(call => call.method === 'Fetch.continueRequest'))
  await network.stop()
  const order = calls.map(call => call.method)
  assert.ok(order.indexOf('Fetch.continueRequest') >= 0 && order.indexOf('Fetch.continueRequest') < order.indexOf('Fetch.disable'), 'released before interception is removed')
  assert.equal((network.evidence().affectedRequests as Record<string, unknown>[])[0]?.released, 'run ended')
  assert.ok(network.cleanedUp())
})

test('network conditions apply for the run and are removed at its end; a failed removal is reported for detaching', async () => {
  const calls: { method: string; params: any }[] = []
  const network = new BrowserTestNetwork([], 'http://localhost:3000', new Set(['top']), async (method, params) => { calls.push({ method, params }) }, () => true,
    { latencyMs: 200, downloadKbps: 2000 })
  await network.start()
  assert.deepEqual(calls[0], { method: 'Network.emulateNetworkConditions', params: { offline: false, latency: 200, downloadThroughput: 250000, uploadThroughput: -1 } })
  assert.equal(network.cleanedUp(), false, 'still slowed while the run is open')
  await network.stop()
  assert.deepEqual(calls[1], { method: 'Network.emulateNetworkConditions', params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } })
  assert.ok(network.cleanedUp())
  assert.deepEqual(network.evidence().networkConditions, { latencyMs: 200, downloadKbps: 2000, applied: true, removed: true })
  let fail = false
  const stuck = new BrowserTestNetwork([], 'http://localhost:3000', new Set(['top']), async method => { if (fail && method === 'Network.emulateNetworkConditions') throw new Error('lost') }, () => true, { offline: true })
  await stuck.start(); fail = true; await stuck.stop()
  assert.equal(stuck.cleanedUp(), false); assert.equal(stuck.evidence().cleanupFailed, true)
  stuck.detached()
  assert.ok(stuck.cleanedUp(), 'a detached debugger drops its emulation')
})

test('requests are counted beyond the 100 the report lists', async () => {
  const network = new BrowserTestNetwork([], 'http://localhost:3000', new Set(['top']), async () => {})
  for (let index = 0; index < 150; index++) {
    await network.message('Network.requestWillBeSent', { requestId: `r${index}`, frameId: 'top', request: { url: `http://localhost:3000/frames/${index}`, method: 'GET' } })
    await network.message('Network.loadingFinished', { requestId: `r${index}` })
  }
  const frames = { urlPattern: 'http://localhost:3000/frames/*', method: 'GET', state: 'finished' }
  assert.equal(network.completed(frames), 150)
  const evidence = network.evidence()
  assert.equal((evidence.requests as unknown[]).length, 100); assert.equal(evidence.truncated, true)
  assert.match(String((evidence.requests as { url: string }[])[99]?.url), /frames\/149$/, 'the report keeps the latest requests')
})

test('network conditions whose acknowledgement is lost are still reset, or reported for detaching', async () => {
  for (const resetFails of [false, true]) {
    const calls: any[] = []; let emulations = 0
    const network = new BrowserTestNetwork([], 'http://localhost:3000', new Set(['top']), async (method, params) => {
      calls.push({ method, params })
      if (method === 'Network.emulateNetworkConditions' && (++emulations === 1 || resetFails)) throw new Error('Timed out waiting for the acknowledgement.')
    }, () => true, { offline: true })
    await assert.rejects(network.start(), /acknowledgement/)
    assert.equal(network.cleanedUp(), false, 'an unacknowledged application may be in effect')
    await network.stop()
    assert.equal(calls.filter(call => call.method === 'Network.emulateNetworkConditions').length, 2, 'the run end resets it anyway')
    assert.deepEqual(calls.at(-1).params, { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    assert.equal(network.cleanedUp(), !resetFails, resetFails ? 'a failed reset leaves it for the debugger detach' : 'a successful reset removes it')
  }
})
