#!/usr/bin/env node
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDaemonAlive, sendControl } from './control-client.js'
import {
  ensureCliDirectories,
  acquireControllerLock,
  getCliPaths,
  isProcessAlive,
  readDaemonState,
  removeDaemonState,
  releaseControllerLock,
  type DaemonState,
  type PublicDaemonState,
} from './runtime-state.js'
import { findWorkspaceArgument } from './start-arguments.js'

const paths = getCliPaths()
const daemonEntry = fileURLToPath(new URL('./daemon.js', import.meta.url))

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function printState(state: PublicDaemonState): void {
  console.log(`Status:    ${state.status}`)
  console.log(`Workspace: ${state.workspace}`)
  console.log(`PID:       ${state.pid}`)
  console.log(`Started:   ${state.startedAt}`)
  if (state.processId) console.log(`copilot PID: ${state.processId}`)
  if (state.error) console.log(`Error:     ${state.error}`)
}

async function getLiveState(): Promise<DaemonState | null> {
  const saved = await readDaemonState(paths)
  if (!saved) return null
  if (await isDaemonAlive(saved)) return saved
  if (isProcessAlive(saved.pid)) {
    throw new Error(
      `Controller PID ${saved.pid} is still running but its control API did not respond; preserved ${paths.statePath}`,
    )
  }
  await removeDaemonState(paths)
  return null
}

async function waitForStartup(timeoutMs = 60_000): Promise<DaemonState> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const saved = await readDaemonState(paths)
    if (saved) {
      if (saved.status === 'crashed') throw new Error(saved.error ?? 'copilot failed to start')
      if (!isProcessAlive(saved.pid)) {
        throw new Error(`Background controller PID ${saved.pid} exited during startup`)
      }
      if (await isDaemonAlive(saved)) {
        const current = await sendControl(saved, '/status')
        if (current.status === 'running') return { ...saved, ...current }
        if (current.status === 'crashed') throw new Error(current.error ?? 'copilot failed to start')
      }
      if (!isProcessAlive(saved.pid)) {
        throw new Error(`Background controller PID ${saved.pid} exited during startup`)
      }
    }
    await delay(250)
  }
  throw new Error('Timed out waiting for the background controller to start')
}

async function start(workspaceArgument: string | undefined, extraArgs: string[]): Promise<void> {
  const existing = await getLiveState()
  if (existing) {
    const current = await sendControl(existing, '/status')
    console.log('copilot is already controlled by this user.')
    printState(current)
    return
  }

  const workspace = resolve(workspaceArgument ?? process.cwd())
  await ensureCliDirectories(paths)
  const lockToken = await acquireControllerLock(paths)

  try {
    const raced = await getLiveState()
    if (raced) {
      await releaseControllerLock(paths, lockToken, process.pid)
      const current = await sendControl(raced, '/status')
      console.log('copilot is already controlled by this user.')
      printState(current)
      return
    }

    const logHandle = openSync(paths.logPath, 'a')
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, [daemonEntry, workspace, ...extraArgs], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logHandle, logHandle],
        env: { ...process.env, COPILOT_DESKTOP_LOCK_TOKEN: lockToken },
      })
    } finally {
      closeSync(logHandle)
    }
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        void readDaemonState(paths).then((saved) => {
          if (saved && saved.pid === child.pid && saved.status === 'crashed' && saved.error) {
            reject(new Error(saved.error))
            return
          }
          reject(new Error(`Background controller exited during startup (code ${String(code)}, signal ${String(signal)})`))
        }, reject)
      })
    })
    child.unref()

    const running = await Promise.race([waitForStartup(), spawnFailure])
    console.log('copilot started in the background.')
    printState(running)
  } catch (error) {
    await releaseControllerLock(paths, lockToken, process.pid)
    throw error
  }
}

async function status(asJson: boolean): Promise<void> {
  const saved = await getLiveState()
  if (!saved) {
    if (asJson) console.log(JSON.stringify({ status: 'stopped' }))
    else console.log('copilot is stopped.')
    return
  }
  const current = await sendControl(saved, '/status')
  if (asJson) console.log(JSON.stringify(current))
  else printState(current)
}

async function stop(): Promise<void> {
  const saved = await getLiveState()
  if (!saved) {
    console.log('copilot is already stopped.')
    return
  }
  await sendControl(saved, '/stop', 'POST', 15_000)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && isProcessAlive(saved.pid)) await delay(200)
  if (isProcessAlive(saved.pid)) {
    throw new Error(`Controller PID ${saved.pid} did not stop within 15 seconds`)
  }

  const cleanupToken = await acquireControllerLock(paths)
  try {
    const remaining = await readDaemonState(paths)
    if (remaining && remaining.pid !== saved.pid) {
      throw new Error(`A new controller started while PID ${saved.pid} was stopping`)
    }
    if (remaining) await removeDaemonState(paths)
  } finally {
    await releaseControllerLock(paths, cleanupToken, process.pid)
  }
  console.log('copilot stopped.')
}

async function restart(): Promise<void> {
  const saved = await getLiveState()
  if (!saved) throw new Error('copilot is stopped. Run `copilot-desktop start` first.')
  const current = await sendControl(saved, '/restart', 'POST', 60_000)
  if (current.status !== 'running') throw new Error(current.error ?? 'copilot failed to restart')
  console.log('copilot restarted.')
  printState(current)
}

async function remoteLogs(tail: number): Promise<void> {
  const saved = await getLiveState()
  if (saved) {
    const current = await sendControl(saved, '/logs')
    for (const line of (current.logs ?? []).slice(-tail)) console.log(line)
    return
  }
  try {
    const contents = await readFile(paths.logPath, 'utf8')
    console.log(contents.trimEnd().split(/\r?\n/).slice(-tail).join('\n'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No controller log exists yet.')
      return
    }
    throw error
  }
}

function help(): void {
  console.log(`copilot-cli-desktop background CLI

Usage:
  copilot-desktop start [workspace] [--preset default|trusted-directory|full-auto]
                                     [--resume-mode new|auto-resume|continue|picker]
                                     [--session-id ID]
  copilot-desktop status [--json]
  copilot-desktop restart
  copilot-desktop logs [--tail N]
  copilot-desktop stop

The controller runs in the background and binds its private control API to
127.0.0.1 only, with a random bearer token. One controller is supported per
Windows user. This is an unofficial wrapper; it is not affiliated with GitHub
or Microsoft. The background controller runs copilot without a real
interactive terminal attached (see src/main/child-process-pty-backend.ts) —
for full interactive TUI use the desktop app's session tabs instead.`)
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  const command = args[0] ?? 'help'
  switch (command) {
    case 'start': {
      const rest = args.slice(1)
      const workspace = findWorkspaceArgument(rest)
      await start(workspace, rest)
      break
    }
    case 'status': await status(args.includes('--json')); break
    case 'stop': await stop(); break
    case 'restart': await restart(); break
    case 'logs': {
      const tailIndex = args.indexOf('--tail')
      const requested = tailIndex >= 0 ? Number(args[tailIndex + 1]) : 80
      if (!Number.isInteger(requested) || requested < 1 || requested > 10_000) {
        throw new Error('--tail must be an integer between 1 and 10000')
      }
      await remoteLogs(requested)
      break
    }
    case 'help':
    case '--help':
    case '-h': help(); break
    default: throw new Error(`Unknown command: ${command}. Run copilot-desktop --help.`)
  }
}

void main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  console.error(`Log: ${paths.logPath}`)
  process.exitCode = 1
})
