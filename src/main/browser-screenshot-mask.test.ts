import assert from 'node:assert/strict'
import test from 'node:test'
import { maskScreenshotBitmap, sameScreenshotLayout } from './browser-screenshot-mask.js'

test('screenshot pixel masks cover scaled and clipped CSS bounds even when the compositor returned unmasked pixels', () => {
  const size = { width: 8, height: 8 }
  const bitmap = Buffer.alloc(8 * 8 * 4, 255)
  maskScreenshotBitmap(bitmap, size, { viewport: { width: 4, height: 4 }, rectangles: [
    { x: 1.25, y: 1.25, width: 0.5, height: 0.5 }, { x: -2, y: 3, width: 3, height: 2 },
  ] })
  const pixel = (x: number, y: number): number[] => [...bitmap.subarray((y * 8 + x) * 4, (y * 8 + x + 1) * 4)]
  for (const [x, y] of [[1, 1], [4, 4], [0, 7], [2, 7]] as const) assert.deepEqual(pixel(x, y), [17, 17, 17, 255])
  assert.deepEqual(pixel(7, 0), [255, 255, 255, 255])
})

test('invalid screenshot dimensions and mask bounds fail closed', () => {
  const size = { width: 4, height: 4 }
  const bitmap = Buffer.alloc(64)
  for (const geometry of [
    { viewport: { width: 0, height: 4 }, rectangles: [] },
    { viewport: size, rectangles: [{ x: NaN, y: 0, width: 1, height: 1 }] },
    { viewport: size, rectangles: [{ x: 0, y: 0, width: -1, height: 1 }] },
  ]) assert.throws(() => maskScreenshotBitmap(bitmap, size, geometry), /no image was exported/)
  assert.throws(() => maskScreenshotBitmap(Buffer.alloc(63), size, { viewport: size, rectangles: [] }), /no image was exported/)
})

test('layout checks ignore CDP key ordering but reject scrolling, resizing, moved or newly protected elements', () => {
  const before = { viewport: { width: 4, height: 4 }, rectangles: [{ x: 1, y: 1, width: 2, height: 2 }], scrollX: 0, scrollY: 0, truncated: false }
  const reordered = { rectangles: [{ height: 2, width: 2, y: 1, x: 1 }], truncated: false, scrollY: 0, scrollX: 0, viewport: { height: 4, width: 4 } }
  assert.equal(sameScreenshotLayout(before, reordered), true)
  for (const changed of [{ ...before, scrollY: 10 }, { ...before, viewport: { width: 5, height: 4 } },
    { ...before, rectangles: [{ x: 2, y: 1, width: 2, height: 2 }] }, { ...before, rectangles: [...before.rectangles, ...before.rectangles] }]) {
    assert.equal(sameScreenshotLayout(before, changed), false)
  }
})
