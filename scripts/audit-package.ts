import { existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const unpackedRoot = resolve(process.argv[2] ?? 'release/win-unpacked')
const resourcesRoot = join(unpackedRoot, 'resources')
const asarPath = join(resourcesRoot, 'app.asar')
const unpackedAsarRoot = join(resourcesRoot, 'app.asar.unpacked')

if (!existsSync(asarPath)) throw new Error(`Packaged application archive is missing: ${asarPath}`)
if (!existsSync(unpackedAsarRoot)) throw new Error(`Native-module unpack directory is missing: ${unpackedAsarRoot}`)

function findFiles(root: string, predicate: (path: string) => boolean): string[] {
  const found: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (predicate(path)) found.push(path)
    }
  }
  return found
}

const nativeAddons = findFiles(unpackedAsarRoot, (path) => path.toLowerCase().endsWith('.node'))
if (nativeAddons.length === 0) {
  throw new Error('The packaged application has no unpacked native node-pty addon')
}
if (!nativeAddons.some((path) => /node-pty/i.test(path))) {
  throw new Error('The packaged native addons do not include node-pty')
}

const executables = readdirSync(unpackedRoot).filter((entry) => entry.toLowerCase().endsWith('.exe'))
if (executables.length === 0) throw new Error(`No Windows executable was found in ${unpackedRoot}`)

process.stdout.write(
  `Packaged runtime audit passed (${basename(asarPath)}, ${nativeAddons.length} native addon(s), ${executables.length} executable(s)).\n`,
)
