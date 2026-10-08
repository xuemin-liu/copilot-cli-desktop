import { redactDiagnosticText } from './desktop-diagnostics.js'
import { diffArgs, logArgs, statusArgs } from './git-commands.js'
import { discoverRepos } from './git-discovery.js'
import type { DiscoveredRepo } from './git-discovery.js'
import { boundText, groupStatusEntries, parseLog, parseNumstat, parseStatusV2 } from './git-parse.js'
import type { GitStatus, GitStatusEntry } from './git-parse.js'
import { gitSucceeded } from './git-runner.js'
import type { GitExecutable, GitRunResult, GitRunner } from './git-runner.js'
import { GitTrustStore, repoTrustKey, scanRepoConfig } from './git-trust.js'
import type { RepoConfigScan } from './git-trust.js'
import { readUntrackedFile } from './git-untracked.js'
import type {
  GitDiffView, GitEntryView, GitLogEntry, GitProjectView, GitRepoState, GitRepoStatusView, GitRepoSummary,
} from './git-types.js'
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
    let canonical: string
    try { canonical = await realPathNative(folder) } catch { throw new Error('The workspace folder is not available') }
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
    if (this.projects.get(key) === project) this.arm(project)
    return this.viewOf(project)
  }

  unsubscribe(subscriberId: number, profileId: string): void {
    this.release(subscriberId, profileId)
  }

  /** Called when a renderer reloads, crashes or closes: nothing it started may keep running. */
  unsubscribeAll(subscriberId: number): void {
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
      })
    }
    for (const key of [...project.repos.keys()]) if (!seen.has(key)) project.repos.delete(key)
  }

  private async refreshRepo(project: ProjectRuntime, repo: RepoRuntime, runtime: GitRuntime, signal: AbortSignal): Promise<void> {
    const root = repo.discovered.root
    const fail = (message: string): void => { repo.state = 'error'; repo.error = message; repo.status = null; repo.statusView = null; repo.entries = new Map(); repo.scan = null }
    if (repo.discovered.issue) return fail(repo.discovered.issue)
    if (!runtime.executable.supported) return fail(`${runtime.executable.version.text} is older than the supported minimum (2.30)`)
    try {
      const scan = await scanRepoConfig(runtime.runner, root, signal)
      if (signal.aborted) return
      repo.scan = scan
      if (scan.items.length > 0 && !(await this.options.trustStore.isTrusted(root, scan.hash))) {
        repo.state = 'needs-review'
        repo.error = null
        repo.status = null
        repo.statusView = null
        repo.entries = new Map()
        return
      }
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

  async getLog(subscriberId: number, profileId: string, repoId: string, limit: number, skip: number): Promise<GitLogEntry[]> {
    const project = this.projectFor(subscriberId, profileId)
    const repo = this.repoFor(project, repoId)
    const runtime = await this.getRuntime()
    if (!runtime || repo.state !== 'ready') throw new Error('This repository is not available')
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
    await this.options.trustStore.trust(repo.discovered.root, configHash)
    await this.refreshProject(project, true)
    return this.viewOf(project)
  }

  // ---- shutdown -----------------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.disposed = true
    const pending: Promise<void>[] = []
    for (const project of [...this.projects.values()]) {
      if (project.refreshing) pending.push(project.refreshing.catch(() => undefined))
      this.stopProject(project)
    }
    this.subscriptions.clear()
    await Promise.allSettled(pending)
  }
}
