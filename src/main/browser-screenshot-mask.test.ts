import assert from 'node:assert/strict'
import test from 'node:test'
import { maskScreenshotBitmap } from './browser-screenshot-mask.js'

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
