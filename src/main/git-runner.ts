import { execFile, spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { win32 } from 'node:path'
import { assertGitArgument, buildGitEnvironment, gitArgsPrefix } from './git-env.js'
import type { GitCommandKind, GitEnvironmentOptions } from './git-env.js'
import { isSupportedGitVersion, parseGitVersion } from './git-parse.js'
import type { GitVersion } from './git-parse.js'
import { isLocalFilesystemPath } from './external-targets.js'
import { findWindowsExecutable, windowsSystemDirectory, windowsSystemExecutable } from './resolve-copilot.js'
import { startWindowsProcessWatchdog } from './windows-process-watchdog.js'
import type { ProcessWatchdogLease } from './windows-process-watchdog.js'

export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitUnavailableError'
  }
}

export interface GitExecutable {
  /** Absolute path to `git.exe`. The bare name `git` is never spawned. */
  path: string
  version: GitVersion
  supported: boolean
}

const VERSION_PROBE_TIMEOUT_MS = 8_000

function probeGitVersion(path: string, env: NodeJS.ProcessEnv): Promise<GitVersion | null> {
  return new Promise(resolve => {
    // The working directory is System32, never a workspace, so a planted `git.exe` cannot win a lookup.
    execFile(path, ['--version'], { cwd: windowsSystemDirectory(env), env: buildGitEnvironment(env), timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseGitVersion(String(stdout)))
    })
  })
}

export interface ResolveGitOptions {
  env?: NodeJS.ProcessEnv
  findExecutable?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  probeVersion?: (path: string, env: NodeJS.ProcessEnv) => Promise<GitVersion | null>
}

/** Locate one absolute `git.exe` without searching any workspace folder. */
export async function resolveGitExecutable(options: ResolveGitOptions = {}): Promise<GitExecutable | null> {
  const env = options.env ?? process.env
  const find = options.findExecutable ?? ((command, environment) => findWindowsExecutable(command, environment))
  const probe = options.probeVersion ?? probeGitVersion
  const candidates: string[] = []
  const located = await find('git', env).catch(() => null)
  if (located) candidates.push(located)
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
    if (base) candidates.push(win32.join(base, 'Git', 'cmd', 'git.exe'))
  }
  if (env.LOCALAPPDATA) candidates.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'))
  for (const candidate of new Set(candidates.map(item => win32.normalize(item)))) {
    if (!win32.isAbsolute(candidate) || !isLocalFilesystemPath(candidate) || !candidate.toLowerCase().endsWith('.exe')) continue
    const version = await probe(candidate, env)
    if (version) return { path: candidate, version, supported: isSupportedGitVersion(version) }
  }
  return null
}

export type KillProcessTree = (pid: number) => Promise<void>
export type TrackProcess = (pid: number) => ProcessWatchdogLease
export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess

/** Kill git and everything it started: ssh, credential helpers and hooks do not die with `git.exe`. */
export const killGitProcessTree: KillProcessTree = (pid) => new Promise(resolve => {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    resolve()
    return
  }
  execFile(windowsSystemExecutable('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => resolve())
})

export interface GitRunnerOptions {
  gitPath: string
  /** An empty directory. Reads point `core.hooksPath` here so no repository hook can run. */
  hooksDirectory: string
  baseEnvironment?: NodeJS.ProcessEnv
  spawn?: SpawnFn
  killProcessTree?: KillProcessTree
  trackProcess?: TrackProcess | null
}

export interface GitRunOptions {
  cwd: string
  args: readonly string[]
  kind?: GitCommandKind
  stdin?: string | Buffer | undefined
  timeoutMs?: number | undefined
  maxStdoutBytes?: number | undefined
  signal?: AbortSignal | undefined
  environment?: GitEnvironmentOptions | undefined
}

export interface GitRunResult {
  exitCode: number | null
  stdout: Buffer
  stderr: string
  /** Output passed the cap; the process was stopped and `stdout` holds only what arrived before. */
  stdoutTruncated: boolean
  timedOut: boolean
  cancelled: boolean
  durationMs: number
}

export function gitSucceeded(result: GitRunResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.stdoutTruncated
}

const DEFAULT_TIMEOUT_MS: Record<GitCommandKind, number> = { read: 15_000, network: 120_000, write: 600_000 }
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
/** Upper bound on waiting for a killed tree: taskkill's own 5 s limit plus a second for the pipes to close. */
const KILL_GRACE_MS = 6_000

export class GitRunner {
  private readonly options: GitRunnerOptions
  private hooksReady: Promise<void> | null = null

  constructor(options: GitRunnerOptions) {
    if (!win32.isAbsolute(options.gitPath)) throw new GitUnavailableError('The git executable path must be absolute')
    this.options = options
  }

  async run(options: GitRunOptions): Promise<GitRunResult> {
    const kind = options.kind ?? 'read'
    if (!win32.isAbsolute(options.cwd) || !isLocalFilesystemPath(options.cwd)) throw new Error('git must run in a local, absolute folder')
    assertGitArgument(options.cwd, 'working folder')
    for (const arg of options.args) assertGitArgument(arg)
    if (options.signal?.aborted) return emptyResult({ cancelled: true })
    if (kind === 'read') await this.ensureHooksDirectory()
    // An abort during the await above fires before any listener exists, so check again before spawning.
    if (options.signal?.aborted) return emptyResult({ cancelled: true })
    const args = [...gitArgsPrefix(kind, this.options.hooksDirectory), ...options.args]
    const env = buildGitEnvironment(this.options.baseEnvironment ?? process.env, options.environment)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[kind]
    const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    const spawnFn = this.options.spawn ?? spawn
    const kill = this.options.killProcessTree ?? killGitProcessTree
    const track = this.options.trackProcess === undefined ? defaultTrack : this.options.trackProcess
    const hasInput = options.stdin !== undefined
    const started = Date.now()

    return new Promise<GitRunResult>((resolve, reject) => {
      const child = spawnFn(this.options.gitPath, args, {
        cwd: options.cwd, env, shell: false, windowsHide: true, stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let timedOut = false
      let cancelled = false
      let settled = false
      let exitCode: number | null = null
      let exited = false
      let graceTimer: NodeJS.Timeout | undefined
      let killing: Promise<void> | null = null
      const lease = child.pid && track ? track(child.pid) : null

      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(graceTimer)
        options.signal?.removeEventListener('abort', onAbort)
        lease?.release()
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolve({
          exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'),
          stdoutTruncated: truncated, timedOut, cancelled, durationMs: Date.now() - started,
        })
      }
      // Resolve only after the tree is gone: a hook's child left running would still hold the folder open.
      const finishAfterKill = (): void => { void (killing ?? Promise.resolve()).then(finish, finish) }
      const stop = (): void => {
        if (child.pid) killing ??= kill(child.pid)
        graceTimer ??= setTimeout(finish, KILL_GRACE_MS)
      }
      const onAbort = (): void => { cancelled = true; stop() }
      const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
      options.signal?.addEventListener('abort', onAbort, { once: true })

      child.once('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(graceTimer)
        options.signal?.removeEventListener('abort', onAbort)
        lease?.release()
        reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new GitUnavailableError('git was not found') : error)
      })
      child.stdout?.on('data', (chunk: Buffer) => {
        if (truncated) return
        const room = maxStdout - stdoutBytes
        if (chunk.length > room) {
          if (room > 0) stdout.push(chunk.subarray(0, room))
          stdoutBytes = maxStdout
          truncated = true
          stop()
        } else {
          stdout.push(chunk)
          stdoutBytes += chunk.length
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const room = MAX_STDERR_BYTES - stderrBytes
        if (room > 0) { stderr.push(chunk.subarray(0, room)); stderrBytes += Math.min(room, chunk.length) }
      })
      child.once('exit', code => { exited = true; exitCode = code; if (timedOut || cancelled || truncated) finishAfterKill() })
      child.once('close', code => { if (!exited) exitCode = code; if (killing) finishAfterKill(); else finish() })
      if (hasInput && child.stdin) {
        child.stdin.on('error', () => undefined)
        child.stdin.end(options.stdin)
      }
    })
  }

  private ensureHooksDirectory(): Promise<void> {
    this.hooksReady ??= mkdir(this.options.hooksDirectory, { recursive: true }).then(() => undefined)
    return this.hooksReady
  }
}

function defaultTrack(pid: number): ProcessWatchdogLease {
  return process.platform === 'win32' ? startWindowsProcessWatchdog(pid) : { release: () => undefined }
}

function emptyResult(overrides: Partial<GitRunResult>): GitRunResult {
  return { exitCode: null, stdout: Buffer.alloc(0), stderr: '', stdoutTruncated: false, timedOut: false, cancelled: false, durationMs: 0, ...overrides }
}
