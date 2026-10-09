import { realpath } from 'node:fs'

/** `fs.realpath.native`: resolves links and junctions and expands 8.3 short names, unlike the JS `realpath`. */
export function realPathNative(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpath.native(path, (error, resolved) => error ? reject(error) : resolve(resolved))
  })
}
