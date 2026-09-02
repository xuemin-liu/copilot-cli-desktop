import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import type { CopilotResolution } from './types.js'
import { windowsSystemExecutable, withCopilotPathAdditions } from './resolve-copilot.js'
import { secretEnvArgs } from './secure-credentials.js'
import { startWindowsProcessWatchdog, type ProcessWatchdogLease } from './windows-process-watchdog.js'

const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** The same Content-Length framed JSON-RPC transport used by Copilot SDK.
 * Keep this adapter narrow: no session is resumed/attached in the helper,
 * and no model request or permission callback is accepted. This avoids
 * bundling another CLI binary and a native SDK runtime into the desktop app.
 * Protocol reference: github/copilot-sdk nodejs/src/generated/rpc.ts.
 */
export class CopilotRpc {
  private readonly child: ChildProcessWithoutNullStreams | null
  private readonly socket: Socket | null
  private readonly watchdog: ProcessWatchdogLease | null
  private buffer = Buffer.alloc(0)
  private sequence = 0
  private closed = false
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  constructor(resolution: CopilotResolution | { port: number }, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
    if ('port' in resolution) {
      this.child = null
      this.watchdog = null
      this.socket = createConnection({ host: '127.0.0.1', port: resolution.port })
      this.socket.on('data', (chunk: Buffer) => this.read(chunk))
      this.socket.on('error', () => this.fail(new Error('The session control connection is not ready. Wait for Copilot to finish starting, or restart this tab.')))
      this.socket.on('close', () => this.fail(new Error('The session control connection closed')))
      return
    }
    this.socket = null
    this.child = spawn(resolution.command, [
      ...resolution.prefixArgs,
      ...secretEnvArgs(env),
      '--headless', '--stdio', '--no-auto-update',
    ], {
      cwd,
      env: withCopilotPathAdditions({ ...env, NODE_DEBUG: '' }, resolution.pathAdditions),
      windowsHide: true,
      stdio: 'pipe',
    })
    this.watchdog = process.platform === 'win32' && this.child.pid
      ? startWindowsProcessWatchdog(this.child.pid, env)
      : null
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk))
    // Drain logs without exposing credentials or session contents to the UI.
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.fail(new Error('Copilot fork connection closed')))
    this.child.on('error', () => this.fail(new Error('Could not start the Copilot fork helper')))
    this.child.on('exit', () => {
      this.watchdog?.release()
      this.fail(new Error('Copilot fork helper exited. Update Copilot CLI if background RPC is unavailable.'))
    })
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Copilot fork connection is closed'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Copilot ${method} timed out; the original session was not interrupted`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private send(message: object): void {
    const body = JSON.stringify(message)
    const stream = this.socket ?? this.child?.stdin
    stream?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  private read(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      while (this.buffer.length > 0) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
          if (this.buffer.length > 8192) throw new Error('Invalid Copilot RPC header')
          return
        }
        const lengthMatch = /^Content-Length:\s*(\d+)\s*$/im.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))
        const length = Number(lengthMatch?.[1])
        if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FRAME_BYTES) throw new Error('Invalid Copilot RPC frame size')
        const end = headerEnd + 4 + length
        if (this.buffer.length < end) return
        const message = JSON.parse(this.buffer.subarray(headerEnd + 4, end).toString('utf8')) as Record<string, unknown>
        this.buffer = this.buffer.subarray(end)
        if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid Copilot RPC message')
        if (typeof message.method === 'string') {
          if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Desktop fork helper does not execute callbacks' } })
          continue
        }
        const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
        if (!pending) continue
        this.pending.delete(message.id as number)
        clearTimeout(pending.timer)
        if (message.error) {
          const code = (message.error as { code?: unknown }).code
          pending.reject(new Error(code === -32601
            ? 'This Copilot CLI does not support session forking through RPC. Update Copilot CLI from Settings.'
            : `Copilot fork request failed (${String(code)}). Check the source session has saved history and update Copilot CLI if needed.`))
        } else pending.resolve(message.result)
      }
    } catch {
      this.fail(new Error('Invalid response from the Copilot fork helper'))
    }
  }

  private fail(error: Error): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.buffer = Buffer.alloc(0)
  }

  async stop(): Promise<void> {
    this.fail(new Error('Copilot fork helper stopped'))
    this.socket?.destroy()
    if (!this.child) return
    this.child.stdin.destroy()
    try {
      if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return
      // Stop the whole helper tree, never any of the independent interactive PTYs.
      if (process.platform === 'win32') {
        const pid = this.child.pid
        await new Promise<void>((resolveStop) => {
          execFile(windowsSystemExecutable('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolveStop())
        })
      } else this.child.kill('SIGKILL')
    } finally {
      this.watchdog?.release()
    }
  }
}

export function isForkSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function supportsSessionFork(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version ?? '')
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major! > 1 || (major === 1 && (minor! > 0 || patch! >= 82))
}

/** Use ONLY on an isolated staged copy; CLI 1.0.82 overwrites its source
 * JSONL when writing the fork-info event in a separate headless process. */
export async function forkStagedCopilotSession(
  resolution: CopilotResolution,
  cwd: string,
  env: NodeJS.ProcessEnv,
  sourceSessionId: string,
  name: string,
): Promise<string> {
  const rpc = new CopilotRpc(resolution, cwd, env)
  try {
    await rpc.request('ping')
    const result = await rpc.request('sessions.fork', { sessionId: sourceSessionId, name }) as { sessionId?: unknown } | null
    if (!isForkSessionId(result?.sessionId) || result.sessionId === sourceSessionId) throw new Error('Copilot did not return an independent fork session ID')
    return result.sessionId
  } finally {
    await rpc.stop()
  }
}
