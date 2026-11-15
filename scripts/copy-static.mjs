import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
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
await copyIfExists('vendor/myterminal/electron', 'dist/vendor/myterminal/electron')
await copyIfExists('vendor/myterminal/services.cjs', 'dist/vendor/myterminal/services.cjs')
await copyIfExists('vendor/myterminal/package.json', 'dist/vendor/myterminal/package.json')
const terminalCss = await readFile('vendor/myterminal/src/index.css', 'utf8')
const variables = terminalCss.match(/:root\s*\{([^}]+)\}/)?.[1] ?? ''
await writeFile('dist/src/renderer/myterminal.css', `.myterminal-embedded {${variables}}\n@scope (.myterminal-embedded) {\n${terminalCss}\n}\n`)

console.log('[copy-static] Static assets copied to dist/.')
