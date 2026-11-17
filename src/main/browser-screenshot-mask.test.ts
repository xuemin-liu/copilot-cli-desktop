import assert from 'node:assert/strict'
import test from 'node:test'
import { maskAndCrop, maskScreenshotBitmap, sameScreenshotLayout, screenshotCrop } from './browser-screenshot-mask.js'

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

test('a CSS-pixel crop rounds outwards to physical pixels and is clipped to the image', () => {
  const size = { width: 1250, height: 875 }; const viewport = { width: 1000, height: 700 }
  assert.deepEqual(screenshotCrop(size, viewport, { x: 100, y: 50, width: 200, height: 100 }), { x: 125, y: 62, width: 250, height: 126 })
  assert.deepEqual(screenshotCrop(size, viewport, { x: 900, y: 650, width: 400, height: 400 }), { x: 1125, y: 812, width: 125, height: 63 }, 'clipped at the edge')
  assert.deepEqual(screenshotCrop(size, viewport, { x: -50, y: -50, width: 100, height: 100 }), { x: 0, y: 0, width: 63, height: 63 }, 'partly above and left of the viewport')
  for (const region of [{ x: 1000, y: 0, width: 10, height: 10 }, { x: 0, y: 700, width: 10, height: 10 }, { x: -20, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 }, { x: Number.NaN, y: 0, width: 10, height: 10 }]) assert.equal(screenshotCrop(size, viewport, region), null, JSON.stringify(region))
  assert.equal(screenshotCrop(size, { width: 0, height: 700 }, { x: 0, y: 0, width: 10, height: 10 }), null)
})

test('masks are painted on the whole viewport before the crop, so they stay over their elements', () => {
  // A 20×10 white image of a 10×5 CSS viewport (scale 2), with one masked field at CSS (4,1) 2×2.
  const size = { width: 20, height: 10 }
  const geometry = { viewport: { width: 10, height: 5 }, rectangles: [{ x: 4, y: 1, width: 2, height: 2 }] }
  const cut = maskAndCrop(Buffer.alloc(20 * 10 * 4, 255), size, geometry, { x: 3, y: 0, width: 5, height: 5 })!
  assert.deepEqual([cut.size, cut.pixels], [{ width: 10, height: 10 }, { x: 6, y: 0, width: 10, height: 10 }])
  const at = (x: number, y: number): number[] => [...cut.bitmap.subarray((y * cut.size.width + x) * 4, (y * cut.size.width + x) * 4 + 4)]
  assert.deepEqual(at(3, 4), [17, 17, 17, 255], 'the field (image x 8–11) sits at crop x 2–5')
  assert.deepEqual(at(0, 0), [255, 255, 255, 255])
  assert.deepEqual(at(9, 9), [255, 255, 255, 255])
  assert.equal(cut.bitmap.length, 10 * 10 * 4)
  assert.equal(maskAndCrop(Buffer.alloc(20 * 10 * 4, 255), size, geometry, { x: 50, y: 0, width: 5, height: 5 }), null)
  const whole = maskAndCrop(Buffer.alloc(20 * 10 * 4, 255), size, geometry)!
  assert.deepEqual([whole.size, whole.pixels], [size, null])
})
