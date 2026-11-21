// Takes the place of Mammoth's own archive reader (the build swaps it in for `mammoth/lib/unzip`). Mammoth would open
// the .docx with a ZIP library that unpacks whatever a part claims to hold. Here every part Mammoth asks for (the
// document, styles, numbering, notes, pictures) comes from the app's ZIP reader instead, which stops at a limit for the
// part and at a limit for all parts together, counted while unpacking.
import type { ZipReader } from './zip-reader.js'

/** Most bytes one part of a Word document may unpack to: XML parts, and pictures. */
export const DOCX_PART_BYTES = 100 * 1024 * 1024
export const DOCX_PICTURE_BYTES = 25 * 1024 * 1024

interface DocxArchive { exists(name: string): boolean; read(name: string, encoding?: string): Promise<string | Uint8Array> }

function base64(bytes: Uint8Array): string {
  let binary = ''
  // In pieces: a single call with a large picture would overflow the argument list.
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** The archive as Mammoth uses one, reading through `reader`. A part read twice is unpacked, and counted, once. */
export function docxArchive(reader: ZipReader): DocxArchive {
  const parts = new Map<string, Promise<Uint8Array>>()
  const part = (name: string): Promise<Uint8Array> => {
    let bytes = parts.get(name)
    if (!bytes) { bytes = reader.read(name, /^word\/media\//i.test(name) ? DOCX_PICTURE_BYTES : DOCX_PART_BYTES); parts.set(name, bytes) }
    return bytes
  }
  return {
    exists: name => reader.entries.has(name),
    read: async (name, encoding) => {
      const bytes = await part(name)
      return encoding === 'base64' ? base64(bytes) : encoding ? new TextDecoder(encoding).decode(bytes) : bytes
    },
  }
}

/** Mammoth calls this with the input given to `convertToHtml`. Only an archive made by `docxArchive` is accepted. */
export function openZip(options: { docx?: DocxArchive }): Promise<DocxArchive> {
  return options.docx ? Promise.resolve(options.docx) : Promise.reject(new Error('Word documents are opened through the checked archive reader only'))
}
