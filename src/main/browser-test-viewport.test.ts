import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserTestViewport } from './browser-test-viewport.js'

test('viewport is bounded by the original surface and restores once on every exit', async () => {
  const original = { width: 900, height: 700, dpr: 1.25 }
  for (const exit of ['pass', 'fail', 'cancel']) {
    let current = original, resets = 0
    const view = new BrowserTestViewport(async (method, args) => {
      if (method.endsWith('clearDeviceMetricsOverride')) { resets++; current = original }
      else current = { width: Number(args.width), height: Number(args.height), dpr: Number(args.deviceScaleFactor) }
    }, async () => current, () => assert.fail('detach unnecessary'))
    await view.initialize()
    await assert.rejects(view.apply({ width: 1000, height: 600, dpr: 1 }), /fit/)
    try { await view.apply({ width: 640, height: 480, dpr: 2 }); if (exit !== 'pass') throw new Error(exit) } catch { /* simulated exit */ }
    finally { await view.stop(); await view.stop() }
    assert.deepEqual(current, original); assert.equal(resets, 1); assert.equal(view.evidence().restored, true)
  }
})

test('a late apply acknowledgement cannot reactivate a stopped viewport', async () => {
  const original = { width: 800, height: 600, dpr: 1 }
  let release!: () => void, current = original
  const view = new BrowserTestViewport(async (method, args) => {
    if (method.endsWith('clearDeviceMetricsOverride')) { current = original; return }
    current = { width: Number(args.width), height: Number(args.height), dpr: Number(args.deviceScaleFactor) }
    await new Promise<void>(resolve => { release = resolve })
  }, async () => current, () => {})
  await view.initialize(); const applying = assert.rejects(view.apply({ width: 640, height: 480, dpr: 2 }), /ended/)
  await view.stop(); release(); await applying
  assert.equal(view.current, undefined); assert.deepEqual(current, original)
})

test('reset failure or mismatched restoration detaches and records failure', async () => {
  for (const throws of [true, false]) {
    let detached = false, current = { width: 800, height: 600, dpr: 1 }
    const view = new BrowserTestViewport(async method => {
      if (method.endsWith('clearDeviceMetricsOverride') && throws) throw new Error('disconnected')
      current = { width: 640, height: 480, dpr: 2 }
    }, async () => current, () => { detached = true })
    await view.initialize(); await view.apply({ width: 640, height: 480, dpr: 2 }); await view.stop()
    assert.ok(detached); assert.equal(view.evidence().cleanupFailed, true)
  }
})
