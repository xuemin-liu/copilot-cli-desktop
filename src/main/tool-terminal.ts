import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawnNodePty } from './node-pty-backend.js'
import { spawnMyTerminal } from './myterminal-backend.js'
import type { PtyLike, SpawnPtyFn } from './pty-backend.js'
import type { TerminalConfig, TerminalKind } from './tool-tabs.js'

export interface TerminalSnapshot {
  id: string; generation: string; status: 'starting' | 'running' | 'exited' | 'error'; output: string; cursor: number; start: number
  pid?: number; exitCode?: number; error?: string; splitId?: string
}
interface Runtime { profileId: string; state: TerminalSnapshot; pty?: PtyLike; closed: boolean; abort: AbortController }
const MAX_OUTPUT = 512 * 1024

export function terminalLaunch(kind: TerminalKind, config: TerminalConfig = {}, cwd = homedir(), platform = process.platform): { file: string; args: string[]; cwd: string; config: TerminalConfig } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid terminal settings')
  const field = (value: unknown, name: string, pattern: RegExp): string | undefined => {
    if (value === undefined || value === '') return undefined
    if (typeof value !== 'string' || value.length > 4096 || !pattern.test(value)) throw new Error(`Invalid ${name}`)
    return value
  }
  if (kind === 'local') return { file: platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : process.env.SHELL || '/bin/bash', args: platform === 'win32' ? ['-NoLogo'] : [], cwd, config: {} }
  if (kind === 'wsl') {
    if (platform !== 'win32') throw new Error('WSL terminals are available on Windows')
    const distro = field(config.distro, 'WSL distribution', /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
    return { file: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe'), args: [...(distro ? ['--distribution', distro] : []), '--cd', cwd], cwd, config: distro ? { distro } : {} }
  }
  if (kind !== 'ssh') throw new Error('Unknown terminal type')
  if (config.transport === 'managed') {
    const connectionId = field(config.connectionId, 'SSH connection ID', /^[a-zA-Z0-9_-]+$/)
    if (!connectionId) throw new Error('Choose a saved SSH connection')
    const host = field(config.host, 'SSH host', /^[^\x00-\x1f\x7f]+$/)
    const username = field(config.username, 'SSH user', /^[^\x00-\x1f\x7f]+$/)
    const name = field(config.name, 'connection name', /^[^\x00-\x1f\x7f]+$/)
    const port = config.port
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid SSH port')
    return { file: '', args: [], cwd, config: { transport: 'managed', connectionId, ...(config.temporary === true ? { temporary: true } : {}),
      ...(host ? { host } : {}), ...(username ? { username } : {}), ...(name ? { name } : {}), ...(port ? { port } : {}) } }
  }
  const host = field(config.host, 'SSH host', /^[a-zA-Z0-9][a-zA-Z0-9._:\[\]-]*$/)
  if (!host) throw new Error('Enter an SSH host or SSH config alias')
  const username = field(config.username, 'SSH user', /^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]*$/)
  const identityFile = field(config.identityFile, 'identity file', /^[^\x00-\x1f\x7f]+$/)
  const port = config.port
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid SSH port')
  return { file: platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh',
    args: [...(username ? ['-l', username] : []), ...(port ? ['-p', String(port)] : []), ...(identityFile ? ['-i', identityFile] : []), '--', host], cwd,
    config: { host, ...(username ? { username } : {}), ...(port ? { port } : {}), ...(identityFile ? { identityFile } : {}) } }
}

/** PTYs belong to tool IDs, never to the selected tab. Output is bounded and addressed by an absolute cursor. */
export class ToolTerminals {
  private readonly runtimes = new Map<string, Runtime>()
  constructor(private readonly spawn: SpawnPtyFn = spawnNodePty, private readonly hooks?: {
    managed(profileId: string, id: string, config: TerminalConfig, signal: AbortSignal): Promise<PtyLike>
    started(profileId: string, id: string): void
    output(profileId: string, id: string, data: string): void
    streamed?(profileId: string, state: TerminalSnapshot): void
    closed(profileId: string, id: string, unexpected: boolean): void
  }) {}
  async start(profileId: string, id: string, kind: TerminalKind, config: TerminalConfig, cwd: string | null, env: NodeJS.ProcessEnv): Promise<TerminalSnapshot> {
    if (this.runtimes.has(id)) return this.read(profileId, id)
    if (this.runtimes.size >= 32) throw new Error('Close a terminal tab before opening more (32 maximum)')
    const launch = terminalLaunch(kind, config, cwd ?? homedir())
    const runtime: Runtime = { profileId, state: { id, generation: randomUUID(), status: 'starting', output: '', cursor: 0, start: 0 }, closed: false, abort: new AbortController() }
    this.runtimes.set(id, runtime)
    try {
      const pty = kind === 'ssh' && config.transport === 'managed'
        ? await this.hooks!.managed(profileId, id, config, runtime.abort.signal)
        : await spawnMyTerminal(this.spawn, launch.file, launch.args, { cwd: launch.cwd, env, cols: 80, rows: 24, signal: runtime.abort.signal })
      if (runtime.closed) { pty.kill('SIGKILL'); pty.dispose?.(); throw new Error('Terminal closed during startup') }
      runtime.pty = pty; runtime.state.status = 'running'
      if (pty.pid !== undefined) runtime.state.pid = pty.pid
      this.hooks?.started(profileId, id)
      pty.onData(data => {
        if (runtime.closed) return
        this.hooks?.output(profileId, id, data)
        runtime.state.output = (runtime.state.output + data).slice(-MAX_OUTPUT)
        runtime.state.cursor += data.length
        runtime.state.start = runtime.state.cursor - runtime.state.output.length
        this.hooks?.streamed?.(profileId, { ...runtime.state, output: data, start: runtime.state.cursor - data.length })
      })
      pty.onExit(event => { if (!runtime.closed) { runtime.state.status = 'exited'; runtime.state.exitCode = event.exitCode; this.hooks?.closed(profileId, id, true); pty.dispose?.() } })
    } catch (error) {
      if (runtime.closed) throw error
      runtime.state.status = 'error'; runtime.state.error = error instanceof Error ? error.message : String(error)
      this.hooks?.closed(profileId, id, true)
    }
    return this.read(profileId, id)
  }
  private get(profileId: string, id: string): Runtime {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.profileId !== profileId || runtime.closed) throw new Error('Terminal is not connected in this project')
    return runtime
  }
  read(profileId: string, id: string, cursor = 0): TerminalSnapshot {
    const { state } = this.get(profileId, id)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > state.cursor) throw new Error('Invalid output cursor')
    const start = Math.max(cursor, state.start)
    return { ...state, start, output: state.output.slice(start - state.start) }
  }
  write(profileId: string, id: string, text: string): void {
    const runtime = this.get(profileId, id)
    if (typeof text !== 'string' || text.length > 65536) throw new Error('Input must be at most 64 KiB')
    if (runtime.state.status !== 'running' || !runtime.pty) throw new Error('Terminal is not running')
    runtime.pty.write(text)
  }
  resize(profileId: string, id: string, cols: number, rows: number): void {
    if (![cols, rows].every(n => Number.isInteger(n) && n >= 2 && n <= 500)) throw new Error('Invalid terminal dimensions')
    this.get(profileId, id).pty?.resize(cols, rows)
  }
  close(profileId: string, id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.profileId !== profileId) return
    runtime.closed = true; runtime.abort.abort(); this.runtimes.delete(id)
    this.hooks?.closed(profileId, id, false)
    // Close means terminate; Ctrl+C is the separate interrupt action. A shell trapping HUP/TERM must not survive its tab.
    try { runtime.pty?.kill('SIGKILL') } finally { runtime.pty?.dispose?.() }
  }
  closeProject(profileId: string): void { for (const [id, runtime] of this.runtimes) if (runtime.profileId === profileId) this.close(profileId, id) }
  dispose(): void { for (const [id, runtime] of this.runtimes) this.close(runtime.profileId, id) }
}
