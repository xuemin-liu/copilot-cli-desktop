import assert from 'node:assert/strict'
import test from 'node:test'
import { compareBitmaps, diffBitmap, everyPixelIgnored, ignorePixels, pngSize } from './browser-image-compare.js'

const size = { width: 4, height: 3 }
const solid = (value: number): Buffer => Buffer.alloc(size.width * size.height * 4, value)
const set = (bitmap: Buffer, x: number, y: number, bytes: number[]): Buffer => { bitmap.set(bytes, (y * size.width + x) * 4); return bitmap }

test('identical bitmaps match with nothing differing', () => {
  const result = compareBitmaps(solid(80), solid(80), size, 0)
  assert.equal(result.comparedPixels, 12); assert.equal(result.differentPixels, 0); assert.equal(result.diffRatio, 0)
  assert.equal(result.maxChannelDelta, 0); assert.equal(result.diffBounds, null)
})

test('a pixel differs only when one channel moves by more than the tolerance', () => {
  const actual = set(set(solid(80), 1, 0, [83, 80, 80, 255]), 3, 2, [80, 80, 90, 255])
  const strict = compareBitmaps(actual, solid(80), size, 0)
  assert.equal(strict.differentPixels, 2); assert.equal(strict.maxChannelDelta, 175, 'alpha counts as a channel')
  assert.deepEqual(strict.diffBounds, { x: 1, y: 0, width: 3, height: 3 })
  const baseline = set(set(solid(80), 1, 0, [80, 80, 80, 255]), 3, 2, [80, 80, 80, 255])
  const loose = compareBitmaps(actual, baseline, size, 3)
  assert.equal(loose.differentPixels, 1, 'a change of 3 is within a tolerance of 3; a change of 10 is not')
  assert.deepEqual(loose.diffBounds, { x: 3, y: 2, width: 1, height: 1 })
  assert.equal(loose.diffRatio, 1 / 12)
})

test('ignored pixels are left out of the count and the ratio', () => {
  const actual = set(solid(0), 0, 0, [255, 255, 255, 255])
  const result = compareBitmaps(actual, solid(0), size, 0, [{ x: 0, y: 0, width: 2, height: 1 }])
  assert.equal(result.ignoredPixels, 2); assert.equal(result.comparedPixels, 10); assert.equal(result.differentPixels, 0)
  assert.equal(result.mask[0], 2); assert.equal(result.mask[2], 0)
})

test('ignore rectangles in CSS pixels round outwards and stay inside the image', () => {
  assert.deepEqual(ignorePixels([{ x: 0.5, y: 0.5, width: 1, height: 1 }], { width: 10, height: 10 }, { x: 1.25, y: 1.25 }),
    [{ x: 0, y: 0, width: 2, height: 2 }])
  assert.deepEqual(ignorePixels([{ x: 6, y: 6, width: 100, height: 100 }], { width: 10, height: 10 }, { x: 1.5, y: 1.5 }),
    [{ x: 9, y: 9, width: 1, height: 1 }])
  assert.deepEqual(ignorePixels([{ x: 50, y: 0, width: 5, height: 5 }], { width: 10, height: 10 }, { x: 1, y: 1 }), [], 'off-image rectangles are dropped')
})

test('bitmaps of different sizes are refused', () => {
  assert.throws(() => compareBitmaps(solid(0), Buffer.alloc(8), size, 0), /same size/)
})

test('the diff image marks differing pixels red in the platform byte order and fades the rest', () => {
  const actual = set(solid(120), 2, 1, [0, 0, 0, 255])
  const result = compareBitmaps(actual, solid(120), size, 0, [{ x: 0, y: 0, width: 1, height: 1 }])
  for (const red of [0, 2] as const) {
    const diff = diffBitmap(actual, result, red)
    const pixel = (x: number, y: number): number[] => [...diff.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 4)]
    const marked = pixel(2, 1)
    assert.equal(marked[red], 255); assert.equal(marked[1], 0); assert.equal(marked[2 - red], 0); assert.equal(marked[3], 255)
    const faded = pixel(1, 0)
    assert.ok(faded[0] === faded[1] && faded[1] === faded[2] && faded[0]! > 160, 'matching pixels are light grey')
    assert.ok(pixel(0, 0)[0]! < 40, 'ignored pixels are dark')
  }
})

test('a PNG size is read from its header without decoding, and anything else is refused', () => {
  const header = (width: number, height: number, type = 'IHDR', length = 13): Buffer => {
    const bytes = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    bytes.writeUInt32BE(length, 8); bytes.write(type, 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
    return bytes
  }
  assert.deepEqual(pngSize(header(23000, 23000)), { width: 23000, height: 23000 }, 'a huge image is measured from 33 bytes')
  assert.deepEqual(pngSize(header(300, 213).subarray(0, 24)), { width: 300, height: 213 })
  for (const bytes of [header(0, 10), header(10, 10, 'IDAT'), header(10, 10, 'IHDR', 12), Buffer.from('not a png at all, just text bytes'), header(10, 10).subarray(0, 20)]) {
    assert.equal(pngSize(bytes), null)
  }
  const jpeg = header(10, 10); jpeg[0] = 0xff
  assert.equal(pngSize(jpeg), null)
  const offset = Buffer.concat([Buffer.alloc(5), header(64, 32)]).subarray(5)
  assert.deepEqual(pngSize(offset), { width: 64, height: 32 }, 'works on a view into a larger buffer')
})

test('an area is fully ignored only when the rectangles together cover every pixel', () => {
  const area = { width: 4, height: 3 }
  assert.equal(everyPixelIgnored([], area), false)
  assert.equal(everyPixelIgnored([{ x: 0, y: 0, width: 4, height: 3 }], area), true)
  assert.equal(everyPixelIgnored([{ x: 0, y: 0, width: 2, height: 3 }, { x: 2, y: 0, width: 2, height: 3 }], area), true, 'two halves cover it')
  assert.equal(everyPixelIgnored([{ x: 0, y: 0, width: 4, height: 2 }, { x: 0, y: 1, width: 3, height: 2 }], area), false, 'one corner pixel is left')
  assert.equal(everyPixelIgnored(ignorePixels([{ x: 0, y: 0, width: 5000, height: 5000 }], area, { x: 1.25, y: 1.25 }), area), true, 'an oversized rectangle is clipped to the area')
})
