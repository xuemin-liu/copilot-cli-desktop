import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { windowsSystemExecutable } from '../src/main/resolve-copilot.js'

const execFileAsync = promisify(execFile)
const PACKAGE_SMOKE_ENVIRONMENT = 'COPILOT_DESKTOP_PACKAGE_SMOKE'
const PACKAGE_SMOKE_READY_MARKER = '[package-smoke] renderer-ready'
const STARTUP_TIMEOUT_MS = 15_000

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('[package-smoke] Windows-only packaged launch check skipped.')
    return
  }

  const executable = resolve(process.argv[2] ?? 'release/win-unpacked/Copilot CLI Desktop.exe')
  const isolatedUserData = await mkdtemp(join(tmpdir(), 'copilot-desktop-package-smoke-'))
  let stopped = false
  let stderr = ''
  let signalRendererReady!: () => void
  const rendererReady = new Promise<{ kind: 'ready' }>((resolveReady) => {
    signalRendererReady = () => resolveReady({ kind: 'ready' })
  })
  const child = spawn(executable, [`--user-data-dir=${isolatedUserData}`, '--disable-gpu'], {
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      [PACKAGE_SMOKE_ENVIRONMENT]: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_000)
    if (stderr.includes(PACKAGE_SMOKE_READY_MARKER)) signalRendererReady()
  })
  const termination = new Promise<
    | { kind: 'error'; error: Error }
    | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  >((resolveTermination) => {
    child.once('error', (error) => {
      stopped = true
      resolveTermination({ kind: 'error', error })
    })
    child.once('exit', (code, signal) => {
      stopped = true
      resolveTermination({ kind: 'exit', code, signal })
    })
  })

  try {
    let startupTimer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      termination,
      rendererReady,
      new Promise<null>((resolveWait) => {
        startupTimer = setTimeout(() => resolveWait(null), STARTUP_TIMEOUT_MS)
      }),
    ])
    if (startupTimer) clearTimeout(startupTimer)
    if (!outcome) {
      throw new Error(
        `${basename(executable)} did not finish its startup check within ${STARTUP_TIMEOUT_MS}ms.${stderr ? `\n${stderr.trim()}` : ''}`,
      )
    }
    if (outcome.kind === 'error') {
      throw new Error(`Unable to launch ${basename(executable)}: ${outcome.error.message}`)
    }
    if (outcome.kind === 'ready') {
      console.log(`[package-smoke] ${basename(executable)} loaded its renderer successfully.`)
      return
    }
    if (outcome.code !== 0) {
      throw new Error(
        `${basename(executable)} exited during startup (code ${String(outcome.code)}, signal ${String(outcome.signal ?? 'none')}).${stderr ? `\n${stderr.trim()}` : ''}`,
      )
    }
    throw new Error(`${basename(executable)} exited without confirming that its renderer loaded.${stderr ? `\n${stderr.trim()}` : ''}`)
  } finally {
    if (!stopped && child.pid) {
      // The smoke-only app path exits itself after reporting renderer readiness.
      await Promise.race([termination, new Promise((resolveWait) => setTimeout(resolveWait, 3_000))])
    }
    if (!stopped && child.pid) {
      // Let Electron close its sandboxed children and release the profile before
      // falling back to forced termination. Killing the browser first can leave
      // a restricted child alive long enough to lock the temporary profile.
      await execFileAsync(windowsSystemExecutable('taskkill.exe'), ['/PID', String(child.pid), '/T'], {
        windowsHide: true,
        timeout: 10_000,
      }).catch(() => undefined)
      await Promise.race([termination, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))])
      if (!stopped) {
        await execFileAsync(windowsSystemExecutable('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 10_000,
        }).catch(() => undefined)
        await Promise.race([termination, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))])
      }
    }
    await rm(isolatedUserData, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    })
  }
}

main().catch((error: unknown) => {
  console.error('[package-smoke] failed:', error)
  process.exitCode = 1
})
