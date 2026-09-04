import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import { isPermissionPreset, type PermissionPreset } from './permission-presets.js'
import { isResumeMode, type ResumeMode } from './resume-args.js'
import { DEFAULT_PROVIDER_CONFIG, normalizeProviderConfig, type CopilotProviderConfig } from './provider-config.js'
import { DEFAULT_SESSION_LAUNCH_CONFIG, normalizeSessionLaunchConfig } from './session-launch.js'
import type { RestoredTab, WorkspaceProfile } from './types.js'

export interface DesktopConfig {
  profiles: WorkspaceProfile[]
  activeProfileId: string | null
  lastRunVersion: string | null
  rollbackVersion: string | null
  closeBehavior: CloseBehavior
  trayEnabled: boolean
  notifications: boolean
  automaticUpdateChecks: boolean
  globalShortcutEnabled: boolean
  launchAtLogin: boolean
  provider: CopilotProviderConfig
}

export type DesktopPreferences = Pick<
  DesktopConfig,
  'closeBehavior' | 'trayEnabled' | 'notifications' | 'automaticUpdateChecks' | 'globalShortcutEnabled'
>

export const CLOSE_BEHAVIORS = ['ask', 'tray', 'quit'] as const
export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number]

export function isCloseBehavior(value: unknown): value is CloseBehavior {
  return CLOSE_BEHAVIORS.includes(value as CloseBehavior)
}

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  profiles: [],
  activeProfileId: null,
  lastRunVersion: null,
  rollbackVersion: null,
  closeBehavior: 'ask',
  trayEnabled: true,
  notifications: true,
  automaticUpdateChecks: true,
  globalShortcutEnabled: false,
  launchAtLogin: false,
  provider: { ...DEFAULT_PROVIDER_CONFIG },
}

export const MAX_PROFILES = 20
const MAX_RESTORED_TABS = 20

export function workspaceProfileId(path: string): string {
  return createHash('sha256').update(resolve(path).toLowerCase()).digest('hex').slice(0, 16)
}

export function createWorkspaceProfile(
  path: string,
  permissionPreset: PermissionPreset = 'default',
  defaultResumeMode: ResumeMode = 'auto-resume',
): WorkspaceProfile {
  const normalized = resolve(path)
  return {
    id: workspaceProfileId(normalized),
    name: basename(normalized) || normalized,
    path: normalized,
    permissionPreset,
    defaultResumeMode,
    launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG },
    tabs: [],
  }
}

export function activateWorkspaceProfile(
  config: DesktopConfig,
  path: string,
  protectedProfileIds: ReadonlySet<string> = new Set(),
): WorkspaceProfile {
  const normalized = resolve(path)
  const id = workspaceProfileId(normalized)
  const existing = config.profiles.find((profile) => profile.id === id)
  const profile = existing ?? createWorkspaceProfile(normalized)
  const ordered = [profile, ...config.profiles.filter((candidate) => candidate.id !== id)]
  if (ordered.length > MAX_PROFILES) {
    const evictionIndex = ordered.findLastIndex(
      (candidate, index) => index > 0 && !protectedProfileIds.has(candidate.id),
    )
    if (evictionIndex < 0) {
      throw new Error(`Close a workspace session before adding more than ${MAX_PROFILES} workspace profiles`)
    }
    ordered.splice(evictionIndex, 1)
  }
  config.profiles = ordered
  config.activeProfileId = profile.id
  return profile
}

export function activeWorkspaceProfile(config: DesktopConfig): WorkspaceProfile | null {
  return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null
}

export function recordDesktopVersion(config: DesktopConfig, currentVersion: string): boolean {
  if (config.lastRunVersion === currentVersion) return false
  if (config.lastRunVersion) config.rollbackVersion = config.lastRunVersion
  config.lastRunVersion = currentVersion
  return true
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function readRestoredTabs(value: unknown): RestoredTab[] {
  if (!Array.isArray(value)) return []
  const tabs: RestoredTab[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const tab = candidate as Record<string, unknown>
    if (typeof tab.title !== 'string' || tab.title.length === 0 || tab.title.length > 200) continue
    const lastSessionId = typeof tab.lastSessionId === 'string' && tab.lastSessionId.length > 0
      ? tab.lastSessionId
      : null
    tabs.push({
      title: tab.title,
      lastSessionId,
      ...(isPermissionPreset(tab.sessionPermissionPreset)
        ? { sessionPermissionPreset: tab.sessionPermissionPreset }
        : {}),
      ...(tab.sideChat === true ? {
        sideChat: true as const,
        ...(typeof tab.sideParentSessionId === 'string' && tab.sideParentSessionId.length <= 128
          ? { sideParentSessionId: tab.sideParentSessionId } : {}),
      } : {}),
    })
    if (tabs.length >= MAX_RESTORED_TABS) break
  }
  return tabs
}

export async function readDesktopConfig(
  filename: string,
  reportMigration?: (message: string) => void,
): Promise<DesktopConfig> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filename, 'utf8')) as unknown
  } catch (error) {
    if (!isMissingPath(error) && !(error instanceof SyntaxError)) throw error
    return { ...DEFAULT_DESKTOP_CONFIG }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_DESKTOP_CONFIG }
  }
  const value = parsed as Record<string, unknown>
  const profiles: WorkspaceProfile[] = []
  if (Array.isArray(value.profiles)) {
    for (const candidate of value.profiles) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const profile = candidate as Record<string, unknown>
      // A profile can legitimately point at a temporarily disconnected drive
      // or network share. Keep syntactically valid paths and let the launcher
      // surface availability when the user next activates the profile.
      if (typeof profile.path !== 'string' || profile.path.trim().length === 0) continue
      const normalized = resolve(profile.path)
      const permissionPreset = isPermissionPreset(profile.permissionPreset) ? profile.permissionPreset : 'default'
      const defaultResumeMode = isResumeMode(profile.defaultResumeMode) ? profile.defaultResumeMode : 'auto-resume'
      const id = workspaceProfileId(normalized)
      if (profiles.some((entry) => entry.id === id)) continue
      profiles.push({
        id,
        name: typeof profile.name === 'string' && profile.name.trim().length > 0
          ? profile.name.trim().slice(0, 100)
          : basename(normalized) || normalized,
        path: normalized,
        permissionPreset,
        defaultResumeMode,
        launch: normalizeSessionLaunchConfig(profile.launch),
        tabs: readRestoredTabs(profile.tabs),
      })
      if (profiles.length >= MAX_PROFILES) break
    }
  }
  const requestedActiveId = typeof value.activeProfileId === 'string' ? value.activeProfileId : null
  const activeProfile = profiles.find((profile) => profile.id === requestedActiveId) ?? profiles[0] ?? null
  return {
    profiles,
    activeProfileId: activeProfile?.id ?? null,
    lastRunVersion: typeof value.lastRunVersion === 'string' && /^[0-9A-Za-z.+-]{1,50}$/.test(value.lastRunVersion)
      ? value.lastRunVersion
      : null,
    rollbackVersion: typeof value.rollbackVersion === 'string' && /^[0-9A-Za-z.+-]{1,50}$/.test(value.rollbackVersion)
      ? value.rollbackVersion
      : null,
    closeBehavior: isCloseBehavior(value.closeBehavior)
      ? value.closeBehavior
      // Older releases stored only closeToTray. Preserve an explicit exit
      // preference, but migrate background closing to the new prompt so an
      // overflow-hidden Windows tray icon cannot make the app appear lost.
      : value.closeToTray === false ? 'quit' : 'ask',
    trayEnabled: typeof value.trayEnabled === 'boolean' ? value.trayEnabled : true,
    notifications: typeof value.notifications === 'boolean' ? value.notifications : true,
    automaticUpdateChecks: typeof value.automaticUpdateChecks === 'boolean' ? value.automaticUpdateChecks : true,
    globalShortcutEnabled: typeof value.globalShortcutEnabled === 'boolean' ? value.globalShortcutEnabled : false,
    launchAtLogin: typeof value.launchAtLogin === 'boolean' ? value.launchAtLogin : false,
    provider: normalizeProviderConfig(value.provider, reportMigration),
  }
}

export async function writeDesktopConfig(filename: string, config: DesktopConfig): Promise<void> {
  await writeFileAtomic(filename, `${JSON.stringify(config, null, 2)}\n`)
}
