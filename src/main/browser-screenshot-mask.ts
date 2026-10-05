interface Size { width: number; height: number }
interface Rectangle { x: number; y: number; width: number; height: number }
export interface ScreenshotMaskGeometry { viewport: Size; rectangles: Rectangle[] }

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
