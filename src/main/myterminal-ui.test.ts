import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

test('the imported SSH sidebar renders arbitrary saved group names without inherited-key collisions', async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import React from 'react'
    import { renderToString } from 'react-dom/server'
    import Sidebar from './vendor/myterminal/src/components/Sidebar.jsx'
    export function render(group) {
      const state = { sessions: [{ id: 'one', host: 'example.test', username: 'user', name: 'Server', group }] }
      return renderToString(React.createElement(Sidebar, { host: { api: {}, store: () => state } }))
    }
  ` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
  const module = { exports: {} as { render(group: string): string } }
  new Function('require', 'module', 'exports', Buffer.from(bundle.outputFiles[0]!.contents).toString())(createRequire(import.meta.url), module, module.exports)
  for (const group of ['Production', 'constructor', 'toString', '__proto__', '']) {
    const html = module.exports.render(group)
    assert.ok(html.includes('Server'))
    if (group) assert.ok(html.includes(group))
  }
})
