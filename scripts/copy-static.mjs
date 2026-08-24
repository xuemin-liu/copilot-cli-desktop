import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

async function copyIfExists(from, to) {
  if (!existsSync(from)) return
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}

await mkdir('dist/src/renderer', { recursive: true })
await mkdir('dist/src/preload', { recursive: true })

await copyIfExists('src/renderer/index.html', 'dist/src/renderer/index.html')
await copyIfExists('src/renderer/settings.html', 'dist/src/renderer/settings.html')
await copyIfExists('src/renderer/styles.css', 'dist/src/renderer/styles.css')
await copyIfExists('src/preload/preload.cjs', 'dist/src/preload/preload.cjs')
await copyIfExists('src/preload/settings-preload.cjs', 'dist/src/preload/settings-preload.cjs')
await copyIfExists('node_modules/@xterm/xterm/css/xterm.css', 'dist/src/renderer/xterm.css')
await copyIfExists('build/icon.png', 'dist/build/icon.png')

console.log('[copy-static] Static assets copied to dist/.')
