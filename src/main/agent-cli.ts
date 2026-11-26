import { existsSync } from 'node:fs'
import { access, open, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, join, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { samePath } from './host-path.js'
import { findPosixExecutable } from './posix-executables.js'
import {
  defaultExecFile, resolveWindowsCommand, tryVersion, unwrapNpmShim, withCopilotPathAdditions,
  windowsSystemDirectory, windowsSystemExecutable,
  type ExecFileFn, type NpmCliPackage, type ReadTextFileFn,
} from './resolve-copilot.js'
import { sessionCliLabel, type OtherCli } from './session-cli.js'

/**
 * Session tabs for CLIs other than Copilot run the CLI's own terminal UI in the project folder.
 * Each CLI keeps its own sign-in, settings and approvals.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CLI_INSTALLATIONS: Record<OtherCli, { bin: string; npmPackage?: string }> = {
  claude: { bin: 'claude', npmPackage: '@anthropic-ai/claude-code' },
  codex: { bin: 'codex', npmPackage: '@openai/codex' },
  antigravity: { bin: 'agy' },
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
  const { bin, npmPackage } = CLI_INSTALLATIONS[cli]
  if (!npmPackage) return 'Install agy from https://antigravity.google/download, then try again.'
  return `Install it with \`npm install -g ${npmPackage}\`, make sure a terminal finds \`${bin}\`, then try again.`
}

const WINDOWS_APP_LOOKUP_TIMEOUT_MS = 8_000

/**
 * The OpenAI Codex Windows Store app bundles `codex.exe` inside its package without putting it on PATH.
 * Query its install location via System32 PowerShell from a trusted CWD so the workspace is never searched.
 */
async function findWindowsCodexAppExecutables(
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
): Promise<string[]> {
  try {
    const { stdout } = await execFileFn(
      windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe', env),
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage OpenAI.Codex).InstallLocation'],
      { env, cwd: windowsSystemDirectory(env), timeout: WINDOWS_APP_LOOKUP_TIMEOUT_MS, windowsHide: true },
    )
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => win32.isAbsolute(line))
      .map((location) => win32.join(location, 'app', 'resources', 'codex.exe'))
  } catch {
    return []
  }
}

/** Find the CLI without ever invoking a command shell: an executable on PATH, or a verified npm shim's target. */
export async function resolveAgentCli(cli: OtherCli, deps: AgentCliResolveDeps = {}): Promise<AgentCliResolution> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const pathExists = deps.pathExists ?? existsSync
  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, 'utf8'))
  const findExecutable = deps.findExecutable ?? findPosixExecutable
  const execFileFn = deps.execFile ?? defaultExecFile
  const { bin, npmPackage } = CLI_INSTALLATIONS[cli]
  const cliPackage: NpmCliPackage | null = npmPackage ? { name: npmPackage, bin } : null
  const attempts: string[] = []

  const probe = async (launch: Pick<AgentCliResolution, 'command' | 'prefixArgs' | 'resolvedPath' | 'pathAdditions'>): Promise<AgentCliResolution | null> => {
    const result = await tryVersion(launch.command, [...launch.prefixArgs, '--version'], withCopilotPathAdditions(env, launch.pathAdditions), execFileFn)
    if (result.ok) return { cli, ...launch, version: result.version ?? 'unknown', error: null }
    attempts.push(`${launch.resolvedPath ?? launch.command}: ${describe(result.error)}`)
    return null
  }

  if (platform === 'win32') {
    const located = await resolveWindowsCommand(bin, env, execFileFn)
    const candidates = [
      ...located.paths.filter((path) => cliPackage || /\.exe$/i.test(path)),
      // The native installers' default folders may be absent from the desktop's PATH.
      ...(cli === 'claude' && env.USERPROFILE ? [win32.join(env.USERPROFILE, '.local', 'bin', 'claude.exe')] : []),
      ...(cli === 'antigravity' && env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)
        ? [win32.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')] : []),
      ...(cliPackage && env.APPDATA ? [win32.join(env.APPDATA, 'npm', `${bin}.cmd`)] : []),
    ]
    const seen = new Set<string>()
    const tryCandidate = async (path: string, fromWhere: boolean): Promise<AgentCliResolution | null> => {
      const key = path.toLowerCase()
      if (seen.has(key) || (!fromWhere && !pathExists(path))) return null
      seen.add(key)
      const launch = key.endsWith('.exe')
        ? { command: path, prefixArgs: [], resolvedPath: path, pathAdditions: [] }
        : cliPackage && await unwrapNpmShim(path, cliPackage, env, execFileFn, pathExists, readTextFile)
      if (!launch) { attempts.push(`${path}: package-manager shim target could not be verified`); return null }
      return probe(launch)
    }
    for (const path of candidates) {
      const found = await tryCandidate(path, located.paths.includes(path))
      if (found) return found
    }
    if (cli === 'codex') {
      for (const path of await findWindowsCodexAppExecutables(env, execFileFn)) {
        const found = await tryCandidate(path, false)
        if (found) return found
      }
    }
  } else {
    const searchEnv = cli === 'antigravity'
      ? { ...env, PATH: [env.PATH, join(env.HOME || homedir(), '.local', 'bin')].filter(Boolean).join(delimiter) }
      : env
    const located = await findExecutable(bin, searchEnv)
    if (located) {
      const found = await probe({ command: located, prefixArgs: [], resolvedPath: located })
      if (found) return found
    }
  }

  return {
    cli, command: bin, prefixArgs: [], resolvedPath: null, version: null,
    error: [`${sessionCliLabel(cli)} was not found. ${agentCliInstallHint(cli)}`, ...attempts].join('\n'),
  }
}

const HELP_TIMEOUT_MS = 15_000

/**
 * The resolved CLI's `--help` text, used to check that the launch flags a workspace configured are ones this installed
 * build lists before a running tab is stopped for them. Null when nothing could be read. Some CLIs print help with a
 * non-zero exit; their output still counts.
 */
export async function agentCliHelp(
  resolution: Pick<AgentCliResolution, 'command' | 'prefixArgs' | 'pathAdditions'>,
  deps: { env?: NodeJS.ProcessEnv; execFile?: ExecFileFn } = {},
): Promise<string | null> {
  const env = withCopilotPathAdditions(deps.env ?? process.env, resolution.pathAdditions)
  const read = (output: { stdout?: unknown; stderr?: unknown }): string | null => {
    const text = [output.stdout, output.stderr].filter((part): part is string => typeof part === 'string').join('\n').trim()
    return text.length > 0 ? text : null
  }
  try {
    return read(await (deps.execFile ?? defaultExecFile)(resolution.command, [...resolution.prefixArgs, '--help'], { env, timeout: HELP_TIMEOUT_MS, windowsHide: true }))
  } catch (error) {
    return error && typeof error === 'object' ? read(error as { stdout?: unknown; stderr?: unknown }) : null
  }
}

/**
 * Whether Codex, started in `cwd` with these `-c` overrides, still loads its configuration and the MCP server `server`.
 * An override only merges into an entry the person configured (a stdio entry plus a `url` fails to load), and Codex
 * reads more than one config file, so asking it is the only sure check.
 */
export async function codexAcceptsMcpOverride(
  resolution: Pick<AgentCliResolution, 'command' | 'prefixArgs' | 'pathAdditions'>,
  overrides: string[],
  server: string,
  cwd: string,
  deps: { env?: NodeJS.ProcessEnv; execFile?: ExecFileFn } = {},
): Promise<boolean> {
  const env = withCopilotPathAdditions(deps.env ?? process.env, resolution.pathAdditions)
  try {
    await (deps.execFile ?? defaultExecFile)(resolution.command, [...resolution.prefixArgs, ...overrides, 'mcp', 'get', server], { env, timeout: HELP_TIMEOUT_MS, windowsHide: true, cwd })
    return true
  } catch {
    return false
  }
}

/**
 * The CLI's arguments for a tab. Claude Code takes the id of a new session and resumes by it; Codex and Antigravity
 * name their own sessions, so a new one gets no id (it is read from the CLI's session store later) and a stored one is
 * resumed by id.
 */
export function buildAgentCliArgs(cli: OtherCli, session: { id: string | null; stored: boolean }): string[] {
  if (session.id !== null && !UUID.test(session.id)) throw new Error('Invalid session id')
  if (cli === 'claude') {
    if (session.id === null) return []
    return session.stored ? ['--resume', session.id] : ['--session-id', session.id]
  }
  if (session.id === null || !session.stored) return []
  if (cli === 'codex') return ['resume', session.id]
  return ['--conversation', session.id]
}

function claudeConfigRoot(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
}

export function antigravityDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini'), 'antigravity-cli')
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

interface AntigravitySummaryRow {
  id: string
  workspacePaths: string[]
  isSubagent: boolean
}

function parseAntigravityWorkspaceUris(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const paths: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || !item.startsWith('file://')) continue
    try { paths.push(fileURLToPath(item)) } catch { /* ignore malformed or non-local URI */ }
  }
  return paths
}

function readAntigravitySummaries(root: string): AntigravitySummaryRow[] | null {
  const dbPath = join(root, 'conversation_summaries.db')
  if (!existsSync(dbPath)) return null
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1_000 })
    let rows: Array<Record<string, unknown>>
    try {
      rows = db.prepare(
        'SELECT conversation_id, workspace_uris, parent_conversation_id, nesting_depth FROM conversation_summaries',
      ).all() as Array<Record<string, unknown>>
    } catch {
      rows = db.prepare(
        'SELECT conversation_id, workspace_uris FROM conversation_summaries',
      ).all() as Array<Record<string, unknown>>
    }
    const result: AntigravitySummaryRow[] = []
    for (const row of rows) {
      if (typeof row.conversation_id !== 'string' || !UUID.test(row.conversation_id)) continue
      const parent = typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.trim() : ''
      const depth = typeof row.nesting_depth === 'number' ? row.nesting_depth : 0
      result.push({
        id: row.conversation_id.toLowerCase(),
        workspacePaths: parseAntigravityWorkspaceUris(row.workspace_uris),
        isSubagent: parent.length > 0 || depth > 0,
      })
    }
    return result
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore close errors */ }
  }
}

async function readAntigravityHistory(root: string): Promise<Array<{ id: string; workspace: string }>> {
  let content: string
  try { content = await readFile(join(root, 'history.jsonl'), 'utf8') } catch { return [] }
  const entries: Array<{ id: string; workspace: string }> = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as { conversationId?: unknown; workspace?: unknown }
      if (typeof parsed.conversationId === 'string' && UUID.test(parsed.conversationId) && typeof parsed.workspace === 'string') {
        entries.push({ id: parsed.conversationId.toLowerCase(), workspace: parsed.workspace })
      }
    } catch { /* ignore malformed or partial line */ }
  }
  return entries
}

/**
 * Whether Antigravity CLI has stored the conversation: it writes `conversations/<id>.db` (or `.pb`) and indexes it in
 * `conversation_summaries.db`. Checking avoids passing `--conversation` for a conversation that was deleted.
 */
export async function antigravitySessionStored(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!UUID.test(sessionId)) return false
  const root = antigravityDataRoot(env)
  const id = sessionId.toLowerCase()
  for (const ext of ['.db', '.pb']) {
    try { await access(join(root, 'conversations', `${id}${ext}`)); return true } catch { /* try next */ }
  }
  const summaries = readAntigravitySummaries(root)
  return summaries?.some((row) => row.id === id) ?? false
}

/** What a PtySession needs from something that finds its session id after the process has started. */
export interface SessionIdDiscovery {
  /** Resolves once everything that existed before the spawn has been recorded. */
  ready(): Promise<void>
  find(): Promise<string | null>
  /** One immediate check right before stopping, so a fast restart still captures a newly stored session. */
  check?(): Promise<string | null>
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

export interface AntigravityDiscoveryOptions {
  /** `antigravityDataRoot`. */
  root: string
  /** The folder the process was started in: the conversation's workspace must match it. */
  cwd: string
  /** Called with a matching conversation's id; false when another tab already has it, and the search goes on. */
  claim(sessionId: string): boolean
  now?(): number
  sleep?(ms: number): Promise<void>
  pollMs?: number
  slowAfterMs?: number
  slowPollMs?: number
}

const ANTIGRAVITY_CONVERSATION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:db|pb)$/i

async function existingAntigravityIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const row of readAntigravitySummaries(root) ?? []) ids.add(row.id)
  try {
    for (const name of await readdir(join(root, 'conversations'))) {
      const match = ANTIGRAVITY_CONVERSATION_FILE.exec(name)
      if (match) ids.add(match[1]!.toLowerCase())
    }
  } catch { /* conversations folder may not exist yet */ }
  try {
    for (const name of await readdir(join(root, 'brain'))) {
      if (UUID.test(name)) ids.add(name.toLowerCase())
    }
  } catch { /* brain folder may not exist yet */ }
  for (const entry of await readAntigravityHistory(root)) ids.add(entry.id)
  return ids
}

/**
 * Finds the id of an Antigravity CLI conversation the desktop started. Like Codex, `agy` names its own conversations
 * once the user sends a prompt, indexing them in `conversation_summaries.db` (and later `history.jsonl`). This watches
 * for a new top-level conversation whose workspace matches the tab's folder and claims it for the tab.
 */
export class AntigravitySessionDiscovery implements SessionIdDiscovery {
  private readonly before = new Set<string>()
  private readonly rejected = new Set<string>()
  private cancelled = false
  private foundId: string | null = null
  private inFlight: Promise<string | null> | null = null
  private realCwd: string | null = null
  private readonly started: number
  private readonly snapshot: Promise<void>

  constructor(private readonly options: AntigravityDiscoveryOptions) {
    this.started = this.now()
    this.snapshot = Promise.all([
      existingAntigravityIds(options.root),
      realpath(options.cwd).catch(() => null),
    ]).then(([ids, resolved]) => {
      for (const id of ids) this.before.add(id)
      this.realCwd = resolved
    })
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  ready(): Promise<void> { return this.snapshot }

  cancel(): void { this.cancelled = true }

  private async matchesCwd(candidate: string): Promise<boolean> {
    if (samePath(candidate, this.options.cwd)) return true
    if (this.realCwd && samePath(candidate, this.realCwd)) return true
    const resolved = await realpath(candidate).catch(() => null)
    if (!resolved) return false
    return samePath(resolved, this.options.cwd) || (this.realCwd !== null && samePath(resolved, this.realCwd))
  }

  private async scanOnce(): Promise<string | null> {
    await this.snapshot
    if (this.foundId !== null) return this.foundId
    const summaries = readAntigravitySummaries(this.options.root)
    if (summaries) {
      for (const row of summaries) {
        if (this.before.has(row.id) || this.rejected.has(row.id)) continue
        if (row.isSubagent) { this.rejected.add(row.id); continue }
        if (row.workspacePaths.length === 0) continue
        let matched = false
        for (const workspace of row.workspacePaths) {
          if (await this.matchesCwd(workspace)) { matched = true; break }
        }
        if (!matched || !this.options.claim(row.id)) { this.rejected.add(row.id); continue }
        this.foundId = row.id
        return row.id
      }
    }
    for (const entry of await readAntigravityHistory(this.options.root)) {
      if (this.before.has(entry.id) || this.rejected.has(entry.id)) continue
      if (!entry.workspace.trim()) continue
      if (!await this.matchesCwd(entry.workspace) || !this.options.claim(entry.id)) { this.rejected.add(entry.id); continue }
      this.foundId = entry.id
      return entry.id
    }
    return null
  }

  check(): Promise<string | null> {
    if (this.foundId !== null) return Promise.resolve(this.foundId)
    if (this.inFlight) return this.inFlight
    const scan = this.scanOnce().finally(() => { if (this.inFlight === scan) this.inFlight = null })
    this.inFlight = scan
    return scan
  }

  async find(): Promise<string | null> {
    await this.snapshot
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() }))
    while (!this.cancelled) {
      const slow = this.now() - this.started > (this.options.slowAfterMs ?? 120_000)
      await sleep(slow ? this.options.slowPollMs ?? 10_000 : this.options.pollMs ?? 2_000)
      if (this.cancelled) break
      const id = await this.check()
      if (id !== null) return this.cancelled ? null : id
    }
    return null
  }
}
