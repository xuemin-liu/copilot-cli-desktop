import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { caseInsensitivePaths, hostPath, pathKey } from './host-path.js'
import { writeFileAtomic } from './atomic-file.js'
import { commitDiffTreeArgs } from './git-commands.js'
import { boundText, parseNumstat, splitNul } from './git-parse.js'
import { gitSucceeded, type GitRunResult, type GitRunner } from './git-runner.js'
import { safeRepoSegments } from './git-untracked.js'

/**
 * Turn checkpoints: snapshots of a session's working folder, kept in a Git directory this app owns.
 *
 * Nothing is ever written to the person's repository. Each worktree gets a "shadow" Git directory under the app's data
 * folder, run with `GIT_DIR` (the shadow) and `GIT_WORK_TREE` (the worktree). The shadow has its own config and an
 * `info/attributes` line that switches every conversion off, so no filter program runs and a snapshot holds the bytes
 * that are on disk. The project's own Git decides which paths are eligible (tracked, or untracked and not ignored) on
 * every capture; the shadow stages exactly that list.
 *
 * Listing the eligible paths runs Git in the project, so `capture` asks the caller's trust gate right before it does.
 */

export interface CheckpointLimits {
  /** A file larger than this is left out of the snapshot. */
  maxFileBytes: number
  /** The eligible files together; over this there is no checkpoint. */
  maxTreeBytes: number
  /** Eligible paths; over this there is no checkpoint. */
  maxPaths: number
  /** A whole capture, from listing to commit. */
  captureTimeoutMs: number
  /** Turns kept for one session. */
  maxTurnsPerSession: number
  /** Turns kept for one worktree, over all its sessions. */
  maxTurnsPerStore: number
  /** Turns older than this are pruned. */
  maxAgeMs: number
  /** The shadow directory's size on disk after reclaiming space; over this its oldest turns go. */
  maxStoreBytes: number
}

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxTreeBytes: 500 * 1024 * 1024,
  maxPaths: 60_000,
  captureTimeoutMs: 120_000,
  maxTurnsPerSession: 50,
  maxTurnsPerStore: 200,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxStoreBytes: 1024 * 1024 * 1024,
}

export type CheckpointPhase = 'before' | 'after'

/** One snapshot of a turn: a commit in the shadow, or the reason there is none. */
export interface CheckpointCapture {
  commit: string | null
  reason: string | null
  /** Eligible paths left out (links, oversized files, submodules, embedded repositories). */
  notCaptured: number
  /** Up to twenty of them, for display. */
  notCapturedSample: string[]
  /**
   * All of them, up to a few thousand. A path left out of one snapshot of a turn and present in the other would look
   * added or deleted in the turn's diff, so the diff needs to know them. Absent in snapshots taken before this was kept.
   */
  notCapturedPaths?: string[]
  at: number
}

export type TurnState = 'open' | 'complete' | 'incomplete'

export interface CheckpointTurn {
  n: number
  /** The first line of the prompt. Kept here, in the app's data, and never in a Git object. */
  label: string
  startedAt: number
  endedAt: number | null
  state: TurnState
  /** Why the turn is incomplete. */
  note: string | null
  before: CheckpointCapture | null
  after: CheckpointCapture | null
}

interface StoreMeta {
  version: 1
  worktree: string
  lastTree: string | null
  lastCommit: string | null
  /** Turns dropped since space was last reclaimed, and turns ended since then. */
  unreclaimed?: number
  turnsSinceReclaim?: number
  sessions: Record<string, { turns: CheckpointTurn[] }>
}

/** A turn as the Git panel lists it. */
export interface TurnSummary {
  sessionId: string
  n: number
  label: string
  startedAt: number
  endedAt: number | null
  state: TurnState
  /** Why an incomplete turn has no diff. */
  note: string | null
  /** Both snapshots exist, so the turn's changes can be shown. */
  diffable: boolean
  /** Both snapshots are the same: nothing changed during the turn. */
  unchanged: boolean
  notCaptured: number
  notCapturedSample: string[]
}

export interface TurnFiles {
  /** `leftOut`: the path was left out of one of the two snapshots, so whether it changed is not known. */
  files: Array<{ path: string; added: number | null; deleted: number | null; binary: boolean; leftOut: boolean }>
  truncated: boolean
  /** Some left-out paths are not on record, so a file shown as added or deleted may have been left out instead. */
  uncertain: boolean
}

export interface CheckpointStoreOptions {
  /** `<userData>/checkpoints`. Everything this class writes is inside it. */
  root: string
  runner: GitRunner
  limits?: Partial<CheckpointLimits>
  now?: () => number
}

export interface EligiblePaths {
  paths: string[]
  totalBytes: number
  notCaptured: string[]
}

export interface PruneOptions {
  /** Whether Copilot still stores this session. A session it no longer has loses its checkpoints. */
  sessionExists(sessionId: string): boolean | Promise<boolean>
}

export interface PruneReport { stores: number; deletedStores: number; removedTurns: number; bytesBefore: number; bytesAfter: number }

const STORE_NAME = /^[0-9a-f]{24}$/
const SHADOW_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n'
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Copilot CLI Desktop', GIT_AUTHOR_EMAIL: 'checkpoints@localhost',
  GIT_COMMITTER_NAME: 'Copilot CLI Desktop', GIT_COMMITTER_EMAIL: 'checkpoints@localhost',
}
const LIST_MAX_BYTES = 64 * 1024 * 1024
const OID = /^[0-9a-f]{40,64}$/
const MAX_LABEL_CHARS = 120
const SAMPLE = 20
const MAX_LISTED_TURNS = 200
const MAX_TURN_FILES = 5_000
const MAX_TURN_DIFF_BYTES = 512 * 1024
const MAX_TURN_FILES_BYTES = 4 * 1024 * 1024
const MAX_RECORDED_NOT_CAPTURED = 5_000
const UNAVAILABLE = 'This checkpoint is no longer available'

/** Which paths of a turn's diff cannot be compared, because one of its snapshots left them out. */
function leftOutOf(record: CheckpointTurn): { has(path: string): boolean; complete: boolean } {
  const captures = [record.before, record.after].filter((capture): capture is CheckpointCapture => capture !== null)
  const exact = new Set<string>()
  const folders: string[] = []
  for (const capture of captures) for (const path of capture.notCapturedPaths ?? capture.notCapturedSample) {
    // An embedded repository is recorded as its folder, with a trailing slash; a POSIX symlink replacing a folder is
    // recorded without a slash, and files behind it from the other snapshot are left out too.
    if (path.endsWith('/')) folders.push(path)
    else { exact.add(path); folders.push(`${path}/`) }
  }
  return {
    has: path => exact.has(path) || folders.some(folder => path.startsWith(folder)),
    complete: captures.every(capture => (capture.notCapturedPaths ?? capture.notCapturedSample).length >= capture.notCaptured),
  }
}
/** Space is reclaimed while the app runs once this many turns were dropped, or this many ended, since the last time. */
const RECLAIM_AFTER_DROPPED_TURNS = 10
const RECLAIM_AFTER_TURNS = 10

export class CheckpointRefused extends Error {
  constructor(message: string) { super(message); this.name = 'CheckpointRefused' }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The store folder's name for a worktree: stable for the folder, and nothing of its path can be read from it. */
export function storeNameFor(worktreeRoot: string): string { return sha(pathKey(worktreeRoot)).slice(0, 24) }

/** A session's ref folder. Session ids come from Copilot's files, so only their hash goes into a ref name. */
export function sessionRefKey(sessionId: string): string { return `s-${sha(sessionId).slice(0, 24)}` }

export function checkpointRef(sessionId: string, turn: number, phase: CheckpointPhase): string {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('A turn number must be a positive integer')
  return `refs/checkpoints/${sessionRefKey(sessionId)}/${turn}-${phase}`
}

export function turnLabel(prompt: string): string {
  const line = prompt.replace(/\r\n?/g, '\n').split('\n').find(candidate => candidate.trim()) ?? ''
  return line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL_CHARS)
}

function describe(result: GitRunResult, what: string): string {
  if (result.timedOut) return `${what} took too long`
  if (result.cancelled) return `${what} was stopped`
  if (result.stdoutTruncated) return `${what} produced too much output`
  return `${what} failed${result.stderr.trim() ? `: ${result.stderr.trim().split(/\r?\n/, 1)[0]!.slice(0, 200)}` : ''}`
}

export class CheckpointStore {
  readonly limits: CheckpointLimits
  private readonly root: string
  private readonly runner: GitRunner
  private readonly now: () => number
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(options: CheckpointStoreOptions) {
    if (!hostPath.isAbsolute(options.root)) throw new Error('The checkpoint folder must be absolute')
    this.root = hostPath.resolve(options.root)
    this.runner = options.runner
    this.limits = { ...DEFAULT_CHECKPOINT_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
  }

  storeDirectory(worktreeRoot: string): string { return hostPath.join(this.root, storeNameFor(worktreeRoot)) }
  private gitDirectory(store: string): string { return hostPath.join(store, 'git') }
  private emptyConfig(): string { return hostPath.join(this.root, 'gitconfig-empty') }

  /** One thing at a time for a worktree: a capture, a read and a prune never overlap. */
  private queued<T>(store: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(store) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.then(() => undefined, () => undefined)
    this.queues.set(store, settled)
    void settled.then(() => { if (this.queues.get(store) === settled) this.queues.delete(store) })
    return next
  }

  /** The environment of every command that runs in the shadow: its own Git directory and no outside config. */
  private shadowEnvironment(store: string, worktreeRoot: string | null): Record<string, string> {
    return {
      GIT_DIR: this.gitDirectory(store),
      ...(worktreeRoot ? { GIT_WORK_TREE: worktreeRoot } : {}),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.emptyConfig(), GIT_ATTR_NOSYSTEM: '1',
      ...IDENTITY,
    }
  }

  private shadow(store: string, worktreeRoot: string | null, args: readonly string[], options: { stdin?: string; signal?: AbortSignal | undefined; timeoutMs?: number; write?: boolean; maxStdoutBytes?: number } = {}): Promise<GitRunResult> {
    return this.runner.run({
      cwd: worktreeRoot ?? hostPath.join(store, 'empty'), args, kind: options.write === false ? 'read' : 'write', disableHooks: true,
      stdin: options.stdin, signal: options.signal, timeoutMs: options.timeoutMs ?? 60_000, maxStdoutBytes: options.maxStdoutBytes ?? LIST_MAX_BYTES,
      environment: { extra: this.shadowEnvironment(store, worktreeRoot) },
    })
  }

  private async ensureShadow(store: string, signal?: AbortSignal): Promise<void> {
    const git = this.gitDirectory(store)
    await mkdir(hostPath.join(store, 'empty'), { recursive: true })
    await writeFile(this.emptyConfig(), '')
    const fresh = !(await stat(hostPath.join(git, 'HEAD')).then(entry => entry.isFile(), () => false))
    if (fresh) {
      await mkdir(git, { recursive: true })
      const init = await this.shadow(store, null, ['init', '-q'], { signal })
      if (!gitSucceeded(init)) throw new CheckpointRefused(describe(init, 'Creating the checkpoint store'))
    }
    // Written every time: these lines are what keeps a snapshot to the bytes on disk, so they are never taken on trust.
    const core = ['repositoryformatversion = 0', 'bare = false', 'filemode = false', 'symlinks = false', 'autocrlf = false', 'safecrlf = false',
      'longpaths = true', 'logallrefupdates = false', ...(caseInsensitivePaths ? ['ignorecase = true'] : [])]
    const config = `[core]\n${core.map(line => `\t${line}\n`).join('')}[gc]\n\tauto = 0\n`
    await writeFile(hostPath.join(git, 'config'), config)
    await mkdir(hostPath.join(git, 'info'), { recursive: true })
    await writeFile(hostPath.join(git, 'info', 'attributes'), SHADOW_ATTRIBUTES)
    await writeFile(hostPath.join(git, 'info', 'exclude'), '')
  }

  private async readMeta(store: string, worktreeRoot: string | null): Promise<StoreMeta> {
    const empty = (): StoreMeta => ({ version: 1, worktree: worktreeRoot ?? '', lastTree: null, lastCommit: null, sessions: {} })
    try {
      const value = JSON.parse(await readFile(hostPath.join(store, 'meta.json'), 'utf8')) as StoreMeta
      if (!value || value.version !== 1 || typeof value.worktree !== 'string' || !value.sessions || typeof value.sessions !== 'object') return empty()
      for (const session of Object.values(value.sessions)) if (!session || !Array.isArray(session.turns)) return empty()
      return value
    } catch { return empty() }
  }

  private writeMeta(store: string, meta: StoreMeta): Promise<void> {
    return writeFileAtomic(hostPath.join(store, 'meta.json'), JSON.stringify(meta))
  }

  /**
   * The paths a snapshot holds, decided by the project's own Git: tracked files, and untracked files it does not ignore.
   * Each is checked on disk. Links, anything behind a linked folder, oversized files, submodules and embedded
   * repositories are left out and reported. Throws `CheckpointRefused` when there can be no checkpoint at all.
   */
  async eligiblePaths(worktreeRoot: string, signal?: AbortSignal): Promise<EligiblePaths> {
    const project = (args: string[]): Promise<GitRunResult> => this.runner.run({ cwd: worktreeRoot, args, signal, timeoutMs: 30_000, maxStdoutBytes: LIST_MAX_BYTES })
    // The value Git itself would use: the last one over every config file, with a bare key read as true.
    for (const key of ['core.sparseCheckout', 'index.sparse']) {
      const value = await project(['config', '--type=bool', '--get', key])
      if (value.exitCode === 0 && value.stdout.toString('utf8').trim() === 'true') throw new CheckpointRefused('This repository uses a sparse checkout')
      // 1 means the key is not set.
      if (value.exitCode !== 0 && value.exitCode !== 1) throw new CheckpointRefused(describe(value, 'Reading the repository settings'))
    }
    const tracked = await project(['ls-files', '-z', '-s'])
    if (!gitSucceeded(tracked)) throw new CheckpointRefused(describe(tracked, 'Listing tracked files'))
    const others = await project(['ls-files', '-z', '-o', '--exclude-standard'])
    if (!gitSucceeded(others)) throw new CheckpointRefused(describe(others, 'Listing untracked files'))

    const notCaptured: string[] = []
    const candidates = new Set<string>()
    for (const record of splitNul(tracked.stdout.toString('utf8'))) {
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const path = record.slice(tab + 1)
      const mode = record.slice(0, 6)
      if (mode === '160000') { notCaptured.push(path); continue }
      candidates.add(path)
    }
    for (const path of splitNul(others.stdout.toString('utf8'))) {
      // Git names an embedded repository as a folder, with a trailing slash; it is not walked.
      if (path.endsWith('/')) { notCaptured.push(path); continue }
      candidates.add(path)
    }
    if (candidates.size > this.limits.maxPaths) throw new CheckpointRefused(`This folder has more than ${this.limits.maxPaths.toLocaleString('en-US')} files to snapshot`)

    // A folder that is a link or a junction: Git would walk through it and read files outside the repository. A
    // folder that is simply gone is another matter: what was in it was deleted, and is absent from the snapshot.
    type FolderState = 'plain' | 'gone' | 'unsafe'
    const folders = new Map<string, Promise<FolderState>>()
    const folderState = (relative: string): Promise<FolderState> => {
      if (relative === '') return Promise.resolve('plain')
      let known = folders.get(relative)
      if (!known) {
        const above = folderState(relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '')
        known = above.then(async (parent): Promise<FolderState> => parent !== 'plain' ? parent : lstat(hostPath.join(worktreeRoot, ...relative.split('/'))).then(
          (entry): FolderState => entry.isDirectory() && !entry.isSymbolicLink() ? 'plain' : 'unsafe',
          // Only a confirmed absence counts as gone; a folder that cannot be read is not walked.
          (error: NodeJS.ErrnoException): FolderState => error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'gone' : 'unsafe'))
        folders.set(relative, known)
      }
      return known
    }
    const paths: string[] = []
    let totalBytes = 0
    const list = [...candidates]
    for (let start = 0; start < list.length; start += 64) {
      if (signal?.aborted) throw new CheckpointRefused('The snapshot was stopped')
      await Promise.all(list.slice(start, start + 64).map(async path => {
        const segments = safeRepoSegments(path)
        if (!segments || segments.some(segment => segment.toLowerCase() === '.git')) { notCaptured.push(path); return }
        const folder = await folderState(segments.slice(0, -1).join('/'))
        // Its folder was deleted with it: absent from the snapshot, like any deleted file.
        if (folder === 'gone') return
        if (folder === 'unsafe') { notCaptured.push(path); return }
        const entry = await lstat(hostPath.join(worktreeRoot, ...segments)).then(found => found, (error: NodeJS.ErrnoException) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : 'unreadable' as const)
        // Gone from disk: a deleted file is simply absent from the snapshot.
        if (!entry) return
        if (entry === 'unreadable') { notCaptured.push(path); return }
        if (!entry.isFile() || entry.size > this.limits.maxFileBytes) { notCaptured.push(path); return }
        totalBytes += entry.size
        paths.push(path)
      }))
    }
    if (totalBytes > this.limits.maxTreeBytes) throw new CheckpointRefused('The files to snapshot are larger than the checkpoint limit')
    paths.sort()
    notCaptured.sort()
    return { paths, totalBytes, notCaptured }
  }

  /** Make the shadow's index hold exactly `paths` as they are on disk, and return the tree. */
  private async stage(store: string, worktreeRoot: string, paths: readonly string[], signal?: AbortSignal): Promise<string> {
    const listed = await this.shadow(store, worktreeRoot, ['ls-files', '-z'], { signal, write: false })
    if (!gitSucceeded(listed)) throw new CheckpointRefused(describe(listed, 'Reading the checkpoint store'))
    const wanted = new Set(paths)
    const stale = splitNul(listed.stdout.toString('utf8')).filter(path => !wanted.has(path))
    if (stale.length > 0) {
      const removed = await this.shadow(store, worktreeRoot, ['update-index', '-z', '--force-remove', '--stdin'], { stdin: stale.join('\0') + '\0', signal })
      if (!gitSucceeded(removed)) throw new CheckpointRefused(describe(removed, 'Updating the checkpoint store'))
    }
    if (paths.length > 0) {
      const added = await this.shadow(store, worktreeRoot, ['update-index', '-z', '--add', '--remove', '--replace', '--stdin'], { stdin: paths.join('\0') + '\0', signal, timeoutMs: this.limits.captureTimeoutMs })
      if (!gitSucceeded(added)) throw new CheckpointRefused(describe(added, 'Taking the snapshot'))
    }
    const tree = await this.shadow(store, worktreeRoot, ['write-tree'], { signal })
    const oid = tree.stdout.toString('utf8').trim()
    if (!gitSucceeded(tree) || !OID.test(oid)) throw new CheckpointRefused(describe(tree, 'Writing the snapshot'))
    return oid
  }

  /** Start a turn for a session in a worktree and return its number. */
  beginTurn(worktreeRoot: string, sessionId: string, label: string): Promise<number> {
    const store = this.storeDirectory(worktreeRoot)
    return this.queued(store, async () => {
      await mkdir(store, { recursive: true })
      const meta = await this.readMeta(store, worktreeRoot)
      meta.worktree = worktreeRoot
      const session = meta.sessions[sessionId] ??= { turns: [] }
      const n = (session.turns.at(-1)?.n ?? 0) + 1
      session.turns.push({ n, label: turnLabel(label), startedAt: this.now(), endedAt: null, state: 'open', note: null, before: null, after: null })
      await this.writeMeta(store, meta)
      return n
    })
  }

  /** Change a turn's record; `change` returns false to leave it as it is. */
  updateTurn(worktreeRoot: string, sessionId: string, turn: number, change: (record: CheckpointTurn) => boolean | void): Promise<void> {
    const store = this.storeDirectory(worktreeRoot)
    return this.queued(store, async () => {
      const meta = await this.readMeta(store, worktreeRoot)
      const record = meta.sessions[sessionId]?.turns.find(candidate => candidate.n === turn)
      if (!record || change(record) === false) return
      await this.writeMeta(store, meta)
    })
  }

  /**
   * Snapshot the worktree for one side of a turn and record it on the turn. Never throws: a snapshot that cannot be
   * taken is recorded with its reason. `gate` is the caller's trust check: it is asked inside the queue, right before
   * Git first runs in the project, and a reason it returns is recorded instead of a snapshot. A turn that is no longer
   * recorded (its store was deleted) gets nothing: no Git runs and nothing is written.
   * `skip` says the snapshot is no longer wanted. It is asked when the capture reaches the front of the queue and
   * again after the last file was read, just before the snapshot is saved; a true answer records nothing. After a
   * turn's end snapshot the store's turn caps are enforced, so they hold while the app stays open.
   */
  capture(worktreeRoot: string, sessionId: string, turn: number, phase: CheckpointPhase, options: { gate?: () => Promise<string | null>; skip?: () => boolean } = {}): Promise<CheckpointCapture | null> {
    const store = this.storeDirectory(worktreeRoot)
    return this.queued(store, async () => {
      if (options.skip?.()) return null
      let discarded = false
      const meta = await this.readMeta(store, worktreeRoot)
      if (!meta.sessions[sessionId]?.turns.some(candidate => candidate.n === turn)) return null
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.limits.captureTimeoutMs)
      let result: CheckpointCapture
      try {
        const refused = await options.gate?.()
        if (refused) throw new CheckpointRefused(refused)
        await this.ensureShadow(store, controller.signal)
        const eligible = await this.eligiblePaths(worktreeRoot, controller.signal)
        const tree = await this.stage(store, worktreeRoot, eligible.paths, controller.signal)
        // Every file has been read. A prompt that arrived meanwhile may already be in this tree.
        if (options.skip?.()) { discarded = true; throw new CheckpointRefused('Discarded') }
        let commit = meta.lastTree === tree ? meta.lastCommit : null
        if (!commit) {
          const made = await this.shadow(store, worktreeRoot, ['commit-tree', tree, '-m', 'checkpoint'], { signal: controller.signal })
          commit = made.stdout.toString('utf8').trim()
          if (!gitSucceeded(made) || !OID.test(commit)) throw new CheckpointRefused(describe(made, 'Saving the snapshot'))
        }
        const ref = await this.shadow(store, worktreeRoot, ['update-ref', checkpointRef(sessionId, turn, phase), commit], { signal: controller.signal })
        if (!gitSucceeded(ref)) throw new CheckpointRefused(describe(ref, 'Saving the snapshot'))
        meta.lastTree = tree
        meta.lastCommit = commit
        result = { commit, reason: null, notCaptured: eligible.notCaptured.length, notCapturedSample: eligible.notCaptured.slice(0, SAMPLE),
          notCapturedPaths: eligible.notCaptured.slice(0, MAX_RECORDED_NOT_CAPTURED), at: this.now() }
      } catch (error) {
        const reason = controller.signal.aborted ? 'The snapshot took too long' : error instanceof CheckpointRefused ? error.message : 'The snapshot failed'
        result = { commit: null, reason, notCaptured: 0, notCapturedSample: [], at: this.now() }
      } finally { clearTimeout(timer) }
      if (discarded) return null
      const record = meta.sessions[sessionId]?.turns.find(candidate => candidate.n === turn)
      if (record) {
        record[phase] = result
        if (phase === 'after') {
          record.endedAt = result.at
          if (record.state === 'open') record.state = record.before?.commit && result.commit ? 'complete' : 'incomplete'
          if (record.state === 'incomplete') record.note ??= record.before?.reason ?? result.reason ?? 'This turn has no snapshot of its start'
        }
      }
      await mkdir(store, { recursive: true })
      await this.writeMeta(store, meta)
      if (phase === 'after') {
        await this.pruneStore(storeNameFor(worktreeRoot), store, { sessionExists: () => true }, { stores: 0, deletedStores: 0, removedTurns: 0, bytesBefore: 0, bytesAfter: 0 }, false)
      }
      return result
    })
  }

  /** The turns recorded for a worktree, by session, oldest first. */
  turns(worktreeRoot: string): Promise<Record<string, CheckpointTurn[]>> {
    const store = this.storeDirectory(worktreeRoot)
    return this.queued(store, async () => {
      const meta = await this.readMeta(store, worktreeRoot)
      return Object.fromEntries(Object.entries(meta.sessions).map(([id, session]) => [id, session.turns]))
    })
  }

  /** Read one file of a snapshot; null when the snapshot does not hold it. For tests and the Turns diff. */
  async fileAt(worktreeRoot: string, commit: string, path: string): Promise<Buffer | null> {
    if (!OID.test(commit)) return null
    const store = this.storeDirectory(worktreeRoot)
    return this.queued(store, async () => {
      const result = await this.shadow(store, null, ['cat-file', 'blob', `${commit}:${path}`], { write: false })
      return gitSucceeded(result) ? result.stdout : null
    })
  }

  /** The turns of a worktree, over all its sessions, newest first: what the Git panel lists. */
  listTurns(worktreeRoot: string): Promise<TurnSummary[]> {
    const store = this.storeDirectory(worktreeRoot)
    return this.queued(store, async () => {
      const meta = await this.readMeta(store, worktreeRoot)
      return Object.entries(meta.sessions)
        .flatMap(([sessionId, session]) => session.turns.map(turn => ({
          sessionId, n: turn.n, label: turn.label, startedAt: turn.startedAt, endedAt: turn.endedAt, state: turn.state,
          note: turn.state === 'incomplete' ? turn.note ?? turn.before?.reason ?? turn.after?.reason ?? null : null,
          diffable: turn.state === 'complete' && Boolean(turn.before?.commit && turn.after?.commit),
          unchanged: turn.state === 'complete' && Boolean(turn.before?.commit) && turn.before?.commit === turn.after?.commit,
          notCaptured: Math.max(turn.before?.notCaptured ?? 0, turn.after?.notCaptured ?? 0),
          notCapturedSample: (turn.after?.notCapturedSample.length ? turn.after.notCapturedSample : turn.before?.notCapturedSample ?? []).slice(0, SAMPLE),
        })))
        .sort((left, right) => right.startedAt - left.startedAt)
        .slice(0, MAX_LISTED_TURNS)
    })
  }

  /** Run a diff between a complete turn's two snapshots, inside the shadow. Git never runs in the project for this. */
  private turnDiffTree(worktreeRoot: string, sessionId: string, turn: number, path?: string): Promise<{ result: GitRunResult | null; leftOut: ReturnType<typeof leftOutOf> }> {
    const store = this.storeDirectory(worktreeRoot)
    return this.queued(store, async () => {
      const meta = await this.readMeta(store, worktreeRoot)
      const record = meta.sessions[sessionId]?.turns.find(candidate => candidate.n === turn)
      const before = record?.before?.commit, after = record?.after?.commit
      if (!record || record.state !== 'complete' || !before || !after) throw new CheckpointRefused('This turn has no snapshots to compare')
      const leftOut = leftOutOf(record)
      // A file one snapshot left out is not compared: Git would call it added or deleted.
      if (path !== undefined && leftOut.has(path)) return { result: null, leftOut }
      // A store that lost its folders is a damaged store, not a missing Git: the command is never started there.
      const whole = await Promise.all([stat(hostPath.join(store, 'empty')).then(entry => entry.isDirectory(), () => false), stat(hostPath.join(this.gitDirectory(store), 'HEAD')).then(entry => entry.isFile(), () => false)])
      if (whole.includes(false)) throw new CheckpointRefused(UNAVAILABLE)
      // Read no more than is shown: Git is stopped once the output passes the cap.
      const result = await this.shadow(store, null, commitDiffTreeArgs(after, before, path), {
        write: false, timeoutMs: 30_000, maxStdoutBytes: path === undefined ? MAX_TURN_FILES_BYTES : MAX_TURN_DIFF_BYTES + 64 * 1024,
      })
      if (result.timedOut) throw new CheckpointRefused('Reading this turn’s changes took too long')
      // Space was reclaimed, or the store was damaged: said for this turn only.
      if (!gitSucceeded(result) && !result.stdoutTruncated) throw new CheckpointRefused(UNAVAILABLE)
      return { result, leftOut }
    })
  }

  /** The files a turn changed, with line counts. */
  async turnFiles(worktreeRoot: string, sessionId: string, turn: number): Promise<TurnFiles> {
    const { result, leftOut } = await this.turnDiffTree(worktreeRoot, sessionId, turn)
    if (!result) throw new CheckpointRefused('This turn has no snapshots to compare')
    // Only complete NUL-terminated records can name a file.
    const files = parseNumstat(result.stdout.subarray(0, result.stdout.lastIndexOf(0) + 1).toString('utf8'))
      .map(({ path, added, deleted, binary }) => leftOut.has(path)
        ? { path, added: null, deleted: null, binary: false, leftOut: true }
        : { path, added, deleted, binary, leftOut: false })
    return { files: files.slice(0, MAX_TURN_FILES), truncated: result.stdoutTruncated || files.length > MAX_TURN_FILES, uncertain: !leftOut.complete }
  }

  /** One file's changes in a turn, as a patch. `leftOut`: one snapshot left the file out, so there is no patch to show. */
  async turnDiff(worktreeRoot: string, sessionId: string, turn: number, path: string): Promise<{ text: string; truncated: boolean; leftOut: boolean }> {
    const { result } = await this.turnDiffTree(worktreeRoot, sessionId, turn, path)
    if (!result) return { text: '', truncated: false, leftOut: true }
    const bounded = boundText(result.stdout, MAX_TURN_DIFF_BYTES)
    return { text: bounded.text, truncated: result.stdoutTruncated || bounded.truncated, leftOut: false }
  }

  private async storeNames(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    return entries.filter(entry => entry.isDirectory() && STORE_NAME.test(entry.name)).map(entry => entry.name)
  }

  private async removeStore(name: string): Promise<void> {
    // Only ever a folder this class named, directly under its own root.
    if (!STORE_NAME.test(name)) return
    await rm(hostPath.join(this.root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  /**
   * Delete every checkpoint of every worktree: what turning the feature off does. Each store is deleted inside its own
   * queue, so no capture or prune runs in a folder while it is removed, and a store whose first write is still queued
   * (it is not on disk yet) is deleted after that write. Throws when a store could not be removed.
   */
  async clear(): Promise<void> {
    const names = new Set([...(await this.storeNames()), ...[...this.queues.keys()].map(store => hostPath.basename(store))])
    const failed: string[] = []
    await Promise.all([...names].map(name => this.queued(hostPath.join(this.root, name), () => this.removeStore(name)).catch(() => { failed.push(name) })))
    if (failed.length > 0) throw new Error(`${failed.length} checkpoint ${failed.length === 1 ? 'store' : 'stores'} could not be deleted`)
  }

  /** Turns left open by a run of the app that has ended have no end snapshot, and never will. */
  async closeOpenTurns(note = 'The app closed during this turn'): Promise<void> {
    for (const name of await this.storeNames()) {
      const store = hostPath.join(this.root, name)
      await this.queued(store, async () => {
        const meta = await this.readMeta(store, null)
        let changed = false
        for (const session of Object.values(meta.sessions)) for (const turn of session.turns) {
          if (turn.state === 'open') { turn.state = 'incomplete'; turn.note = note; changed = true }
        }
        if (changed) await this.writeMeta(store, meta)
      })
    }
  }

  /**
   * Drop what is no longer wanted and give the disk space back: turns of sessions Copilot no longer stores, old turns,
   * turns over the caps, stores whose folder is gone. Space is reclaimed inside the shadow only.
   */
  async prune(options: PruneOptions): Promise<PruneReport> {
    const report: PruneReport = { stores: 0, deletedStores: 0, removedTurns: 0, bytesBefore: 0, bytesAfter: 0 }
    for (const name of await this.storeNames()) {
      const store = hostPath.join(this.root, name)
      await this.queued(store, () => this.pruneStore(name, store, options, report, true))
    }
    return report
  }

  /**
   * One store, inside its queue. The `full` pass (at startup and on a timer) also deletes a store whose folder is
   * gone, and always reclaims space. The other pass runs after every turn: it enforces the turn caps at once, and
   * reclaims space and checks the size cap once enough turns were dropped or have ended since the last time.
   */
  private async pruneStore(name: string, store: string, options: PruneOptions, report: PruneReport, full: boolean): Promise<void> {
    report.stores++
    if (full) report.bytesBefore += await folderBytes(store)
    const meta = await this.readMeta(store, null)
    if (full) {
      const worktreeThere = meta.worktree !== '' && await stat(meta.worktree).then(entry => entry.isDirectory(), () => false)
      if (!worktreeThere) { await this.removeStore(name); report.deletedStores++; return }
    }
    const removed: Array<{ sessionId: string; n: number }> = []
    let forgotten = 0
    const drop = (sessionId: string, turns: CheckpointTurn[]): void => { for (const turn of turns) removed.push({ sessionId, n: turn.n }) }
    const cutoff = this.now() - this.limits.maxAgeMs
    for (const [sessionId, session] of Object.entries(meta.sessions)) {
      if (!(await options.sessionExists(sessionId))) { drop(sessionId, session.turns); delete meta.sessions[sessionId]; continue }
      const keep = session.turns.filter(turn => turn.state === 'open' || turn.startedAt >= cutoff).slice(-this.limits.maxTurnsPerSession)
      drop(sessionId, session.turns.filter(turn => !keep.includes(turn)))
      session.turns = keep
      if (keep.length === 0) delete meta.sessions[sessionId]
    }
    const dropOldest = (count: number): number => {
      const all = Object.entries(meta.sessions).flatMap(([sessionId, session]) => session.turns.filter(turn => turn.state !== 'open').map(turn => ({ sessionId, turn })))
        .sort((left, right) => left.turn.startedAt - right.turn.startedAt).slice(0, Math.max(0, count))
      for (const { sessionId, turn } of all) {
        const session = meta.sessions[sessionId]!
        session.turns = session.turns.filter(candidate => candidate !== turn)
        if (session.turns.length === 0) delete meta.sessions[sessionId]
        removed.push({ sessionId, n: turn.n })
      }
      return all.length
    }
    const count = (): number => Object.values(meta.sessions).reduce((sum, session) => sum + session.turns.length, 0)
    dropOldest(count() - this.limits.maxTurnsPerStore)
    const hasShadow = await stat(hostPath.join(this.gitDirectory(store), 'HEAD')).then(() => true, () => false)
    /** Dropped turns stop being reachable. Their bytes stay until the next reclaim. */
    const forget = async (): Promise<void> => {
      const fresh = removed.slice(forgotten)
      forgotten = removed.length
      meta.unreclaimed = (meta.unreclaimed ?? 0) + fresh.length
      const refs = fresh.flatMap(({ sessionId, n }) => (['before', 'after'] as const).map(phase => `delete ${checkpointRef(sessionId, n, phase)}\n`))
      if (refs.length > 0 && hasShadow) await this.shadow(store, null, ['update-ref', '--stdin'], { stdin: refs.join('') })
      // The newest tree stays reusable only while a kept turn still points at its commit.
      const kept = new Set(Object.values(meta.sessions).flatMap(session => session.turns.flatMap(turn => [turn.before?.commit, turn.after?.commit])))
      if (!meta.lastCommit || !kept.has(meta.lastCommit)) { meta.lastTree = null; meta.lastCommit = null }
      await this.writeMeta(store, meta)
    }
    const reclaim = async (): Promise<number> => {
      await forget()
      if (hasShadow) await this.shadow(store, null, ['gc', '--prune=now', '--quiet'], { timeoutMs: 300_000 })
      meta.unreclaimed = 0
      meta.turnsSinceReclaim = 0
      await this.writeMeta(store, meta)
      return folderBytes(store)
    }
    if (!full) {
      meta.turnsSinceReclaim = (meta.turnsSinceReclaim ?? 0) + 1
      await forget()
      if ((meta.unreclaimed ?? 0) < RECLAIM_AFTER_DROPPED_TURNS && meta.turnsSinceReclaim < RECLAIM_AFTER_TURNS) { report.removedTurns += removed.length; return }
    }
    let bytes = await reclaim()
    for (let round = 0; bytes > this.limits.maxStoreBytes && count() > 0 && round < 8; round++) {
      // Open turns are never dropped: with only those left there is nothing more to give back.
      if (dropOldest(Math.max(1, Math.ceil(count() / 2))) === 0) break
      bytes = await reclaim()
    }
    report.removedTurns += removed.length
    // A store with a turn still running keeps its start snapshot, whatever its size.
    const running = Object.values(meta.sessions).some(session => session.turns.some(turn => turn.state === 'open'))
    if (!running && (count() === 0 || bytes > this.limits.maxStoreBytes)) { await this.removeStore(name); report.deletedStores++; return }
    report.bytesAfter += bytes
  }
}

/**
 * Delete every checkpoint store under the app's checkpoint folder. It needs no Git, so turning the feature off works
 * when Git is gone. Throws when a store could not be removed.
 */
export async function clearCheckpointFolder(root: string, remove: (folder: string) => Promise<void> = folder => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const failed: string[] = []
  for (const entry of entries) {
    // Only ever a folder named as a store is, directly under the checkpoint folder.
    if (!entry.isDirectory() || !STORE_NAME.test(entry.name)) continue
    await remove(hostPath.join(root, entry.name)).catch(() => { failed.push(entry.name) })
  }
  if (failed.length > 0) throw new Error(`${failed.length} checkpoint ${failed.length === 1 ? 'store' : 'stores'} could not be deleted`)
}

export async function folderBytes(folder: string): Promise<number> {
  let total = 0
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = hostPath.join(folder, entry.name)
    if (entry.isDirectory()) total += await folderBytes(path)
    else total += await lstat(path).then(found => found.size, () => 0)
  }
  return total
}
