import assert from 'node:assert/strict'
import test from 'node:test'
import { embeddedTerminalEnvironment } from './node-pty-backend.js'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

test('interactive PTYs advertise the embedded xterm even when the launcher has TERM=dumb', () => {
  const inherited = { TERM: 'dumb', COLORTERM: '', KEEP_ME: 'value' }

  const result = embeddedTerminalEnvironment(inherited)

  assert.deepEqual(result, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    KEEP_ME: 'value',
  })
  assert.equal(inherited.TERM, 'dumb')
})

test('PTY shutdown preserves POSIX signal escalation and avoids duplicate ConPTY termination on dispose', async () => {
  const directory = resolve('test-results/node-pty-termination'); await mkdir(directory, { recursive: true })
  for (const platform of ['linux', 'win32']) {
    const outfile = resolve(directory, `${platform}-${randomUUID()}.mjs`)
    await build({ stdin: { contents: 'export { spawnNodePty } from "./src/main/node-pty-backend.ts"; export { signals } from "fixture-signals";', resolveDir: process.cwd() },
      outfile, bundle: true, platform: 'node', format: 'esm', define: { 'process.platform': JSON.stringify(platform) }, plugins: [{ name: 'native-boundary', setup(builder) {
        builder.onResolve({ filter: /^(node-pty|fixture-signals|\.\/process-tree\.js|\.\/session-worktree-launch\.js)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
          args.path === 'fixture-signals' ? 'export const signals=[]' : args.path === 'node-pty'
            ? 'import {signals} from "fixture-signals"; export function spawn(){return {pid:123,onExit(){},onData(){},write(){},resize(){},kill(signal){signals.push(signal)}}}'
            : args.path.includes('process-tree') ? 'import {signals} from "fixture-signals"; export function signalProcessGroup(pid,signal){signals.push(signal)}; export function startProcessWatchdog(){return {release(){}}}'
              : 'export async function prepareSessionWorktree(args,options){return {args,options}}' }))
      } }] })
    const fixture = await import(pathToFileURL(outfile).href)
    const pty = await fixture.spawnNodePty('shell', [], { cwd: '.', env: {}, cols: 80, rows: 24 })
    pty.kill('SIGTERM'); pty.kill('SIGKILL'); pty.dispose(); pty.dispose()
    assert.deepEqual(fixture.signals, platform === 'linux' ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'])
  }
})
