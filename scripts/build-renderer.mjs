import * as esbuild from 'esbuild'

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
  })
}

console.log('[build-renderer] Renderer bundles built.')
