import { StringDecoder } from 'node:string_decoder'

/** Truncate valid UTF-8 text without emitting a partial trailing code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  const decoder = new StringDecoder('utf8')
  return decoder.write(bytes.subarray(0, maxBytes))
}
