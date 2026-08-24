// Generates build/icon.png from scratch with zero image-processing
// dependencies (no sharp/canvas): a minimal raw PNG encoder draws a simple
// open-ring "C" monogram. Keeping this dependency-free avoids adding another
// native module (sharp) alongside node-pty.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const SIZE = 256
const BACKGROUND = [11, 16, 32]
const ACCENT = [88, 166, 255]
const OUTER_RADIUS = SIZE * 0.36
const INNER_RADIUS = SIZE * 0.22
const GAP_START = -Math.PI / 4
const GAP_END = Math.PI / 4

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1
  crcTable[n] = c >>> 0
}

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

const stride = 1 + SIZE * 4
const raw = Buffer.alloc(SIZE * stride)
const cx = SIZE / 2
const cy = SIZE / 2

for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * stride
  raw[rowStart] = 0 // filter type: none
  for (let x = 0; x < SIZE; x += 1) {
    const dx = x - cx
    const dy = y - cy
    const distance = Math.sqrt(dx * dx + dy * dy)
    const angle = Math.atan2(dy, dx)
    const inRing = distance <= OUTER_RADIUS && distance >= INNER_RADIUS
    const inGap = angle > GAP_START && angle < GAP_END
    const [r, g, b] = inRing && !inGap ? ACCENT : BACKGROUND
    const idx = rowStart + 1 + x * 4
    raw[idx] = r
    raw[idx + 1] = g
    raw[idx + 2] = b
    raw[idx + 3] = 255
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const png = Buffer.concat([
  signature,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('[generate-icon] Wrote build/icon.png')
