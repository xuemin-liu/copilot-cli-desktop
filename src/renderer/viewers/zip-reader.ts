// A small reader for ZIP archives (.xlsx and .docx are ZIP files), written so that every limit is enforced while data is
// being unpacked, not taken from what the archive claims: a file that says it is 1 KB and unpacks to gigabytes is stopped
// at the limit. No DOM and no network; runs in a worker and in tests.

export class ZipError extends Error {
  constructor(readonly reason: 'invalid' | 'too-large' | 'protected', message: string) { super(message) }
}

export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number; encrypted: boolean }
export interface ZipLimits {
  /** Most entries an archive may list. */
  entries: number
  /** Most bytes all unpacked entries together may come to, counted as they are unpacked. */
  totalBytes: number
}

const END_SIGNATURE = 0x06054b50, DIRECTORY_SIGNATURE = 0x02014b50, LOCAL_SIGNATURE = 0x04034b50

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>()
  private readonly view: DataView
  private unpacked = 0

  constructor(private readonly bytes: Uint8Array, private readonly limits: ZipLimits) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // The end record is at the very end, after a comment of at most 65,535 bytes.
    let end = -1
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
      if (this.view.getUint32(at, true) === END_SIGNATURE) { end = at; break }
    }
    if (end < 0) throw new ZipError('invalid', 'Not a ZIP archive')
    const count = this.view.getUint16(end + 10, true), size = this.view.getUint32(end + 12, true), start = this.view.getUint32(end + 16, true)
    if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipError('too-large', 'ZIP64 archives are not supported')
    if (count > limits.entries) throw new ZipError('too-large', 'The archive lists too many files')
    if (start + size > end) throw new ZipError('invalid', 'The archive directory is damaged')
    const decoder = new TextDecoder('utf-8')
    let at = start
    for (let index = 0; index < count; index++) {
      if (at + 46 > end || this.view.getUint32(at, true) !== DIRECTORY_SIGNATURE) throw new ZipError('invalid', 'The archive directory is damaged')
      const flags = this.view.getUint16(at + 8, true), nameLength = this.view.getUint16(at + 28, true)
      const extraLength = this.view.getUint16(at + 30, true), commentLength = this.view.getUint16(at + 32, true)
      if (nameLength > 1_024 || at + 46 + nameLength > end) throw new ZipError('invalid', 'The archive directory is damaged')
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
      const entry: ZipEntry = { name, method: this.view.getUint16(at + 10, true), compressedSize: this.view.getUint32(at + 20, true),
        size: this.view.getUint32(at + 24, true), offset: this.view.getUint32(at + 42, true), encrypted: (flags & 1) === 1 }
      if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) throw new ZipError('too-large', 'ZIP64 archives are not supported')
      // The first entry of a name wins: a second one with the same name cannot replace what was checked.
      if (!this.entries.has(name)) this.entries.set(name, entry)
      at += 46 + nameLength + extraLength + commentLength
    }
  }

  /** The sizes the archive claims, for a first check before anything is unpacked. */
  get declaredBytes(): number { let total = 0; for (const entry of this.entries.values()) total += entry.size; return total }

  /** Unpack one entry, refusing to produce more than `maxBytes` for it or more than the archive's total limit. */
  async read(name: string, maxBytes: number): Promise<Uint8Array> {
    const entry = this.entries.get(name)
    if (!entry) throw new ZipError('invalid', `The archive has no ${name}`)
    if (entry.encrypted) throw new ZipError('protected', 'The archive is protected with a password')
    const header = entry.offset
    if (header + 30 > this.bytes.length || this.view.getUint32(header, true) !== LOCAL_SIGNATURE) throw new ZipError('invalid', 'The archive is damaged')
    const start = header + 30 + this.view.getUint16(header + 26, true) + this.view.getUint16(header + 28, true)
    if (start + entry.compressedSize > this.bytes.length) throw new ZipError('invalid', 'The archive is damaged')
    const packed = this.bytes.subarray(start, start + entry.compressedSize)
    const allowed = Math.min(maxBytes, this.limits.totalBytes - this.unpacked)
    if (entry.method === 0) {
      if (packed.length > allowed) throw new ZipError('too-large', `${name} is too large`)
      this.unpacked += packed.length
      return packed
    }
    if (entry.method !== 8) throw new ZipError('invalid', `${name} uses a compression this viewer cannot read`)
    const stream = new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > allowed) throw new ZipError('too-large', `${name} is too large`)
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error instanceof ZipError ? error : new ZipError('invalid', `${name} is damaged`)
    }
    this.unpacked += length
    // The claimed size is never used as a limit, but an entry that unpacks to another size is damaged or lying.
    if (length !== entry.size) throw new ZipError('invalid', `${name} is damaged`)
    const out = new Uint8Array(length)
    let at = 0
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
    return out
  }

  async text(name: string, maxBytes: number): Promise<string> { return new TextDecoder('utf-8').decode(await this.read(name, maxBytes)) }
}
