import { execFile, spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { posix, win32 } from 'node:path'
import { hostPath } from './host-path.js'
import { POSIX_PROBE_DIRECTORY, findPosixExecutable } from './posix-executables.js'
import { assertGitArgument, buildGitEnvironment, gitArgsPrefix } from './git-env.js'
import type { GitCommandKind, GitEnvironmentOptions } from './git-env.js'
import { isSupportedGitVersion, parseGitVersion } from './git-parse.js'
import type { GitVersion } from './git-parse.js'
import { isLocalFilesystemPath } from './external-targets.js'
import { findWindowsExecutable, windowsSystemDirectory, windowsSystemExecutable } from './resolve-copilot.js'
import { detachedGroup, killProcessTree, startProcessWatchdog } from './process-tree.js'
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
    // The working directory is System32 (or the root folder), never a workspace, so a planted `git.exe` cannot win a lookup.
    const cwd = process.platform === 'win32' ? windowsSystemDirectory(env) : POSIX_PROBE_DIRECTORY
    execFile(path, ['--version'], { cwd, env: buildGitEnvironment(env), timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseGitVersion(String(stdout)))
    })
  })
}

export interface ResolveGitOptions {
  env?: NodeJS.ProcessEnv
  findExecutable?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  probeVersion?: (path: string, env: NodeJS.ProcessEnv) => Promise<GitVersion | null>
  platform?: NodeJS.Platform
  /** macOS: whether the Command Line Tools (or Xcode) are installed. */
  hasDeveloperTools?: () => Promise<boolean>
}

/** On macOS, /usr/bin/git is a stub that opens an installer dialog when the Command Line Tools are missing. */
export const MACOS_GIT_STUB = '/usr/bin/git'

function macDeveloperToolsInstalled(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('/usr/bin/xcode-select', ['-p'], { cwd: POSIX_PROBE_DIRECTORY, timeout: VERSION_PROBE_TIMEOUT_MS }, (error, stdout) => resolve(!error && String(stdout).trim().length > 0))
  })
}

/** Locate one absolute Git executable without searching any workspace folder. */
export async function resolveGitExecutable(options: ResolveGitOptions = {}): Promise<GitExecutable | null> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const probe = options.probeVersion ?? probeGitVersion
  if (platform !== 'win32') return resolvePosixGit(env, platform, options, probe)
  const find = options.findExecutable ?? ((command, environment) => findWindowsExecutable(command, environment))
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

async function resolvePosixGit(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, options: ResolveGitOptions,
  probe: (path: string, env: NodeJS.ProcessEnv) => Promise<GitVersion | null>): Promise<GitExecutable | null> {
  const find = options.findExecutable ?? findPosixExecutable
  const located = await find('git', env).catch(() => null)
  const candidates = [located, ...(platform === 'darwin' ? ['/opt/homebrew/bin/git'] : []), '/usr/local/bin/git', '/usr/bin/git']
  let developerTools: boolean | null = null
  for (const candidate of new Set(candidates)) {
    if (!candidate || !posix.isAbsolute(candidate)) continue
    if (platform === 'darwin' && candidate === MACOS_GIT_STUB) {
      developerTools ??= await (options.hasDeveloperTools ?? macDeveloperToolsInstalled)()
      if (!developerTools) continue
    }
    const version = await probe(candidate, env)
    if (version) return { path: candidate, version, supported: isSupportedGitVersion(version) }
  }
  return null
}

export type KillProcessTree = (pid: number) => Promise<void>
export type TrackProcess = (pid: number) => ProcessWatchdogLease
export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess

/** Kill git and everything it started: ssh, credential helpers and hooks do not die with `git.exe`. */
export const killGitProcessTree: KillProcessTree = (pid) => killProcessTree(pid)

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
  /** Run with `core.hooksPath` pointed at an empty folder, so no repository hook can run. Always on for reads. */
  disableHooks?: boolean | undefined
  /** Called with output as it arrives (for example a commit hook's messages), decoded and never split mid-character. */
  onOutput?: ((stream: 'stdout' | 'stderr', text: string) => void) | undefined
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
    if (!hostPath.isAbsolute(options.gitPath)) throw new GitUnavailableError('The git executable path must be absolute')
    this.options = options
  }

  async run(options: GitRunOptions): Promise<GitRunResult> {
    const kind = options.kind ?? 'read'
    if (!hostPath.isAbsolute(options.cwd) || !isLocalFilesystemPath(options.cwd)) throw new Error('git must run in a local, absolute folder')
    assertGitArgument(options.cwd, 'working folder')
    for (const arg of options.args) assertGitArgument(arg)
    if (options.signal?.aborted) return emptyResult({ cancelled: true })
    if (kind === 'read' || options.disableHooks) await this.ensureHooksDirectory()
    // An abort during the await above fires before any listener exists, so check again before spawning.
    if (options.signal?.aborted) return emptyResult({ cancelled: true })
    const args = [...gitArgsPrefix(kind, this.options.hooksDirectory, options.disableHooks === true), ...options.args]
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
        cwd: options.cwd, env, shell: false, windowsHide: true, detached: detachedGroup(), stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const emit = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (!options.onOutput) return
        const text = decoders[stream].write(chunk)
        // A listener that throws must never break the command it is watching.
        if (text) try { options.onOutput(stream, text) } catch { /* ignored */ }
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        emit('stdout', chunk)
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
        emit('stderr', chunk)
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
  return startProcessWatchdog(pid)
}

function emptyResult(overrides: Partial<GitRunResult>): GitRunResult {
  return { exitCode: null, stdout: Buffer.alloc(0), stderr: '', stdoutTruncated: false, timedOut: false, cancelled: false, durationMs: 0, ...overrides }
}
