import { randomBytes } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { spawnChildProcessPty } from '../main/child-process-pty-backend.js'
import { buildPermissionArgs, isPermissionPreset, type PermissionPreset } from '../main/permission-presets.js'
import { PtySession, type PtySessionExit } from '../main/pty-session.js'
import { resolveCopilotBinary } from '../main/resolve-copilot.js'
import { buildResumeArgs, isResumeMode, type ResumeMode } from '../main/resume-args.js'
import {
  ensureCliDirectories,
  claimControllerLock,
  getCliPaths,
  releaseControllerLock,
  removeDaemonState,
  toPublicState,
  writeDaemonState,
  type DaemonState,
} from './runtime-state.js'

const paths = getCliPaths()
const workspace = resolve(process.argv[2] ?? process.cwd())
const rawArgs = process.argv.slice(3)
function flagValue(name: string): string | undefined {
  const index = rawArgs.indexOf(name)
  return index >= 0 ? rawArgs[index + 1] : undefined
}
const presetArgument = flagValue('--preset')
const preset: PermissionPreset = isPermissionPreset(presetArgument) ? presetArgument : 'default'
const resumeModeArgument = flagValue('--resume-mode')
const resumeMode: ResumeMode = isResumeMode(resumeModeArgument) ? resumeModeArgument : 'new'
const lastSessionId = flagValue('--session-id') ?? null

const lockToken: string = process.env.COPILOT_DESKTOP_LOCK_TOKEN ?? ''
if (!lockToken) throw new Error('The controller startup lock token is missing')
delete process.env.COPILOT_DESKTOP_LOCK_TOKEN
const token = randomBytes(32).toString('hex')
let session: PtySession | null = null
let state: DaemonState | null = null
let shuttingDown = false
let stoppingRequested = false
let controllerLockClaimed = false
let stateWriteQueue = Promise.resolve()
let mutationQueue = Promise.resolve()

async function log(message: string): Promise<void> {
  await appendFile(paths.logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
}

async function updateState(patch: Partial<DaemonState>): Promise<void> {
  if (!state) throw new Error('Controller state is not initialized')
  state = { ...state, ...patch }
  const stateSnapshot = { ...state }
  const write = stateWriteQueue.then(() => writeDaemonState(paths, stateSnapshot))
  stateWriteQueue = write.then(() => undefined, () => undefined)
  await write
}

function currentState(): DaemonState {
  if (!state) throw new Error('Controller state is not initialized')
  return state
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(`${JSON.stringify(body)}\n`)
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${token}`
}

async function createSession(): Promise<PtySession> {
  const resolution = await resolveCopilotBinary()
  if (resolution.version === null) {
    throw new Error(resolution.error ?? 'The copilot CLI could not be resolved')
  }
  const args = [
    ...resolution.prefixArgs,
    ...buildResumeArgs({ mode: resumeMode, lastSessionId }),
    ...buildPermissionArgs(preset, workspace),
  ]
  const instance = new PtySession({
    file: resolution.command,
    args,
    cwd: workspace,
    spawnPty: spawnChildProcessPty,
  })
  instance.on('log', (line: string) => void log(line).catch(() => undefined))
  instance.on('exit', (exit: PtySessionExit) => {
    if (shuttingDown || stoppingRequested || exit.expected) return
    void updateState({
      status: 'crashed',
      processId: null,
      error: `copilot exited unexpectedly (code ${exit.exitCode}, signal ${String(exit.signal ?? 'none')})`,
    }).catch(() => undefined)
  })
  return instance
}

async function startSession(status: 'starting' | 'restarting', instance: PtySession): Promise<void> {
  await updateState({ status, processId: null, error: null })
  try {
    await instance.start()
    if (session !== instance || stoppingRequested) return
    await updateState({ status: 'running', processId: instance.processId, error: null })
    await log(`copilot started for ${workspace} (pid ${String(instance.processId)})`)
  } catch (error) {
    if (session !== instance || stoppingRequested) return
    const message = error instanceof Error ? error.message : String(error)
    await updateState({ status: 'crashed', processId: null, error: message })
    await log(`copilot failed to start: ${message}`)
  }
}

async function restartSession(): Promise<void> {
  if (stoppingRequested) return
  await updateState({ status: 'restarting', processId: null, error: null })
  try {
    const previous = session
    if (!previous) throw new Error('No session is initialized')
    await previous.stop()
    previous.removeAllListeners()
    if (stoppingRequested) return
    const replacement = await createSession()
    session = replacement
    await startSession('restarting', replacement)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateState({ status: 'crashed', processId: null, error: `Restart failed and can be retried: ${message}` })
    throw error
  }
}

const server = createServer((request, response) => {
  void (async () => {
    if (!authorized(request)) {
      writeJson(response, 401, { message: 'Unauthorized' })
      return
    }

    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && requestUrl.pathname === '/status') {
      writeJson(response, 200, toPublicState(currentState()))
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/logs') {
      writeJson(response, 200, { ...toPublicState(currentState()), logs: [...(session?.recentOutput ?? [])].slice(-200) })
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/restart') {
      if (stoppingRequested) {
        writeJson(response, 409, { message: 'The controller is stopping' })
        return
      }
      await enqueueMutation(restartSession)
      if (stoppingRequested) {
        writeJson(response, 409, { message: 'The controller is stopping' })
        return
      }
      const latest = currentState()
      writeJson(response, latest.status === 'running' ? 200 : 500, toPublicState(latest))
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/stop') {
      if (stoppingRequested) {
        writeJson(response, 202, toPublicState(currentState()))
        return
      }
      const activeSession = session
      if (!activeSession) throw new Error('No session is initialized')
      stoppingRequested = true
      const cancellation = activeSession.stop().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      try {
        await enqueueMutation(async () => {
          const result = await cancellation
          if (!result.ok) throw result.error
          await updateState({ status: 'stopping', processId: null, error: null })
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          await updateState({ status: 'crashed', processId: null, error: `Stop failed and can be retried: ${message}` })
        } finally {
          stoppingRequested = false
        }
        throw error
      }
      writeJson(response, 202, toPublicState(currentState()))
      setImmediate(() => void shutdown(0))
      return
    }

    writeJson(response, 404, { message: 'Not found' })
  })().catch((error: unknown) => {
    writeJson(response, 500, { message: error instanceof Error ? error.message : String(error) })
  })
})

async function shutdown(exitCode: number, failure?: unknown): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  stoppingRequested = true
  const failed = failure !== undefined
  const failureMessage = !failed ? null : failure instanceof Error ? failure.message : String(failure)
  const cleanupErrors: string[] = []
  let sessionStopped = true

  if (state) {
    try {
      await updateState({ status: failed ? 'crashed' : 'stopping', processId: null, error: failureMessage })
    } catch (error) {
      cleanupErrors.push(`state update: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (session) {
    try {
      await session.stop()
    } catch (error) {
      sessionStopped = false
      cleanupErrors.push(`session stop: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (controllerLockClaimed) {
    try {
      const released = await releaseControllerLock(paths, lockToken, process.pid)
      if (!released) cleanupErrors.push('lock release: controller lock ownership changed')
      controllerLockClaimed = false
    } catch (error) {
      cleanupErrors.push(`lock release: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!failed && sessionStopped) {
    try {
      await removeDaemonState(paths)
    } catch (error) {
      cleanupErrors.push(`state removal: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    if (server.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  } catch (error) {
    cleanupErrors.push(`control server close: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (cleanupErrors.length > 0) {
    await log(`Shutdown errors: ${cleanupErrors.join('; ')}`).catch(() => undefined)
    exitCode = 1
  }
  process.exit(exitCode)
}

process.once('SIGINT', () => void shutdown(0))
process.once('SIGTERM', () => void shutdown(0))
process.once('uncaughtException', (error) => {
  void log(`Uncaught exception: ${error.stack ?? error.message}`)
    .catch(() => undefined)
    .finally(() => void shutdown(1, error))
})
process.once('unhandledRejection', (error) => {
  void log(`Unhandled rejection: ${String(error)}`)
    .catch(() => undefined)
    .finally(() => void shutdown(1, error))
})

async function initialize(): Promise<void> {
  await ensureCliDirectories(paths)
  await claimControllerLock(paths, lockToken)
  controllerLockClaimed = true

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })

  const address = server.address() as AddressInfo
  state = {
    version: 1,
    pid: process.pid,
    controlPort: address.port,
    token,
    workspace,
    processId: null,
    status: 'starting',
    startedAt: new Date().toISOString(),
    error: null,
  }
  await writeDaemonState(paths, state)
  await log(`Controller started (PID ${process.pid}) for ${workspace}`)
  const instance = await createSession()
  session = instance
  await enqueueMutation(() => startSession('starting', instance))
}

void initialize().catch((error: unknown) => {
  void log(`Controller initialization failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    .catch(() => undefined)
    .finally(() => void shutdown(1, error))
})
