import { deflateSync, crc32 } from 'node:zlib'
import { nativeImage } from 'electron'
import { compareBitmaps, diffBitmap, ignorePixels, pngSize, type PixelRectangle } from './browser-image-compare.js'
import type { BrowserTestReport, BrowserTestStep } from './browser-test-plan.js'
import type { TestObservation } from './browser-test-runner.js'

type Screenshot = BrowserTestReport['screenshots'][number]
interface Capture { imageBase64: string; redacted: boolean; region?: PixelRectangle; viewport: { width: number; height: number } }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A one-pixel opaque red PNG, written here so the platform's bitmap byte order can be read back from Chromium's decoder. */
function redPixelPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))])
}

let redIndex: 0 | 2 | null = null
/** Where red sits in a NativeImage bitmap on this platform: 2 for BGRA, 0 for RGBA. */
function bitmapRed(): 0 | 2 {
  if (redIndex === null) redIndex = nativeImage.createFromBuffer(redPixelPng()).toBitmap()[0] === 255 ? 0 : 2
  return redIndex
}

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places

/** Compares a test capture with the plan's reference PNG. The capture is always kept as evidence, and a diff image when pixels differ. */
export function compareCapture(step: BrowserTestStep, capture: Capture): TestObservation {
  const area = capture.region ? { width: capture.region.width, height: capture.region.height } : capture.viewport
  const kept: Screenshot = { step: 0, imageBase64: capture.imageBase64, redacted: capture.redacted, kind: 'capture', ...(capture.region ? { region: capture.region } : {}) }
  const actual = nativeImage.createFromBuffer(Buffer.from(capture.imageBase64, 'base64'))
  const size = actual.getSize()
  const scale = { x: size.width / area.width, y: size.height / area.height }
  const baselineBytes = Buffer.from(step.baselineImage!, 'base64')
  const summary = { baseline: step.baseline, width: size.width, height: size.height, cssWidth: round(area.width, 2), cssHeight: round(area.height, 2),
    scale: round(scale.x, 4) }
  const unreadable: TestObservation = { passed: false, reason: 'The baseline file is not a PNG image that can be read.', data: { comparison: summary }, screenshots: [kept] }
  // The size comes from the header, so only a reference the size of the capture is ever decoded.
  const expected = pngSize(baselineBytes)
  if (!expected) return unreadable
  if (expected.width !== size.width || expected.height !== size.height) {
    return { passed: false, data: { comparison: { ...summary, baselineWidth: expected.width, baselineHeight: expected.height } }, screenshots: [kept],
      reason: `The baseline is ${expected.width}×${expected.height} pixels but the capture is ${size.width}×${size.height} pixels (${summary.cssWidth}×${summary.cssHeight} CSS pixels at scale ${summary.scale}). Nothing is rescaled: recreate the baseline from a capture of the same area at the same browser zoom and display scaling.` }
  }
  const reference = nativeImage.createFromBuffer(baselineBytes)
  const decoded = reference.getSize()
  if (reference.isEmpty() || decoded.width !== size.width || decoded.height !== size.height) return unreadable
  const channel = step.imageTolerance?.channel ?? 0
  const maxDiffRatio = step.imageTolerance?.maxDiffRatio ?? 0
  const bitmap = actual.toBitmap()
  const result = compareBitmaps(bitmap, reference.toBitmap(), size, channel, ignorePixels(step.ignore ?? [], size, scale))
  const bounds = result.diffBounds
  const comparison = { ...summary, tolerance: { channel, maxDiffRatio }, comparedPixels: result.comparedPixels, ignoredPixels: result.ignoredPixels,
    differentPixels: result.differentPixels, diffRatio: round(result.diffRatio, 6), maxChannelDelta: result.maxChannelDelta,
    ...(bounds ? { diffBounds: { x: round(bounds.x / scale.x, 1), y: round(bounds.y / scale.y, 1), width: round(bounds.width / scale.x, 1), height: round(bounds.height / scale.y, 1) },
      diffBoundsPixels: bounds } : {}) }
  const screenshots: Screenshot[] = [kept]
  if (result.differentPixels) {
    const png = nativeImage.createFromBitmap(diffBitmap(bitmap, result, bitmapRed()), { ...size, scaleFactor: 1 }).toPNG()
    if (png.length <= 2 * 1024 * 1024) screenshots.push({ step: 0, imageBase64: png.toString('base64'), redacted: capture.redacted, kind: 'diff', ...(capture.region ? { region: capture.region } : {}) })
  }
  if (!result.comparedPixels) return { passed: false, reason: 'Every pixel is inside an ignore rectangle, so nothing was compared.', data: { comparison }, screenshots }
  const percent = (value: number): string => `${round(value * 100, 4)}%`
  if (result.diffRatio > maxDiffRatio) {
    return { passed: false, data: { comparison }, screenshots,
      reason: `${result.differentPixels} of ${result.comparedPixels} compared pixels (${percent(result.diffRatio)}) differ from the baseline by more than ${channel} in a channel; at most ${percent(maxDiffRatio)} may differ. The largest difference is ${result.maxChannelDelta}${comparison.diffBounds ? `, within x ${comparison.diffBounds.x}, y ${comparison.diffBounds.y}, ${comparison.diffBounds.width}×${comparison.diffBounds.height} CSS pixels of the compared area` : ''}.` }
  }
  return { passed: true, data: { comparison }, screenshots,
    detail: result.differentPixels ? `${result.differentPixels} pixels (${percent(result.diffRatio)}) differ, within the allowed ${percent(maxDiffRatio)}.` : 'The capture matches the baseline.' }
}
