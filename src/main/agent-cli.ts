import { existsSync } from 'node:fs'
import { access, open, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import { samePath } from './host-path.js'
import { findPosixExecutable } from './posix-executables.js'
import {
  defaultExecFile, resolveWindowsCommand, tryVersion, unwrapNpmShim, withCopilotPathAdditions,
  type ExecFileFn, type NpmCliPackage, type ReadTextFileFn,
} from './resolve-copilot.js'
import { sessionCliLabel, type OtherCli } from './session-cli.js'

/**
 * Session tabs for CLIs other than Copilot: Claude Code and Codex CLI. Such a tab is the CLI's own terminal UI, started in
 * the project folder and resumed by the CLI's own session id. Nothing here passes Copilot's credentials, permission
 * presets or helpers to it: the CLI keeps its own sign-in, settings and approvals.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PACKAGES: Record<OtherCli, NpmCliPackage> = {
  claude: { name: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { name: '@openai/codex', bin: 'codex' },
}

export interface AgentCliResolution {
  cli: OtherCli
  command: string
  prefixArgs: string[]
  resolvedPath: string | null
  version: string | null
  error: string | null
  pathAdditions?: string[]
}

export interface AgentCliResolveDeps {
  env?: NodeJS.ProcessEnv
  execFile?: ExecFileFn
  platform?: NodeJS.Platform
  pathExists?: (path: string) => boolean
  readTextFile?: ReadTextFileFn
  findExecutable?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | null>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split(/\r?\n/, 1)[0]! : String(error)
}

/** How to get the CLI, for the message shown when it was not found. */
export function agentCliInstallHint(cli: OtherCli): string {
  return `Install it with \`npm install -g ${PACKAGES[cli].name}\`, make sure a terminal finds \`${PACKAGES[cli].bin}\`, then try again.`
}

/** Find the CLI without ever invoking a command shell: an executable on PATH, or a verified npm shim's target. */
export async function resolveAgentCli(cli: OtherCli, deps: AgentCliResolveDeps = {}): Promise<AgentCliResolution> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const pathExists = deps.pathExists ?? existsSync
  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, 'utf8'))
  const findExecutable = deps.findExecutable ?? findPosixExecutable
  const execFileFn = deps.execFile ?? defaultExecFile
  const cliPackage = PACKAGES[cli]
  const attempts: string[] = []

  const probe = async (launch: Pick<AgentCliResolution, 'command' | 'prefixArgs' | 'resolvedPath' | 'pathAdditions'>): Promise<AgentCliResolution | null> => {
    const result = await tryVersion(launch.command, [...launch.prefixArgs, '--version'], withCopilotPathAdditions(env, launch.pathAdditions), execFileFn)
    if (result.ok) return { cli, ...launch, version: result.version ?? 'unknown', error: null }
    attempts.push(`${launch.resolvedPath ?? launch.command}: ${describe(result.error)}`)
    return null
  }

  if (platform === 'win32') {
    const located = await resolveWindowsCommand(cliPackage.bin, env, execFileFn)
    const candidates = [
      ...located.paths,
      // Claude Code's own installer puts it here, which may not be on the PATH the desktop started with.
      ...(cli === 'claude' && env.USERPROFILE ? [win32.join(env.USERPROFILE, '.local', 'bin', 'claude.exe')] : []),
      ...(env.APPDATA ? [win32.join(env.APPDATA, 'npm', `${cliPackage.bin}.cmd`)] : []),
    ]
    const seen = new Set<string>()
    for (const path of candidates) {
      const key = path.toLowerCase()
      if (seen.has(key) || (!located.paths.includes(path) && !pathExists(path))) continue
      seen.add(key)
      const launch = key.endsWith('.exe')
        ? { command: path, prefixArgs: [], resolvedPath: path, pathAdditions: [] }
        : await unwrapNpmShim(path, cliPackage, env, execFileFn, pathExists, readTextFile)
      if (!launch) { attempts.push(`${path}: package-manager shim target could not be verified`); continue }
      const found = await probe(launch)
      if (found) return found
    }
  } else {
    const located = await findExecutable(cliPackage.bin, env)
    if (located) {
      const found = await probe({ command: located, prefixArgs: [], resolvedPath: located })
      if (found) return found
    }
  }

  return {
    cli, command: cliPackage.bin, prefixArgs: [], resolvedPath: null, version: null,
    error: [`${sessionCliLabel(cli)} was not found. ${agentCliInstallHint(cli)}`, ...attempts].join('\n'),
  }
}

/**
 * The CLI's arguments for a tab. Claude Code takes the id of a new session and resumes by it; Codex names its own
 * sessions, so a new one gets no id (it is read from Codex's session store later) and a stored one is resumed by id.
 */
export function buildAgentCliArgs(cli: OtherCli, session: { id: string | null; stored: boolean }): string[] {
  if (session.id !== null && !UUID.test(session.id)) throw new Error('Invalid session id')
  if (cli === 'claude') {
    if (session.id === null) return []
    return session.stored ? ['--resume', session.id] : ['--session-id', session.id]
  }
  return session.id !== null && session.stored ? ['resume', session.id] : []
}

function claudeConfigRoot(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
}

/**
 * Whether Claude Code has stored the session: it writes `<id>.jsonl` under the project's folder only with the first
 * prompt, and resuming an id it never stored fails. A tab opened and never used starts fresh under the same id instead.
 */
export async function claudeSessionStored(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!UUID.test(sessionId)) return false
  const projects = join(claudeConfigRoot(env), 'projects')
  let folders: string[]
  try { folders = await readdir(projects) } catch { return false }
  for (const folder of folders) {
    try { await access(join(projects, folder, `${sessionId}.jsonl`)); return true } catch { /* not in this project */ }
  }
  return false
}

/** What a PtySession needs from something that finds its session id after the process has started. */
export interface SessionIdDiscovery {
  /** Resolves once everything that existed before the spawn has been recorded. */
  ready(): Promise<void>
  find(): Promise<string | null>
  cancel(): void
}

export interface CodexDiscoveryOptions {
  /** `codexSessionsRoot`. */
  root: string
  /** The folder the process was started in: the session's own cwd must be it. */
  cwd: string
  /** Called with a matching session's id; false when another tab already has it, and the search goes on. */
  claim(sessionId: string): boolean
  now?(): number
  sleep?(ms: number): Promise<void>
  pollMs?: number
  slowAfterMs?: number
  slowPollMs?: number
}

const HEAD_BYTES = 8_192
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** The folders Codex files sessions under for the days around `time`: `<root>/YYYY/MM/DD`, by local date. */
function dayFolders(root: string, time: number): string[] {
  return [-1, 0, 1].map((offset) => {
    const day = new Date(time + offset * 86_400_000)
    return join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
  })
}

async function rolloutFiles(root: string, time: number): Promise<string[]> {
  const files: string[] = []
  for (const folder of new Set(dayFolders(root, time))) {
    let names: string[]
    try { names = await readdir(folder) } catch { continue }
    for (const name of names) if (ROLLOUT.test(name)) files.push(join(folder, name))
  }
  return files
}

/** The cwd in the `session_meta` record that heads a rollout file; undefined while the record is not written yet. */
async function rolloutCwd(path: string): Promise<string | null | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    if (!head.includes('"session_meta"')) return head.includes('\n') ? null : undefined
    const match = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head)
    if (!match) return head.includes('\n') ? null : undefined
    const cwd: unknown = JSON.parse(match[1]!)
    return typeof cwd === 'string' ? cwd : null
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Finds the id of a Codex session the desktop started. Codex names its own sessions and stores one, as
 * `rollout-<time>-<id>.jsonl`, once it has something to store, which can be long after the tab opened. This watches
 * for a file that was not there before the spawn and whose first record says it runs in the tab's folder.
 *
 * Everything read is data Codex wrote: only the file name's id and the cwd in its first record are looked at. Two new
 * Codex tabs in one folder cannot be told apart this way; each session goes to the first tab that asks for it.
 */
export class CodexSessionDiscovery implements SessionIdDiscovery {
  private readonly before = new Set<string>()
  private readonly rejected = new Set<string>()
  private cancelled = false
  private readonly started: number
  private readonly snapshot: Promise<void>

  constructor(private readonly options: CodexDiscoveryOptions) {
    this.started = this.now()
    this.snapshot = rolloutFiles(options.root, this.started).then((files) => { for (const file of files) this.before.add(file) })
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  ready(): Promise<void> { return this.snapshot }

  cancel(): void { this.cancelled = true }

  async find(): Promise<string | null> {
    await this.snapshot
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() }))
    while (!this.cancelled) {
      const slow = this.now() - this.started > (this.options.slowAfterMs ?? 120_000)
      await sleep(slow ? this.options.slowPollMs ?? 10_000 : this.options.pollMs ?? 2_000)
      if (this.cancelled) break
      for (const file of await rolloutFiles(this.options.root, this.now())) {
        if (this.before.has(file) || this.rejected.has(file)) continue
        const cwd = await rolloutCwd(file)
        if (cwd === undefined) continue
        const id = ROLLOUT.exec(basename(file))?.[1]?.toLowerCase()
        if (cwd === null || !id || !samePath(cwd, this.options.cwd) || !this.options.claim(id)) { this.rejected.add(file); continue }
        return this.cancelled ? null : id
      }
    }
    return null
  }
}
