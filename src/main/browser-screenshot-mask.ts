interface Size { width: number; height: number }
export interface Rectangle { x: number; y: number; width: number; height: number }
export interface ScreenshotMaskGeometry { viewport: Size; rectangles: Rectangle[] }
export interface ScreenshotLayout extends ScreenshotMaskGeometry { scrollX: number; scrollY: number; truncated: boolean }

/** CDP may reorder object keys; compare layout values instead of JSON text. */
export function sameScreenshotLayout(before: ScreenshotLayout, after: ScreenshotLayout): boolean {
  return before.viewport.width === after.viewport.width && before.viewport.height === after.viewport.height
    && before.scrollX === after.scrollX && before.scrollY === after.scrollY && before.truncated === after.truncated
    && before.rectangles.length === after.rectangles.length && before.rectangles.every((rect, index) => {
      const other = after.rectangles[index]!
      return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height
    })
}

/** The physical-pixel rectangle for a CSS-pixel viewport region, rounded outwards and clipped to
 * the image. Null when nothing of the region is on screen. Applied after masking, never before. */
export function screenshotCrop(size: Size, viewport: Size, region: Rectangle): Rectangle | null {
  if (![size.width, size.height, viewport.width, viewport.height, region.x, region.y, region.width, region.height].every(Number.isFinite)
    || size.width < 1 || size.height < 1 || viewport.width <= 0 || viewport.height <= 0 || region.width <= 0 || region.height <= 0) return null
  const scaleX = size.width / viewport.width
  const scaleY = size.height / viewport.height
  const left = Math.max(0, Math.floor(region.x * scaleX))
  const top = Math.max(0, Math.floor(region.y * scaleY))
  const right = Math.min(size.width, Math.ceil((region.x + region.width) * scaleX))
  const bottom = Math.min(size.height, Math.ceil((region.y + region.height) * scaleY))
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

/** NativeImage's platform bitmap format is preserved. Equal RGB components and
 * opaque alpha work with both BGRA and RGBA. Never trust compositor mask timing. */
export function maskScreenshotBitmap(bitmap: Buffer, size: Size, geometry: ScreenshotMaskGeometry): Buffer {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1
    || size.width * size.height > 16_000_000 || bitmap.length !== size.width * size.height * 4
    || !Number.isFinite(geometry.viewport?.width) || !Number.isFinite(geometry.viewport?.height)
    || geometry.viewport.width <= 0 || geometry.viewport.height <= 0 || !Array.isArray(geometry.rectangles)
    || geometry.rectangles.some(rect => !rect || [rect.x, rect.y, rect.width, rect.height].some(value => !Number.isFinite(value))
      || rect.width < 0 || rect.height < 0)) {
    throw new Error('Screenshot mask geometry is unavailable; no image was exported.')
  }
  const scaleX = size.width / geometry.viewport.width
  const scaleY = size.height / geometry.viewport.height
  const opaque = Buffer.from([17, 17, 17, 255])
  for (const rect of geometry.rectangles) {
    // Round outwards and add a pixel around edges to cover fractional CSS bounds.
    const left = Math.max(0, Math.floor(rect.x * scaleX) - 1)
    const top = Math.max(0, Math.floor(rect.y * scaleY) - 1)
    const right = Math.min(size.width, Math.ceil((rect.x + rect.width) * scaleX) + 1)
    const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height) * scaleY) + 1)
    if (right <= left || bottom <= top) continue
    for (let y = top; y < bottom; y++) bitmap.fill(opaque, (y * size.width + left) * 4, (y * size.width + right) * 4)
  }
  return bitmap
}

/** Masks the whole viewport bitmap, then cuts out the region. Masks use full-viewport geometry,
 * so they must be painted before the crop: cutting first would shift every mask. Null when the
 * region is not on screen. */
export function maskAndCrop(bitmap: Buffer, size: Size, geometry: ScreenshotMaskGeometry, region?: Rectangle): { bitmap: Buffer; size: Size; pixels: Rectangle | null } | null {
  const masked = maskScreenshotBitmap(bitmap, size, geometry)
  if (!region) return { bitmap: masked, size, pixels: null }
  const pixels = screenshotCrop(size, geometry.viewport, region)
  if (!pixels) return null
  const out = Buffer.alloc(pixels.width * pixels.height * 4)
  for (let row = 0; row < pixels.height; row++) {
    const start = ((pixels.y + row) * size.width + pixels.x) * 4
    masked.copy(out, row * pixels.width * 4, start, start + pixels.width * 4)
  }
  return { bitmap: out, size: { width: pixels.width, height: pixels.height }, pixels }
}
