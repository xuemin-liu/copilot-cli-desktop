import type { GitService } from './git-service.js'

/** The few `webContents` members the Git IPC needs, so the handlers can be tested without Electron. */
export interface GitIpcSender {
  id: number
  on(event: 'render-process-gone' | 'did-start-loading' | 'destroyed', listener: () => void): unknown
}

export interface GitIpcEvent {
  sender: GitIpcSender
}

export interface GitIpcDeps {
  ipcMain: { handle(channel: string, listener: (event: never, ...args: unknown[]) => unknown): void }
  /** The service, or null once shutdown has begun. */
  service(): GitService | null
  /** Throws unless the frame is the app shell and no exclusive operation (migration) is running. */
  assertTrustedSender(event: GitIpcEvent): void
  isMainWindowSender(event: GitIpcEvent): boolean
}

const PROFILE_ID = /^[0-9a-f]{16}$/
const REPO_ID = /^repo-[1-9]\d{0,8}$/
const ENTRY_ID = /^e\d{1,9}-\d{1,6}$/
const CONFIG_HASH = /^[0-9a-f]{64}$/

/** A remote's name: printable, not an option, short. The service also requires it to be one of the repository's remotes. */
function expectedBranchArg(value: unknown): { branch: string; headOid: string } {
  const entry = value as { branch?: unknown; headOid?: unknown } | null
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Invalid branch')
  const { branch, headOid } = entry
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > 255 || [...branch].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) throw new Error('Invalid branch')
  if (typeof headOid !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headOid)) throw new Error('Invalid commit')
  return { branch, headOid }
}

/** The current branch (null while detached) and its commit, as the person saw them when they asked for a branch change. */
function expectedHeadArg(value: unknown): { branch: string | null; headOid: string } {
  const entry = value as { branch?: unknown; headOid?: unknown } | null
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Invalid branch')
  const { branch, headOid } = entry
  if (branch !== null && (typeof branch !== 'string' || branch.length < 1 || branch.length > 255 || [...branch].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))) throw new Error('Invalid branch')
  if (typeof headOid !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headOid)) throw new Error('Invalid commit')
  return { branch: branch as string | null, headOid }
}

function branchNameArg(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || value.startsWith('-') || [...value].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) throw new Error('Invalid branch name')
  return value
}

function remoteNameArg(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || value.startsWith('-') || [...value].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) throw new Error('Invalid remote')
  return value
}

function profileIdArg(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_ID.test(value)) throw new Error('Invalid workspace')
  return value
}

function repoIdArg(value: unknown): string {
  if (typeof value !== 'string' || !REPO_ID.test(value)) throw new Error('Invalid repository')
  return value
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`)
  return value
}

export function registerGitIpc(deps: GitIpcDeps): void {
  const watched = new Set<number>()
  const guard = (event: GitIpcEvent): GitService => {
    deps.assertTrustedSender(event)
    if (!deps.isMainWindowSender(event)) throw new Error('The Git panel is only available in the main window')
    const service = deps.service()
    if (!service) throw new Error('The Git panel is not available while the app is closing')
    return service
  }
  // A renderer that reloads, crashes or closes never calls `git-close`, so main tears its subscriptions down.
  const watch = (event: GitIpcEvent): void => {
    const id = event.sender.id
    if (watched.has(id)) return
    watched.add(id)
    const release = (): void => { deps.service()?.unsubscribeAll(id) }
    event.sender.on('render-process-gone', release)
    event.sender.on('did-start-loading', release)
    event.sender.on('destroyed', () => { release(); watched.delete(id) })
  }
  const handle = (channel: string, run: (service: GitService, event: GitIpcEvent, ...args: unknown[]) => unknown): void => {
    deps.ipcMain.handle(channel, (event: GitIpcEvent, ...args: unknown[]) => run(guard(event), event, ...args))
  }

  handle('desktop:git-open', (service, event, profileId: unknown) => {
    const id = profileIdArg(profileId)
    watch(event)
    return service.subscribe(event.sender.id, id)
  })
  handle('desktop:git-close', (service, event, profileId: unknown) => { service.unsubscribe(event.sender.id, profileIdArg(profileId)) })
  handle('desktop:git-rescan', (service, event, profileId: unknown) => service.rescan(event.sender.id, profileIdArg(profileId)))
  handle('desktop:git-trust', (service, event, profileId: unknown, repoId: unknown, configHash: unknown) => {
    if (typeof configHash !== 'string' || !CONFIG_HASH.test(configHash)) throw new Error('Invalid repository settings')
    return service.trust(event.sender.id, profileIdArg(profileId), repoIdArg(repoId), configHash)
  })
  handle('desktop:git-status', (service, event, profileId: unknown, repoId: unknown) =>
    service.getStatus(event.sender.id, profileIdArg(profileId), repoIdArg(repoId)))
  handle('desktop:git-diff', (service, event, profileId: unknown, repoId: unknown, entryId: unknown, staged: unknown) => {
    if (typeof entryId !== 'string' || !ENTRY_ID.test(entryId)) throw new Error('Invalid file')
    if (typeof staged !== 'boolean') throw new Error('Invalid diff side')
    return service.getDiff(event.sender.id, profileIdArg(profileId), repoIdArg(repoId), entryId, staged)
  })
  const entryIdsArg = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 5_000) throw new Error('Invalid file selection')
    for (const id of value) if (typeof id !== 'string' || !ENTRY_ID.test(id)) throw new Error('Invalid file')
    return value as string[]
  }
  for (const operation of ['stage', 'unstage'] as const) {
    handle(`desktop:git-${operation}`, (service, event, profileId: unknown, repoId: unknown, entryIds: unknown, generation: unknown) => {
      const ids = entryIdsArg(entryIds)
      const seen = boundedInteger(generation, 'file list version', 0, 1_000_000_000)
      return service[operation](event.sender.id, profileIdArg(profileId), repoIdArg(repoId), ids, seen)
    })
  }
  handle('desktop:git-commit', (service, event, profileId: unknown, repoId: unknown, message: unknown, generation: unknown, approvedHooksHash: unknown) => {
    if (typeof message !== 'string' || message.trim() === '' || message.length > 100_000 || message.includes('\0')) throw new Error('Invalid commit message')
    if (approvedHooksHash !== null && (typeof approvedHooksHash !== 'string' || !CONFIG_HASH.test(approvedHooksHash))) throw new Error('Invalid hooks approval')
    return service.commit(event.sender.id, profileIdArg(profileId), repoIdArg(repoId), message, boundedInteger(generation, 'file list version', 0, 1_000_000_000), approvedHooksHash)
  })
  handle('desktop:git-sync', (service, event, profileId: unknown, repoId: unknown, operation: unknown, remote: unknown, expected: unknown) => {
    if (operation !== 'fetch' && operation !== 'pull' && operation !== 'push') throw new Error('Invalid operation')
    const remoteName = remote === null ? null : remoteNameArg(remote)
    if (remoteName !== null && operation !== 'push') throw new Error('Only a push takes a remote')
    const args = [event.sender.id, profileIdArg(profileId), repoIdArg(repoId)] as const
    if (operation === 'fetch') {
      if (expected !== null) throw new Error('A fetch is not tied to a branch')
      return service.fetch(...args)
    }
    // A pull or push belongs to the branch, at the commit, that the person was looking at when they asked.
    const seen = expectedBranchArg(expected)
    return operation === 'push' ? service.push(...args, remoteName, seen) : service.pull(...args, seen)
  })
  handle('desktop:git-head-commit', (service, event, profileId: unknown, repoId: unknown) =>
    service.getHeadCommit(event.sender.id, profileIdArg(profileId), repoIdArg(repoId)))
  handle('desktop:git-amend', (service, event, profileId: unknown, repoId: unknown, message: unknown, generation: unknown, approvedHooksHash: unknown, expected: unknown) => {
    if (typeof message !== 'string' || message.trim() === '' || message.length > 100_000 || message.includes('\0')) throw new Error('Invalid commit message')
    if (approvedHooksHash !== null && (typeof approvedHooksHash !== 'string' || !CONFIG_HASH.test(approvedHooksHash))) throw new Error('Invalid hooks approval')
    return service.amend(event.sender.id, profileIdArg(profileId), repoIdArg(repoId), message, boundedInteger(generation, 'file list version', 0, 1_000_000_000), approvedHooksHash, expectedHeadArg(expected))
  })
  handle('desktop:git-discard', (service, event, profileId: unknown, repoId: unknown, entryIds: unknown, generation: unknown) => {
    if (!Array.isArray(entryIds) || entryIds.length < 1 || entryIds.length > 500) throw new Error('Invalid file selection')
    for (const id of entryIds) if (typeof id !== 'string' || !ENTRY_ID.test(id)) throw new Error('Invalid file')
    return service.discard(event.sender.id, profileIdArg(profileId), repoIdArg(repoId), entryIds as string[], boundedInteger(generation, 'file list version', 0, 1_000_000_000))
  })
  handle('desktop:git-branches', (service, event, profileId: unknown, repoId: unknown) =>
    service.getBranches(event.sender.id, profileIdArg(profileId), repoIdArg(repoId)))
  handle('desktop:git-branch', (service, event, profileId: unknown, repoId: unknown, action: unknown, name: unknown, expected: unknown) => {
    if (action !== 'create' && action !== 'switch') throw new Error('Invalid operation')
    const args = [event.sender.id, profileIdArg(profileId), repoIdArg(repoId), branchNameArg(name), expectedHeadArg(expected)] as const
    return action === 'create' ? service.createBranch(...args) : service.switchBranch(...args)
  })
  handle('desktop:git-cancel', (service, event, profileId: unknown, repoId: unknown) => { service.cancel(event.sender.id, profileIdArg(profileId), repoIdArg(repoId)) })
  handle('desktop:git-log', (service, event, profileId: unknown, repoId: unknown, limit: unknown, skip: unknown) =>
    service.getLog(event.sender.id, profileIdArg(profileId), repoIdArg(repoId), boundedInteger(limit, 'limit', 1, 200), boundedInteger(skip, 'offset', 0, 100_000)))
}
