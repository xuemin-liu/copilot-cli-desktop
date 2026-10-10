import { redactDiagnosticText } from './desktop-diagnostics.js'
import { branchListArgs, commitArgs, configGetArgs, createBranchArgs, diffArgs, fastForwardArgs, fetchArgs, fetchRefspecsArgs, headRefArgs, logArgs, pushArgs, refFormatArgs, remoteListArgs, remoteUrlArgs, restoreArgs, stageArgs, stagedRawArgs, statusArgs, switchArgs, unstageArgs, upstreamConfigArgs, upstreamRefArgs } from './git-commands.js'
import { branchNameProblem, describeSwitchFailure } from './git-branch.js'
import { DiscardRefused, checkSnapshotable, checkTrashable, pruneSnapshots, saveSnapshot, stampFiles } from './git-discard.js'
import type { Snapshot } from './git-discard.js'
import type { ProjectActivity } from './git-branch.js'
import { inspectCommitHooks, inspectHooks, PUSH_HOOKS } from './git-hooks.js'
import type { HooksInventory } from './git-hooks.js'
import { discoverRepos, inspectGitEntry } from './git-discovery.js'
import type { DiscoveredRepo } from './git-discovery.js'
import { boundText, groupStatusEntries, parseBranches, parseLog, parseNumstat, parseStagedRaw, parseStatusV2 } from './git-parse.js'
import type { GitStatus, GitStatusEntry } from './git-parse.js'
import { gitSucceeded } from './git-runner.js'
import type { GitExecutable, GitRunOptions, GitRunResult, GitRunner } from './git-runner.js'
import { isReviewable } from './git-review-format.js'
import { GitTrustStore, repoTrustKey, scanRepoConfig } from './git-trust.js'
import type { RepoConfigScan } from './git-trust.js'
import { readUntrackedFile } from './git-untracked.js'
import type {
  GitBranchView, GitConfirmRequest, GitDiffView, GitEntryView, GitLogEntry, GitOperationResult, GitProgressEvent, GitProjectView, GitRepoState, GitRepoStatusView, GitRepoSummary,
} from './git-types.js'
import { ALLOWED_PROTOCOLS, checkFetchRefspecs, checkRemoteUrl, describeSyncFailure } from './git-sync.js'
import type { SyncOperation } from './git-sync.js'
import { realPathNative } from './real-path.js'

export interface GitRuntime {
  runner: GitRunner
  executable: GitExecutable
}

export interface GitServiceOptions {
  getRuntime(): Promise<GitRuntime | null>
  trustStore: GitTrustStore
  /** Folder of a workspace profile, or null when the profile is unknown. */
  resolveProject(profileId: string): string | null
  /** One call per subscription whose project view changed. */
  onChanged(subscriberId: number, profileId: string, view: GitProjectView): void
  /** Output from a running write, for example a commit hook's messages. */
  onProgress?(subscriberId: number, profileId: string, event: GitProgressEvent): void
  /** How long a write waits for another process's `index.lock` before saying so. */
  lockWaitMs?: number
  lockPollMs?: number
  /** The largest hook that can be hashed for approval; a bigger one can never be approved. Tests lower it. */
  maxHookBytes?: number
  /** Whether a Copilot session is working in this project. A branch switch is refused while one is. */
  sessionActivity?(profileId: string): ProjectActivity
  /** Ask the person in a native window. Without it, anything that needs a confirmation is refused. */
  confirm?(profileId: string, request: GitConfirmRequest): Promise<boolean>
  /** A folder the app owns, where a copy of each tracked file is saved before its changes are discarded. Without it none can be. */
  snapshotDirectory?: string
  /** Move a file or folder to the Recycle Bin. Without it no untracked item can be discarded. */
  trash?(absolutePath: string): Promise<void>
  /** Limits on the saved copies, and the clock; tests lower and fix them. */
  maxSnapshotFileBytes?: number
  maxSnapshotTotalBytes?: number
  now?(): Date
  /** True while refreshing must not start (shutdown, migration, window hidden). Checked before every refresh. */
  shouldPause?(): boolean
  discover?: typeof discoverRepos
  debounceMs?: number
  fallbackMs?: number
  concurrency?: number
}

/** A caller used an id or generation that no longer matches the repository's current state. */
export class GitStaleError extends Error {
  constructor(message = 'The file list changed. Refresh and try again.') {
    super(message)
    this.name = 'GitStaleError'
  }
}

/** The caller closed the panel (or its renderer went away) before the request finished. */
export class GitCancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'GitCancelledError'
  }
}

/** Carries a finished refusal out of the lock-wait loop, so a check that fails on a retry still ends as a normal result. */
class WriteRefused extends Error {
  constructor(readonly result: GitOperationResult) {
    super(result.message)
    this.name = 'WriteRefused'
  }
}

interface RepoRuntime {
  id: string
  discovered: DiscoveredRepo
  state: GitRepoState
  error: string | null
  scan: RepoConfigScan | null
  generation: number
  signature: string
  status: GitStatus | null
  entries: Map<string, GitStatusEntry>
  statusView: GitRepoStatusView | null
  /** Tail of this repository's write queue: writes run one at a time, in order. */
  writeQueue: Promise<unknown>
  /** Cancel handle of the write running now, if any. */
  writeAbort: AbortController | null
}

interface ProjectRuntime {
  key: string
  path: string
  repos: Map<string, RepoRuntime>
  notes: string[]
  truncated: boolean
  discovered: boolean
  view: GitProjectView | null
  viewJson: string
  abort: AbortController
  refreshing: Promise<void> | null
  again: boolean
  rescanNext: boolean
  debounce: NodeJS.Timeout | undefined
  fallback: NodeJS.Timeout | undefined
  lastDuration: number
  lastFinished: number
}

const MAX_DIFF_BYTES = 512 * 1024
const STATUS_TIMEOUT_MS = 30_000
const UNAVAILABLE_MESSAGE = 'Git was not found. Install Git for Windows to use the Git panel.'

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) ?? ''
}

function describeFailure(result: GitRunResult, what: string, repoRoot: string): string {
  if (result.timedOut) return `${what} timed out`
  const line = redactDiagnosticText(firstLine(result.stderr))
  if (/dubious ownership/i.test(result.stderr)) {
    return `${line || 'git does not trust this folder'}. To allow it, run: git config --global --add safe.directory "${repoRoot.replace(/\\/g, '/')}"`
  }
  return line || `${what} failed (exit ${result.exitCode ?? 'none'})`
}

/** The failure every write shares: another process holds the index lock. Git says so when it cannot create `index.lock`. */
export function isIndexLockFailure(result: GitRunResult): boolean {
  return result.exitCode !== 0 && result.stderr.includes('index.lock') && /File exists|another git process/i.test(result.stderr)
}

/** What git and its hooks printed, redacted and cut to the last few thousand characters. */
/** The branch, and the commit on it, that a pull or push was asked for. */
export interface ExpectedBranch {
  branch: string
  headOid: string
}

/** What a branch change was asked from: the current branch (null while detached) and its commit. */
export interface ExpectedHead {
  branch: string | null
  headOid: string
}

function tailOutput(result: GitRunResult): string {
  const text = redactDiagnosticText(`${result.stdout.toString('utf8')}${result.stderr}`).replace(/\r\n/g, '\n').trim()
  return text.length > 4_000 ? `…${text.slice(-3_999)}` : text
}

async function mapLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await task(items[next++]!)
  })
  await Promise.all(workers)
}

export class GitService {
  private readonly projects = new Map<string, ProjectRuntime>()
  /** subscriber (a webContents id) -> profile id -> project */
  private readonly subscriptions = new Map<number, Map<string, ProjectRuntime>>()
  /** Opens still in flight, by `subscriber:profile`. Releasing the subscriber removes its entry, which cancels the open. */
  private readonly opening = new Map<string, symbol>()
  /** Writes in flight. They outlive a closed panel (the user asked for them) but not the app. */
  private readonly writeControllers = new Set<AbortController>()
  private nextRepoNumber = 1
  private paused = false
  private disposed = false
  private runtime: Promise<GitRuntime | null> | null = null
  private runtimeFailedAt = 0

  constructor(private readonly options: GitServiceOptions) {}

  // ---- subscriptions ----------------------------------------------------------------------------

  async subscribe(subscriberId: number, profileId: string): Promise<GitProjectView> {
    if (this.disposed) throw new Error('The git service has stopped')
    const folder = this.options.resolveProject(profileId)
    if (!folder) throw new Error('Unknown workspace')
    // The open is cancellable until it returns: closing the panel or losing the renderer while the folder is being
    // resolved must not leave a subscription (and its timers) behind.
    const openKey = `${subscriberId}:${profileId}`
    const token = Symbol('open')
    this.opening.set(openKey, token)
    try {
      return await this.openSubscription(subscriberId, profileId, folder, openKey, token)
    } finally {
      if (this.opening.get(openKey) === token) this.opening.delete(openKey)
    }
  }

  private async openSubscription(subscriberId: number, profileId: string, folder: string, openKey: string, token: symbol): Promise<GitProjectView> {
    const cancelled = (): boolean => this.disposed || this.opening.get(openKey) !== token
    let canonical: string
    try { canonical = await realPathNative(folder) } catch { throw new Error('The workspace folder is not available') }
    if (cancelled()) throw new GitCancelledError()
    const key = repoTrustKey(canonical)
    let project = this.projects.get(key)
    if (!project) {
      project = {
        key, path: canonical, repos: new Map(), notes: [], truncated: false, discovered: false, view: null, viewJson: '',
        abort: new AbortController(), refreshing: null, again: false, rescanNext: false,
        debounce: undefined, fallback: undefined, lastDuration: 0, lastFinished: 0,
      }
      this.projects.set(key, project)
    }
    let mine = this.subscriptions.get(subscriberId)
    if (!mine) { mine = new Map(); this.subscriptions.set(subscriberId, mine) }
    const previous = mine.get(profileId)
    if (previous && previous !== project) this.release(subscriberId, profileId)
    mine.set(profileId, project)
    await this.refreshProject(project, true)
    if (cancelled()) throw new GitCancelledError()
    if (this.projects.get(key) === project) this.arm(project)
    return this.viewOf(project)
  }

  unsubscribe(subscriberId: number, profileId: string): void {
    this.opening.delete(`${subscriberId}:${profileId}`)
    this.release(subscriberId, profileId)
  }

  /** Called when a renderer reloads, crashes or closes: nothing it started may keep running. */
  unsubscribeAll(subscriberId: number): void {
    for (const key of [...this.opening.keys()]) if (key.startsWith(`${subscriberId}:`)) this.opening.delete(key)
    for (const profileId of [...(this.subscriptions.get(subscriberId)?.keys() ?? [])]) this.release(subscriberId, profileId)
    this.subscriptions.delete(subscriberId)
  }

  hasSubscribers(): boolean {
    return this.projects.size > 0
  }

  private release(subscriberId: number, profileId: string): void {
    const mine = this.subscriptions.get(subscriberId)
    const project = mine?.get(profileId)
    if (!mine || !project) return
    mine.delete(profileId)
    if (mine.size === 0) this.subscriptions.delete(subscriberId)
    if (![...this.subscriptions.values()].some(entries => [...entries.values()].includes(project))) this.stopProject(project)
  }

  private stopProject(project: ProjectRuntime): void {
    clearTimeout(project.debounce)
    clearTimeout(project.fallback)
    project.abort.abort()
    this.projects.delete(project.key)
  }

  private projectFor(subscriberId: number, profileId: string): ProjectRuntime {
    const project = this.subscriptions.get(subscriberId)?.get(profileId)
    if (!project) throw new Error('Open the Git panel before asking for repository data')
    return project
  }

  private repoFor(project: ProjectRuntime, repoId: string): RepoRuntime {
    for (const repo of project.repos.values()) if (repo.id === repoId) return repo
    throw new GitStaleError('That repository is no longer in this project. Rescan and try again.')
  }

  // ---- refresh scheduling -----------------------------------------------------------------------

  private isPaused(): boolean {
    return this.paused || this.disposed || (this.options.shouldPause?.() ?? false)
  }

  /** Window hidden or restored. Pausing also cancels work in flight. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    for (const project of this.projects.values()) {
      if (paused) {
        clearTimeout(project.debounce)
        project.debounce = undefined
        project.abort.abort()
        project.abort = new AbortController()
      } else {
        this.schedule(project, 0)
      }
    }
  }

  /** Something that probably changed files happened (a session finished a tool call, the window gained focus). */
  requestRefresh(profileId: string): void {
    for (const mine of this.subscriptions.values()) {
      const project = mine.get(profileId)
      if (project) { this.schedule(project, this.options.debounceMs ?? 400); return }
    }
  }

  private schedule(project: ProjectRuntime, delay: number): void {
    if (this.isPaused() || project.debounce) return
    // Adaptive spacing: never start the next refresh sooner than three times the last one took.
    const minGap = Math.min(10_000, project.lastDuration * 3) - (Date.now() - project.lastFinished)
    project.debounce = setTimeout(() => {
      project.debounce = undefined
      void this.refreshProject(project).catch(() => undefined)
    }, Math.max(delay, minGap, 0))
    project.debounce.unref?.()
  }

  private arm(project: ProjectRuntime): void {
    clearTimeout(project.fallback)
    project.fallback = setTimeout(() => {
      const refresh = this.isPaused() ? Promise.resolve() : this.refreshProject(project)
      void refresh.catch(() => undefined).finally(() => { if (this.projects.get(project.key) === project) this.arm(project) })
    }, this.options.fallbackMs ?? 20_000)
    project.fallback.unref?.()
  }

  async rescan(subscriberId: number, profileId: string): Promise<GitProjectView> {
    const project = this.projectFor(subscriberId, profileId)
    project.rescanNext = true
    await this.refreshProject(project, true)
    return this.viewOf(project)
  }

  /**
   * `force` is for something the user just asked for (open, rescan, trust, read a status): it runs even while background
   * refreshing is paused, because a hidden window must not make an explicit request return nothing. Shutdown still wins.
   */
  private refreshProject(project: ProjectRuntime, force = false): Promise<void> {
    if (this.disposed || (!force && this.isPaused())) return Promise.resolve()
    if (project.refreshing) { project.again = true; return project.refreshing }
    const run = this.doRefresh(project).finally(() => {
      project.refreshing = null
      if (project.again && this.projects.get(project.key) === project) { project.again = false; this.schedule(project, 0) }
    })
    project.refreshing = run
    return run
  }

  private async getRuntime(): Promise<GitRuntime | null> {
    if (this.runtime && (await this.runtime !== null || Date.now() - this.runtimeFailedAt < 10_000)) return this.runtime
    this.runtime = this.options.getRuntime().catch(() => null)
    const value = await this.runtime
    if (!value) this.runtimeFailedAt = Date.now()
    return value
  }

  private async doRefresh(project: ProjectRuntime): Promise<void> {
    const started = Date.now()
    const signal = project.abort.signal
    const runtime = await this.getRuntime()
    if (signal.aborted) return
    if (!runtime) {
      project.view = this.emptyView(null)
      this.publish(project)
      return
    }
    try {
      if (!project.discovered || project.rescanNext) {
        project.rescanNext = false
        const found = await (this.options.discover ?? discoverRepos)(project.path)
        if (signal.aborted) return
        this.reconcile(project, found.repos)
        project.notes = found.notes
        project.truncated = found.truncated
        project.discovered = true
      }
      await mapLimit([...project.repos.values()], this.options.concurrency ?? 3, repo => this.refreshRepo(project, repo, runtime, signal))
    } catch (error) {
      if (signal.aborted) return
      project.notes = [`Could not inspect this folder: ${redactDiagnosticText(error instanceof Error ? error.message : String(error))}`]
    }
    if (signal.aborted) return
    project.view = this.buildView(project, runtime)
    project.lastDuration = Date.now() - started
    project.lastFinished = Date.now()
    this.publish(project)
  }

  private reconcile(project: ProjectRuntime, discovered: readonly DiscoveredRepo[]): void {
    const seen = new Set<string>()
    for (const found of discovered) {
      const key = repoTrustKey(found.root)
      seen.add(key)
      const existing = project.repos.get(key)
      if (existing) { existing.discovered = found; continue }
      project.repos.set(key, {
        id: `repo-${this.nextRepoNumber++}`, discovered: found, state: 'ready', error: null, scan: null,
        generation: 0, signature: '', status: null, entries: new Map(), statusView: null,
        writeQueue: Promise.resolve(), writeAbort: null,
      })
    }
    for (const key of [...project.repos.keys()]) if (!seen.has(key)) project.repos.delete(key)
  }

  private markError(repo: RepoRuntime, message: string): void {
    repo.state = 'error'
    repo.error = message
    repo.status = null
    repo.statusView = null
    repo.entries = new Map()
    repo.scan = null
  }

  /**
   * Everything that must hold before git is pointed at a repository: its `.git` pointers stay on local storage, git is
   * recent enough, and its own config either names no program or the user has accepted exactly that config. It runs before
   * every git command, not only at discovery, because the CLI or another process can change `.git` while the panel is open.
   * Returns false, with the repository's state updated, when git must not be run.
   */
  private async passGate(repo: RepoRuntime, runtime: GitRuntime, signal: AbortSignal): Promise<boolean> {
    const root = repo.discovered.root
    const entry = await inspectGitEntry(root)
    if (!entry) { this.markError(repo, 'The .git entry is gone'); return false }
    if (entry.issue ?? repo.discovered.issue) { this.markError(repo, entry.issue ?? repo.discovered.issue ?? 'Not safe to open'); return false }
    if (!runtime.executable.supported) { this.markError(repo, `${runtime.executable.version.text} is older than the supported minimum (2.30)`); return false }
    try {
      const scan = await scanRepoConfig(runtime.runner, root, signal)
      if (signal.aborted) return false
      repo.scan = scan
      if (scan.items.length > 0 && !(await this.options.trustStore.isTrusted(root, scan.hash))) {
        repo.state = 'needs-review'
        repo.error = null
        repo.status = null
        repo.statusView = null
        repo.entries = new Map()
        return false
      }
      return true
    } catch (error) {
      if (signal.aborted) return false
      this.markError(repo, redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 300))
      return false
    }
  }

  private async refreshRepo(project: ProjectRuntime, repo: RepoRuntime, runtime: GitRuntime, signal: AbortSignal): Promise<void> {
    const root = repo.discovered.root
    const fail = (message: string): void => this.markError(repo, message)
    try {
      if (!(await this.passGate(repo, runtime, signal))) return
      const result = await runtime.runner.run({
        cwd: root, args: statusArgs(repo.discovered.kind === 'parent' ? 'no' : 'normal'), signal, timeoutMs: STATUS_TIMEOUT_MS,
      })
      if (result.cancelled || signal.aborted) return
      if (!gitSucceeded(result)) return fail(describeFailure(result, 'git status', root))
      this.applyStatus(repo, parseStatusV2(result.stdout.toString('utf8')))
    } catch (error) {
      if (signal.aborted) return
      fail(redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 300))
    }
  }

  private applyStatus(repo: RepoRuntime, status: GitStatus): void {
    repo.state = 'ready'
    repo.error = null
    repo.status = status
    const signature = JSON.stringify([status.entries, status.totalEntries, status.truncated])
    if (signature !== repo.signature || !repo.statusView) {
      if (signature !== repo.signature) repo.generation++
      repo.signature = signature
      repo.entries = new Map()
      const views = new Map<GitStatusEntry, GitEntryView>()
      status.entries.forEach((entry, index) => {
        const id = `e${repo.generation}-${index}`
        repo.entries.set(id, entry)
        views.set(entry, {
          id, path: entry.path, originalPath: entry.originalPath, kind: entry.kind, index: entry.index, worktree: entry.worktree,
          isDirectory: entry.isDirectory, submodule: entry.submodule,
        })
      })
      const grouped = groupStatusEntries(status.entries)
      const toViews = (entries: GitStatusEntry[]): GitEntryView[] => entries.map(entry => views.get(entry)!)
      repo.statusView = {
        repoId: repo.id, generation: repo.generation, summary: this.summarize(repo),
        staged: toViews(grouped.staged), unstaged: toViews(grouped.unstaged), untracked: toViews(grouped.untracked), conflicted: toViews(grouped.conflicted),
        totalEntries: status.totalEntries, truncated: status.truncated,
      }
    }
    // Branch, upstream and ahead/behind can change while the file list does not, so the summary is rebuilt on every read.
    // The entry ids and generation above stay put.
    if (repo.statusView) repo.statusView = { ...repo.statusView, summary: this.summarize(repo) }
  }

  // ---- views --------------------------------------------------------------------------------------

  private summarize(repo: RepoRuntime): GitRepoSummary {
    const branch = repo.status?.branch
    const relative = repo.discovered.relativePath
    return {
      id: repo.id,
      name: repo.discovered.root.split('\\').filter(Boolean).at(-1) ?? repo.discovered.root,
      relativePath: relative,
      kind: repo.discovered.kind,
      state: repo.state,
      branch: branch?.head ?? null,
      detached: branch?.detached ?? false,
      upstream: branch?.upstream ?? null,
      ahead: branch?.ahead ?? null,
      behind: branch?.behind ?? null,
      generation: repo.generation,
      headOid: branch?.oid ?? null,
      changeCount: repo.status ? repo.status.entries.filter(entry => entry.kind !== 'ignored').length + Math.max(0, repo.status.totalEntries - repo.status.entries.length) : 0,
      error: repo.error,
      reviewItems: repo.state === 'needs-review' ? repo.scan?.items ?? [] : [],
      configHash: repo.state === 'needs-review' ? repo.scan?.hash ?? null : null,
    }
  }

  private viewOf(project: ProjectRuntime): GitProjectView {
    if (!project.view) throw new Error('The refresh was cancelled. Try again.')
    return project.view
  }

  private emptyView(runtime: GitRuntime | null): GitProjectView {
    return {
      git: runtime
        ? { available: true, version: runtime.executable.version.text, supported: runtime.executable.supported, error: runtime.executable.supported ? null : `${runtime.executable.version.text} is older than the supported minimum (2.30)` }
        : { available: false, version: null, supported: false, error: UNAVAILABLE_MESSAGE },
      repos: [], truncated: false, notes: [],
    }
  }

  private buildView(project: ProjectRuntime, runtime: GitRuntime): GitProjectView {
    const base = this.emptyView(runtime)
    return { ...base, repos: [...project.repos.values()].map(repo => this.summarize(repo)), truncated: project.truncated, notes: project.notes }
  }

  private publish(project: ProjectRuntime): void {
    const view = project.view
    if (!view) return
    const json = JSON.stringify(view)
    if (json === project.viewJson) return
    project.viewJson = json
    for (const [subscriberId, mine] of this.subscriptions) {
      for (const [profileId, candidate] of mine) if (candidate === project) this.options.onChanged(subscriberId, profileId, view)
    }
  }

  // ---- reads --------------------------------------------------------------------------------------

  async getStatus(subscriberId: number, profileId: string, repoId: string): Promise<GitRepoStatusView> {
    const project = this.projectFor(subscriberId, profileId)
    this.repoFor(project, repoId)
    await this.refreshProject(project, true)
    const current = this.repoFor(project, repoId)
    if (current.statusView) return current.statusView
    return {
      repoId, generation: current.generation, summary: this.summarize(current), staged: [], unstaged: [], untracked: [], conflicted: [],
      totalEntries: 0, truncated: false,
    }
  }

  async getDiff(subscriberId: number, profileId: string, repoId: string, entryId: string, staged: boolean): Promise<GitDiffView> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
    await this.requireGate(project, repo, runtime)
    const entry = repo.entries.get(entryId)
    if (!entry) throw new GitStaleError()
    const base = { entryId, path: entry.path }
    const root = repo.discovered.root

    if (entry.kind === 'untracked') {
      const read = await readUntrackedFile(root, entry.path)
      if (read.kind === 'directory') return { ...base, kind: 'directory', text: '', truncated: false, added: null, deleted: null }
      if (read.kind === 'binary') return { ...base, kind: 'binary', text: '', truncated: false, added: null, deleted: null }
      if (read.kind === 'too-large') return { ...base, kind: 'too-large', text: '', truncated: true, added: null, deleted: null }
      if (read.kind === 'unsafe') throw new Error(read.reason)
      const lines = read.text.length === 0 ? [] : read.text.replace(/\n$/, '').split('\n')
      const body = lines.map(line => `+${line.replace(/\r$/, '')}`).join('\n')
      const text = lines.length === 0 ? '' : `--- /dev/null\n+++ b/${entry.path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`
      return { ...base, kind: text ? 'text' : 'empty', text, truncated: read.truncated, added: lines.length, deleted: 0 }
    }

    const paths = { path: entry.path, alsoPath: entry.originalPath, staged: entry.kind === 'unmerged' ? false : staged }
    const signal = project.abort.signal
    const stats = await runtime.runner.run({ cwd: root, args: diffArgs({ ...paths, numstat: true }), signal })
    if (!gitSucceeded(stats)) throw new Error(describeFailure(stats, 'git diff', root))
    const counts = parseNumstat(stats.stdout.toString('utf8'))
    const binary = counts.length > 0 && counts.every(count => count.binary)
    if (binary) return { ...base, kind: 'binary', text: '', truncated: false, added: null, deleted: null }
    const added = counts.reduce((sum, count) => sum + (count.added ?? 0), 0)
    const deleted = counts.reduce((sum, count) => sum + (count.deleted ?? 0), 0)
    const diff = await runtime.runner.run({ cwd: root, args: diffArgs(paths), signal, maxStdoutBytes: MAX_DIFF_BYTES + 64 * 1024 })
    if (diff.cancelled) throw new Error('Cancelled')
    if (!gitSucceeded(diff) && !diff.stdoutTruncated) throw new Error(describeFailure(diff, 'git diff', root))
    const bounded = boundText(diff.stdout, MAX_DIFF_BYTES)
    if (!bounded.text.trim()) return { ...base, kind: 'empty', text: '', truncated: false, added, deleted }
    return { ...base, kind: 'text', text: bounded.text, truncated: bounded.truncated || diff.stdoutTruncated, added, deleted }
  }

  /** Explicit reads re-run the gate: the settings may have changed since the last refresh. */
  private async requireGate(project: ProjectRuntime, repo: RepoRuntime, runtime: GitRuntime, signal: AbortSignal = project.abort.signal): Promise<void> {
    if (await this.passGate(repo, runtime, signal)) return
    // Tell the panel straight away that this repository needs attention, then refuse the read.
    project.view = this.buildView(project, runtime)
    this.publish(project)
    throw new Error(repo.state === 'needs-review' ? 'This repository\'s settings changed and need review before it can be read' : repo.error ?? 'This repository is not available')
  }

  async getLog(subscriberId: number, profileId: string, repoId: string, limit: number, skip: number): Promise<GitLogEntry[]> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
    await this.requireGate(project, repo, runtime)
    const result = await runtime.runner.run({ cwd: repo.discovered.root, args: logArgs({ limit, skip }), signal: project.abort.signal })
    // A repository with no commits yet exits 128 with "does not have any commits".
    if (result.exitCode === 128 && /does not have any commits/i.test(result.stderr)) return []
    if (!gitSucceeded(result)) throw new Error(describeFailure(result, 'git log', repo.discovered.root))
    return parseLog(result.stdout.toString('utf8'))
  }

  // ---- trust --------------------------------------------------------------------------------------

  async trust(subscriberId: number, profileId: string, repoId: string, configHash: string): Promise<GitProjectView> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    if (repo.state !== 'needs-review' || !repo.scan || repo.scan.hash !== configHash) {
      throw new GitStaleError('The repository settings changed. Review them again.')
    }
    // What is trusted is the hash of the complete values, so every value must be short enough to have been shown in full.
    if (!isReviewable(repo.scan.items)) throw new Error('A setting in this repository is too long to review, so it cannot be trusted from the panel')
    await this.options.trustStore.trust(repo.discovered.root, configHash)
    await this.refreshProject(project, true)
    return this.viewOf(project)
  }

  // ---- writes -------------------------------------------------------------------------------------

  /** Run `task` after any write already running on this repository, with a cancel handle of its own. */
  private enqueueWrite<T>(repo: RepoRuntime, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('The git service has stopped'))
    const run = async (): Promise<T> => {
      const controller = new AbortController()
      repo.writeAbort = controller
      this.writeControllers.add(controller)
      try { return await task(controller.signal) } finally {
        this.writeControllers.delete(controller)
        if (repo.writeAbort === controller) repo.writeAbort = null
      }
    }
    const result = repo.writeQueue.then(run, run)
    repo.writeQueue = result.catch(() => undefined)
    return result
  }

  /** Stop the write running on this repository (a commit waiting on a slow hook, say). Writes still queued are not affected. */
  cancel(subscriberId: number, profileId: string, repoId: string): void {
    this.repoFor(this.projectFor(subscriberId, profileId), repoId).writeAbort?.abort()
  }

  /** git takes `index.lock` for the duration of a write; another process (Copilot, a hook) may hold it for a moment. */
  private async runWithLockWait(runtime: GitRuntime, options: GitRunOptions, before?: () => Promise<void>): Promise<GitRunResult> {
    const deadline = Date.now() + (this.options.lockWaitMs ?? 10_000)
    for (;;) {
      // Whatever the caller checked must still hold at the moment of each attempt, not only before the first wait.
      if (before) await before()
      const result = await runtime.runner.run(options)
      if (!isIndexLockFailure(result) || Date.now() >= deadline || options.signal?.aborted) return result
      await new Promise(resolve => setTimeout(resolve, this.options.lockPollMs ?? 400))
    }
  }

  private emitter(subscriberId: number, profileId: string, repoId: string, operation: GitProgressEvent['operation']): (stream: 'stdout' | 'stderr', text: string) => void {
    // What git prints can include the address it is talking to, with credentials in it.
    return (stream, text) => this.options.onProgress?.(subscriberId, profileId, { repoId, operation, stream, text: redactDiagnosticText(text).slice(0, 4_000) })
  }

  /** A refresh that is certain to start after a write finished, then the repository's fresh status. */
  private async statusAfterWrite(project: ProjectRuntime, repo: RepoRuntime): Promise<GitRepoStatusView | null> {
    if (this.disposed || this.projects.get(project.key) !== project) return null
    if (project.refreshing) await project.refreshing.catch(() => undefined)
    await this.refreshProject(project, true).catch(() => undefined)
    return repo.statusView
  }

  /** Read the repository again inside the write queue, so a request is judged against the index as it is now, not as it was cached. */
  private async freshenBeforeWrite(project: ProjectRuntime, repo: RepoRuntime): Promise<void> {
    await this.statusAfterWrite(project, repo)
    if (repo.state !== 'ready') throw new Error('This repository is not available')
  }

  private outcome(overrides: Partial<GitOperationResult> & Pick<GitOperationResult, 'ok' | 'message'>): GitOperationResult {
    return { reason: null, output: '', hooks: [], hooksHash: null, remotes: [], commit: null, status: null, ...overrides }
  }

  /** A failed command as a result: busy, cancelled, timed out or failed, with what git said. */
  private failure(result: GitRunResult, root: string, what: string): Omit<GitOperationResult, 'status'> {
    const output = tailOutput(result)
    const base = { ok: false, hooks: [], hooksHash: null, remotes: [], commit: null, output }
    if (result.cancelled) return { ...base, reason: 'cancelled', message: 'Cancelled. If Git left a lock file behind, delete .git/index.lock in this repository before trying again.' }
    if (result.timedOut) return { ...base, reason: 'failed', message: `${what} timed out. If Git left a lock file behind, delete .git/index.lock in this repository before trying again.` }
    if (isIndexLockFailure(result)) return { ...base, reason: 'busy', message: 'Another Git process is using this repository (it holds .git/index.lock). Wait for it to finish; if none is running, delete that file yourself.' }
    return { ...base, reason: 'failed', message: describeFailure(result, what, root) }
  }

  // ---- network ------------------------------------------------------------------------------------------------------

  fetch(subscriberId: number, profileId: string, repoId: string): Promise<GitOperationResult> {
    return this.sync('fetch', subscriberId, profileId, repoId, null, null)
  }

  /** Pull into the branch the person was looking at (`expected`); if the current branch or its commit is different now, nothing happens. */
  pull(subscriberId: number, profileId: string, repoId: string, expected: ExpectedBranch): Promise<GitOperationResult> {
    return this.sync('pull', subscriberId, profileId, repoId, null, expected)
  }

  /**
   * Push the branch the person was looking at (`expected`) to its upstream. A branch with none is refused with the remotes it could
   * be published to; sending one of them publishes it. A confirmation made for one branch or commit never pushes another.
   */
  push(subscriberId: number, profileId: string, repoId: string, publishTo: string | null, expected: ExpectedBranch): Promise<GitOperationResult> {
    return this.sync('push', subscriberId, profileId, repoId, publishTo, expected)
  }

  private async sync(operation: SyncOperation, subscriberId: number, profileId: string, repoId: string, publishTo: string | null, expected: ExpectedBranch | null): Promise<GitOperationResult> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
    return this.enqueueWrite(repo, async signal => {
      await this.requireGate(project, repo, runtime, signal)
      await this.freshenBeforeWrite(project, repo)
      const root = repo.discovered.root
      const branch = repo.status?.branch
      if (!branch) throw new Error('This repository is not available')
      const refused = (reason: GitOperationResult['reason'], text: string, extra: Partial<GitOperationResult> = {}): GitOperationResult =>
        this.outcome({ ok: false, reason, message: text, status: repo.statusView, ...extra })
      const read = async (args: string[]): Promise<string | null> => {
        const result = await runtime.runner.run({ cwd: root, args, signal, timeoutMs: 15_000 })
        return gitSucceeded(result) ? result.stdout.toString('utf8').trim() : null
      }

      const remotes = ((await read(remoteListArgs())) ?? '').split(/\r?\n/).map(name => name.trim()).filter(name => name !== '' && !name.startsWith('-'))
      const onBranch = !branch.detached && branch.head !== null
      if (operation !== 'fetch') {
        if (!onBranch) return refused('detached', `There is no current branch to ${operation}. Switch to a branch in a terminal first.`)
        if (branch.oid === null) return refused('failed', `There are no commits on this branch yet, so there is nothing to ${operation}.`)
        // What the person confirmed was a branch at a commit. Another terminal or Copilot may have switched or committed since.
        if (!expected || expected.branch !== branch.head || expected.headOid !== branch.oid) {
          throw new GitStaleError('The branch changed since you last looked. Check it, then try again.')
        }
      }
      const head = branch.head ?? ''
      const upstreamRemote = onBranch ? await read(configGetArgs(`branch.${head}.remote`)) : null
      const upstreamMerge = onBranch ? await read(configGetArgs(`branch.${head}.merge`)) : null

      let remote: string | null
      let remoteBranch = head
      let setUpstream = false
      let upstreamRef: string | null = null
      if (operation === 'fetch') {
        remote = upstreamRemote && remotes.includes(upstreamRemote) ? upstreamRemote
          : remotes.includes('origin') ? 'origin'
          : remotes.length === 1 ? remotes[0] ?? null : null
        if (!remote) return refused('no-remote', remotes.length === 0 ? 'This repository has no remote to fetch from.' : 'This repository has several remotes and none is this branch\'s upstream. Fetch from a terminal.')
      } else if (branch.upstream !== null && upstreamRemote && upstreamMerge?.startsWith('refs/heads/')) {
        remote = remotes.includes(upstreamRemote) ? upstreamRemote : null
        if (!remote) return refused('no-remote', `This branch's upstream is on "${upstreamRemote}", which is not a remote of this repository.`)
        remoteBranch = upstreamMerge.slice('refs/heads/'.length)
        if (operation === 'push' && remoteBranch !== head) {
          return refused('failed', `This branch tracks "${remoteBranch}" on ${remote}, a differently named branch. Push from a terminal, where you can see exactly what goes where.`)
        }
      } else if (operation === 'pull') {
        return refused('no-remote', upstreamRemote === '.' ? 'This branch tracks a local branch, so there is nothing to pull from a remote.' : 'This branch has no upstream to pull from.')
      } else if (publishTo === null) {
        return refused(remotes.length === 0 ? 'no-remote' : 'needs-upstream',
          remotes.length === 0 ? 'This repository has no remote to publish to.' : `The branch "${head}" has not been published yet. Choose where to publish it.`, { remotes })
      } else {
        if (!remotes.includes(publishTo)) throw new Error('That is not a remote of this repository')
        remote = publishTo
        setUpstream = true
      }

      // The address comes from the repository's own config, so it is checked each time, after `insteadOf` rewriting.
      const addresses = await read(remoteUrlArgs(remote, operation === 'push'))
      if (addresses === null || addresses === '') return refused('no-remote', `The remote "${remote}" has no address.`)
      for (const address of addresses.split(/\r?\n/)) {
        const verdict = checkRemoteUrl(address)
        if (!verdict.ok) return refused('no-remote', `The remote "${remote}" ${verdict.reason}, so the panel will not contact it. Use a terminal if you trust it.`)
      }
      if (operation === 'pull') {
        // The remote-tracking branch of the confirmed branch, named now: the merge must not resolve `@{upstream}` for whatever is current later.
        upstreamRef = await read(upstreamRefArgs(head))
        if (!upstreamRef?.startsWith('refs/remotes/')) return refused('no-remote', 'This branch\'s upstream is not a remote-tracking branch, so there is nothing to pull from.')
      }
      if (operation !== 'push') {
        // A fetch writes wherever the repository's refspecs say, so they must say "only my own remote-tracking branches".
        const specs = (await read(fetchRefspecsArgs(remote))) ?? ''
        const scope = checkFetchRefspecs(remote, specs.split(/\r?\n/))
        if (!scope.ok) return refused('no-remote', `The remote "${remote}" ${scope.reason}, so the panel will not fetch it. Fetch from a terminal if you trust it.`)
      }
      if (operation === 'push') {
        const hooks = await inspectHooks(runtime.runner, root, PUSH_HOOKS, signal, this.options.maxHookBytes)
        if (hooks.hooks.length > 0) return refused('hooks-unsupported', 'This repository has a pre-push hook, which the panel does not run, so it will not push around it. Push from a terminal.', { hooks: hooks.hooks })
      }

      // Fail instead of waiting for a host-key or passphrase prompt nobody can answer. `GIT_SSH_COMMAND` outranks `core.sshCommand`, so only when that is unset.
      const sshCommand = await runtime.runner.run({ cwd: root, args: configGetArgs('core.sshcommand'), signal, timeoutMs: 15_000 })
      const environment = { sshBatchMode: sshCommand.exitCode === 1, extra: { GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS } }
      const emit = this.emitter(subscriberId, profileId, repoId, operation)
      const network = (args: string[]): Promise<GitRunResult> =>
        runtime.runner.run({ cwd: root, kind: 'network', disableHooks: true, args, signal, environment, timeoutMs: 120_000, onOutput: emit })

      const syncFailure = async (result: GitRunResult): Promise<GitOperationResult> => {
        const status = await this.statusAfterWrite(project, repo)
        const output = tailOutput(result)
        if (result.cancelled) return this.outcome({ ok: false, reason: 'cancelled', message: 'Cancelled.', output, status })
        if (result.timedOut) return this.outcome({ ok: false, reason: 'failed', message: `${operation} timed out after two minutes. Check the connection and try again.`, output, status })
        if (isIndexLockFailure(result)) return { ...this.failure(result, root, `git ${operation}`), status }
        const failed = describeSyncFailure(result, operation)
        return this.outcome({ ok: false, reason: failed.reason, message: failed.message, output, status })
      }

      if (operation === 'fetch') {
        const result = await network(fetchArgs(remote))
        if (!gitSucceeded(result)) return syncFailure(result)
        const status = await this.statusAfterWrite(project, repo)
        return this.outcome({ ok: true, message: `Fetched ${remote}.`, output: tailOutput(result), status })
      }
      if (operation === 'pull') {
        const fetched = await network(fetchArgs(remote))
        if (!gitSucceeded(fetched)) return syncFailure(fetched)
        const merged = await this.runWithLockWait(runtime, {
          cwd: root, kind: 'write', disableHooks: true, args: fastForwardArgs(upstreamRef ?? ''), signal, timeoutMs: 120_000, onOutput: emit,
        }, async () => {
          await this.requireGate(project, repo, runtime, signal)
          // The fetch may have taken a while, and a merge changes whichever branch is current. Before every attempt it must still be
          // the branch, at the commit, that the person asked to pull into.
          if ((await read(headRefArgs())) !== `refs/heads/${head}` || (await read(['rev-parse', 'HEAD'])) !== branch.oid) {
            throw new GitStaleError('The branch changed while the pull was running. Nothing was merged. Check it, then try again.')
          }
        })
        if (!gitSucceeded(merged)) return syncFailure(merged)
        const status = await this.statusAfterWrite(project, repo)
        const output = tailOutput(merged)
        return this.outcome({ ok: true, message: /already up to date/i.test(output) ? 'Already up to date.' : `Fast-forwarded ${head} to ${branch.upstream ?? remote}.`, output, status })
      }
      // The commit that was confirmed, by id: a commit added to the branch after the click is not sent.
      const pushed = await network(pushArgs(remote, branch.oid ?? '', remoteBranch))
      if (!gitSucceeded(pushed)) return syncFailure(pushed)
      let upstreamNote = ''
      if (setUpstream) {
        // `push --set-upstream` needs a branch name as its source, so the upstream is written by name once the push has succeeded.
        for (const args of upstreamConfigArgs(head, remote, remoteBranch)) {
          const written = await runtime.runner.run({ cwd: root, kind: 'write', disableHooks: true, args, signal, timeoutMs: 15_000 })
          if (!gitSucceeded(written)) { upstreamNote = ' The branch was pushed, but its upstream could not be saved; set it in a terminal.'; break }
        }
      }
      const status = await this.statusAfterWrite(project, repo)
      const output = tailOutput(pushed)
      const message = (/everything up-to-date/i.test(output) ? 'Everything is already up to date.'
        : setUpstream ? `Published ${head} to ${remote} and set it as the upstream.` : `Pushed ${head} to ${remote}/${remoteBranch}.`) + upstreamNote
      return this.outcome({ ok: true, message, output, status })
    })
  }

  // ---- branches -----------------------------------------------------------------------------------------------------

  /** The local branches, newest commit first. A read: it runs no hook and changes nothing. */
  async getBranches(subscriberId: number, profileId: string, repoId: string): Promise<GitBranchView[]> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
    await this.requireGate(project, repo, runtime)
    return this.readBranches(runtime, repo.discovered.root, project.abort.signal)
  }

  private async readBranches(runtime: GitRuntime, root: string, signal: AbortSignal): Promise<GitBranchView[]> {
    const result = await runtime.runner.run({ cwd: root, args: branchListArgs(), signal, timeoutMs: 15_000 })
    if (!gitSucceeded(result)) throw new Error(describeFailure(result, 'git for-each-ref', root))
    return parseBranches(result.stdout.toString('utf8'))
  }

  /** Create a branch at the current commit and switch to it. No file changes, so no confirmation; a branch name is all it needs. */
  createBranch(subscriberId: number, profileId: string, repoId: string, name: string, expected: ExpectedHead): Promise<GitOperationResult> {
    return this.changeBranch('create', subscriberId, profileId, repoId, name, expected)
  }

  /**
   * Switch to another local branch. This rewrites files under any Copilot session working in the project, so it is refused while
   * one is working and otherwise needs the person's confirmation in a native window. Git itself refuses, and changes nothing, when
   * uncommitted changes would be overwritten: the panel never passes `--force` or `--merge`.
   */
  switchBranch(subscriberId: number, profileId: string, repoId: string, name: string, expected: ExpectedHead): Promise<GitOperationResult> {
    return this.changeBranch('switch', subscriberId, profileId, repoId, name, expected)
  }

  private async changeBranch(kind: 'create' | 'switch', subscriberId: number, profileId: string, repoId: string, name: string, expected: ExpectedHead): Promise<GitOperationResult> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
    if (typeof name !== 'string' || name.includes('\0')) throw new Error('Invalid branch name')
    return this.enqueueWrite(repo, async signal => {
      await this.requireGate(project, repo, runtime, signal)
      await this.freshenBeforeWrite(project, repo)
      const root = repo.discovered.root
      const branch = repo.status?.branch
      if (!branch) throw new Error('This repository is not available')
      const refused = (reason: GitOperationResult['reason'], text: string): GitOperationResult =>
        this.outcome({ ok: false, reason, message: text, status: repo.statusView })
      const read = async (args: string[]): Promise<string | null> => {
        const result = await runtime.runner.run({ cwd: root, args, signal, timeoutMs: 15_000 })
        return gitSucceeded(result) ? result.stdout.toString('utf8').trim() : null
      }
      // The person chose this from a branch at a commit. If another tool has moved on, nothing happens.
      const moved = (head: string | null, oid: string | null): boolean => expected.branch !== head || expected.headOid !== oid
      if (branch.oid === null) return refused('failed', 'There are no commits yet. Make the first commit before creating or switching branches.')
      if (moved(branch.head, branch.oid)) throw new GitStaleError('The branch changed since you last looked. Check it, then try again.')

      const verb = kind === 'create' ? 'create' : 'switch'
      if (kind === 'create') {
        const problem = branchNameProblem(name)
        if (problem) return refused('failed', problem)
        if (!gitSucceeded(await runtime.runner.run({ cwd: root, args: refFormatArgs(name), signal, timeoutMs: 15_000 }))) return refused('failed', 'That is not a valid branch name.')
      }
      const branches = await this.readBranches(runtime, root, signal)
      if (kind === 'create' && branches.some(item => item.name === name)) return refused('failed', 'A branch with that name already exists.')
      if (kind === 'switch') {
        const target = branches.find(item => item.name === name)
        if (!target) return refused('failed', `There is no local branch "${name}".`)
        if (target.current) return refused('failed', `You are already on "${name}".`)
        const working = this.options.sessionActivity?.(profileId)
        if (working?.busy) return refused('agent-working', `${working.detail}. Switching branches rewrites files under it. Wait for it to finish, then switch.`)
        if (!this.options.confirm) return refused('failed', 'Switching branches needs a confirmation window, which is not available.')
        const changes = repo.statusView?.totalEntries ?? 0
        const confirmed = await this.options.confirm(profileId, {
          title: `Switch to "${name}"?`,
          detail: `${repo.discovered.relativePath === '.' ? 'This repository' : repo.discovered.relativePath} will move from "${branch.head ?? 'a detached commit'}" to "${name}", and the files in your folder will change to match it.\n\n`
            + (changes > 0 ? `${changes} uncommitted change${changes === 1 ? '' : 's'} stay in your folder. If any of them would be overwritten, Git refuses and nothing is changed.` : 'There are no uncommitted changes.'),
          confirmLabel: 'Switch branch',
        })
        if (!confirmed) return this.outcome({ ok: false, reason: 'cancelled', message: 'Not switched.', status: repo.statusView })
      }

      const emit = this.emitter(subscriberId, profileId, repoId, 'switch')
      let result: GitRunResult
      try {
        result = await this.runWithLockWait(runtime, {
          cwd: root, kind: 'write', disableHooks: true, args: kind === 'create' ? createBranchArgs(name) : switchArgs(name), signal, timeoutMs: 120_000, onOutput: emit,
        }, async () => {
          // A confirmation window can stay open for a long time, and a lock wait for seconds: before every attempt it must still be the
          // branch, at the commit, that was confirmed, and (for a switch) no session may have started working meanwhile.
          await this.requireGate(project, repo, runtime, signal)
          const headRef = await read(headRefArgs())
          const head = headRef === null ? null : headRef.startsWith('refs/heads/') ? headRef.slice('refs/heads/'.length) : headRef
          if (moved(head, await read(['rev-parse', 'HEAD']))) throw new GitStaleError('The branch changed while you were deciding. Nothing was switched. Check it, then try again.')
          const working = kind === 'switch' ? this.options.sessionActivity?.(profileId) : undefined
          if (working?.busy) throw new WriteRefused(refused('agent-working', `${working.detail}. Switching branches rewrites files under it. Wait for it to finish, then switch.`))
        })
      } catch (error) {
        if (error instanceof WriteRefused) return error.result
        throw error
      }
      const status = await this.statusAfterWrite(project, repo)
      if (!gitSucceeded(result)) {
        if (result.cancelled) return this.outcome({ ok: false, reason: 'cancelled', message: 'Cancelled.', output: tailOutput(result), status })
        if (isIndexLockFailure(result)) return { ...this.failure(result, root, `git ${verb}`), status }
        const failed = describeSwitchFailure(result, kind)
        return this.outcome({ ok: false, reason: failed.reason, message: failed.message, output: tailOutput(result), status })
      }
      return this.outcome({ ok: true, message: kind === 'create' ? `Created and switched to ${name}.` : `Switched to ${name}.`, output: tailOutput(result), status })
    })
  }

  // ---- discard ------------------------------------------------------------------------------------------------------

  /** Which entries a discard request means, checked against the exact list the person was looking at. */
  private discardableEntries(repo: RepoRuntime, entryIds: readonly string[], generation: number): GitStatusEntry[] {
    if (repo.generation !== generation) throw new GitStaleError()
    if (entryIds.length === 0 || entryIds.length > 500) throw new Error('Choose between 1 and 500 files')
    const chosen: GitStatusEntry[] = []
    for (const id of new Set(entryIds)) {
      const entry = repo.entries.get(id)
      if (!entry) throw new GitStaleError()
      // Working-tree changes of tracked files, and untracked files and folders. Not conflicts, submodules, or an added-but-empty file.
      const tracked = !entry.submodule && ((entry.kind === 'changed' && ['M', 'T', 'D'].includes(entry.worktree)) || (entry.kind === 'renamed' && ['M', 'T'].includes(entry.worktree)))
      if (tracked || entry.kind === 'untracked') chosen.push(entry)
    }
    if (chosen.length === 0) throw new Error('There is nothing to discard in that selection')
    return chosen
  }

  /**
   * Throw away working-tree changes. Irreversible by nature, so: a copy of each tracked file is saved to a folder the app owns before
   * it is restored; untracked files go to the Recycle Bin, never deleted outright, and a folder that holds a git repository is never
   * touched. The person confirms in a native window that lists the files, and it is refused while a Copilot session is working.
   * Everything is checked before the window opens (so nothing is offered that cannot be done safely) and again after it closes.
   */
  async discard(subscriberId: number, profileId: string, repoId: string, entryIds: readonly string[], generation: number): Promise<GitOperationResult> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
    return this.enqueueWrite(repo, async signal => {
      await this.requireGate(project, repo, runtime, signal)
      await this.freshenBeforeWrite(project, repo)
      const entries = this.discardableEntries(repo, entryIds, generation)
      const root = repo.discovered.root
      const refused = (reason: GitOperationResult['reason'], text: string): GitOperationResult => this.outcome({ ok: false, reason, message: text, status: repo.statusView })
      const tracked = entries.filter(entry => entry.kind !== 'untracked').map(entry => entry.path)
      const untracked = entries.filter(entry => entry.kind === 'untracked').map(entry => entry.path)
      const limits = {
        ...(this.options.maxSnapshotFileBytes !== undefined ? { maxFileBytes: this.options.maxSnapshotFileBytes } : {}),
        ...(this.options.maxSnapshotTotalBytes !== undefined ? { maxTotalBytes: this.options.maxSnapshotTotalBytes } : {}),
      }

      // Everything the discard needs, checked now and again once the person has answered.
      const prepare = async (): Promise<{ problems: string[]; trash: string[] }> => {
        const problems = await checkSnapshotable(root, tracked, limits)
        const trash: string[] = []
        for (const path of untracked) {
          const verdict = await checkTrashable(root, path)
          if (verdict.ok) trash.push(verdict.absolute); else problems.push(verdict.reason)
        }
        return { problems, trash }
      }
      const blocked = (problems: string[]): GitOperationResult =>
        refused('failed', `${problems.slice(0, 3).join('. ')}${problems.length > 3 ? ` (and ${problems.length - 3} more problems)` : ''}. Nothing was discarded.`)
      const working = (): GitOperationResult | null => {
        const activity = this.options.sessionActivity?.(profileId)
        return activity?.busy ? refused('agent-working', `${activity.detail}. Discarding changes files under it. Wait for it to finish, then discard.`) : null
      }

      if (!this.options.confirm) return refused('failed', 'Discarding needs a confirmation window, which is not available.')
      if (tracked.length > 0 && !this.options.snapshotDirectory) return refused('failed', 'Discarding tracked changes saves a copy first, and there is no place to keep it.')
      if (untracked.length > 0 && !this.options.trash) return refused('failed', 'Discarding untracked files moves them to the Recycle Bin, which is not available.')
      const busy = working()
      if (busy) return busy
      const first = await prepare()
      if (first.problems.length > 0) return blocked(first.problems)

      const shown = [...tracked.map(path => `  ${path}`), ...untracked.map(path => `  ${path}  (untracked)`)]
      const confirmed = await this.options.confirm(profileId, {
        title: `Discard ${entries.length} change${entries.length === 1 ? '' : 's'}?`,
        detail: `${shown.slice(0, 12).join('\n')}${shown.length > 12 ? `\n  …and ${shown.length - 12} more` : ''}\n\n`
          + (tracked.length > 0 ? `Tracked files go back to their last committed or staged version. A copy of what is on disk now is saved first.\n` : '')
          + (untracked.length > 0 ? `Untracked items are moved to the Recycle Bin.` : ''),
        confirmLabel: 'Discard', danger: true,
      })
      if (!confirmed) return this.outcome({ ok: false, reason: 'cancelled', message: 'Nothing was discarded.', status: repo.statusView })

      // The window may have been open for a while: the list, the session and the files can all have moved.
      await this.requireGate(project, repo, runtime, signal)
      await this.freshenBeforeWrite(project, repo)
      if (repo.generation !== generation) throw new GitStaleError('The file list changed while you were deciding. Nothing was discarded. Check it, then try again.')
      const later = working()
      if (later) return later
      const second = await prepare()
      if (second.problems.length > 0) return blocked(second.problems)

      let note = ''
      if (tracked.length > 0) {
        // Restoring can wait for `index.lock` for seconds, so nothing decided earlier is trusted at the moment of an attempt. Before
        // every attempt: the trust gate, the session, and the paths (a link may have appeared) are checked again, and the saved copy
        // is of the files as they are now. A copy made for an earlier attempt is reused only if the files still look the same,
        // otherwise a new one is made, so work added during the wait is in a copy and never overwritten by an older one.
        let kept: Snapshot | null = null
        let result: GitRunResult
        try {
          result = await this.runWithLockWait(runtime, {
            cwd: root, kind: 'write', disableHooks: true, args: restoreArgs(), stdin: `${tracked.join('\0')}\0`, signal, timeoutMs: 120_000,
            onOutput: this.emitter(subscriberId, profileId, repoId, 'discard'),
          }, async () => {
            await this.requireGate(project, repo, runtime, signal)
            const stillBusy = working()
            if (stillBusy) throw new WriteRefused(stillBusy)
            const problems = await checkSnapshotable(root, tracked, limits)
            if (problems.length > 0) throw new WriteRefused(blocked(problems))
            const stamps = await stampFiles(root, tracked)
            const current = kept as Snapshot | null
            if (current === null || tracked.some(path => current.stamps.get(path) !== stamps.get(path))) {
              try {
                kept = await saveSnapshot(this.options.snapshotDirectory ?? '', root, tracked, this.options.now?.() ?? new Date(), limits)
              } catch (error) {
                if (error instanceof DiscardRefused) throw new WriteRefused(refused('failed', error.message))
                throw error
              }
            }
          })
        } catch (error) {
          if (error instanceof WriteRefused) return error.result
          throw error
        }
        await pruneSnapshots(this.options.snapshotDirectory ?? '')
        const snapshot = kept as Snapshot | null
        if (!gitSucceeded(result)) {
          const status = await this.statusAfterWrite(project, repo)
          const failed = this.failure(result, root, 'git restore')
          return { ...failed, message: `${failed.message}${snapshot ? ` A copy of the files is in ${snapshot.directory}.` : ''}`, status }
        }
        if (snapshot && snapshot.files > 0) note = snapshot.files === 1 ? ` A copy of the changed file is saved in ${snapshot.directory}.` : ` Copies of the ${snapshot.files} changed files are saved in ${snapshot.directory}.`
      }
      // Each untracked item is checked once more right before it is moved: the restore above may have waited, and a folder can have
      // been replaced by a link, or a session may have started, since the checks before the window.
      const problems: string[] = []
      let moved = 0
      for (const path of untracked) {
        const busyNow = working()
        if (busyNow) { problems.push(`${busyNow.message.split('.')[0]}`); break }
        const verdict = await checkTrashable(root, path)
        if (!verdict.ok) { problems.push(verdict.reason); continue }
        try { await this.options.trash?.(verdict.absolute); moved++ } catch (error) { problems.push(`${path}: ${redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`) }
      }
      const status = await this.statusAfterWrite(project, repo)
      if (problems.length > 0) {
        return this.outcome({ ok: false, reason: 'failed', message: `${untracked.length - moved} of ${untracked.length} untracked item${untracked.length === 1 ? '' : 's'} ${untracked.length - moved === 1 ? 'was' : 'were'} not moved to the Recycle Bin: ${problems[0]}.${note}`, status })
      }
      return this.outcome({ ok: true, message: `Discarded ${entries.length} change${entries.length === 1 ? '' : 's'}.${note}`, status })
    })
  }

  /** Which entries a stage or unstage request means, checked against the exact list the person was looking at. */
  private writableEntries(repo: RepoRuntime, entryIds: readonly string[], generation: number, operation: 'stage' | 'unstage'): GitStatusEntry[] {
    if (repo.generation !== generation) throw new GitStaleError()
    if (entryIds.length === 0 || entryIds.length > 5_000) throw new Error('Choose between 1 and 5,000 files')
    const chosen: GitStatusEntry[] = []
    for (const id of new Set(entryIds)) {
      const entry = repo.entries.get(id)
      if (!entry) throw new GitStaleError()
      const eligible = operation === 'stage'
        ? entry.kind === 'untracked' || entry.kind === 'unmerged' || ((entry.kind === 'changed' || entry.kind === 'renamed') && entry.worktree !== '.')
        : (entry.kind === 'changed' || entry.kind === 'renamed') && entry.index !== '.'
      if (eligible) chosen.push(entry)
    }
    if (chosen.length === 0) throw new Error(`There is nothing to ${operation} in that selection`)
    return chosen
  }

  stage(subscriberId: number, profileId: string, repoId: string, entryIds: readonly string[], generation: number): Promise<GitOperationResult> {
    return this.changeIndex('stage', subscriberId, profileId, repoId, entryIds, generation)
  }

  unstage(subscriberId: number, profileId: string, repoId: string, entryIds: readonly string[], generation: number): Promise<GitOperationResult> {
    return this.changeIndex('unstage', subscriberId, profileId, repoId, entryIds, generation)
  }

  private async changeIndex(operation: 'stage' | 'unstage', subscriberId: number, profileId: string, repoId: string, entryIds: readonly string[], generation: number): Promise<GitOperationResult> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
    return this.enqueueWrite(repo, async signal => {
      // Everything is checked again now that this write has its turn: the list or the settings may have changed while it waited.
      await this.requireGate(project, repo, runtime, signal)
      await this.freshenBeforeWrite(project, repo)
      const entries = this.writableEntries(repo, entryIds, generation, operation)
      const paths = [...new Set(entries.flatMap(entry => operation === 'unstage' && entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]))]
      const root = repo.discovered.root
      const result = await this.runWithLockWait(runtime, {
        cwd: root, kind: 'write', disableHooks: true, signal, timeoutMs: 120_000,
        args: operation === 'stage' ? stageArgs() : unstageArgs(repo.status?.branch.oid != null),
        stdin: `${paths.join('\0')}\0`,
        onOutput: this.emitter(subscriberId, profileId, repoId, operation),
      })
      const status = await this.statusAfterWrite(project, repo)
      if (!gitSucceeded(result)) return { ...this.failure(result, root, `git ${operation === 'stage' ? 'add' : 'restore'}`), status }
      const count = entries.length
      return this.outcome({ ok: true, message: `${operation === 'stage' ? 'Staged' : 'Unstaged'} ${count} file${count === 1 ? '' : 's'}.`, status })
    })
  }

  /**
   * Commit what is staged. Refused, with a result that says why, when git does not know who the author is, when a hook
   * the person has not approved would run, or when conflicts are unresolved. The message goes in on stdin, hooks run only
   * after approval, and the exit code decides success.
   */
  async commit(subscriberId: number, profileId: string, repoId: string, message: string, generation: number, approvedHooksHash: string | null): Promise<GitOperationResult> {
    if (typeof message !== 'string' || message.trim() === '') throw new Error('Write a commit message first')
    if (message.length > 100_000 || message.includes('\0')) throw new Error('That commit message is not valid')
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
    return this.enqueueWrite(repo, async signal => {
      await this.requireGate(project, repo, runtime, signal)
      // The cached list may be older than the index (another terminal, an editor, Copilot): read it again before comparing.
      await this.freshenBeforeWrite(project, repo)
      if (repo.generation !== generation) throw new GitStaleError('The staged files changed since you last looked. Review them and commit again.')
      const root = repo.discovered.root
      const stagedNow = async (): Promise<string> => {
        const raw = await runtime.runner.run({ cwd: root, args: stagedRawArgs(), signal })
        if (!gitSucceeded(raw)) throw new Error('Could not read what is staged')
        return raw.stdout.toString('utf8')
      }
      const staged = await stagedNow()
      const refused = (reason: GitOperationResult['reason'], text: string, extra: Partial<GitOperationResult> = {}): GitOperationResult =>
        this.outcome({ ok: false, reason, message: text, status: repo.statusView, ...extra })
      const status = repo.status
      if (!status || status.entries.some(entry => entry.kind === 'unmerged')) return refused('conflicts', 'Resolve the conflicts and stage the result before committing.')

      // The status view leaves submodules out (reading them would run git inside another repository), so a staged submodule
      // update is in the index but not in the list. A commit must not include what the person was never shown.
      const shown = new Set(status.entries.flatMap(entry => entry.index === '.' ? [] : [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])]))
      const unseen = parseStagedRaw(staged).filter(entry => !shown.has(entry.path))
      if (unseen.length > 0) {
        const named = unseen.slice(0, 5).map(entry => entry.path).join(', ') + (unseen.length > 5 ? ` and ${unseen.length - 5} more` : '')
        const kind = unseen.every(entry => entry.oldMode === '160000' || entry.newMode === '160000') ? 'Staged submodule changes' : 'Staged changes'
        return refused('hidden-staged', `${kind} that this panel does not list would be included in the commit: ${named}. Unstage them, or commit from a terminal.`)
      }

      if (!status.entries.some(entry => (entry.kind === 'changed' || entry.kind === 'renamed') && entry.index !== '.')) return refused('nothing-staged', 'There is nothing staged to commit.')

      for (const key of ['user.name', 'user.email']) {
        const configured = await runtime.runner.run({ cwd: root, args: configGetArgs(key), signal })
        if (!gitSucceeded(configured) || configured.stdout.toString('utf8').trim() === '') {
          return refused('identity-missing', 'Git does not know who you are. In a terminal, run: git config --global user.name "Your Name" and git config --global user.email "you@example.com", then commit again.')
        }
      }

      /** Whether the hooks a commit would run now are ones the person has approved. Null means yes; otherwise the refusal. */
      const hooksProblem = async (found: HooksInventory, approvedHash: string | null): Promise<GitOperationResult | null> => {
        if (found.unverifiable.length > 0) {
          const named = found.unverifiable.map(hook => `${hook.name} (${hook.reason})`).join('; ')
          return refused('hooks-unverifiable', `This repository has a hook that cannot be checked, so it cannot be approved: ${named}. Commit from a terminal if you trust it.`, { hooks: found.hooks })
        }
        if (found.hooks.length === 0 || await this.options.trustStore.areHooksApproved(root, found.hash)) return null
        if (approvedHash !== found.hash) {
          return refused('hooks-need-approval', `This repository has hooks that a commit would run: ${found.hooks.join(', ')}.`, { hooks: found.hooks, hooksHash: found.hash })
        }
        await this.options.trustStore.approveHooks(root, found.hash)
        return null
      }
      const inventory = await inspectCommitHooks(runtime.runner, root, signal, this.options.maxHookBytes)
      const unapproved = await hooksProblem(inventory, approvedHooksHash)
      if (unapproved) return unapproved

      let result: GitRunResult
      try {
        result = await this.runWithLockWait(runtime, {
          cwd: root, kind: 'write', args: commitArgs(), stdin: message, signal, timeoutMs: 600_000,
          onOutput: this.emitter(subscriberId, profileId, repoId, 'commit'),
        }, async () => {
          // Everything above was checked once, and waiting for a lock can take seconds. Before every attempt, the commit must
          // still be the one that was reviewed: the same staged contents, the same trusted settings and pointers, and hooks
          // that are still approved. Anything else ends the commit, or asks again, instead of running what changed meanwhile.
          await this.requireGate(project, repo, runtime, signal)
          const refusal = await hooksProblem(await inspectCommitHooks(runtime.runner, root, signal, this.options.maxHookBytes), null)
          if (refusal) throw new WriteRefused(refusal)
          // Last, because it is the check that must stay closest to the attempt: the slower checks above must not leave a gap
          // in which something else gets staged.
          if (await stagedNow() !== staged) throw new GitStaleError('The staged files changed while the commit was waiting. Review them and commit again.')
        })
      } catch (error) {
        if (error instanceof WriteRefused) return error.result
        throw error
      }
      const fresh = await this.statusAfterWrite(project, repo)
      if (!gitSucceeded(result)) return { ...this.failure(result, root, 'git commit'), status: fresh }
      const latest = await runtime.runner.run({ cwd: root, args: logArgs({ limit: 1 }), signal: new AbortController().signal }).then(run => gitSucceeded(run) ? parseLog(run.stdout.toString('utf8'))[0] : undefined, () => undefined)
      return this.outcome({
        ok: true, message: latest ? `Committed ${latest.hash.slice(0, 7)}: ${latest.subject}` : 'Committed.', output: tailOutput(result),
        commit: latest ? { hash: latest.hash, subject: latest.subject } : null, status: fresh,
      })
    })
  }

  // ---- shutdown -----------------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.writeControllers) controller.abort()
    const pending: Promise<void>[] = []
    for (const project of [...this.projects.values()]) {
      if (project.refreshing) pending.push(project.refreshing.catch(() => undefined))
      this.stopProject(project)
    }
    this.subscriptions.clear()
    this.opening.clear()
    await Promise.allSettled(pending)
  }
}
