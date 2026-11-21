import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// The real command, as a person runs it, with its state in a folder of its own. Nothing here starts copilot.
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url))

function run(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, COPILOT_DESKTOP_CLI_HOME: home }, windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => resolveRun({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }))
  })
}

async function withHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'copilot-desktop-cli-commands-'))
  try { await body(home) } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
}

test('start refuses a workspace folder that does not exist, before anything is started or locked', async () => {
  await withHome(async (home) => {
    const missing = join(home, 'no-such-workspace')
    const result = await run(home, 'start', missing)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr + result.stdout, /The workspace folder does not exist/)
    assert.doesNotMatch(result.stdout, /started in the background/)
    assert.deepEqual(await readdir(home), [], 'no state, lock or log was left behind')
  })
})

test('state left by a controller that is gone does not block the commands when another program has its process id', async () => {
  await withHome(async (home) => {
    const state = join(home, 'state.json')
    // This test's process stands in for the unrelated program: alive, with the id the state names, started long after it.
    const stale = { version: 1, pid: process.pid, controlPort: 9, token: 'x'.repeat(48), workspace: home, processId: null, status: 'running', startedAt: '2020-01-01T00:00:00.000Z', error: null, warning: null }
    await writeFile(state, JSON.stringify(stale))
    const result = await run(home, 'status', '--json')
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { status: 'stopped' })
    await assert.rejects(access(state), 'the stale state is removed')

    // A controller that started before it wrote its state and is only slow to answer is kept, as before.
    await writeFile(state, JSON.stringify({ ...stale, startedAt: new Date().toISOString() }))
    const kept = await run(home, 'status', '--json')
    assert.notEqual(kept.code, 0)
    assert.match(kept.stderr, /is still running but its control API did not respond/)
    await access(state)
  })
})
