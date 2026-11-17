/**
 * Pixel comparison for the compareScreenshot test step. Both bitmaps come from Chromium's own PNG decoder in the same
 * platform byte order, so a comparison never needs to know which byte is red; only the diff image does.
 */
interface Size { width: number; height: number }
export interface PixelRectangle { x: number; y: number; width: number; height: number }

export interface ImageComparison {
  width: number; height: number
  /** Pixels compared: every pixel outside the ignore rectangles. */
  comparedPixels: number
  ignoredPixels: number
  differentPixels: number
  /** differentPixels / comparedPixels, 0 when nothing was compared. */
  diffRatio: number
  /** The largest difference in one colour channel, over every compared pixel. */
  maxChannelDelta: number
  /** The smallest rectangle holding every differing pixel, in image pixels; null when none differ. */
  diffBounds: PixelRectangle | null
  /** One byte per pixel: 1 differs, 2 ignored, 0 matches. */
  mask: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * A PNG's pixel size from its header, without decoding it: the signature, then the IHDR chunk, which must come first
 * (length 13, type "IHDR", width and height as big-endian 32-bit integers). Null for anything else. The file limit is on
 * compressed bytes, so a small file can describe a huge bitmap; reading the size first keeps it from ever being decoded.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
  const width = view.getUint32(16), height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** Image-pixel rectangles from CSS-pixel ones relative to the compared area, rounded outwards and clipped. */
export function ignorePixels(ignore: readonly PixelRectangle[], size: Size, scale: { x: number; y: number }): PixelRectangle[] {
  const out: PixelRectangle[] = []
  for (const rect of ignore) {
    const left = Math.max(0, Math.floor(rect.x * scale.x))
    const top = Math.max(0, Math.floor(rect.y * scale.y))
    const right = Math.min(size.width, Math.ceil((rect.x + rect.width) * scale.x))
    const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height) * scale.y))
    if (right > left && bottom > top) out.push({ x: left, y: top, width: right - left, height: bottom - top })
  }
  return out
}

/** Compares two same-size 32-bit bitmaps. Alpha counts as a channel, so a transparent pixel never matches an opaque one. */
export function compareBitmaps(actual: Buffer, baseline: Buffer, size: Size, channel: number, ignore: readonly PixelRectangle[] = []): ImageComparison {
  const pixels = size.width * size.height
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || pixels > 16_000_000
    || actual.length !== pixels * 4 || baseline.length !== pixels * 4) throw new Error('Images to compare must have the same size.')
  const mask = new Uint8Array(pixels)
  for (const rect of ignore) for (let y = rect.y; y < rect.y + rect.height; y++) mask.fill(2, y * size.width + rect.x, y * size.width + rect.x + rect.width)
  let different = 0; let ignored = 0; let maxDelta = 0
  let left = size.width, top = size.height, right = -1, bottom = -1
  for (let index = 0; index < pixels; index++) {
    if (mask[index] === 2) { ignored++; continue }
    const offset = index * 4
    let delta = 0
    for (let byte = 0; byte < 4; byte++) {
      const value = Math.abs(actual[offset + byte]! - baseline[offset + byte]!)
      if (value > delta) delta = value
    }
    if (delta > maxDelta) maxDelta = delta
    if (delta > channel) {
      mask[index] = 1; different++
      const x = index % size.width, y = (index - x) / size.width
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  const compared = pixels - ignored
  return { width: size.width, height: size.height, comparedPixels: compared, ignoredPixels: ignored, differentPixels: different,
    diffRatio: compared ? different / compared : 0, maxChannelDelta: maxDelta,
    diffBounds: different ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null, mask }
}

/**
 * The diff image: the capture faded to grey, differing pixels in solid red and ignored areas darkened. `red` is the byte
 * index of the red channel in the platform's bitmap order (0 for RGBA, 2 for BGRA).
 */
export function diffBitmap(actual: Buffer, comparison: ImageComparison, red: 0 | 2): Buffer {
  const out = Buffer.alloc(actual.length)
  const blue = red === 0 ? 2 : 0
  for (let index = 0; index < comparison.mask.length; index++) {
    const offset = index * 4
    const grey = Math.round((actual[offset]! + actual[offset + 1]! + actual[offset + 2]!) / 3)
    if (comparison.mask[index] === 1) { out[offset + red] = 255; out[offset + 1] = 0; out[offset + blue] = 0 }
    else {
      const faded = comparison.mask[index] === 2 ? Math.round(grey * 0.25) : Math.round(160 + grey * 0.35)
      out[offset] = faded; out[offset + 1] = faded; out[offset + 2] = faded
    }
    out[offset + 3] = 255
  }
  return out
}
