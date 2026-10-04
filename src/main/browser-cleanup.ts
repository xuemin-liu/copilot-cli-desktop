import { lstat, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { normalizeBrowserProfileId } from './browser-profile.js'
import { isSessionTabId } from './external-targets.js'
import type { Session } from 'electron'

export async function clearBrowserStorage(
  storage: Pick<Session, 'closeAllConnections' | 'clearData' | 'clearCache' | 'clearAuthCache'>,
  reportError: (message: string) => void,
): Promise<void> {
  // Close page contents first so unload handlers cannot recreate credentials.
  for (const operation of [() => storage.closeAllConnections(), () => storage.clearData(),
    () => storage.clearCache(), () => storage.clearAuthCache()]) {
    try { await operation() }
    catch (error) { reportError(`Could not clear browser storage: ${String(error)}`) }
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Browser cleanup refuses linked or non-directory paths')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Only delete a checked direct child of an app-owned directory. */
async function removeChild(root: string, name: string): Promise<void> {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, name)
  if (dirname(target) !== absoluteRoot) throw new Error('Browser cleanup path is outside its root')
  if (!await directoryExists(absoluteRoot) || !await directoryExists(target)) return
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

export async function removeBrowserProfileSettings(userData: string, profileId: string): Promise<void> {
  const id = normalizeBrowserProfileId(profileId)
  if (!id) throw new Error('Invalid browser profile')
  await removeChild(resolve(userData, 'browser-profiles'), id)
}

export async function browserProfileHasPartition(userData: string, profileId: string): Promise<boolean> {
  const id = normalizeBrowserProfileId(profileId)
  if (!id) throw new Error('Invalid browser profile')
  const root = resolve(userData, 'Partitions')
  if (!await directoryExists(root)) return false
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    try { if (decodeURIComponent(entry.name) === `browser-debug:${id}`) return true }
    catch { /* Unrelated malformed partition names are not owned by this feature. */ }
  }
  return false
}

/** Run before creating any native browser sessions: Chromium owns open partition files until exit. */
export async function pruneBrowserProfiles(userData: string, referenced: Iterable<string | undefined>): Promise<void> {
  const retained = new Set([...referenced].map(normalizeBrowserProfileId).filter(Boolean))
  for (const [name, partition] of [['browser-profiles', false], ['Partitions', true]] as const) {
    const root = resolve(userData, name)
    if (!await directoryExists(root)) continue
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      let candidate = entry.name
      if (partition) {
        try { candidate = decodeURIComponent(candidate) } catch { continue }
        if (!candidate.startsWith('browser-debug:')) continue
        candidate = candidate.slice('browser-debug:'.length)
      }
      const id = normalizeBrowserProfileId(candidate)
      if (id && !retained.has(id)) await removeChild(root, entry.name)
    }
  }
}

export async function removeBrowserLaunch(userData: string, launchId: string, tabId?: string): Promise<void> {
  const id = normalizeBrowserProfileId(launchId)
  if (!id || (tabId !== undefined && !isSessionTabId(tabId))) throw new Error('Invalid browser launch')
  const root = resolve(userData, 'browser-sessions')
  if (!await directoryExists(root)) return
  if (tabId === undefined) await removeChild(root, id)
  else {
    const launch = resolve(root, id)
    if (await directoryExists(launch)) await removeChild(launch, tabId)
  }
}

export async function pruneBrowserLaunches(userData: string, currentLaunchId: string): Promise<void> {
  const current = normalizeBrowserProfileId(currentLaunchId)
  if (!current) throw new Error('Invalid browser launch')
  const root = resolve(userData, 'browser-sessions')
  if (!await directoryExists(root)) return
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const id = normalizeBrowserProfileId(entry.name)
    if (id && id !== current && entry.isDirectory() && !entry.isSymbolicLink()) await removeChild(root, entry.name)
  }
}
