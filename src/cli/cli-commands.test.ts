import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireControllerLock } from './runtime-state.js'

// The real command, as a person runs it, with its state in a folder of its own. Nothing here starts copilot.
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url))
const DAEMON = fileURLToPath(new URL('./daemon.js', import.meta.url))

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

test('start validates flags strictly before acquiring locks, creating directories, or spawning the daemon', async () => {
  await withHome(async (home) => {
    const workspace = await mkdtemp(join(tmpdir(), 'copilot-desktop-cli-ws-'))
    try {
      for (const badArgs of [
        ['start', workspace, '--unknown-flag'],
        ['start', workspace, '--preset', 'invalid-preset'],
        ['start', workspace, '--preset=invalid-preset'],
        ['start', workspace, '--resume-mode=invalid-mode'],
        ['start', workspace, '--session-id=--allow-all-tools'],
        ['start', workspace, '--preset'],
        ['start', workspace, workspace],
      ]) {
        const result = await run(home, ...badArgs)
        assert.notEqual(result.code, 0, `expected failure for ${badArgs.join(' ')}`)
        assert.deepEqual(await readdir(home), [], `no state, lock, or log created for ${badArgs.join(' ')}`)
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

test('daemon rejects invalid start flags directly and handles POST /stop cleanly while still starting', async () => {
  await withHome(async (home) => {
    const workspace = await mkdtemp(join(tmpdir(), 'copilot-desktop-daemon-ws-'))
    const fakeBin = await mkdtemp(join(tmpdir(), 'copilot-desktop-fake-bin-'))
    try {
      // 1. Direct daemon invocation with invalid --preset fails immediately without writing state.json.
      const invalidDaemon = await new Promise<{ code: number; stderr: string }>((resolveRun) => {
        execFile(
          process.execPath,
          [DAEMON, workspace, '--preset', 'not-a-preset'],
          { env: { ...process.env, COPILOT_DESKTOP_CLI_HOME: home, COPILOT_DESKTOP_LOCK_TOKEN: 'unused-token' }, windowsHide: true, timeout: 15_000 },
          (error, _stdout, stderr) => resolveRun({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr }),
        )
      })
      assert.notEqual(invalidDaemon.code, 0)
      assert.match(invalidDaemon.stderr, /Invalid --preset value/)
      await assert.rejects(access(join(home, 'state.json')))

      // 2. Slow copilot binary resolution keeps daemon in status === 'starting' (session === null) while POST /stop arrives.
      const markerPath = join(fakeBin, 'session-spawned.txt')
      const scriptPath = join(fakeBin, 'slow-copilot.mjs')
      await writeFile(scriptPath, `
        import { writeFileSync } from 'node:fs';
        if (process.argv.includes('--version')) {
          setTimeout(() => { console.log('1.0.105'); process.exit(0); }, 2500);
        } else {
          writeFileSync(${JSON.stringify(markerPath)}, 'spawned');
          setTimeout(() => process.exit(0), 10000);
        }
      `)
      if (process.platform === 'win32') {
        await writeFile(join(fakeBin, 'copilot.cmd'), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
      } else {
        const shPath = join(fakeBin, 'copilot')
        await writeFile(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
        await chmod(shPath, 0o755)
      }

      const cliPaths = {
        root: home,
        statePath: join(home, 'state.json'),
        lockPath: join(home, 'controller.lock'),
        logPath: join(home, 'controller.log'),
      }
      const lockToken = await acquireControllerLock(cliPaths)

      const daemonEnv: NodeJS.ProcessEnv = {
        ...process.env,
        COPILOT_DESKTOP_CLI_HOME: home,
        COPILOT_DESKTOP_LOCK_TOKEN: lockToken,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      }
      // Ensure resolveCopilotBinary prefers PATH over any default user location by pointing HOME/USERPROFILE/LOCALAPPDATA to fakeBin.
      daemonEnv.HOME = fakeBin
      daemonEnv.USERPROFILE = fakeBin
      daemonEnv.LOCALAPPDATA = fakeBin
      daemonEnv.APPDATA = fakeBin

      const child = spawn(process.execPath, [DAEMON, workspace, '--preset=default', '--resume-mode=new'], {
        env: daemonEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      })

      const statePath = join(home, 'state.json')
      let startingState: { pid: number; controlPort: number; token: string; status: string } | null = null
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        try {
          const parsed = JSON.parse(await readFile(statePath, 'utf8')) as { pid: number; controlPort: number; token: string; status: string }
          if (parsed.status === 'starting') {
            startingState = parsed
            break
          }
        } catch { /* Wait for initial starting state write. */ }
        await new Promise((r) => setTimeout(r, 40))
      }
      assert.ok(startingState, 'daemon wrote starting state while copilot --version was still in flight')

      const stopResponse = await new Promise<{ status: number; body: string }>((resolveReq, rejectReq) => {
        const req = request({
          host: '127.0.0.1',
          port: startingState!.controlPort,
          path: '/stop',
          method: 'POST',
          headers: { authorization: `Bearer ${startingState!.token}` },
        }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c as Buffer))
          res.on('end', () => resolveReq({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', rejectReq)
        req.end()
      })
      assert.equal(stopResponse.status, 202, `POST /stop during starting returned ${stopResponse.status}: ${stopResponse.body}`)
      assert.equal(JSON.parse(stopResponse.body).status, 'stopping')

      const exited = await exitPromise
      assert.equal(exited.code, 0, 'daemon shut down cleanly with exit code 0')
      await assert.rejects(access(statePath), 'clean stop during starting removes state.json rather than leaving crashed state')
      await assert.rejects(access(join(home, 'controller.lock')), 'clean stop during starting releases controller.lock')
      await assert.rejects(access(markerPath), 'session was fenced off and never spawned after /stop')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(fakeBin, { recursive: true, force: true })
    }
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
