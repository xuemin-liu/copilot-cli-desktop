import { readFile } from 'node:fs/promises'
import { normalizeBrowserProfileId } from './browser-profile.js'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import { isPermissionPreset, type PermissionPreset } from './permission-presets.js'
import { isSessionPermissionMode } from './permission-modes.js'
import { isOtherCli, normalizeReviewerClis, DEFAULT_REVIEWER_CLIS, type OtherCli, type ReviewerCli } from './session-cli.js'
import { normalizeOtherCliConfig, normalizePerCliConfig } from './agent-cli-settings.js'
import { isResumeMode, type ResumeMode } from './resume-args.js'
import { DEFAULT_PROVIDER_CONFIG, normalizeProviderConfig, type CopilotProviderConfig } from './provider-config.js'
import { DEFAULT_SESSION_LAUNCH_CONFIG, normalizeSessionLaunchConfig } from './session-launch.js'
import type { RestoredTab, WorkspaceProfile } from './types.js'
import { DEFAULT_WORKTREE_TIMEOUT_MINUTES, normalizeWorktreeTimeoutMinutes } from './worktree-timeout.js'
import { DEFAULT_WORKTREE_CLEANUP, isWorktreeCleanupMode, type WorktreeCleanupMode } from './session-worktree-cleanup.js'
import { DEFAULT_MEETING_MAX_ROUNDS, DEFAULT_MEETING_ROUND_TIMEOUT_MINUTES, normalizeMeetingMaxRounds, normalizeMeetingRoundTimeoutMinutes } from './meeting-settings.js'
import { DEFAULT_MAX_SESSION_TABS, MAX_MAX_SESSION_TABS, normalizeMaxSessionTabs } from './session-tab-limit.js'

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
  browserProfile: BrowserProfileMode
  /** Whether a new session's browser uses the DevTools settings and Local Overrides every session shares, or its own. */
  browserOverrides: BrowserOverridesMode
  worktreeTimeoutMinutes: number
  /** What happens to the worktree the desktop made for a session when its tab is closed. */
  worktreeCleanup: WorktreeCleanupMode
  /** A meeting between sessions pauses after this many rounds; the person may allow more. */
  meetingMaxRounds: number
  /** How long a meeting round waits for every reviewer's reply. */
  meetingRoundTimeoutMinutes: number
  /** After a meeting round's reviews are in, each reviewer reads the others' and answers them before the host sees all of it. */
  meetingDiscussion: boolean
  /** How many session tabs may be open at once; lowering it leaves tabs already open alone. */
  maxSessionTabs: number
  /** Lets a session that starts while this is on use desktop control, which the person still turns on per session (Windows only). */
  desktopControl: boolean
  /** A clicked path outside the session's workspace opens in a File tab too. Off: such paths are refused, as before. */
  openFilesOutsideWorkspace: boolean
  /** Snapshot a session's working folder at each turn, in the app's own data folder. Turning it off deletes the snapshots. */
  turnCheckpoints: boolean
  /** Default CLIs launched as temporary PR reviewers when a workspace has no override of its own. */
  reviewerClis: ReviewerCli[]
  /** Launch hidden temporary PR reviewer sessions with allow-all flags so background reviews do not block on prompts. */
  reviewerAllowAll: boolean
  /** Ask before hidden reviewers start for a meeting or a pull request. Off (the default): they start at once, unless the pull request is not verified as the person's own or changes repo-local CLI/MCP configuration. */
  reviewerStartPrompt: boolean
  provider: CopilotProviderConfig
}

export type DesktopPreferences = Pick<
  DesktopConfig,
  'closeBehavior' | 'trayEnabled' | 'notifications' | 'automaticUpdateChecks' | 'globalShortcutEnabled' | 'browserProfile' | 'browserOverrides' | 'worktreeTimeoutMinutes' | 'worktreeCleanup' | 'meetingMaxRounds' | 'meetingRoundTimeoutMinutes' | 'meetingDiscussion' | 'maxSessionTabs' | 'desktopControl' | 'openFilesOutsideWorkspace' | 'turnCheckpoints' | 'reviewerClis' | 'reviewerAllowAll' | 'reviewerStartPrompt'
>

function samePrefValue(a: unknown, b: unknown): boolean {
  return Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, index) => item === b[index])
    : a === b
}

/**
 * What to put back when saving a preference change fails: each value the change set returns to what it was
 * before, unless another change has replaced it since, so a failed save never undoes a newer one.
 */
export function preferenceRollback(
  before: DesktopPreferences,
  applied: DesktopPreferences,
  current: DesktopPreferences,
): Partial<DesktopPreferences> {
  const rollback: Partial<DesktopPreferences> = {}
  for (const key of Object.keys(before) as Array<keyof DesktopPreferences>) {
    if (!samePrefValue(before[key], applied[key]) && samePrefValue(current[key], applied[key])) {
      Object.assign(rollback, { [key]: Array.isArray(before[key]) ? [...before[key]] : before[key] })
    }
  }
  return rollback
}

/**
 * Chains a config write after the ones already queued. `write` should copy the config when it runs, not
 * when it is queued, and `onFailure` runs before the next write starts: together a failed change is
 * undone before any later write copies the config, so a later successful write cannot save it after all.
 */
export function queueConfigWrite(
  queue: Promise<void>,
  write: () => Promise<void>,
  onFailure?: () => void,
): { operation: Promise<void>; queue: Promise<void> } {
  const operation = queue.then(write)
  // The second catch keeps the queue usable if undoing the change throws.
  return { operation, queue: operation.catch(() => onFailure?.()).catch(() => {}) }
}

export const CLOSE_BEHAVIORS = ['ask', 'tray', 'quit'] as const
export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number]

export function isCloseBehavior(value: unknown): value is CloseBehavior {
  return CLOSE_BEHAVIORS.includes(value as CloseBehavior)
}

/** Whether each session's browser has its own cookies and storage, or every session shares one profile like Chrome. */
export const BROWSER_PROFILE_MODES = ['separate', 'shared'] as const
export type BrowserProfileMode = (typeof BROWSER_PROFILE_MODES)[number]

export function isBrowserProfileMode(value: unknown): value is BrowserProfileMode {
  return BROWSER_PROFILE_MODES.includes(value as BrowserProfileMode)
}

export const BROWSER_OVERRIDES_MODES = ['shared', 'private'] as const
export type BrowserOverridesMode = (typeof BROWSER_OVERRIDES_MODES)[number]

export function isBrowserOverridesMode(value: unknown): value is BrowserOverridesMode {
  return BROWSER_OVERRIDES_MODES.includes(value as BrowserOverridesMode)
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
  browserProfile: 'separate',
  browserOverrides: 'shared',
  worktreeTimeoutMinutes: DEFAULT_WORKTREE_TIMEOUT_MINUTES,
  worktreeCleanup: DEFAULT_WORKTREE_CLEANUP,
  meetingMaxRounds: DEFAULT_MEETING_MAX_ROUNDS,
  meetingRoundTimeoutMinutes: DEFAULT_MEETING_ROUND_TIMEOUT_MINUTES,
  meetingDiscussion: false,
  maxSessionTabs: DEFAULT_MAX_SESSION_TABS,
  desktopControl: false,
  openFilesOutsideWorkspace: false,
  turnCheckpoints: true,
  reviewerClis: [...DEFAULT_REVIEWER_CLIS],
  reviewerAllowAll: true,
  reviewerStartPrompt: false,
  provider: { ...DEFAULT_PROVIDER_CONFIG },
}

export const MAX_PROFILES = 20
// A workspace may hold every tab the highest session limit allows.
const MAX_RESTORED_TABS = MAX_MAX_SESSION_TABS

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
  options: { general?: boolean; onEvicted?: ((profile: WorkspaceProfile) => void) | undefined } = {},
): WorkspaceProfile {
  const normalized = resolve(path)
  const id = workspaceProfileId(normalized)
  const existing = config.profiles.find((profile) => profile.id === id)
  const profile = existing ?? { ...createWorkspaceProfile(normalized), ...(options.general ? { general: true as const } : {}) }
  const ordered = [profile, ...config.profiles.filter((candidate) => candidate.id !== id)]
  if (ordered.length > MAX_PROFILES) {
    const evictable = (candidate: WorkspaceProfile, index: number): boolean => index > 0 && !protectedProfileIds.has(candidate.id)
    // Quick investigations must not push a project out: general workspaces go first, and a new one can only replace another.
    let evictionIndex = ordered.findLastIndex((candidate, index) => candidate.general === true && evictable(candidate, index))
    if (evictionIndex < 0 && !profile.general) evictionIndex = ordered.findLastIndex(evictable)
    if (evictionIndex < 0) {
      throw new Error(profile.general
        ? `All ${MAX_PROFILES} workspaces are projects or are in use. Remove one before adding a general workspace.`
        : `All ${MAX_PROFILES} workspaces are in use: each has a session, a saved session or open tools. Remove one you no longer need before adding another.`)
    }
    const [evicted] = ordered.splice(evictionIndex, 1)
    if (evicted) options.onEvicted?.(evicted)
  }
  config.profiles = ordered
  config.activeProfileId = profile.id
  return profile
}

export interface RemovedWorkspaceProfile {
  profile: WorkspaceProfile
  index: number
  previousActiveId: string | null
  activeIdAfterRemoval: string | null
}

/**
 * Forgets a workspace; its folder and Copilot's own session history are left alone. When it was the
 * active workspace, `nextActiveId` (or else the first remaining one) becomes active.
 */
export function removeWorkspaceProfile(
  config: DesktopConfig,
  profileId: string,
  nextActiveId: string | null = null,
): RemovedWorkspaceProfile {
  const index = config.profiles.findIndex((profile) => profile.id === profileId)
  const profile = config.profiles[index]
  if (!profile) throw new Error('The selected workspace profile no longer exists')
  const previousActiveId = config.activeProfileId
  config.profiles = config.profiles.filter((candidate) => candidate.id !== profileId)
  if (previousActiveId === profileId) {
    config.activeProfileId = config.profiles.some((candidate) => candidate.id === nextActiveId)
      ? nextActiveId
      : config.profiles[0]?.id ?? null
  }
  return { profile, index, previousActiveId, activeIdAfterRemoval: config.activeProfileId }
}

/** Undoes removeWorkspaceProfile after its save failed, unless the workspace was added back since. */
export function restoreWorkspaceProfile(config: DesktopConfig, removed: RemovedWorkspaceProfile): void {
  if (config.profiles.some((candidate) => candidate.id === removed.profile.id)) return
  const profiles = [...config.profiles]
  profiles.splice(Math.min(removed.index, profiles.length), 0, removed.profile)
  config.profiles = profiles
  // Make it active again only if nothing has changed the active workspace since.
  if (removed.previousActiveId === removed.profile.id && config.activeProfileId === removed.activeIdAfterRemoval) {
    config.activeProfileId = removed.profile.id
  }
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

/** Omit the profile's otherCli field entirely when no non-Copilot CLI has any configured setting. */
function otherCliProfileField(value: unknown): Pick<WorkspaceProfile, 'otherCli'> {
  const otherCli = normalizeOtherCliConfig(value)
  return Object.keys(otherCli).length > 0 ? { otherCli } : {}
}

/** Omit the profile's reviewerClis override when unset or when no supported CLI remains in it. */
function reviewerClisProfileField(value: unknown): Pick<WorkspaceProfile, 'reviewerClis'> {
  if (!Array.isArray(value)) return {}
  const normalized = normalizeReviewerClis(value, [])
  return normalized.length > 0 ? { reviewerClis: normalized } : {}
}

/** A restored non-Copilot tab keeps its CLI and, when it had a saved permission/model snapshot, that snapshot. */
function otherCliTabFields(cli: OtherCli, config: unknown): Pick<RestoredTab, 'cli' | 'otherCliConfig'> {
  const otherCliConfig = normalizePerCliConfig(cli, config)
  return { cli, ...(Object.keys(otherCliConfig).length > 0 ? { otherCliConfig } : {}) }
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
    const browserProfileId = normalizeBrowserProfileId(tab.browserProfileId)
    tabs.push({
      title: tab.title,
      lastSessionId,
      ...(isOtherCli(tab.cli) ? otherCliTabFields(tab.cli, tab.otherCliConfig) : {}),
      ...(browserProfileId ? { browserProfileId } : {}),
      ...(isPermissionPreset(tab.sessionPermissionPreset)
        ? { sessionPermissionPreset: tab.sessionPermissionPreset }
        : {}),
      ...(lastSessionId && tab.sideChat !== true && isSessionPermissionMode(tab.sessionPermissionMode)
        ? { sessionPermissionMode: tab.sessionPermissionMode }
        : {}),
      ...(typeof tab.autoTitle === 'boolean' ? { autoTitle: tab.autoTitle } : {}),
      ...(tab.renamePending === true ? { renamePending: true as const } : {}),
      ...(typeof tab.launchWorktree === 'boolean' ? { launchWorktree: tab.launchWorktree } : {}),
      ...(typeof tab.launchWorktreePath === 'string' && tab.launchWorktreePath.length > 0 && tab.launchWorktreePath.length <= 4_096
        ? { launchWorktreePath: tab.launchWorktreePath } : {}),
      ...(tab.privateOverrides === true ? { privateOverrides: true as const } : {}),
      ...(tab.active === true ? { active: true as const } : {}),
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
  reportUnparseable?: () => void,
): Promise<DesktopConfig> {
  let parsed: unknown
  try {
    // Editors such as Notepad prepend a UTF-8 BOM, which JSON.parse rejects.
    parsed = JSON.parse((await readFile(filename, 'utf8')).replace(/^﻿/, '')) as unknown
  } catch (error) {
    if (!isMissingPath(error) && !(error instanceof SyntaxError)) throw error
    // Distinguish "no config yet" from "config exists but is unreadable" so
    // callers do not treat the empty default as the user's real state.
    if (error instanceof SyntaxError) reportUnparseable?.()
    return normalizeDesktopConfig(null)
  }
  return normalizeDesktopConfig(parsed, reportMigration)
}

/** Shared, side-effect-free normalization for startup and migration previews. */
export function normalizeDesktopConfig(parsed: unknown, reportMigration?: (message: string) => void): DesktopConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return structuredClone(DEFAULT_DESKTOP_CONFIG)
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
        ...otherCliProfileField(profile.otherCli),
        ...reviewerClisProfileField(profile.reviewerClis),
        tabs: readRestoredTabs(profile.tabs),
        ...(profile.general === true ? { general: true as const } : {}),
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
    browserProfile: isBrowserProfileMode(value.browserProfile) ? value.browserProfile : 'separate',
    browserOverrides: isBrowserOverridesMode(value.browserOverrides) ? value.browserOverrides : 'shared',
    worktreeTimeoutMinutes: normalizeWorktreeTimeoutMinutes(value.worktreeTimeoutMinutes),
    worktreeCleanup: isWorktreeCleanupMode(value.worktreeCleanup) ? value.worktreeCleanup : DEFAULT_WORKTREE_CLEANUP,
    meetingMaxRounds: normalizeMeetingMaxRounds(value.meetingMaxRounds),
    meetingRoundTimeoutMinutes: normalizeMeetingRoundTimeoutMinutes(value.meetingRoundTimeoutMinutes),
    meetingDiscussion: value.meetingDiscussion === true,
    maxSessionTabs: normalizeMaxSessionTabs(value.maxSessionTabs),
    desktopControl: value.desktopControl === true,
    openFilesOutsideWorkspace: value.openFilesOutsideWorkspace === true,
    turnCheckpoints: value.turnCheckpoints !== false,
    reviewerClis: normalizeReviewerClis(value.reviewerClis),
    reviewerAllowAll: value.reviewerAllowAll !== false,
    reviewerStartPrompt: value.reviewerStartPrompt === true,
    provider: normalizeProviderConfig(value.provider, reportMigration),
  }
}

export async function writeDesktopConfig(filename: string, config: DesktopConfig): Promise<void> {
  await writeFileAtomic(filename, `${JSON.stringify(config, null, 2)}\n`)
}
