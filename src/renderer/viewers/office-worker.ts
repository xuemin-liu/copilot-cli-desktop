// The worker that reads Word and Excel files. One is started for each conversion and ended when it answers, when it takes
// too long, or when its tab goes away, so a file that makes a parser run forever or use too much memory costs one worker.
// It has no DOM and no access to the app's API, and its ways to the network are removed first.
import './worker-lockdown.js'
import mammoth from 'mammoth'
import { readWorkbook, type SheetData } from './xlsx-reader.js'
import { ZipError, ZipReader } from './zip-reader.js'
import { docxArchive } from './mammoth-unzip.js'

export type OfficeRequest = { kind: 'docx' | 'xlsx'; bytes: Uint8Array }
export type OfficeProblem = 'invalid' | 'too-large' | 'protected' | 'failed'
export type OfficeReply = { ok: true; kind: 'docx'; html: string; warnings: number } | { ok: true; kind: 'xlsx'; sheets: SheetData[] } | { ok: false; problem: OfficeProblem }

export const DOCX_LIMITS = {
  entries: 5_000,
  /** All parts the converter reads, unpacked, together. Counted while unpacking, whatever the archive claims. */
  unpackedBytes: 200 * 1024 * 1024,
  /** Pictures kept in the result, counted in base64 characters; more than this are left out. */
  imageChars: 40 * 1024 * 1024,
  /** The HTML handed back to the window. */
  htmlChars: 24 * 1024 * 1024,
}
const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp'])

async function convertDocument(bytes: Uint8Array): Promise<OfficeReply> {
  // The converter never opens the archive itself. Every part it reads comes through this reader (see mammoth-unzip.ts),
  // which counts bytes as it unpacks them: a limit for each part, and this one for all of them together.
  const zip = new ZipReader(bytes, { entries: DOCX_LIMITS.entries, totalBytes: DOCX_LIMITS.unpackedBytes })
  const main = zip.entries.get('word/document.xml')
  if (!main) throw new ZipError('invalid', 'Not a Word document')
  if (main.encrypted) throw new ZipError('protected', 'The document is protected with a password')
  let pictures = 0, problem: unknown = null
  const kept = async <Result>(work: Promise<Result>): Promise<Result> => { try { return await work } catch (error) { problem ??= error; throw error } }
  const archive = docxArchive(zip)
  const input = { docx: { exists: archive.exists, read: (name: string, encoding?: string) => kept(archive.read(name, encoding)) } }
  let result
  try {
    result = await mammoth.convertToHtml(input as unknown as Parameters<typeof mammoth.convertToHtml>[0], {
      convertImage: mammoth.images.imgElement(async image => {
        if (!PICTURES.has(image.contentType)) return { src: '' }
        const data = await image.readAsBase64String()
        pictures += data.length
        return pictures > DOCX_LIMITS.imageChars ? { src: '' } : { src: `data:${image.contentType};base64,${data}` }
      }),
    })
  } catch (error) { throw problem ?? error }
  // The converter reports some failed reads as warnings and carries on. A part over its limit is not a warning.
  if (problem instanceof ZipError && problem.reason !== 'invalid') throw problem
  if (result.value.length > DOCX_LIMITS.htmlChars) throw new ZipError('too-large', 'The document is too large')
  return { ok: true, kind: 'docx', html: result.value, warnings: result.messages.length }
}

self.onmessage = (event: MessageEvent<OfficeRequest>) => {
  const { kind, bytes } = event.data
  const work = kind === 'xlsx' ? readWorkbook(bytes).then((sheets): OfficeReply => ({ ok: true, kind: 'xlsx', sheets })) : convertDocument(bytes)
  work.catch((error: unknown): OfficeReply => ({ ok: false, problem: error instanceof ZipError ? error.reason : 'failed' }))
    .then(reply => (self as unknown as { postMessage(message: OfficeReply): void }).postMessage(reply))
}
