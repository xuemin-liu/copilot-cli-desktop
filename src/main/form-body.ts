import type { IncomingMessage } from 'node:http'

/**
 * Request bodies for the loopback endpoints the session helpers call. The Windows helpers send JSON. The macOS and Linux
 * helpers are `sh` scripts with `curl` and nothing else, which cannot build JSON from a file's text, so they send form data
 * and `curl` reads the file itself: the desktop still receives only text, never a path a model chose to open.
 */

/** The whole body, or null when it is larger than `maxBytes`. */
export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length
    if (bytes > maxBytes) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export const isJsonType = (contentType: string | undefined): boolean => /^application\/json(?:;|$)/i.test(contentType ?? '')
export const isFormType = (contentType: string | undefined): boolean => /^multipart\/form-data;/i.test(contentType ?? '')

/** The text fields of a `multipart/form-data` body (an uploaded file counts as text), or null when it cannot be parsed. */
export async function parseFormFields(body: Buffer, contentType: string): Promise<Map<string, string> | null> {
  try {
    const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData()
    const fields = new Map<string, string>()
    for (const [name, value] of form.entries()) {
      if (fields.has(name)) return null
      fields.set(name, typeof value === 'string' ? value : await value.text())
    }
    return fields
  } catch {
    return null
  }
}
