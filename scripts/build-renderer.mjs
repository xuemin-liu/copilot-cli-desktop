import * as esbuild from 'esbuild'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'

const entries = [
  { in: 'src/renderer/renderer.tsx', out: 'dist/src/renderer/app.js' },
  { in: 'src/renderer/settings.tsx', out: 'dist/src/renderer/settings.js' },
]

for (const entry of entries) {
  await esbuild.build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: true,
    logLevel: 'info',
  })
}

// File viewers are separate scripts the app loads when a file of that kind is first opened (src/renderer/file-viewers.ts).
// Each registers itself on window.copilotFileViewers, so a plain script tag is enough and no module loader is needed.
const viewers = [
  { in: 'src/renderer/viewers/text-viewer.ts', out: 'dist/src/renderer/viewer-text.js' },
  { in: 'src/renderer/viewers/pdf-viewer.ts', out: 'dist/src/renderer/viewer-pdf.js' },
  // PDF.js parses documents in this worker, which has no DOM, no access to the app's API and no network.
  { in: 'src/renderer/viewers/pdf-worker.ts', out: 'dist/src/renderer/viewer-pdf-worker.js' },
]
for (const viewer of viewers) {
  await esbuild.build({
    entryPoints: [viewer.in],
    outfile: viewer.out,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'info',
    loader: { '.svg': 'dataurl', '.gif': 'dataurl', '.png': 'dataurl', '.cur': 'dataurl' },
  })
}

// PDF.js's own stylesheet is written for a page it owns: it sets variables on :root and uses class names such as
// .dialog and .sidebar that this app uses too. Keep it inside the PDF view. Rules that cannot sit in a scope
// (@keyframes, @font-face, @property) stay at the top level; they only define names.
{
  const file = 'dist/src/renderer/viewer-pdf.css'
  const css = await readFile(file, 'utf8')
  const scoped = [], global = []
  for (let index = 0; index < css.length;) {
    const open = css.indexOf('{', index)
    if (open < 0) break
    let depth = 1, end = open + 1
    for (; end < css.length && depth > 0; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0
    const block = css.slice(index, end)
    ;(/^\s*@(?:keyframes|font-face|property|charset|import|namespace)\b/.test(block) ? global : scoped).push(block)
    index = end
  }
  await writeFile(file, `${global.join('')}@scope (.file-pdf){${scoped.join('').replaceAll(':root', ':scope')}}`)
}

// Data files PDF.js reads for some documents. The main process serves them to the viewer (desktop:viewer-asset).
await rm('dist/src/renderer/pdf', { recursive: true, force: true })
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${folder}`, `dist/src/renderer/pdf/${folder}`, { recursive: true })
}
for (const unused of ['quickjs-eval.js', 'quickjs-eval.wasm']) await rm(`dist/src/renderer/pdf/wasm/${unused}`, { force: true })

console.log('[build-renderer] Renderer bundles built.')
