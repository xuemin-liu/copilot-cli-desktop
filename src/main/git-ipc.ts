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
  handle('desktop:git-log', (service, event, profileId: unknown, repoId: unknown, limit: unknown, skip: unknown) =>
    service.getLog(event.sender.id, profileIdArg(profileId), repoIdArg(repoId), boundedInteger(limit, 'limit', 1, 200), boundedInteger(skip, 'offset', 0, 100_000)))
}
