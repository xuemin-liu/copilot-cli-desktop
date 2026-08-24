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

console.log('[build-renderer] Renderer bundles built.')
