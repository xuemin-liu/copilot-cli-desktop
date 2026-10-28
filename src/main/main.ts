import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from './atomic-file.js'
import { resolveConfigRecovery } from './config-recovery.js'
import { access, appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  session as electronSession,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron'
import electronUpdater from 'electron-updater'
import { readAccessStatus } from './access-status.js'
import {
  EMPTY_RESOLUTION_REFRESH_FAILURE_STATE,
  TRANSIENT_REFRESH_FAILURE_TOLERANCE,
  sameCopilotResolution,
  shouldAdoptRefreshedResolution,
  trackResolutionRefreshFailure,
} from './copilot-resolution-state.js'
import {
  DEFAULT_DESKTOP_CONFIG,
  activateWorkspaceProfile,
  activeWorkspaceProfile,
  isBrowserOverridesMode,
  isBrowserProfileMode,
  isCloseBehavior,
  preferenceRollback,
  queueConfigWrite,
  readDesktopConfig,
  removeWorkspaceProfile,
  restoreWorkspaceProfile,
  recordDesktopVersion,
  writeDesktopConfig,
  type CloseBehavior,
  type DesktopConfig,
  type DesktopPreferences,
  type RemovedWorkspaceProfile,
} from './desktop-config.js'
import { formatDesktopDiagnostics } from './desktop-diagnostics.js'
import { isWorktreeTimeoutMinutes } from './worktree-timeout.js'
import {
  inspectDesktopWorktree,
  isWorktreeCleanupMode,
  removalIsSafe,
  removeDesktopWorktree,
  worktreeCleanupDecision,
  worktreeCleanupPrompt,
  type DesktopWorktreeState,
} from './session-worktree-cleanup.js'
import { appendBoundedLog, pruneSessionLogDirectories } from './log-retention.js'
import {
  EMPTY_COPILOT_CAPABILITIES,
  discoverCopilotCapabilities,
  runCopilotCommand,
  type CopilotCapabilities,
} from './copilot-command.js'
import {
  DEFAULT_COPILOT_MAINTENANCE_STATE,
  installCopilotCli,
  updateCopilotCli,
  type CopilotMaintenanceState,
} from './copilot-maintenance.js'
import {
  isCopilotUpdateChannel,
  readCopilotAutoUpdate,
  writeCopilotAutoUpdate,
  type CopilotAutoUpdateState,
} from './copilot-auto-update.js'
import {
  DEFAULT_COPILOT_RESOURCES_STATE,
  buildPluginInstallArgs,
  buildRemoteMcpAddArgs,
  buildResourceMutationArgs,
  buildSkillInstallArgs,
  isCopilotResourceAction,
  isCopilotResourceKind,
  type CopilotResourcesState,
} from './copilot-resources.js'
import { isLauncherShellUrl } from './renderer-trust.js'
import { isLocalFilesystemPath, isPathWithinRoot, isSessionTabId, parseSafeHttpUrl } from './external-targets.js'
import { spawnNodePty } from './node-pty-backend.js'
import { GitService } from './git-service.js'
import { projectActivity } from './git-branch.js'
import { GitRunner, resolveGitExecutable } from './git-runner.js'
import { GitTrustStore } from './git-trust.js'
import { registerGitIpc } from './git-ipc.js'
import type { GitIpcEvent } from './git-ipc.js'
import { configureWindowsProcessWatchdogReporter } from './windows-process-watchdog.js'
import { PERMISSION_PRESET_INFO, buildPermissionArgs, isPermissionPreset, permissionCompatibilityWarning, type PermissionPreset } from './permission-presets.js'
import { describeSessionPermission, type SessionPermissionMode } from './permission-modes.js'
import {
  isCopilotProviderType,
  providerEnvironment,
  validateProviderConfig,
  type CopilotProviderConfig,
} from './provider-config.js'
import { PtySession, type PtySessionExit } from './pty-session.js'
import { supportsSessionFork, isForkSessionId } from './copilot-rpc.js'
import { copilotSessionRoot, forkSessionSnapshot } from './session-fork.js'
import { readSessionStart, worktreeNameFor } from './session-store-discovery.js'
import { listStoredSessions, type SessionCatalogCache, type StoredSession } from './session-catalog.js'
import { isValidSessionId } from './session-id.js'
import { newSessionOptions, newSessionTitle, type NewSessionOptions } from './session-name.js'
import { PromptDraft, nameSyncAction, readCopilotSessionName, renameCommand, type CopilotSessionName } from './session-name-sync.js'
import { sessionTaskDecision, taskPasteSequence, type SessionTaskSend } from './session-task.js'
import { MeetingError, MeetingHub, joinRequest, MAX_MEETING_PARTICIPANTS, MEETING_ID_PATTERN, MEETING_STATE_FILE, realMeetingTimers, type MeetingDelivery, type MeetingView } from './meeting.js'
import { isMeetingMaxRounds, isMeetingRoundTimeoutMinutes } from './meeting-settings.js'
import { MeetingOutbox } from './meeting-delivery.js'
import { MeetingTurnReader } from './meeting-turns.js'
import { MEETING_MARKER_PREFIX, roundPaths } from './meeting-messages.js'
import {
  GUEST_ENDPOINT_FILE, GUEST_HELPER, GUEST_HELPER_SH, GUEST_ID_PATTERN, GUEST_SEATS_FILE, GuestMailbox, guestHelperCommand, guestHostInvitation, guestInvitation,
  guestMessage, guestReplyPath, guestSeatFolder, handleGuestRequest, type GuestDeps, type GuestSeat,
} from './meeting-guests.js'
import { DEFAULT_GUEST_MCP_PORT, GuestMcpServer } from './meeting-guest-mcp.js'
import { folderChanges } from './meeting-folder-changes.js'
import { MeetingControlServer, prepareMeetingSessionEnvironment, pruneMeetingFolders, writeMeetingFile, type MeetingCommand, type MeetingRequest, type MeetingResponse } from './meeting-session.js'
import { GitResolverClaims, type SessionState } from './git-resolver.js'
import { inspectSessionWorktree, listLinkedWorktrees, readWorktreeBranch, resolveLinkedWorktree } from './git-discovery.js'
import type { DesktopSessionTab, FanOutResult, SessionWorktreeInfo } from './types.js'
import { realPathNative } from './real-path.js'
import { isSameOrInside } from './host-path.js'
import { desktopPosixPath } from './posix-executables.js'
import { linuxAutostartEnabled, setLinuxAutostart } from './linux-autostart.js'
import { sideChatProfile, SIDE_CHAT_PERMISSION_WARNING } from './side-chat.js'
import { resolveCopilotBinary, withCopilotPathAdditions } from './resolve-copilot.js'
import { buildResumeArgs, isResumeMode, type ResumeMode } from './resume-args.js'
import {
  buildSessionLaunchArgs,
  normalizeSessionLaunchConfig,
  type SessionLaunchConfig,
} from './session-launch.js'
import {
  SecureCredentialStore,
  isCredentialName,
  protectedStorage,
  secretEnvArgs,
  withoutSensitiveEnvironment,
  type CredentialName,
} from './secure-credentials.js'
import {
  EMPTY_TABS_STATE,
  activateTab,
  activeWorkspaceFor,
  addDormantTab,
  adoptCopilotTitle,
  confirmTabRename,
  closeTab,
  createTab,
  renameTab,
  setTabLaunchConfig,
  setTabProcessId,
  setTabPermissionMode,
  setTabSessionId,
  setTabStatus,
  touchTab,
  visibleSessionTabs,
  type TabsState,
} from './session-tab-machine.js'
import type { CopilotResolution, DesktopEvent, DesktopState, RestoredTab, RevealPathResult, SessionHistoryEntry, SidebarView, WorkspaceProfile } from './types.js'
import { DesktopUpdateController, type DesktopUpdateState, type UpdateAdapter } from './update-controller.js'
import { UsageService, UsageServiceUnavailableError } from './usage-service.js'
import { withShutdownDeadline } from './shutdown-deadline.js'
import { BrowserDebug } from './browser-debug.js'
import { browserSessionPaths, prepareBrowserSessionEnvironment } from './browser-session.js'
import { SHARED_BROWSER_PROFILE_ID, browserProfilePaths, selectBrowserProfileId } from './browser-profile.js'
import { browserProfileHasPartition, clearBrowserStorage, pruneBrowserProfiles, pruneBrowserLaunches, removeBrowserProfileSettings, removeBrowserLaunch } from './browser-cleanup.js'
import { shareDevtoolsSettings } from './browser-devtools-settings.js'
import { BrowserHistory } from './browser-history.js'
import { SitePermissions } from './browser-permissions.js'
import { BrowserZoom } from './browser-zoom.js'
import type { BrowserBounds } from './browser-debug-types.js'
import { MigrationService } from './migration-service.js'
import { recoverMigrationReport } from './migration-import.js'
import { assertMigrationWritersStopped } from './migration-writers.js'
import type { MigrationChoices, MigrationSelection } from './migration-types.js'

let migrationService: MigrationService | null = null
let pendingSessionCreations = 0

let usageService: UsageService | null = null
let usageQuitCleanupComplete = false
let preparingUpdate = false
let updatePreparationFailed = false
let updateQuitTimer: NodeJS.Timeout | undefined

function recoverUpdateAttempt(): void {
  if (quittingAllSessions) return
  clearTimeout(updateQuitTimer)
  if (preparingUpdate) { updatePreparationFailed = true; return }
  installInProgress = false
  explicitQuitRequested = false
  usageService?.resumeCollection()
  updateController?.installationDidNotQuit()
  refreshMenus()
}

function startUsageCollection(): void {
  if (usageService || quittingAllSessions) return
  usageService = new UsageService(join(app.getPath('userData'), 'usage.sqlite'), process.env.COPILOT_HOME || join(app.getPath('home'), '.copilot'),
    (message) => { void writeAppLog(`Usage: ${message}`).catch(() => {}) })
}

async function bestEffortUsage(work: Promise<unknown> | undefined): Promise<void> {
  try { await withShutdownDeadline(work ?? Promise.resolve(), 15_000) }
  catch (error) { void writeAppLog(`Usage maintenance failed: ${String(error)}`).catch(() => {}) }
}
import { truncateUtf8 } from './utf8.js'

const { autoUpdater } = electronUpdater
const BACKGROUND_START_ARGUMENT = '--background'
const PACKAGE_SMOKE_ENVIRONMENT = 'COPILOT_DESKTOP_PACKAGE_SMOKE'
const PACKAGE_SMOKE_READY_MARKER = '[package-smoke] renderer-ready'
// Packaged smoke runs must never read/write the user's normal desktop profile.
if (app.isPackaged && process.env[PACKAGE_SMOKE_ENVIRONMENT] === '1') {
  const isolatedDirectory = app.commandLine.getSwitchValue('user-data-dir')
  if (!isolatedDirectory) throw new Error('Packaged smoke requires an isolated user-data-dir')
  app.setPath('userData', resolve(isolatedDirectory))
}
const GLOBAL_TOGGLE_SHORTCUT = 'CommandOrControl+Alt+H'
const GLOBAL_TOGGLE_SHORTCUT_LABEL = process.platform === 'darwin' ? 'Command+Alt+H' : 'Ctrl+Alt+H'
const RELEASES_URL = 'https://github.com/xuemin-liu/copilot-cli-desktop/releases'
const MAX_SESSION_TABS = 20
const COPILOT_RESOLUTION_REFRESH_DELAYS_MS = [10_000, 60_000, 5 * 60_000] as const

let mainWindow: BrowserWindow | null = null
const sessionBrowsers = new Map<string, BrowserDebug>()
const logBrowserError = (message: string): void => { void writeAppLog(message).catch(() => {}) }
// Shared by every session's browser and kept across launches, like one Chrome profile.
let browserHistory: BrowserHistory | null = null
const sharedBrowserHistory = (): BrowserHistory => browserHistory ??= new BrowserHistory(
  join(app.getPath('userData'), 'browser-history.json'), logBrowserError)
let sitePermissions: SitePermissions | null = null
const sharedSitePermissions = (): SitePermissions => sitePermissions ??= new SitePermissions(undefined,
  { file: join(app.getPath('userData'), 'browser-permissions.json'), reportError: logBrowserError })
let browserZoom: BrowserZoom | null = null
const sharedBrowserZoom = (): BrowserZoom => browserZoom ??= new BrowserZoom(join(app.getPath('userData'), 'browser-zoom.json'), logBrowserError)
const closingBrowserTabs = new Set<string>()
const sessionWindows = new Map<string, BrowserWindow>()
const sessionOutputSequences = new Map<string, number>()
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let credentialStore: SecureCredentialStore | null = null
let updateController: DesktopUpdateController | null = null
let updateCheckTimer: NodeJS.Timeout | null = null
let copilotResolutionRefreshTimer: NodeJS.Timeout | null = null
let copilotResolutionProbePromise: Promise<{ resolution: CopilotResolution; sequence: number }> | null = null
let copilotResolutionProbeSequence = 0
let copilotResolutionRefreshFailureState = EMPTY_RESOLUTION_REFRESH_FAILURE_STATE
let installInProgress = false
let quittingAllSessions = false
let explicitQuitRequested = false
let trayHintShown = false
let closePromptWindow: BrowserWindow | null = null
let closePromptAbort: AbortController | null = null
let quitAfterClosePrompt = false
let desktopConfig: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG }
let configWriteQueue: Promise<void> = Promise.resolve()
/** Set when an unreadable desktop.json could not be preserved: never replace the only copy. */
let configWritesBlocked = false
let appLogWriteQueue: Promise<void> = Promise.resolve()
let nextTabSequence = 1
let copilotCapabilities: CopilotCapabilities = { ...EMPTY_COPILOT_CAPABILITIES }
let capabilityProbeGeneration = 0
let capabilityProbe: {
  resolution: CopilotResolution
  generation: number
  promise: Promise<CopilotCapabilities>
} | null = null
let copilotMaintenance: CopilotMaintenanceState = { ...DEFAULT_COPILOT_MAINTENANCE_STATE }
let copilotResources: CopilotResourcesState = { ...DEFAULT_COPILOT_RESOURCES_STATE }

interface ManagedTab {
  session: PtySession
}

let tabsState: TabsState = EMPTY_TABS_STATE
const managedTabs = new Map<string, ManagedTab>()
// An unloaded profile is not an empty profile. Keep saved entries until their
// replacement process starts successfully, including across failed attempts.
const profilesWithSessionTabs = new Set<string>()
const unrestoredProfileTabs = new Map<string, RestoredTab[]>()
const activityBroadcastTimers = new Map<string, NodeJS.Timeout>()
/** Per dormant tab: the read of the folder its saved session started in, until it settles. Until then the tab may still
 * resume in any worktree, so nothing may treat that worktree as unused. */
const dormantFolderReads = new Map<string, Promise<void>>()
/** Per tab: the number of the latest cwd event, so an older inspection that finishes later cannot overwrite a newer one. */
const sessionCwdGenerations = new Map<string, number>()
/** Per tab: the git directory of the worktree it runs in, so its HEAD can be read again when the branch changes. */
const sessionWorktreeGitDirs = new Map<string, string>()
const WORKTREE_BRANCH_POLL_MS = 5_000
/** How often tab titles and Copilot session names are compared; Copilot has no event for a name. */
const SESSION_NAME_POLL_MS = 3_000

// The Git panel's service. Created on first use, and never again once shutdown starts, so no git process can
// start while the app is closing. It runs git only while a renderer has the panel open.
let gitService: GitService | null = null
let gitServiceStopped = false
/** Ask the main window to open or close the Git panel (keyboard shortcut, including from the native browser view). */
function toggleGitPanel(): void {
  const window = mainWindow
  if (window && !window.isDestroyed()) window.webContents.send('desktop:git-toggle')
}
/** Ask the main window for its new-session dialog, where the session is named before it starts (menu and tray). */
// Mirrors the renderer's saved choice so the View menu can check the right items.
let sidebarView: SidebarView = { group: 'workspace', order: 'manual' }

function requestSidebarView(change: Partial<SidebarView>): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  window.webContents.send('desktop:sidebar-view-request', change)
}

function requestSessionHistory(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  restoreMainWindow()
  window.webContents.send('desktop:session-history-request')
}

function requestNewSession(attachments: boolean): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  restoreMainWindow()
  window.webContents.send('desktop:new-session-request', attachments)
}

/** Repositories sessions were asked to resolve a pull in (Resolve with Copilot). */
const gitResolvers = new GitResolverClaims()

/** Whether a session is in the middle of something (a turn, an approval, starting up), idle, or no longer running at all. */
function sessionStateOf(tabId: string): SessionState {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  if (!tab || !managedTabs.has(tabId) || (tab.status !== 'starting' && tab.status !== 'running' && tab.status !== 'approval-needed')) return 'gone'
  return tab.status === 'starting' || tab.status === 'approval-needed' || tab.activity === 'working' ? 'busy' : 'idle'
}

/** What the person accepted about repositories' Git settings, shared by the Git panel and meetings so one answer counts in both. */
let sharedGitTrust: GitTrustStore | null = null
function gitTrustStore(): GitTrustStore {
  sharedGitTrust ??= new GitTrustStore(join(app.getPath('userData'), 'git-trust.json'))
  return sharedGitTrust
}

/** A hardened Git runner, as the Git panel has, for the changes an outside host attaches; null without Git. */
let meetingRunner: Promise<GitRunner | null> | null = null
function meetingGitRunner(): Promise<GitRunner | null> {
  meetingRunner ??= resolveGitExecutable().then((executable) => executable?.supported
    ? new GitRunner({ gitPath: executable.path, hooksDirectory: join(app.getPath('userData'), 'git-no-hooks') })
    : null)
  // Git installed later is found on the next try.
  void meetingRunner.then((runner) => { if (!runner) meetingRunner = null })
  return meetingRunner
}

function gitServiceInstance(): GitService | null {
  if (gitServiceStopped || shuttingDown()) return null
  gitService ??= new GitService({
    getRuntime: async () => {
      const executable = await resolveGitExecutable()
      return executable ? { executable, runner: new GitRunner({ gitPath: executable.path, hooksDirectory: join(app.getPath('userData'), 'git-no-hooks') }) } : null
    },
    trustStore: gitTrustStore(),
    resolveProject: (profileId) => desktopConfig.profiles.find((profile) => profile.id === profileId)?.path ?? null,
    onProgress: (subscriberId, profileId, event) => {
      const window = mainWindow
      if (window && !window.isDestroyed() && window.webContents.id === subscriberId) window.webContents.send('desktop:git-progress', { profileId, event })
    },
    onChanged: (subscriberId, profileId, view) => {
      const window = mainWindow
      if (window && !window.isDestroyed() && window.webContents.id === subscriberId) window.webContents.send('desktop:git-changed', { profileId, view })
    },
    // A branch switch rewrites files, so it is refused while a session in the project is working and otherwise confirmed in a native window.
    sessionActivity: (profileId) => projectActivity(tabsState.tabs, profileId, Date.now()),
    // A repository a session was asked to resolve a pull in: the panel's writes there wait for it.
    resolverFor: (folder) => gitResolvers.forFolder(folder, sessionStateOf),
    // Folders the profile's sessions report running in; the service lists those that are worktrees of its repositories.
    sessionWorktrees: (profileId) => tabsState.tabs.flatMap((tab) => tab.workspaceProfileId === profileId && tab.sessionCwd ? [tab.sessionCwd] : []),
    // Every live session of the app, whichever profile it belongs to (a worktree can be another profile's workspace), with its
    // folder when known: a worktree removal is refused while one runs there or has not said. A dormant tab counts only
    // where its saved session started, since that is where it resumes; one with no stored session runs nowhere yet, and
    // one whose saved folder is still being read has not said.
    liveSessionFolders: () => tabsState.tabs.flatMap((tab) => tab.status === 'dormant'
      ? (tab.sessionCwd ? [tab.sessionCwd] : dormantFolderReads.has(tab.id) ? [null] : [])
      : tab.status !== 'completed' && tab.status !== 'crashed' ? [tab.sessionCwd ?? null] : []),
    // Discarding saves a copy of each tracked file here first, and sends untracked files to the Recycle Bin (never deletes them outright).
    snapshotDirectory: join(app.getPath('userData'), 'git-discarded'),
    trash: (absolutePath) => shell.trashItem(absolutePath),
    confirm: async (_profileId, request) => {
      const window = mainWindow
      if (!window || window.isDestroyed()) return false
      const answer = await dialog.showMessageBox(window, {
        type: request.danger ? 'warning' : 'question', buttons: [request.confirmLabel, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        title: request.title, message: request.title, detail: request.detail,
      })
      return answer.response === 0
    },
    // Hidden or minimized windows (including tray mode), shutdown and migration all pause refreshing.
    shouldPause: () => shuttingDown() || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized(),
  })
  return gitService
}

// Serializes every operation that stops/replaces/removes a tab's managed
// session (restart, close, and the global stop-all used by quit/update
// install) against every other one on the *same* tab. Restart alone is
// reachable from several entry points at once (the tab button, the app menu
// accelerator, the tray menu, direct IPC); close can race a restart that's
// already in flight; and a global shutdown can race either one. Without this,
// two such operations can both capture the same managed session, and
// whichever finishes last either orphans a live, untracked Copilot PTY (a
// second restart, or a shutdown snapshot taken before a restart's
// replacement is registered), or resets managedTabs for a tab another
// operation already deleted from tabsState — a replacement process nothing
// can ever reach again.
//
// A caller queued behind another one simply waits for it to settle (success
// or failure, via the leading .catch(() => {})) before running, rather than
// being rejected outright — closing a tab mid-restart should work once the
// restart finishes, not fail and strand the user's click.
const tabTransitionQueue = new Map<string, Promise<unknown>>()

function queueTabTransition<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tabTransitionQueue.get(tabId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(fn)
  tabTransitionQueue.set(tabId, next)
  void next.catch(() => {}).finally(() => {
    if (tabTransitionQueue.get(tabId) === next) tabTransitionQueue.delete(tabId)
  })
  return next
}

/** True once a global shutdown (quit or update install) has started stopping
 * every session — checked before *admitting* a new restart so shutdown can't
 * be raced by one that slips into the per-tab queue just ahead of it (a
 * pointless spawn immediately followed by stopAllSessions killing it). */
function shuttingDown(): boolean {
  return installInProgress || quittingAllSessions || explicitQuitRequested || migrationService?.exclusive === true
}

/** The in-flight restart promise for a tab, if any. A rapid double-click (two
 * `click` events before the first restart has changed the tab's status), or
 * the same restart being triggered again from the menu/tray/IPC while one is
 * already running, must not both be admitted to tabTransitionQueue: the
 * second would run right after the first finishes and immediately stop the
 * replacement PTY the first just started, causing a pointless second restart
 * (and another chance to lose continuity). restartSessionTab() returns this
 * same promise to every caller instead of queueing a second one — unlike
 * Close, which still needs to run once the restart it's queued behind
 * finishes, a second Restart on the same tab is redundant with the first. */
const pendingRestarts = new Map<string, Promise<DesktopState>>()
const pendingProfileRestores = new Map<string, Promise<void>>()
const pendingForks = new Map<string, Promise<DesktopState>>()

function scheduleActivityBroadcast(tabId: string): void {
  if (activityBroadcastTimers.has(tabId)) return
  activityBroadcastTimers.set(tabId, setTimeout(() => {
    activityBroadcastTimers.delete(tabId)
    syncTabState()
    broadcastState()
  }, 1_000))
}

const state: DesktopState = {
  desktopVersion: 'unknown',
  resolution: null,
  profiles: [],
  activeProfileId: null,
  tabs: [],
  activeTabId: null,
  maxSessionTabs: MAX_SESSION_TABS,
  recentLogs: [],
  error: null,
}

function rendererPath(file: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer', file)
}

function preloadPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'preload', 'preload.cjs')
}

function settingsPreloadPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'preload', 'settings-preload.cjs')
}

function iconPath(): string {
  return join(app.getAppPath(), 'build', 'icon.png')
}

function shellUrl(): string {
  return pathToFileURL(rendererPath('index.html')).href
}

function settingsUrl(): string {
  return pathToFileURL(rendererPath('settings.html')).href
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent, migration = false): void {
  if (!migration && migrationService?.exclusive) throw new Error('Wait for migration to finish or cancel it in Settings')
  if (!isLauncherShellUrl(event.senderFrame?.url, shellUrl())) {
    throw new Error('Desktop IPC request rejected from an untrusted renderer')
  }
}

function assertTrustedSettingsSender(event: IpcMainInvokeEvent, migration = false): void {
  if (!migration && migrationService?.exclusive) throw new Error('Wait for migration to finish or cancel it')
  if (!isLauncherShellUrl(event.senderFrame?.url, settingsUrl())) {
    throw new Error('Settings IPC request rejected from an untrusted renderer')
  }
}

function configPath(): string {
  return join(app.getPath('userData'), 'desktop.json')
}

function protectedCredentialPath(): string {
  return join(app.getPath('userData'), 'protected-credentials.json')
}

// Tab ids (`tab-1`, `tab-2`, …) reset to 1 every launch, so scoping session
// logs under a per-launch directory keeps a later launch from silently
// appending to — and exposing — a previous launch's transcript at the same
// filename.
const launchId = randomUUID()
function browserSessionRoot(): string { return join(app.getPath('userData'), 'browser-sessions', launchId) }

function sessionLogPath(tabId: string): string {
  if (!isSessionTabId(tabId)) throw new Error('Invalid session tab')
  return join(app.getPath('userData'), 'logs', 'sessions', launchId, `${tabId}.log`)
}

function appLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'app.log')
}

function writeAppLog(line: string): Promise<void> {
  const operation = appLogWriteQueue.then(() => appendBoundedLog(
    appLogPath(),
    `${new Date().toISOString()} ${line}\n`,
  ))
  appLogWriteQueue = operation.catch(() => undefined)
  return appLogWriteQueue
}

const MAX_SESSION_LOG_BYTES = 5 * 1024 * 1024
const sessionLogBytesWritten = new Map<string, number>()
const sessionLogWriteQueues = new Map<string, Promise<void>>()

async function appendSessionLog(tabId: string, chunk: string): Promise<void> {
  const written = sessionLogBytesWritten.get(tabId) ?? 0
  if (written >= MAX_SESSION_LOG_BYTES) return
  const filename = sessionLogPath(tabId)
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  if (written + chunkBytes <= MAX_SESSION_LOG_BYTES) {
    await appendFile(filename, chunk, { encoding: 'utf8', mode: 0o600 })
    sessionLogBytesWritten.set(tabId, written + chunkBytes)
    return
  }
  const truncated = truncateUtf8(chunk, MAX_SESSION_LOG_BYTES - written)
  await appendFile(filename, `${truncated}\n[log truncated at ${MAX_SESSION_LOG_BYTES} bytes]\n`, { encoding: 'utf8', mode: 0o600 })
  sessionLogBytesWritten.set(tabId, MAX_SESSION_LOG_BYTES)
}

configureWindowsProcessWatchdogReporter((message) => void writeAppLog(message))

function writeSessionLog(tabId: string, chunk: string): Promise<void> {
  const previous = sessionLogWriteQueues.get(tabId) ?? Promise.resolve()
  const operation = previous.then(() => appendSessionLog(tabId, chunk))
  const tracked = operation.catch(() => undefined)
  sessionLogWriteQueues.set(tabId, tracked)
  void tracked.finally(() => {
    if (sessionLogWriteQueues.get(tabId) === tracked) sessionLogWriteQueues.delete(tabId)
  })
  return operation
}

function snapshot(windowSessionId?: string): DesktopState {
  return {
    ...state,
    poppedOutTabIds: [...sessionWindows.keys()],
    ...(windowSessionId ? { windowSessionId } : {}),
    profiles: state.profiles.map((profile) => ({ ...profile, tabs: profile.tabs.map((tab) => ({ ...tab })) })),
    tabs: state.tabs.map((tab) => ({ ...tab })),
    recentLogs: [...state.recentLogs],
    newSessionPrivateOverrides: desktopConfig.browserOverrides === 'private',
    meetings: meetingViews(),
    meetingToolsUrl: guestMcp.url(),
  }
}

function syncWorkspaceState(): void {
  state.profiles = desktopConfig.profiles.map((profile) => ({ ...profile }))
  state.activeProfileId = desktopConfig.activeProfileId
}

function syncTabState(): void {
  state.tabs = tabsState.tabs.map((tab) => ({ ...tab }))
  state.activeTabId = tabsState.activeTabId
}

function broadcastState(): void {
  const visible = visibleSessionTabs(tabsState)
  for (const [tabId, browser] of sessionBrowsers) {
    if (!sessionWindows.has(tabId) && tabId !== visible.main?.id && tabId !== visible.side?.id) browser.setBounds(null)
  }
  // A restored tab starts the first time it is on screen.
  for (const tabId of [visible.main?.id, visible.side?.id, ...sessionWindows.keys()]) if (tabId) void wakeDormantTab(tabId)
  const window = mainWindow
  if (window && !window.isDestroyed() && isLauncherShellUrl(window.webContents.getURL(), shellUrl())) {
    window.webContents.send('desktop:state-changed', snapshot())
  }
  for (const [tabId, popout] of sessionWindows) {
    if (!popout.isDestroyed() && isLauncherShellUrl(popout.webContents.getURL(), shellUrl())) {
      popout.setTitle(`${state.tabs.find(tab => tab.id === tabId)?.title ?? 'Session'} — Copilot CLI Desktop`)
      popout.webContents.send('desktop:state-changed', snapshot(tabId))
    }
  }
}

function sessionWindowId(sender: IpcMainInvokeEvent['sender']): string | undefined {
  return [...sessionWindows].find(([, window]) => window.webContents === sender)?.[0]
}

// Ownership changes synchronously, before either renderer processes its next
// state update. Ignore stale input/resize messages from the previous terminal.
function ownsSessionTerminal(event: IpcMainInvokeEvent, tabId: string): boolean {
  return (sessionWindows.get(tabId) ?? mainWindow)?.webContents === event.sender
}

function focusSessionWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function popOutSessionTab(tabId: string): DesktopState {
  if (shuttingDown()) throw new Error('The application is shutting down')
  const tab = tabsState.tabs.find(tab => tab.id === tabId)
  if (!tab) throw new Error('Unknown session tab')
  const existing = sessionWindows.get(tabId)
  if (existing) { focusSessionWindow(existing); return snapshot() }
  const window = new BrowserWindow({
    width: 1000, height: 760, minWidth: 500, minHeight: 360,
    show: false, backgroundColor: '#0b1020', icon: iconPath(),
    title: `${tab.title} — Copilot CLI Desktop`,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged },
  })
  sessionWindows.set(tabId, window)
  sessionBrowsers.get(tabId)?.setOwner(window)
  window.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) sessionBrowsers.get(tabId)?.setOwner(mainWindow)
  })
  // Keep the session name authoritative even when the shared HTML loads or
  // changes its document title while this session is idle.
  window.on('page-title-updated', event => event.preventDefault())
  window.on('focus', refreshMenus)
  window.setMenu(null)
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== shellUrl()) event.preventDefault() })
  window.webContents.on('render-process-gone', () => {
    if (mainWindow && !mainWindow.isDestroyed()) sessionBrowsers.get(tabId)?.setOwner(mainWindow)
    if (!window.isDestroyed()) window.destroy()
  })
  window.once('ready-to-show', () => { if (!window.isDestroyed()) focusSessionWindow(window) })
  window.on('closed', () => {
    if (sessionWindows.get(tabId) !== window) return
    sessionWindows.delete(tabId)
    if (!shuttingDown() && tabsState.tabs.some(tab => tab.id === tabId)) activateSessionTab(tabId)
    else broadcastState()
  })
  broadcastState()
  observe(window.loadFile(rendererPath('index.html')).catch(error => {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }), 'Could not open session window')
  return snapshot()
}

function dockSessionTab(tabId: string): DesktopState {
  sessionWindows.get(tabId)?.close()
  return snapshot()
}

/**
 * `change`, when given, runs when this write's turn comes, right before the config is copied, and
 * `onFailure` undoes it before the next queued write copies the config: a change that fails to save
 * is never written by another write.
 */
async function persistConfig(change?: () => void, onFailure?: () => void): Promise<void> {
  if (configWritesBlocked) {
    change?.()
    return
  }
  const { operation, queue } = queueConfigWrite(
    configWriteQueue,
    () => {
      change?.()
      return writeDesktopConfig(configPath(), structuredClone(desktopConfig))
    },
    onFailure,
  )
  configWriteQueue = queue
  await operation
}

/**
 * Tabs from an inactive profile keep running in the background (switching
 * profiles does not stop them), so a tab whose state just changed may not
 * belong to the currently active profile. Re-derive every profile's
 * persisted tab list from the live tab state rather than only touching
 * `activeWorkspaceProfile()`, so a change to a background tab is not lost —
 * and does not get papered over by whichever profile happens to be active
 * when this runs.
 */
function persistProfileTabs(): void {
  for (const profile of desktopConfig.profiles) {
    if (!profilesWithSessionTabs.has(profile.id)) continue
    profile.tabs = tabsState.tabs
      .filter((tab) => tab.workspaceProfileId === profile.id && !tab.remote)
      .map((tab) => {
        const parentSessionId = tabsState.tabs.find((parent) => parent.id === tab.sideParentTabId)?.lastSessionId
        return {
          title: tab.title,
          lastSessionId: tab.lastSessionId,
          ...(tab.launchWorktree !== undefined ? { launchWorktree: tab.launchWorktree } : {}),
          ...(tab.launchWorktreePath ? { launchWorktreePath: tab.launchWorktreePath } : {}),
          ...(tab.privateOverrides ? { privateOverrides: true as const } : {}),
          ...(tab.autoTitle !== undefined ? { autoTitle: tab.autoTitle } : {}),
          ...(tab.renamePending ? { renamePending: true as const } : {}),
          ...(tab.browserProfileId ? { browserProfileId: tab.browserProfileId } : {}),
          ...(tab.sessionPermissionPreset ? { sessionPermissionPreset: tab.sessionPermissionPreset } : {}),
          ...(tab.lastSessionId && tab.sessionPermissionMode && !tab.sideChat
            ? { sessionPermissionMode: tab.sessionPermissionMode }
            : {}),
          ...(tab.sideChat ? { sideChat: true as const } : {}),
          ...(parentSessionId ? { sideParentSessionId: parentSessionId } : {}),
        }
      }).concat(unrestoredProfileTabs.get(profile.id) ?? [])
  }
  void persistConfig().catch((error) => void writeAppLog(`Failed to save session tabs: ${String(error)}`))
}

function loginItemOptions(): { path: string; args: string[] } {
  // An AppImage runs from a temporary mount; APPIMAGE names the file to start next time.
  return { path: process.platform === 'linux' && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath, args: [BACKGROUND_START_ARGUMENT] }
}

function launchAtLoginAvailable(): boolean {
  return app.isPackaged
}

function launchAtLoginEnabled(): boolean {
  if (!launchAtLoginAvailable()) return false
  if (process.platform === 'linux') return linuxAutostartEnabled()
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin
}

function setLaunchAtLogin(enabled: boolean): void {
  if (!launchAtLoginAvailable()) throw new Error('Launch at login is available in installed builds.')
  const options = loginItemOptions()
  if (process.platform === 'linux') setLinuxAutostart(enabled, options.path, options.args)
  else app.setLoginItemSettings({ openAtLogin: enabled, ...options })
}

function applyGlobalShortcut(enabled: boolean): void {
  globalShortcut.unregister(GLOBAL_TOGGLE_SHORTCUT)
  if (!enabled) return
  globalShortcut.register(GLOBAL_TOGGLE_SHORTCUT, () => {
    const window = mainWindow
    if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) {
      window.hide()
      return
    }
    restoreMainWindow()
  })
}

function restoreMainWindow(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function showNotification(title: string, body: string, onClick = restoreMainWindow): void {
  if (!desktopConfig.notifications || !Notification.isSupported()) return
  const notification = new Notification({ title, body, icon: iconPath() })
  notification.on('click', onClick)
  notification.show()
}

function hideWindowToTray(window: BrowserWindow): boolean {
  if (!tray || tray.isDestroyed() || window.isDestroyed()) return false
  window.hide()
  if (!trayHintShown) {
    trayHintShown = true
    showNotification(
      'Copilot CLI Desktop is still running',
      'Windows may place its icon under Show hidden icons in the notification area.',
    )
  }
  return true
}

async function rememberCloseBehavior(closeBehavior: CloseBehavior): Promise<void> {
  desktopConfig.closeBehavior = closeBehavior
  try {
    await persistConfig()
  } catch (error) {
    await writeAppLog(`Failed to save close behavior: ${String(error)}`).catch(() => {})
  }
  broadcastSettingsPreferences()
}

function finishClosePrompt(window: BrowserWindow, owner: AbortController | null): void {
  if (closePromptWindow !== window || closePromptAbort !== owner) return
  closePromptWindow = null
  closePromptAbort = null
  const shouldResumeQuit = quitAfterClosePrompt && explicitQuitRequested
  quitAfterClosePrompt = false
  if (shouldResumeQuit) setImmediate(() => app.quit())
}

function dismissClosePromptForUpdate(): void {
  closePromptAbort?.abort()
  closePromptAbort = null
  closePromptWindow = null
  quitAfterClosePrompt = false
}

async function promptForWindowClose(window: BrowserWindow): Promise<void> {
  if (closePromptWindow || window.isDestroyed()) return
  closePromptWindow = window
  const abort = new AbortController()
  closePromptAbort = abort
  try {
    const canMinimizeToTray = tray !== null && !tray.isDestroyed()
    const buttons = canMinimizeToTray
      ? ['Exit application', 'Minimize to tray', 'Cancel']
      : ['Exit application', 'Cancel']
    const result = await dialog.showMessageBox(window, {
      signal: abort.signal,
      type: 'question',
      title: 'Close Copilot CLI Desktop',
      message: 'What should happen when this window closes?',
      detail: canMinimizeToTray
        ? 'Minimizing keeps Copilot sessions running. Windows may place the app icon under Show hidden icons in the notification area.'
        : 'The tray icon is disabled, so the application cannot remain available in the notification area.',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
      checkboxLabel: 'Remember my choice',
      checkboxChecked: false,
    })

    if (window.isDestroyed()) return
    // Process this dialog's own Exit response before honoring a quit that
    // was already in flight (for example, quitAndInstall). If that earlier
    // updater quit fails and clears explicitQuitRequested while a remembered
    // preference is being persisted, requestExplicitQuit below reasserts the
    // user's independent Exit choice.
    if (result.response === 0) {
      if (result.checkboxChecked) await rememberCloseBehavior('quit')
      await requestExplicitQuit()
      return
    }
    if (explicitQuitRequested) return
    if (canMinimizeToTray && result.response === 1) {
      // The independent Settings window can disable and destroy the tray
      // while this native dialog is open. Re-check immediately before the
      // synchronous hide so that choice can never strand the main window.
      if (!tray || tray.isDestroyed()) {
        await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'Tray icon unavailable',
          message: 'The window was not minimized.',
          detail: 'The tray icon was disabled while the close dialog was open. Enable it in Desktop Settings before minimizing to the tray.',
          buttons: ['OK'],
          defaultId: 0,
        })
        return
      }
      if (!hideWindowToTray(window)) return
      if (result.checkboxChecked) await rememberCloseBehavior('tray')
    }
  } catch (error) {
    if (!explicitQuitRequested && !window.isDestroyed()) {
      await writeAppLog(`Close dialog failed: ${String(error)}`).catch(() => {})
    }
  } finally {
    finishClosePrompt(window, abort)
  }
}

// `state.resolution?.version !== null` is true both when resolution
// succeeded AND while it hasn't run yet (resolution is null, so the
// optional-chain short-circuits to `undefined`, and `undefined !== null`).
// Callers that mean "copilot was found" must check both explicitly.
function isCopilotResolved(): boolean {
  return state.resolution !== null && state.resolution.version !== null
}

function trayStatusLabel(): string {
  const running = tabsState.tabs.filter((tab) => tab.status === 'running' || tab.status === 'approval-needed').length
  if (state.resolution?.version === null) return 'copilot CLI not found'
  if (tabsState.tabs.length === 0) return 'No sessions running'
  return `${running}/${tabsState.tabs.length} session(s) active`
}

function activeAccessLabel(): string {
  const activeTab = tabsState.tabs.find((candidate) => candidate.id === tabsState.activeTabId)
  if (activeTab?.remote) return 'Unknown (remote session)'
  const preset = activeTab?.sessionPermissionPreset
    ?? activeWorkspaceProfile(desktopConfig)?.permissionPreset
    ?? 'default'
  return describeSessionPermission(preset, activeTab?.sessionPermissionMode ?? null).label
}

// A remote tab has no workspace-profile launch config to rebuild against, so
// restartSessionTab always rejects it — keep every entry point (menu, tray,
// the tab button) consistently disabled for one instead of only some of them
// surfacing that as a runtime error.
function activeTabIsRestartable(): boolean {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabsState.activeTabId)
  return tab !== undefined && !tab.remote
}

/**
 * Rebuilds both the tray menu and the application menu. The two menus share
 * enabled/disabled state derived from `installInProgress`, the active
 * profile, and the tab list — call this (not `rebuildTrayMenu` alone)
 * whenever any of those change, or the application menu's "New/Close Session
 * Tab" items go stale (e.g. staying disabled after a workspace is selected).
 */
function refreshMenus(): void {
  rebuildTrayMenu()
  if (Menu.getApplicationMenu()) installApplicationMenu()
}

function rebuildTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return
  const accessLabel = tabsState.activeTabId ? 'Active session access' : 'Profile startup access'
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Copilot CLI Desktop', click: restoreMainWindow },
    { label: trayStatusLabel(), enabled: false },
    { label: `${accessLabel}: ${activeAccessLabel()}`, enabled: false },
    { type: 'separator' },
    {
      label: 'New Session Tab',
      enabled: !installInProgress && desktopConfig.activeProfileId !== null && tabsState.tabs.length < MAX_SESSION_TABS,
      click: () => requestNewSession(false),
    },
    {
      label: 'Restart Active Session',
      enabled: !shuttingDown() && activeTabIsRestartable(),
      click: () => tabsState.activeTabId && observe(restartSessionTab(tabsState.activeTabId), 'Could not restart session tab'),
    },
    {
      label: 'Show Active Session Log',
      enabled: tabsState.activeTabId !== null,
      click: () => tabsState.activeTabId && observe(showSessionLog(tabsState.activeTabId), 'Could not show session log'),
    },
    { label: 'Desktop Settings…', click: () => observe(showSettingsWindow(), 'Could not open Settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => void requestExplicitQuit() },
  ]))
}

function updateTrayVisibility(): void {
  if (desktopConfig.trayEnabled && !tray) {
    // macOS draws menu-bar icons at their pixel size, so the window icon would fill the bar.
    tray = new Tray(process.platform === 'darwin' ? nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 }) : iconPath())
    tray.setToolTip('Copilot CLI Desktop')
    tray.on('click', restoreMainWindow)
    rebuildTrayMenu()
  } else if (!desktopConfig.trayEnabled) {
    // Restore a hidden window only when this call is actually removing a
    // live tray at runtime. At startup tray is null; showing there would
    // defeat --background and bypass the ready-to-show flash guard.
    if (!tray) return
    tray.destroy()
    tray = null
    const window = mainWindow
    if (window && !window.isDestroyed() && !window.isVisible()) restoreMainWindow()
  }
}

async function requestExplicitQuit(): Promise<void> {
  explicitQuitRequested = true
  app.quit()
}

async function showSessionLog(tabId: string): Promise<void> {
  const filename = sessionLogPath(tabId)
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  await appendFile(filename, '', { encoding: 'utf8', mode: 0o600 })
  shell.showItemInFolder(filename)
}

async function showApplicationLog(): Promise<void> {
  const filename = appLogPath()
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  await appendFile(filename, '', { encoding: 'utf8', mode: 0o600 })
  shell.showItemInFolder(filename)
}

function copyDiagnosticsToClipboard(): void {
  const snap = snapshot()
  clipboard.writeText(formatDesktopDiagnostics({
    desktopVersion: snap.desktopVersion,
    resolution: snap.resolution,
    activeWorkspace: activeWorkspaceProfile(desktopConfig)?.path ?? null,
    tabs: snap.tabs,
    recentLogs: snap.recentLogs,
    error: snap.error,
  }))
}

function handleDesktopEvent(tabId: string, event: DesktopEvent): void {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  const title = tab?.title ?? 'Copilot session'
  const popout = sessionWindows.get(tabId)
  const window = popout ?? mainWindow
  const isFocusedOnThisTab = Boolean(window?.isFocused()) && (Boolean(popout) || tabsState.activeTabId === tabId)
  if (isFocusedOnThisTab) return
  const openTab = (): void => {
    if (tabsState.tabs.some((candidate) => candidate.id === tabId)) {
      activateSessionTab(tabId)
    } else {
      restoreMainWindow()
    }
  }
  if (event.type === 'approval-needed') {
    showNotification('Copilot needs approval', `"${title}" is waiting for your approval.`, openTab)
  } else if (event.type === 'session-completed') {
    showNotification('Copilot session finished', `"${title}" finished.`, openTab)
  } else if (event.type === 'session-crashed') {
    showNotification('Copilot session stopped', `"${title}" stopped unexpectedly.`, openTab)
  }
}

interface SessionSpawnPlan {
  file: string
  cliVersion: string
  cwd: string
  env: NodeJS.ProcessEnv
  prefixArgs: string[]
  attachmentPaths: string[]
  launch: SessionLaunchConfig
  permissionPreset: PermissionPreset
  permissionCapabilities: { toolAllowlist: boolean }
  secretArgs: string[]
  connectSessionId: string | null
  sessionTitle: string
  /** False when nobody named the session: no `--name`, so Copilot names it from the first prompt. */
  nameSession?: boolean
  /** A fresh launch takes this id instead of a new one: a session that was never stored keeps its id. */
  sessionId?: string
}

/**
 * Copilot stores a session started without `--name` only once it gets its first prompt, so a tab that was opened and
 * never used has an id Copilot does not know, and resuming it would fail. Such a tab starts fresh under the same id.
 */
async function copilotSessionStored(sessionId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return true
  try { await access(join(copilotSessionRoot(process.env), sessionId, 'events.jsonl')); return true } catch { return false }
}

/** Throws if the launch options a *fresh-vs-resume* choice would produce
 * aren't supported by this Copilot CLI. `buildSessionLaunchArgs` is pure/sync
 * (`--worktree` is its only freshSession-dependent flag), so this is cheap
 * enough to run twice: once as an early, best-guess check in
 * buildSessionSpawnPlan (before touching any existing process), and again
 * inside finalizeSessionArgs against whichever freshSession turns out to be
 * true once the final resume id is known. */
function validateLaunchOptions(launch: SessionLaunchConfig, connectSessionId: string | null, freshSession: boolean): void {
  const launchArgs = buildSessionLaunchArgs(
    connectSessionId ? { ...launch, remoteControl: 'inherit', remoteExport: 'inherit' } : launch,
    freshSession,
  )
  if (launchArgs.length > 0 && copilotCapabilities.probeFailed) {
    throw new Error('Could not determine Copilot CLI capabilities. Retry CLI detection from Settings before starting a session.')
  }
  const unsupportedLaunchOptions = launchArgs.filter((argument) => (
    argument.startsWith('--') && !copilotCapabilities.supportedOptions.includes(argument)
  ))
  if (unsupportedLaunchOptions.length > 0) {
    throw new Error(
      `This Copilot CLI version does not support ${[...new Set(unsupportedLaunchOptions)].join(', ')}; update it or change the workspace launch profile`,
    )
  }
}

/**
 * Resolves a profile's current settings (permission preset, launch config,
 * provider config, credentials) into everything a `PtySession` spawn needs
 * *except* the parts that depend on whether the launch is actually starting
 * fresh or resuming a conversation — see finalizeSessionArgs() for those.
 * Shared by session creation and restart. Callers pass a profile snapshot
 * whose permission is the session-owned value; profile edits only affect new
 * sessions.
 */
async function buildSessionSpawnPlan(
  profile: WorkspaceProfile,
  resumeMode: ResumeMode,
  restoreLastSessionId: string | null,
  attachmentPaths: string[],
  connectSessionId: string | null,
  sessionTitle: string,
): Promise<SessionSpawnPlan> {
  await refreshCopilotResolutionIfChanged()
  // A tab started right after launch would otherwise be validated against empty capabilities while the startup
  // probe is still running, and be refused for a launch option the CLI does support.
  await capabilityProbe?.promise
  const resolution = state.resolution
  if (!resolution || resolution.version === null) {
    throw new Error('The copilot CLI is not available. Resolve it from the diagnostics screen first.')
  }
  if (connectSessionId && !copilotCapabilities.remoteSessions) {
    throw new Error('This Copilot CLI version does not support remote sessions; update it from Settings')
  }
  // Best-guess freshSession, so an unsupported launch option surfaces here,
  // before the existing process is touched, in the overwhelmingly common
  // case where the final freshSession (decided in finalizeSessionArgs, once
  // the true resume id is known) agrees with this guess.
  const likelyFreshSession = !connectSessionId
    && (resumeMode === 'new' || (resumeMode === 'auto-resume' && buildResumeArgs({ mode: resumeMode, lastSessionId: restoreLastSessionId }).length === 0))
  validateLaunchOptions(profile.launch, connectSessionId, likelyFreshSession)
  const vaultEnvironment = credentialStore ? await credentialStore.resolveEnvironment() : {}
  const inheritedEnvironment = { ...process.env, ...vaultEnvironment }
  const configuredEnvironment = providerEnvironment(desktopConfig.provider, inheritedEnvironment)
  const environment = withCopilotPathAdditions(
    { ...inheritedEnvironment, ...configuredEnvironment },
    resolution.pathAdditions,
  )
  return {
    file: resolution.command,
    cliVersion: resolution.version,
    cwd: profile.path,
    env: environment as NodeJS.ProcessEnv,
    prefixArgs: resolution.prefixArgs,
    attachmentPaths,
    launch: profile.launch,
    permissionPreset: profile.permissionPreset,
    permissionCapabilities: { toolAllowlist: copilotCapabilities.toolAllowlist },
    // This must receive the full environment that PtySession will pass to
    // Copilot, not only provider/vault overrides. Ambient credentials also
    // reach Copilot through PtySession's process.env merge and must be named
    // here so they are withheld from shell commands and MCP servers.
    secretArgs: secretEnvArgs(environment),
    connectSessionId,
    sessionTitle,
  }
}

/**
 * Everything that depends on whether the launch is actually starting fresh
 * or resuming a conversation — including which launch flags apply
 * (`--worktree` only makes sense for a fresh session) and the identity
 * segment (`--connect`, or `--session-id`+`--name`, or `--resume...`).
 * Pure and synchronous, so it's safe to call again after an async gap (e.g.
 * once a restart's old process has actually stopped and revealed a fresher
 * resume id) without redoing any of buildSessionSpawnPlan's fallible work —
 * and critical to call again rather than reusing an earlier freshSession
 * guess, since that guess and the final one can disagree.
 */
function finalizeSessionArgs(
  plan: SessionSpawnPlan,
  resumeMode: ResumeMode,
  restoreLastSessionId: string | null,
): { args: string[]; deterministicSessionId: string | null; worktreeName: string | null } {
  const resumeArgs = buildResumeArgs({ mode: resumeMode, lastSessionId: restoreLastSessionId })
  const freshSession = !plan.connectSessionId
    && (resumeMode === 'new' || (resumeMode === 'auto-resume' && resumeArgs.length === 0))
  validateLaunchOptions(plan.launch, plan.connectSessionId, freshSession)
  const launchArgs = buildSessionLaunchArgs(
    plan.connectSessionId ? { ...plan.launch, remoteControl: 'inherit', remoteExport: 'inherit' } : plan.launch,
    freshSession,
  )
  // Copilot refuses `--worktree` together with `--session-id`: a worktree session picks its own id, which the desktop
  // then reads back from the session store. `--name` is still accepted.
  const worktreeLaunch = freshSession && !plan.connectSessionId && plan.launch.worktree === true
  // The desktop names the worktree, so the session it starts can be told apart from any other by its cwd.
  const worktreeName = worktreeLaunch ? worktreeNameFor(plan.sessionTitle) : null
  const deterministicSessionId = freshSession && copilotCapabilities.sessionIdentity && !worktreeLaunch ? plan.sessionId ?? randomUUID() : restoreLastSessionId
  const name = plan.nameSession === false ? [] : [`--name=${plan.sessionTitle}`]
  const identity = plan.connectSessionId
    ? [`--connect=${plan.connectSessionId}`]
    : worktreeLaunch
      ? name
      : freshSession && deterministicSessionId
        ? [`--session-id=${deterministicSessionId}`, ...name]
        : resumeArgs
  const args = [
    ...plan.prefixArgs,
    // Copilot's top navigation (Sessions, Issues, Pull requests, Gists) is
    // mouse-driven. Enable its terminal mouse protocol explicitly so clicks
    // continue to work even if the CLI's default or saved setting is off.
    '--mouse=on',
    ...identity,
    ...plan.attachmentPaths.map((path) => `--attachment=${path}`),
    ...launchArgs.map((argument) => argument === '--worktree' && worktreeName ? `--worktree=${worktreeName}` : argument),
    ...(plan.connectSessionId
      ? []
      : buildPermissionArgs(plan.permissionPreset, plan.cwd, plan.permissionCapabilities)),
    ...plan.secretArgs,
  ]
  return { args, deterministicSessionId: worktreeLaunch ? null : deterministicSessionId, worktreeName }
}

/** The folder a session reports is data the CLI wrote: it is shown as a worktree only after the filesystem checks in
 * `inspectSessionWorktree` pass and the repository it belongs to lies inside the workspace folder. */
async function applySessionCwd(id: string, session: PtySession, cwd: string | null, generation: number): Promise<void> {
  const tab = tabsState.tabs.find((candidate) => candidate.id === id)
  const profile = tab ? desktopConfig.profiles.find((candidate) => candidate.id === tab.workspaceProfileId) : undefined
  const { worktree, gitDir } = await sessionWorktreeIn(profile, cwd)
  // A newer cwd event (or a log reset) for this tab has been applied meanwhile: this result is stale, and none of it,
  // the polling directory included, may take effect.
  if (managedTabs.get(id)?.session !== session || sessionCwdGenerations.get(id) !== generation) return
  if (gitDir) sessionWorktreeGitDirs.set(id, gitDir)
  else sessionWorktreeGitDirs.delete(id)
  tabsState = { ...tabsState, tabs: tabsState.tabs.map((candidate) => candidate.id === id ? { ...candidate, sessionCwd: cwd, worktree } : candidate) }
  syncTabState()
  broadcastState()
  if (profile) gitService?.requestRefresh(profile.id)
}

async function sessionWorktreeIn(profile: WorkspaceProfile | undefined, cwd: string | null): Promise<{ worktree: SessionWorktreeInfo | null; gitDir: string | null }> {
  if (!cwd || !profile) return { worktree: null, gitDir: null }
  const base = await realPathNative(profile.path).catch(() => profile.path)
  const within = (mainRoot: string): boolean => isSameOrInside(mainRoot, base)
  const found = await inspectSessionWorktree(cwd, within)
  return found ? { worktree: { path: found.root, name: found.name, branch: found.branch }, gitDir: found.gitDir } : { worktree: null, gitDir: null }
}

/** A dormant tab runs nowhere yet, but its session will resume in the folder it started in: read from the stored
 * `session.start` record so the sidebar, Git panel and worktree cleanup know it before the tab is first shown. */
async function applyDormantSessionCwd(id: string, sessionId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) return
  const start = await readSessionStart(join(copilotSessionRoot(process.env), sessionId, 'events.jsonl'))
  const tab = tabsState.tabs.find((candidate) => candidate.id === id)
  if (!start?.cwd || tab?.status !== 'dormant') return
  // The folder alone is enough to keep a worktree it resumes in; the worktree chip is extra.
  const { worktree } = await sessionWorktreeIn(desktopConfig.profiles.find((candidate) => candidate.id === tab.workspaceProfileId), start.cwd)
    .catch(() => ({ worktree: null }))
  // Woken meanwhile: the running session reports its own folder.
  if (tabsState.tabs.find((candidate) => candidate.id === id)?.status !== 'dormant') return
  tabsState = { ...tabsState, tabs: tabsState.tabs.map((candidate) => candidate.id === id ? { ...candidate, sessionCwd: start.cwd, worktree } : candidate) }
  syncTabState()
  broadcastState()
}

const FAN_OUT_MAX = 5
/** How long one fan-out session gets to report where it runs before the fan-out stops (tests shorten it). */
const FAN_OUT_WAIT_MS = Number(process.env.DESKTOP_FAN_OUT_WAIT_MS) > 0 ? Number(process.env.DESKTOP_FAN_OUT_WAIT_MS) : 90_000
let fanOutRunning = false

/**
 * Start the same task in several fresh sessions, each in its own worktree, one after another: the next one starts only
 * once the previous one has reported where it runs, because several `git worktree add` at once in one repository contend
 * for the same locks. If a session does not report in time the fan-out stops and says how many it started; it never
 * starts the next one blind. The prompt is not sent here: the renderer pastes it into each prompt box once the session is
 * ready, and the person presses Enter in each.
 */
async function fanOutSessions(profile: WorkspaceProfile, label: string, count: number): Promise<FanOutResult> {
  if (fanOutRunning) throw new Error('A fan-out is already starting sessions; wait for it to finish')
  if (!Number.isInteger(count) || count < 2 || count > FAN_OUT_MAX) throw new Error(`Fan out into 2 to ${FAN_OUT_MAX} sessions`)
  if (MAX_SESSION_TABS - tabsState.tabs.length < count) throw new Error(`Only ${Math.max(0, MAX_SESSION_TABS - tabsState.tabs.length)} more session tabs can be open`)
  if (!copilotCapabilities.supportedOptions.includes('--worktree')) throw new Error('This Copilot CLI version does not support worktrees, which a fan-out needs; update it from Settings')
  fanOutRunning = true
  const tabIds: string[] = []
  let stopped: string | null = null
  try {
    for (let index = 1; index <= count; index += 1) {
      // A fresh session in its own worktree, whatever the profile's own launch setting says. Another tab can be created
      // while this one is being prepared, so the id comes from the creation itself, never from a before/after diff.
      let createdId: string | null = null
      await createSessionTab({ ...profile, launch: { ...profile.launch, worktree: true } }, 'new', null, [], null, `${profile.name} ${index}/${count}`, {}, null, null, (tabId) => { createdId = tabId })
      const created = createdId === null ? undefined : tabsState.tabs.find((tab) => tab.id === createdId)
      if (!created) { stopped = 'The session tab could not be found after it started.'; break }
      tabIds.push(created.id)
      tabsState = { ...tabsState, tabs: tabsState.tabs.map((tab) => tab.id === created.id ? { ...tab, fanOutLabel: label } : tab) }
      syncTabState()
      broadcastState()
      const deadline = Date.now() + FAN_OUT_WAIT_MS
      let reported = false
      while (Date.now() < deadline) {
        const current = tabsState.tabs.find((tab) => tab.id === created.id)
        if (!current || current.status === 'crashed' || current.status === 'completed') { stopped = `Session ${index} of ${count} ended before it reported where it runs.`; break }
        if (current.sessionCwd) { reported = true; break }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (stopped) break
      if (!reported) { stopped = `Session ${index} of ${count} did not report where it runs within ${Math.round(FAN_OUT_WAIT_MS / 1000)} seconds, so no more were started.`; break }
    }
  } catch (error) {
    stopped = `${error instanceof Error ? error.message : String(error)} (${tabIds.length} of ${count} started).`
  } finally {
    fanOutRunning = false
  }
  return { tabIds, requested: count, stopped, label }
}

/** The chip names the branch the worktree has checked out now, not the one it had when the session started: a switch or
 * rename inside the worktree changes its HEAD file, which is read again here, without git, for every worktree tab. */
async function refreshWorktreeBranches(): Promise<void> {
  let changed = false
  for (const [id, gitDir] of [...sessionWorktreeGitDirs]) {
    const tab = tabsState.tabs.find((candidate) => candidate.id === id)
    if (!tab?.worktree || !managedTabs.has(id)) { sessionWorktreeGitDirs.delete(id); continue }
    const branch = await readWorktreeBranch(gitDir)
    const current = tabsState.tabs.find((candidate) => candidate.id === id)
    if (!current?.worktree || current.worktree.branch === branch || sessionWorktreeGitDirs.get(id) !== gitDir) continue
    tabsState = { ...tabsState, tabs: tabsState.tabs.map((candidate) => candidate.id === id && candidate.worktree ? { ...candidate, worktree: { ...candidate.worktree, branch } } : candidate) }
    changed = true
  }
  if (changed) { syncTabState(); broadcastState() }
}

/** Wires a session's lifecycle events to tab state for the given tab id.
 * Shared by session creation and restart, since a restarted tab keeps its
 * id but is backed by a brand-new `PtySession` instance. */
function wireSessionEvents(id: string, session: PtySession): void {
  session.on('activity', () => {
    if (managedTabs.get(id)?.session !== session) return
    tabsState = { ...tabsState, tabs: tabsState.tabs.map((tab) => tab.id === id ? { ...tab, activity: session.activity } : tab) }
    gitResolvers.observe(sessionStateOf)
    syncTabState()
    broadcastState()
    // A session doing something probably changed files; the Git panel (if open) refreshes shortly.
    const profileId = tabsState.tabs.find((tab) => tab.id === id)?.workspaceProfileId
    if (profileId) gitService?.requestRefresh(profileId)
    if (session.activity === 'idle') observe(refreshSessionNames(), 'Could not read session names')
    if (session.activity === 'idle') onMeetingIdle(id)
  })
  session.on('session-record', (line: string, live: boolean) => {
    if (managedTabs.get(id)?.session !== session) return
    onMeetingRecord(id, line, live)
  })
  session.on('activity-detail', () => {
    if (managedTabs.get(id)?.session !== session) return
    tabsState = { ...tabsState, tabs: tabsState.tabs.map((tab) => tab.id === id ? { ...tab, activityDetail: session.activityDetail } : tab) }
    // Tool starts and completions are frequent; ride the debounced broadcast and skip the Git refresh.
    scheduleActivityBroadcast(id)
  })
  session.on('session-cwd', (cwd: string | null) => {
    if (managedTabs.get(id)?.session !== session) return
    const generation = (sessionCwdGenerations.get(id) ?? 0) + 1
    sessionCwdGenerations.set(id, generation)
    observe(applySessionCwd(id, session, cwd, generation), 'Could not inspect the session folder')
  })
  session.on('status', (status) => {
    if (status === 'approval-needed') promptDrafts.get(id)?.suppressContext()
    tabsState = setTabStatus(tabsState, id, status)
    tabsState = setTabProcessId(tabsState, id, session.processId)
    // A session whose process ended cannot answer: it leaves its meeting (closing it, for a host). Not while the app quits:
    // its meetings are saved as they stand and go on after the next start.
    if (managedTabs.get(id)?.session === session && (status === 'completed' || status === 'crashed') && !shuttingDown()) forgetMeetingSession(id)
    else scheduleMeetingPump(0)
    syncTabState()
    refreshMenus()
    broadcastState()
  })
  session.on('log', (chunk: string) => {
    sessionLastOutputAt.set(id, Date.now())
    const sequence = (sessionOutputSequences.get(id) ?? 0) + 1
    sessionOutputSequences.set(id, sequence)
    tabsState = touchTab(tabsState, id)
    scheduleActivityBroadcast(id)
    observe(writeSessionLog(id, chunk), 'Could not write session log')
    const window = sessionWindows.get(id) ?? mainWindow
    if (window && !window.isDestroyed()) window.webContents.send('desktop:tab-output', { tabId: id, data: chunk, sequence })
  })
  session.on('session-id', (sessionId: string) => {
    if (managedTabs.get(id)?.session !== session) return
    tabsState = setTabSessionId(tabsState, id, sessionId)
    const tab = tabsState.tabs.find((candidate) => candidate.id === id)
    if (!tab?.remote) usageService?.associate(sessionId, tab?.sideChat === true)
    syncTabState()
    persistProfileTabs()
    broadcastState()
  })
  session.on('permission-mode', (mode: SessionPermissionMode) => applySessionPermissionMode(id, session, mode))
  session.on('permission-monitor-error', (message: string) => {
    observe(writeAppLog(`Could not monitor session permissions: ${message}`), 'Could not write permission monitor error')
  })
  session.on('desktop-event', (event: DesktopEvent) => handleDesktopEvent(id, event))
  session.on('exit', (exit: PtySessionExit) => {
    usageService?.noteSourceChanged()
    if (session.lastSessionId) {
      tabsState = setTabSessionId(tabsState, id, session.lastSessionId)
      const tab = tabsState.tabs.find((candidate) => candidate.id === id)
      if (!tab?.remote) usageService?.associate(session.lastSessionId, tab?.sideChat === true)
    }
    if (usageService && !preparingUpdate) observe(usageService.collect(), 'Could not collect final session usage')
    syncTabState()
    persistProfileTabs()
    broadcastState()
    const window = sessionWindows.get(id) ?? mainWindow
    if (window && !window.isDestroyed()) window.webContents.send('desktop:tab-exit', { tabId: id, exit })
  })
}

function applySessionPermissionMode(id: string, session: PtySession, mode: SessionPermissionMode): void {
  if (managedTabs.get(id)?.session !== session) return
  const tab = tabsState.tabs.find((candidate) => candidate.id === id)
  if (!tab || tab.remote || tab.sessionPermissionMode === mode) return
  tabsState = setTabPermissionMode(tabsState, id, mode)
  syncTabState()
  persistProfileTabs()
  broadcastState()
  refreshMenus()
}

/** Sessions still starting in each workspace: their tab does not exist yet, but removing the workspace must wait. */
const startingWorkspaceSessions = new Map<string, number>()

/** A session can be prepared across awaits while its workspace is removed: no tab may be registered for one that is gone. */
function assertWorkspaceListed(profile: WorkspaceProfile): void {
  if (!desktopConfig.profiles.some((candidate) => candidate.id === profile.id)) {
    throw new Error(`The workspace ${profile.name} was removed while the session was opening`)
  }
}

/** Workspaces a session uses or is starting in, which the profile limit must not drop. */
function workspacesInUse(): Set<string> {
  return new Set([...tabsState.tabs.map((tab) => tab.workspaceProfileId), ...startingWorkspaceSessions.keys()])
}

async function createSessionTab(...args: Parameters<typeof startSessionTab>): Promise<DesktopState> {
  const profileId = (args[0] === undefined ? activeWorkspaceProfile(desktopConfig) : args[0])?.id
  if (!profileId) return startSessionTab(...args)
  startingWorkspaceSessions.set(profileId, (startingWorkspaceSessions.get(profileId) ?? 0) + 1)
  try {
    return await startSessionTab(...args)
  } finally {
    const remaining = (startingWorkspaceSessions.get(profileId) ?? 1) - 1
    if (remaining > 0) startingWorkspaceSessions.set(profileId, remaining)
    else startingWorkspaceSessions.delete(profileId)
  }
}

async function startSessionTab(
  profile: WorkspaceProfile | null = activeWorkspaceProfile(desktopConfig),
  resumeModeOverride: ResumeMode | null = null,
  restoreLastSessionId: string | null = null,
  attachmentPaths: string[] = [],
  connectSessionId: string | null = null,
  titleOverride: string | null = null,
  /** `privateOverrides`: the new-session dialog's choice; absent means the Settings default (or, restored, as saved).
   * `worktreePath`: the existing worktree chosen there, checked against the project's worktrees before anything starts. */
  sideOptions: { sideChat?: true; sideParentTabId?: string; privateOverrides?: boolean; worktreePath?: string } = {},
  sessionPermissionPresetOverride: PermissionPreset | null = null,
  sessionPermissionModeOverride: SessionPermissionMode | null = null,
  /** Called with the new tab's id the moment it is registered, before anything else can create a tab. */
  onCreated: ((tabId: string) => void) | null = null,
): Promise<DesktopState> {
  if (!profile) throw new Error('Select a workspace before starting a session')
  if (sideOptions.sideChat) profile = sideChatProfile(profile, copilotCapabilities)
  // An existing worktree: chosen now, it must still be one of the project's, or nothing starts.
  const requestedWorktree = connectSessionId || sideOptions.sideChat ? undefined : sideOptions.worktreePath
  const existingWorktree = requestedWorktree === undefined ? null : await resolveLinkedWorktree(profile.path, requestedWorktree)
  if (requestedWorktree !== undefined && !existingWorktree) throw new Error('That folder is no longer a worktree of this project\'s repository')
  if (existingWorktree) profile = withSessionChoices(profile, { worktree: false })!
  if (tabsState.tabs.length >= MAX_SESSION_TABS) throw new Error(`No more than ${MAX_SESSION_TABS} session tabs can be open`)
  if (shuttingDown()) throw new Error('The app is shutting down or updating; new sessions cannot be started right now')

  const id = `tab-${nextTabSequence++}`
  let resumeMode = resumeModeOverride ?? profile.defaultResumeMode
  let resumeSessionId = restoreLastSessionId
  let reusedSessionId: string | null = null
  if (restoreLastSessionId && !connectSessionId && !await copilotSessionStored(restoreLastSessionId)) {
    reusedSessionId = restoreLastSessionId
    resumeSessionId = null
    resumeMode = 'new'
  }
  const sessionTitle = titleOverride?.trim().slice(0, 120) || profile.name
  // Nobody named it: the tab shows the project's name until Copilot names the session from its first prompt.
  const autoTitle = !connectSessionId && !titleOverride?.trim()
  const sessionPermissionPreset = connectSessionId
    ? null
    : sideOptions.sideChat
      ? 'read-only'
      : sessionPermissionPresetOverride ?? profile.permissionPreset
  const launchProfile = sessionPermissionPreset
    ? { ...profile, permissionPreset: sessionPermissionPreset }
    : profile
  const sessionPermissionMode = connectSessionId || sideOptions.sideChat ? null : sessionPermissionModeOverride
  pendingSessionCreations++
  let plan: Awaited<ReturnType<typeof buildSessionSpawnPlan>>
  try {
    plan = await buildSessionSpawnPlan(launchProfile, resumeMode, resumeSessionId, attachmentPaths, connectSessionId, sessionTitle)
    plan.nameSession = !autoTitle
    if (existingWorktree) plan.cwd = existingWorktree.root
    if (reusedSessionId) plan.sessionId = reusedSessionId
    plan.env = await prepareBrowserSessionEnvironment(browserSessionRoot(), id, plan.env)
    plan.env = await prepareMeetingSessionEnvironment(browserSessionPaths(browserSessionRoot(), id).directory, await meetingControl.register(id), plan.env)
  }
  finally { pendingSessionCreations-- }
  // Recheck after credential resolution: another creation or shutdown may
  // have completed during the await. Register the new tab synchronously.
  if (shuttingDown()) throw new Error('The app is shutting down or updating')
  if (tabsState.tabs.length >= MAX_SESSION_TABS) throw new Error(`No more than ${MAX_SESSION_TABS} session tabs can be open`)
  assertWorkspaceListed(profile)
  const { args, deterministicSessionId, worktreeName } = finalizeSessionArgs(plan, resumeMode, resumeSessionId)
  if (sideOptions.sideChat) args.push('--mode=interactive')

  const session = new PtySession({
    file: plan.file,
    args,
    cwd: plan.cwd,
    env: plan.env,
    spawnPty: spawnNodePty,
    worktreeTimeoutMinutes: desktopConfig.worktreeTimeoutMinutes,
    sessionId: deterministicSessionId,
    discoverSessionIdFromOutput: deterministicSessionId === null && connectSessionId === null,
    // An unnamed session reaches the store only with its first prompt, which can come any time.
    ...(worktreeName ? { discoverSessionIdFromStore: { root: copilotSessionRoot({ ...process.env, ...plan.env }), since: Date.now(), launchCwd: plan.cwd, worktreeName,
      ...(plan.nameSession === false ? { timeoutMs: Number.POSITIVE_INFINITY } : {}) } } : {}),
    monitorSessionPermissions: connectSessionId === null,
  })
  managedTabs.set(id, { session })
  trackSessionName(id, { ...process.env, ...plan.env }, resumeMode === 'picker')
  profilesWithSessionTabs.add(profile.id)
  if (deterministicSessionId && !connectSessionId) usageService?.associate(deterministicSessionId, sideOptions.sideChat === true)
  const previousProfileId = desktopConfig.activeProfileId
  onCreated?.(id)
  tabsState = createTab(tabsState, {
    id,
    title: connectSessionId ? `Remote ${connectSessionId.slice(0, 12)}` : sessionTitle,
    browserProfileId: selectBrowserProfileId(undefined, tabsState.tabs.map(tab => tab.browserProfileId)),
    workspaceProfileId: profile.id,
    sessionPermissionPreset,
    sessionPermissionMode,
    permissionWarning: sideOptions.sideChat ? SIDE_CHAT_PERMISSION_WARNING : connectSessionId ? null : permissionCompatibilityWarning(sessionPermissionPreset!, copilotCapabilities),
    remote: connectSessionId !== null,
    cliVersion: plan.cliVersion,
    lastSessionId: deterministicSessionId,
    ...(sideOptions.sideChat ? { sideChat: true as const } : {}),
    ...(sideOptions.sideParentTabId ? { sideParentTabId: sideOptions.sideParentTabId } : {}),
    privateOverrides: !connectSessionId && (sideOptions.privateOverrides
      ?? desktopConfig.browserOverrides === 'private'),
    canFork: !connectSessionId && !sideOptions.sideChat && supportsSessionFork(state.resolution?.version ?? null),
    ...(connectSessionId ? {} : { launchWorktree: profile.launch.worktree === true }),
    ...(existingWorktree ? { launchWorktreePath: existingWorktree.root } : {}),
    autoTitle,
  })
  desktopConfig.activeProfileId = profile.id
  syncWorkspaceState()
  syncTabState()
  broadcastState()
  refreshMenus()
  wireSessionEvents(id, session)

  try {
    await queueTabTransition(id, async () => {
      if (shuttingDown()) throw new Error('The app is shutting down or updating')
      await session.start()
      if (shuttingDown()) {
        await session.stop()
        throw new Error('The app is shutting down or updating')
      }
    })
    scheduleCopilotResolutionRefresh()
  } catch (error) {
    if (managedTabs.get(id)?.session === session) {
      session.removeAllListeners()
      const wasActive = tabsState.activeTabId === id
      tabsState = closeTab(tabsState, id)
      managedTabs.delete(id)
      if (wasActive) {
        desktopConfig.activeProfileId = tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId)?.workspaceProfileId
          ?? (desktopConfig.activeProfileId === profile.id ? previousProfileId : desktopConfig.activeProfileId)
        syncWorkspaceState()
      }
    }
    syncTabState()
    broadcastState()
    refreshMenus()
    persistProfileTabs()
    throw error
  }
  persistProfileTabs()
  return snapshot()
}

async function forkSideChat(tabId: string, sourceSessionId: string, title: string): Promise<DesktopState> {
  if (!isForkSessionId(sourceSessionId)) throw new Error('Enter a full source session UUID')
  const pending = pendingForks.get(tabId)
  if (pending) throw new Error('A side chat is already being created for this session. Wait for it to open.')
  const operation = queueTabTransition(tabId, async () => {
    if (shuttingDown()) throw new Error('The app is shutting down or updating')
    const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.remote || tab.sideChat) throw new Error('Select a local main session to fork into a side chat')
    const existing = tabsState.tabs.find((candidate) => candidate.sideParentTabId === tabId)
    if (existing) throw new Error('This session already has a side chat. Close it before creating another fork.')
    if (tabsState.tabs.length >= MAX_SESSION_TABS) throw new Error('Close a session tab before opening a side chat')
    const sourceProfile = desktopConfig.profiles.find((candidate) => candidate.id === tab.workspaceProfileId)
    if (!sourceProfile || !state.resolution) throw new Error('This session workspace is no longer available')
    const profile = sideChatProfile(sourceProfile, copilotCapabilities)
    if (!supportsSessionFork(state.resolution.version)) throw new Error('Side chat needs Copilot CLI 1.0.82 or newer. Update Copilot CLI and restart this tab.')
    const sessionTitle = title.trim().slice(0, 120) || `Side: ${tab.title}`.slice(0, 120)
    const plan = await buildSessionSpawnPlan(profile, 'auto-resume', sourceSessionId, [], null, sessionTitle)
    const forkId = await forkSessionSnapshot(state.resolution, plan.cwd, { ...process.env, ...plan.env }, sourceSessionId, sessionTitle)
    try {
      return await createSessionTab(profile, 'auto-resume', forkId, [], null, sessionTitle, { sideChat: true, sideParentTabId: tabId })
    } catch (error) {
      // Never delete copied history after an ambiguous launch failure. The
      // user can recover it from Copilot's own session picker.
      throw new Error(`Fork ${forkId} was saved, but its side terminal could not open: ${error instanceof Error ? error.message : String(error)}. Resume that ID to recover it.`)
    }
  })
  pendingForks.set(tabId, operation)
  void operation.catch(() => {}).finally(() => {
    if (pendingForks.get(tabId) === operation) pendingForks.delete(tabId)
  })
  return operation
}

async function createSessionWithAttachments(title: string | null = null, options: NewSessionOptions = {}): Promise<DesktopState> {
  if (!mainWindow) return snapshot()
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach files to a new Copilot session',
    properties: ['openFile', 'multiSelections'],
    defaultPath: activeWorkspaceProfile(desktopConfig)?.path ?? app.getPath('home'),
  })
  if (selection.canceled || selection.filePaths.length === 0) return snapshot()
  return createSessionTab(withSessionChoices(activeWorkspaceProfile(desktopConfig), options), 'new', null, selection.filePaths.slice(0, 20), null, title, dialogChoices(options))
}

/** The new-session dialog's Local Overrides and existing-worktree choices, as createSessionTab takes them. */
function dialogChoices(options: NewSessionOptions): { privateOverrides?: boolean; worktreePath?: string } {
  return {
    ...(options.sharedOverrides === undefined ? {} : { privateOverrides: !options.sharedOverrides }),
    ...(options.worktreePath === undefined ? {} : { worktreePath: options.worktreePath }),
  }
}

/** The project with the choices made for one new session in the new-session dialog; the saved project is unchanged. */
function withSessionChoices(profile: WorkspaceProfile | null, options: NewSessionOptions): WorkspaceProfile | null {
  // An existing worktree is never combined with a new one.
  const worktree = options.worktreePath !== undefined ? false : options.worktree
  if (!profile || worktree === undefined) return profile
  return { ...profile, launch: { ...profile.launch, worktree } }
}

function activateSessionTab(tabId: string): DesktopState {
  const popout = sessionWindows.get(tabId)
  tabsState = activateTab(tabsState, tabId)
  syncTabState()
  followActiveTabWorkspace()
  if (popout) focusSessionWindow(popout)
  else restoreMainWindow()
  broadcastState()
  refreshMenus()
  return snapshot()
}

/** Switches the active project to the active session's project, as selecting that project would. */
function followActiveTabWorkspace(): void {
  const next = activeWorkspaceFor(tabsState, desktopConfig.activeProfileId)
  if (next === desktopConfig.activeProfileId) return
  desktopConfig.activeProfileId = next
  syncWorkspaceState()
  void persistConfig().catch((error) => void writeAppLog(`Failed to save the active workspace: ${String(error)}`))
}

function renameSessionTab(tabId: string, title: string): DesktopState {
  tabsState = renameTab(tabsState, tabId, title)
  syncTabState()
  persistProfileTabs()
  broadcastState()
  refreshMenus()
  observe(syncSessionName(tabId), 'Could not rename the Copilot session')
  return snapshot()
}

/**
 * The size each tab's terminal pane last reported, kept while the tab has no process. A restored (dormant) or unloaded tab
 * has none when its pane first measures itself; without this its process would start at the 80x24 default and stay there,
 * since the pane reports again only when its size changes.
 */
const terminalSizes = new Map<string, { cols: number; rows: number }>()

/** Where each tab's session keeps its name, the prompt-draft state of its terminal, and the name last read from it. */
const sessionNameRoots = new Map<string, string>()
const promptDrafts = new Map<string, PromptDraft>()
const copilotNames = new Map<string, { sessionId: string; mtimeMs: number; value: CopilotSessionName | null }>()
const renamesSent = new Map<string, { title: string; at: number }>()
/** Terminal input that arrived while the desktop was typing `/rename` into that tab's session, waiting for its Enter. */
const heldInput = new Map<string, string[]>()

/** A new process for the tab: its prompt starts empty, or on the resume picker. */
function trackSessionName(tabId: string, env: NodeJS.ProcessEnv, picker: boolean): void {
  sessionNameRoots.set(tabId, copilotSessionRoot(env))
  promptDrafts.set(tabId, new PromptDraft({ awaitingFirstEnter: picker }))
  renamesSent.delete(tabId)
}

function forgetSessionName(tabId: string): void {
  heldInput.delete(tabId)
  sessionNameRoots.delete(tabId)
  promptDrafts.delete(tabId)
  copilotNames.delete(tabId)
  renamesSent.delete(tabId)
}

/** Copilot's name for the tab's current session: undefined until it has been read. */
function knownSessionName(tab: DesktopSessionTab): CopilotSessionName | null | undefined {
  const known = copilotNames.get(tab.id)
  return known && known.sessionId === tab.lastSessionId ? known.value : undefined
}

async function readSessionName(tabId: string): Promise<void> {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  const root = sessionNameRoots.get(tabId)
  if (!tab || tab.remote || !tab.lastSessionId || !root) return
  const sessionId = tab.lastSessionId
  const known = copilotNames.get(tabId)
  const read = await readCopilotSessionName(root, sessionId, known?.sessionId === sessionId ? known : undefined)
  if (tabsState.tabs.find((candidate) => candidate.id === tabId)?.lastSessionId === sessionId) copilotNames.set(tabId, { sessionId, ...read })
}

/**
 * Types `/rename` into the session when that cannot disturb anything: it is running and not mid-turn, its prompt box
 * holds nothing the person typed (a draft would be sent to the model with the command appended), and no key was pressed
 * just now. `closing` allows clearing a draft with Ctrl+C first, since closing discards it anyway.
 */
function sendSessionRename(tabId: string, closing = false): boolean {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  const managed = managedTabs.get(tabId)
  const draft = promptDrafts.get(tabId)
  if (!tab || !managed || !draft || tab.status !== 'running') return false
  const action = nameSyncAction(tab, knownSessionName(tab))
  const command = action.kind === 'rename' ? renameCommand(action.title) : null
  if (!command || action.kind !== 'rename') return false
  const session = managed.session
  // Idle by its event log, or (before any turn) showing the prompt's footer.
  const ready = session.activity === 'idle' || (session.activity === null && session.recentOutputText.includes('open sidebar'))
  if (!ready || (!closing && (!draft.empty || !draft.quiet()))) return false
  // Ctrl+C on the resume picker would leave it, not clear a prompt.
  if (closing && draft.beforeFirstEnter) return false
  if (heldInput.has(tabId)) return false
  const sent = renamesSent.get(tabId)
  if (!closing && sent?.title === action.title && Date.now() - sent.at < 15_000) return false
  renamesSent.set(tabId, { title: action.title, at: Date.now() })
  // From here until its Enter, keys the person presses are held back, then passed on in order: typed into the command
  // they would become part of the name (or of a prompt sent with it).
  heldInput.set(tabId, [])
  const release = (): void => {
    const held = heldInput.get(tabId) ?? []
    heldInput.delete(tabId)
    const current = managedTabs.get(tabId)?.session
    for (const data of held) { promptDrafts.get(tabId)?.note(data); current?.write(data) }
  }
  if (!draft.empty) { session.write('\x03'); draft.note('\x03') }
  setTimeout(() => {
    if (managedTabs.get(tabId)?.session !== session) { release(); return }
    session.write(command)
    setTimeout(() => {
      if (managedTabs.get(tabId)?.session === session) session.write('\r')
      release()
    }, 200)
  }, closing ? 300 : 0)
  return true
}

/**
 * Types a task the desktop composed into the session and presses Enter, at the same safe moment as `/rename`: idle, nothing
 * typed in the prompt box and no key pressed just now. Keys pressed meanwhile are held back, then passed on in order. When
 * that moment is not now the answer is `busy`, and the renderer pastes the task for the person to send.
 */
function sendSessionTask(tabId: string, text: string, needsWrite = true): SessionTaskSend {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  const managed = managedTabs.get(tabId)
  const draft = promptDrafts.get(tabId)
  if (!tab || !managed || !draft) return { result: 'refused', message: 'This session is not running. Start or resume it first.' }
  const session = managed.session
  const decision = sessionTaskDecision({
    status: tab.status,
    activity: session.activity,
    promptVisible: session.recentOutputText.includes('open sidebar'),
    preset: tab.sessionPermissionPreset,
    sideChat: tab.sideChat === true,
    remote: tab.remote,
    draft: !draft.empty,
    recentInput: !draft.quiet(),
    picker: draft.beforeFirstEnter,
    typing: heldInput.has(tabId),
    bracketedPaste: session.bracketedPaste,
  }, needsWrite)
  if (decision.result !== 'sent') return decision
  heldInput.set(tabId, [])
  const release = (): void => {
    const held = heldInput.get(tabId) ?? []
    heldInput.delete(tabId)
    const current = managedTabs.get(tabId)?.session
    for (const data of held) { promptDrafts.get(tabId)?.note(data); current?.write(data) }
  }
  const paste = taskPasteSequence(text)
  draft.note(paste)
  session.write(paste)
  // Copilot needs a moment to take a large paste before Enter submits it.
  setTimeout(() => {
    if (managedTabs.get(tabId)?.session === session) { session.write('\r'); promptDrafts.get(tabId)?.note('\r') }
    release()
  }, 300)
  return decision
}

/** Types a one-line slash command (a meeting's `/add-dir`) at the same safe moment, holding back keys pressed meanwhile. */
function sendSessionCommand(tabId: string, command: string): boolean {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  const managed = managedTabs.get(tabId)
  const draft = promptDrafts.get(tabId)
  if (!tab || !managed || !draft || tab.status !== 'running' || tab.remote) return false
  const session = managed.session
  const ready = session.activity === 'idle' || (session.activity === null && session.recentOutputText.includes('open sidebar'))
  if (!ready || !draft.empty || !draft.quiet() || draft.beforeFirstEnter || heldInput.has(tabId)) return false
  heldInput.set(tabId, [])
  const text = command.replace(/[\u0000-\u001f\u007f]/g, '')
  draft.note(text)
  session.write(text)
  setTimeout(() => {
    if (managedTabs.get(tabId)?.session === session) { session.write('\r'); promptDrafts.get(tabId)?.note('\r') }
    const held = heldInput.get(tabId) ?? []
    heldInput.delete(tabId)
    for (const data of held) { promptDrafts.get(tabId)?.note(data); managedTabs.get(tabId)?.session.write(data) }
  }, 200)
  return true
}

// Review meetings between sessions (docs/session-meeting-plan.md): the hub decides, the outbox types, the readers tell what
// each session was asked and what it answered.
function meetingRoot(): string { return join(app.getPath('userData'), 'meetings') }
const meetingReaders = new Map<string, MeetingTurnReader>()
const meetingWrites = new Map<string, Promise<void>>()
let meetingPumpTimer: NodeJS.Timeout | null = null

function meetingReader(tabId: string): MeetingTurnReader {
  let reader = meetingReaders.get(tabId)
  if (!reader) { reader = new MeetingTurnReader(); meetingReaders.set(tabId, reader) }
  return reader
}

function meetingParty(tabId: string): { tabId: string; title: string; folder: string | null } {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  return { tabId, title: tab?.title ?? 'A session', folder: tab?.sessionCwd ?? managedTabs.get(tabId)?.session.sessionCwd ?? null }
}

/**
 * A resumed session reads as idle from its history before its CLI is ready ("Resuming session…", then a "Loading" spinner);
 * keys typed then are lost. A meeting types only once the CLI has turned on bracketed paste (its prompt takes input) and its
 * output has been still for a moment (nothing is loading).
 */
const MEETING_SETTLE_MS = 1_500
const sessionLastOutputAt = new Map<string, number>()
function meetingPromptShown(tabId: string): boolean {
  const session = managedTabs.get(tabId)?.session
  return session !== undefined && session.bracketedPaste && Date.now() - (sessionLastOutputAt.get(tabId) ?? 0) >= MEETING_SETTLE_MS
}

const meetingOutbox = new MeetingOutbox({
  sendTask: (tabId, text) => {
    // A session restored with its meeting is still starting: its messages wait instead of being dropped.
    const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
    if (tab && !tab.unloaded && (tab.status === 'dormant' || tab.status === 'starting' || !meetingPromptShown(tabId))) return { result: 'busy', message: 'The session is starting.' }
    return sendSessionTask(tabId, text, false)
  },
  sendCommand: (tabId, command) => meetingPromptShown(tabId) && sendSessionCommand(tabId, command),
  sent: (tabId) => meetingReader(tabId).expectDesktopPrompt(),
  refused: (tabId, delivery, message) => {
    void writeAppLog(`Meeting ${delivery.meetingId} could not reach session ${tabId}: ${message}`).catch(() => {})
  },
  now: () => Date.now(),
})

const meetingHub = new MeetingHub(meetingRoot, {
  deliver: (tabId, delivery) => {
    if (GUEST_ID_PATTERN.test(tabId)) { deliverToGuest(tabId, delivery); return }
    meetingOutbox.enqueue(tabId, delivery)
    scheduleMeetingPump(0)
  },
  cancel: (meetingId, tabId) => { meetingOutbox.cancel(meetingId, tabId); guestMailbox.cancel(meetingId, tabId) },
  write: (meetingId, path, text) => {
    // One meeting's files are written in order, so the transcript on disk is always the latest one.
    const previous = meetingWrites.get(meetingId) ?? Promise.resolve()
    const next = previous.then(() => writeMeetingFile(meetingRoot(), meetingId, path, text))
      .catch((error) => writeAppLog(`Could not write meeting ${meetingId} file: ${String(error)}`).catch(() => {}))
    meetingWrites.set(meetingId, next)
  },
  changed: () => {
    // Not while meetings are being restored one by one: a guest's meeting may simply not be back yet.
    if (guestsReady) guestMailbox.closeEnded((id) => meetingHub.isOpen(id))
    broadcastState()
  },
  notify: (_meetingId, message) => {
    void writeAppLog(message).catch(() => {})
    showNotification('Copilot CLI Desktop', message)
  },
  sessionIdOf: (tabId) => {
    if (GUEST_ID_PATTERN.test(tabId)) return tabId
    const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
    return tab?.lastSessionId ?? managedTabs.get(tabId)?.session.lastSessionId ?? null
  },
  folderExists: (id) => existsSync(join(meetingRoot(), id)),
}, () => ({ maxRounds: desktopConfig.meetingMaxRounds, roundTimeoutMinutes: desktopConfig.meetingRoundTimeoutMinutes, discussion: desktopConfig.meetingDiscussion }))

// Outside agents as reviewers (docs/meeting-guests-plan.md): seats, tokens and messages live in the mailbox; the hub sees
// each guest as a party with a `guest:` id. Their helper, the endpoint file and their reply folders are in `guestRoot()`.
function guestRoot(): string { return join(app.getPath('userData'), 'meeting-guest') }
/** Guests are answered once saved meetings are restored; before that a guest's meeting may only look closed. */
let guestsReady = false
let guestSeatsWrite: Promise<void> = Promise.resolve()
let guestEndpointWrite: Promise<void> = Promise.resolve()
const guestMailbox = new GuestMailbox(realMeetingTimers, () => {
  const text = guestMailbox.serialize()
  guestSeatsWrite = guestSeatsWrite.then(() => writeFileAtomic(join(guestRoot(), GUEST_SEATS_FILE), text))
    .catch((error) => writeAppLog(`Could not save meeting guests: ${String(error)}`).catch(() => {}))
  broadcastState()
})

/** A meeting message for a guest: show commands in place of meeting files, and the file to write its reply to. */
function deliverToGuest(seatId: string, delivery: MeetingDelivery): void {
  if (delivery.kind === 'add-dir') return
  const folder = meetingHub.folderOf(delivery.meetingId)
  if (!folder) return
  // Worded for the channel the guest uses now: the meeting tools take the reply as an argument, the helper a file. A host
  // answers with its commands, which the message names.
  const seat = guestMailbox.seat(seatId)
  const via = seat?.via === 'mcp' ? 'mcp' as const : 'helper' as const
  const reply = seat?.kind === 'host' ? { via, host: true as const }
    : via === 'mcp' ? { via } : { via, path: guestReplyPath(guestRoot(), seatId, delivery) }
  guestMailbox.enqueue(seatId, { ...delivery, text: guestMessage(delivery.text, folder, delivery.round, reply) })
}

const guestHostTitle = (seat: GuestSeat): string => `${seat.name} (guest)`

const guestDeps: GuestDeps = {
  ready: () => guestsReady,
  isOpen: (id) => meetingHub.isOpen(id),
  join: (seat) => {
    try { meetingHub.join({ tabId: seat.id, title: `${seat.name} (guest)`, folder: null }, seat.meetingId, { role: seat.role }); return null }
    catch (error) { if (error instanceof MeetingError) return error.message; throw error }
  },
  leave: (seat) => meetingHub.leave(seat.id),
  turnCompleted: (seat, delivery, reply) => meetingHub.turnCompleted(seat.id, delivery, reply),
  material: async (id, name, round) => {
    const folder = meetingHub.folderOf(id)
    if (!folder) return null
    await meetingWrites.get(id)
    const paths = roundPaths(folder, round)
    return readFile(name === 'transcript' ? paths.transcript : paths[name], 'utf8').catch(() => null)
  },
  start: (seat, topic, post, changes) => {
    try { return { meetingId: meetingHub.start({ tabId: seat.id, title: guestHostTitle(seat), folder: seat.folder }, { topic, post, changes }).id } }
    catch (error) { if (error instanceof MeetingError) return { error: error.message }; throw error }
  },
  post: (seat, kind, text, changes) => {
    try { return { ok: true, message: meetingHub.post(seat.id, kind, text, changes) } }
    catch (error) { if (error instanceof MeetingError) return { ok: false, message: error.message }; throw error }
  },
  end: (seat) => {
    try { meetingHub.end(seat.id); return { ok: true, message: 'The meeting is closed.' } }
    catch (error) { if (error instanceof MeetingError) return { ok: false, message: error.message }; throw error }
  },
  status: (seat) => meetingStatus(seat.id),
  changes: async (seat) => {
    const runner = await meetingGitRunner()
    if (!runner) throw new Error('Git is not available on this computer, so no changes can be attached.')
    return folderChanges(seat.folder!, { runner, trust: gitTrustStore() })
  },
}

/** The helper and the endpoint file, written each time the endpoint starts: its port changes with every app start. */
function writeGuestEndpoint(port: number): void {
  const windows = process.platform === 'win32'
  guestEndpointWrite = guestEndpointWrite.then(async () => {
    await mkdir(guestRoot(), { recursive: true })
    await writeFileAtomic(join(guestRoot(), windows ? 'meeting-guest.ps1' : 'meeting-guest.sh'), windows ? GUEST_HELPER : GUEST_HELPER_SH)
    await writeFileAtomic(join(guestRoot(), GUEST_ENDPOINT_FILE), JSON.stringify({ pid: process.pid, port }))
  }).catch((error) => writeAppLog(`Could not write the meeting guest endpoint: ${String(error)}`).catch(() => {}))
}

const meetingControl = new MeetingControlServer(handleMeetingCommand, {
  handle: async (token, command, fields, signal) => {
    const seat = guestMailbox.seatOf(token)
    if (!seat) return null
    // Every request says the guest is still there, which the meeting bar shows.
    try { return await handleGuestRequest(guestMailbox, guestDeps, seat, command, fields, signal) } finally { broadcastState() }
  },
  release: () => guestMailbox.release(),
}, writeGuestEndpoint)

// The meeting tools over MCP, on a fixed port the agent's configuration names; started once meetings are restored.
const guestMcp = new GuestMcpServer(guestMailbox, guestDeps, () => broadcastState())

async function startGuestMcp(): Promise<void> {
  const configured = Number(process.env.COPILOT_DESKTOP_MEETING_MCP_PORT ?? DEFAULT_GUEST_MCP_PORT)
  const port = Number.isInteger(configured) && configured >= 0 && configured <= 65535 ? configured : DEFAULT_GUEST_MCP_PORT
  if (await guestMcp.listen(port) === null) {
    await writeAppLog(`The meeting tools could not listen on port ${port}; outside agents can still use the helper.`).catch(() => {})
  }
  broadcastState()
}

/** The hub's views, with what only main knows: which parties are guests, and who is invited but not connected yet. */
function meetingViews(): MeetingView[] {
  const guests = guestMailbox.views()
  return meetingHub.views().map((meeting) => ({
    ...meeting,
    participants: meeting.participants.map((participant) => {
      const seat = guests.find((guest) => guest.id === participant.tabId)
      return seat ? { ...participant, guest: { lastSeenAt: seat.lastSeenAt } } : participant
    }),
    invited: guests.filter((guest) => guest.meetingId === meeting.id && !guest.joined).map(({ id, name, role }) => ({ id, name, role })),
  }))
}

/** Unused invitations expire; seats over for an hour are forgotten, with their reply folders. */
const guestSweepTimer = setInterval(() => {
  for (const seat of guestMailbox.sweep()) void rm(guestSeatFolder(guestRoot(), seat.id), { recursive: true, force: true }).catch(() => {})
}, 60_000)
guestSweepTimer.unref()

async function restoreGuestSeats(): Promise<void> {
  try { guestMailbox.restore(JSON.parse(await readFile(join(guestRoot(), GUEST_SEATS_FILE), 'utf8'))) } catch { /* None saved yet. */ }
}

function scheduleMeetingPump(delayMs = 1_000): void {
  if (meetingPumpTimer) {
    if (delayMs > 0) return
    clearTimeout(meetingPumpTimer)
  }
  meetingPumpTimer = setTimeout(() => {
    meetingPumpTimer = null
    if (meetingOutbox.pump()) scheduleMeetingPump()
  }, delayMs)
  meetingPumpTimer.unref()
}

function handleMeetingCommand(tabId: string, command: MeetingCommand, request: MeetingRequest): MeetingResponse {
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  if (!tab || tab.remote) return { ok: false, message: 'This session is not open in the desktop.' }
  try {
    switch (command) {
      case 'start': {
        // Only the person starts a meeting: the prompt this session is answering must be theirs, not a meeting message.
        if (!meetingReader(tabId).answeringPerson) return { ok: false, message: 'Start a meeting only when the person asks for one in their own message.' }
        const meeting = meetingHub.start(meetingParty(tabId), { topic: request.topic, post: request.text, changes: request.changes }, meetingReader(tabId).usage)
        return { ok: true, message: `Meeting ${meeting.id} is open. Tell the person to say "join meeting ${meeting.id}" in each session that should review it, then end your turn; the replies arrive as your next message.` }
      }
      case 'round':
      case 'propose-close':
        return { ok: true, message: meetingHub.post(tabId, command, request.text, request.changes) }
      case 'end':
        meetingHub.end(tabId)
        return { ok: true, message: 'The meeting is closed.' }
      case 'status':
        return { ok: true, message: meetingStatus(tabId) }
    }
  } catch (error) {
    if (error instanceof MeetingError) return { ok: false, message: error.message }
    throw error
  }
}

/** Where a party's meeting stands, for its `status` command: a tab's, or an outside host's. */
function meetingStatus(partyId: string): string {
  const current = meetingHub.meetingOf(partyId)
  const view = current ? meetingHub.views().find((meeting) => meeting.id === current.id) : undefined
  if (!view) return 'You are not in an open meeting.'
  const waiting = view.waitingFor.map((id) => tabsState.tabs.find((candidate) => candidate.id === id)?.title
    ?? view.participants.find((participant) => participant.tabId === id)?.title ?? id)
  return `Meeting ${view.id}: you are the ${current!.role}; round ${view.round} of at most ${view.maxRounds}, ${view.stage}${view.vote ? ' (vote)' : ''}; ${view.participants.length} reviewer(s)${waiting.length ? `; waiting for ${waiting.join(', ')}` : ''}.`
}

/**
 * A record of a session's event log. Live ones may be a prompt the person typed asking to join a meeting, and usage totals
 * add to the session's meeting cost. From the history read when the session (re)starts only the usage so far matters, so
 * the rest of a long history is not parsed again.
 */
function onMeetingRecord(tabId: string, line: string, live: boolean): void {
  if (!live && !line.includes('"session.usage_checkpoint"')) return
  const reader = meetingReader(tabId)
  const prompt = reader.consume(line, live)
  const usage = reader.takeUsageChange()
  if (usage) meetingHub.usage(tabId, usage)
  if (!prompt || prompt.desktop || prompt.content.startsWith(MEETING_MARKER_PREFIX)) return
  const request = joinRequest(prompt.content)
  if (!request) return
  const { id } = request
  if (!meetingHub.isOpen(id)) { showNotification('Copilot CLI Desktop', `There is no open meeting ${id}.`); return }
  try { meetingHub.join(meetingParty(tabId), id, { role: request.role, usage: reader.usage }) }
  catch (error) {
    if (!(error instanceof MeetingError)) throw error
    showNotification('Copilot CLI Desktop', error.message)
  }
}

/** The session went idle: a prompt the desktop typed (if that is what it answered) is done. */
function onMeetingIdle(tabId: string): void {
  const turn = meetingReaders.get(tabId)?.finish() ?? null
  const delivery = meetingOutbox.turnEnded(tabId)
  if (delivery) meetingHub.turnCompleted(tabId, delivery, turn?.desktop ? turn.reply : '')
  scheduleMeetingPump(0)
}

function forgetMeetingSession(tabId: string): void {
  sessionLastOutputAt.delete(tabId)
  meetingHub.leave(tabId)
  meetingOutbox.forget(tabId)
  meetingReaders.delete(tabId)
}

/** Reads the session's name and acts on it: an unnamed tab takes Copilot's name, and a named one renames the session. */
async function syncSessionName(tabId: string): Promise<boolean> {
  await readSessionName(tabId)
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return false
  const action = nameSyncAction(tab, knownSessionName(tab))
  if (action.kind === 'adopt') {
    tabsState = adoptCopilotTitle(tabsState, tabId, action.title)
    return true
  }
  if (action.kind === 'confirmed') {
    tabsState = confirmTabRename(tabsState, tabId)
    return true
  }
  if (action.kind === 'rename') sendSessionRename(tabId)
  return false
}

async function refreshSessionNames(): Promise<void> {
  let changed = false
  for (const tab of [...tabsState.tabs]) {
    if (!tab.remote && tab.lastSessionId) changed = await syncSessionName(tab.id) || changed
  }
  if (!changed) return
  syncTabState()
  persistProfileTabs()
  broadcastState()
  refreshMenus()
}

/** Before a tab closes: a rename that is still waiting goes to Copilot now, so the session keeps the tab's name. Skipped
 * while Copilot is mid-turn, since only Ctrl+C would make room and that would cancel the turn. */
async function flushSessionName(tabId: string): Promise<void> {
  await readSessionName(tabId)
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  if (!tab || nameSyncAction(tab, knownSessionName(tab)).kind !== 'rename' || !sendSessionRename(tabId, true)) return
  const end = Date.now() + 4_000
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    await readSessionName(tabId)
    if (knownSessionName(tab)?.name === tab.title) return
  }
  void writeAppLog(`Copilot did not confirm the new name for ${tabId} before it closed`).catch(() => {})
}

/** Stops a session's process and its browser to free their memory, but keeps the tab: it becomes Not started, keeping
 * its conversation, folder and browser data, and resumes when Resume (Restart) is chosen. */
async function unloadSessionTab(tabId: string): Promise<DesktopState> {
  return queueTabTransition(tabId, async () => {
    const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) throw new Error('This session tab no longer exists')
    if (tab.remote) throw new Error('A remote session cannot be unloaded')
    if (tab.status === 'dormant') return snapshot()
    const activityTimer = activityBroadcastTimers.get(tabId)
    if (activityTimer) clearTimeout(activityTimer)
    activityBroadcastTimers.delete(tabId)
    const managed = managedTabs.get(tabId)
    if (managed) {
      await flushSessionName(tabId).catch((error) => void writeAppLog(`Could not rename session ${tabId} before unloading: ${String(error)}`))
      await managed.session.stop().catch((error) => void writeAppLog(`Failed to stop session ${tabId}: ${String(error)}`))
      managed.session.removeAllListeners()
      managedTabs.delete(tabId)
      if (managed.session.lastSessionId) tabsState = setTabSessionId(tabsState, tabId, managed.session.lastSessionId)
    }
    forgetSessionName(tabId)
    // An unloaded session cannot answer: it leaves its meeting (closing it, for a host).
    forgetMeetingSession(tabId)
    // Until the tab is marked unloaded, a browser request finds it closing rather than creating a new browser.
    closingBrowserTabs.add(tabId)
    const browser = sessionBrowsers.get(tabId)
    sessionBrowsers.delete(tabId)
    try { await browser?.dispose() }
    catch (error) { void writeAppLog(`Failed to dispose browser for ${tabId}: ${String(error)}`).catch(() => {}) }
    // The session resumes where it ran, so its folder and worktree stay known and protected.
    tabsState = { ...tabsState, tabs: tabsState.tabs.map((candidate) => candidate.id === tabId
      ? { ...candidate, status: 'dormant' as const, unloaded: true as const, processId: null, activity: null, activityDetail: null }
      : candidate) }
    closingBrowserTabs.delete(tabId)
    sessionWindows.get(tabId)?.close()
    syncTabState()
    persistProfileTabs()
    broadcastState()
    refreshMenus()
    return snapshot()
  })
}

async function closeSessionTab(tabId: string): Promise<DesktopState> {
  // Share the queue with restartSessionTab: closing a tab while its restart
  // is still in flight could otherwise stop the very session the restart is
  // about to replace, then delete the tab from tabsState — after which the
  // restart would still go on to managedTabs.set() a brand-new process for a
  // tab that no longer exists anywhere the app can reach it. Queueing (rather
  // than rejecting outright) means a Close that arrives mid-restart still
  // takes effect once the restart's turn finishes, instead of silently
  // dropping the user's click.
  return queueTabTransition(tabId, async () => {
    closingBrowserTabs.add(tabId)
    const activityTimer = activityBroadcastTimers.get(tabId)
    if (activityTimer) clearTimeout(activityTimer)
    activityBroadcastTimers.delete(tabId)
    const managed = managedTabs.get(tabId)
    if (managed) {
      await flushSessionName(tabId).catch((error) => void writeAppLog(`Could not rename session ${tabId} before closing: ${String(error)}`))
      await managed.session.stop().catch((error) => void writeAppLog(`Failed to stop session ${tabId}: ${String(error)}`))
      managed.session.removeAllListeners()
      managedTabs.delete(tabId)
    }
    forgetSessionName(tabId)
    terminalSizes.delete(tabId)
    forgetMeetingSession(tabId)
    meetingControl.forget(tabId)
    // Read before the tab is dropped: its worktree is cleaned up once it is gone.
    const closing = tabsState.tabs.find((tab) => tab.id === tabId)
    const browser = sessionBrowsers.get(tabId)
    const reportBrowserError = (message: string): void => { void writeAppLog(message).catch(() => {}) }
    try { await browser?.dispose() }
    catch (error) { reportBrowserError(`Failed to dispose browser for ${tabId}: ${String(error)}`) }
    try {
      const profileId = tabsState.tabs.find(tab => tab.id === tabId)?.browserProfileId
      if (profileId) {
        const paths = browserProfilePaths(app.getPath('userData'), profileId)
        // A browser on the shared profile leaves its cookies and storage to the other sessions.
        if (browser?.partition === paths.partition || await browserProfileHasPartition(app.getPath('userData'), profileId)) {
          await clearBrowserStorage(electronSession.fromPartition(paths.partition), reportBrowserError)
        }
        if (browser?.devtoolsPartition) await clearBrowserStorage(electronSession.fromPartition(browser.devtoolsPartition), reportBrowserError)
        await removeBrowserProfileSettings(app.getPath('userData'), profileId)
      }
    } catch (error) { reportBrowserError(`Failed to remove browser profile for ${tabId}: ${String(error)}`) }
    try { await removeBrowserLaunch(app.getPath('userData'), launchId, tabId) }
    catch (error) { reportBrowserError(`Failed to remove browser helper for ${tabId}: ${String(error)}`) }
    finally { sessionBrowsers.delete(tabId); closingBrowserTabs.delete(tabId) }
    tabsState = closeTab(tabsState, tabId)
    syncTabState()
    followActiveTabWorkspace()
    const popout = sessionWindows.get(tabId)
    sessionWindows.delete(tabId)
    popout?.destroy()
    persistProfileTabs()
    await sessionLogWriteQueues.get(tabId)
    sessionLogBytesWritten.delete(tabId)
    sessionOutputSequences.delete(tabId)
    broadcastState()
    refreshMenus()
    if (closing) cleanUpSessionWorktree(closing)
    return snapshot()
  })
}

/** Worktree cleanups run one at a time: two in one repository contend for its worktree records, and prompts would stack. */
let worktreeCleanupQueue: Promise<void> = Promise.resolve()

/** Whether a tab still open (running or not, since it can be restarted) runs in the folder or below it, or was started there. */
async function openTabUsesFolder(folder: string): Promise<boolean> {
  let target: string
  try { target = await realPathNative(folder) } catch { return false }
  // A dormant tab whose saved folder is still being read may resume in this one.
  await Promise.all(dormantFolderReads.values())
  for (const tab of tabsState.tabs) {
    for (const where of [tab.sessionCwd, tab.launchWorktreePath]) {
      if (!where) continue
      let real: string
      try { real = await realPathNative(where) } catch { continue }
      if (isSameOrInside(real, target)) return true
    }
  }
  return false
}

async function askToRemoveWorktree(state: DesktopWorktreeState): Promise<boolean> {
  const window = mainWindow
  if (!window || window.isDestroyed() || !window.isVisible()) return false
  const { title, detail } = worktreeCleanupPrompt(state)
  const safe = removalIsSafe(state)
  const answer = await dialog.showMessageBox(window, {
    type: safe ? 'question' : 'warning', title, message: title, detail,
    buttons: ['Remove worktree', 'Keep worktree'], defaultId: safe ? 0 : 1, cancelId: 1, noLink: true,
  })
  return answer.response === 0
}

/**
 * After a session tab closes, remove the worktree the desktop made for it, as Settings → General says: without asking
 * when nothing can be lost, otherwise after a prompt (or never). Only the desktop's own `desktop-*` worktrees qualify; an
 * existing worktree the session was started in, a side chat's folder and one another open tab uses are left alone.
 */
function cleanUpSessionWorktree(tab: DesktopSessionTab): void {
  const folder = tab.worktree?.path
  if (!folder || tab.launchWorktree !== true || tab.launchWorktreePath || tab.sideChat || tab.remote) return
  if (desktopConfig.worktreeCleanup === 'keep') return
  const log = (message: string): void => { void writeAppLog(message).catch(() => {}) }
  worktreeCleanupQueue = worktreeCleanupQueue.then(async () => {
    if (shuttingDown() || await openTabUsesFolder(folder)) return
    const executable = await resolveGitExecutable()
    if (!executable) return
    const runner = new GitRunner({ gitPath: executable.path, hooksDirectory: join(app.getPath('userData'), 'git-no-hooks') })
    const runGit = (request: Parameters<GitRunner['run']>[0]): ReturnType<GitRunner['run']> => runner.run(request)
    const state = await inspectDesktopWorktree(folder, runGit)
    if (!state) { log(`Kept the worktree of a closed session; it could not be checked: ${folder}`); return }
    const decision = worktreeCleanupDecision(desktopConfig.worktreeCleanup, state)
    const asked = decision === 'ask'
    if (decision === 'keep' || (asked && !await askToRemoveWorktree(state))) return
    // The prompt can stay open a long time: a tab may have started there, or the worktree changed, since it was read.
    if (shuttingDown() || await openTabUsesFolder(folder)) return
    const current = await inspectDesktopWorktree(folder, runGit)
    if (!current || current.locked || current.head !== state.head || current.branch !== state.branch || current.changes !== state.changes
      || (!asked && !removalIsSafe(current))) {
      log(`Kept the worktree of a closed session; it changed while it was being checked: ${folder}`)
      return
    }
    const { branchDeleted } = await removeDesktopWorktree(current, runGit, { trash: (path) => shell.trashItem(path) })
    log(`Removed the worktree of a closed session${branchDeleted ? ' and its branch' : ''}: ${current.path}`)
  }).catch((error: unknown) => {
    log(`Could not remove the worktree of a closed session (${folder}): ${String(error)}`)
    // A rejected queue would skip every later cleanup, so a failing notification must not reject it.
    try { showNotification('Worktree not removed', `${folder} was kept. ${error instanceof Error ? error.message : ''}`.trim()) }
    catch (notifyError) { log(`Could not show a notification: ${String(notifyError)}`) }
  })
}

async function restartSessionTab(tabId: string): Promise<DesktopState> {
  // Admission check: a shutdown already underway shouldn't accept a new
  // restart even if the per-tab queue is currently free — checked again
  // below, once this restart's turn actually comes up, in case a shutdown
  // starts while it was queued behind another transition on the same tab.
  if (shuttingDown()) throw new Error('An update is installing; sessions cannot be restarted right now')
  // Coalesce with any restart already running or queued for this tab —
  // every caller gets the one outcome instead of a second restart running
  // right after the first and stopping the replacement it just started.
  const pending = pendingRestarts.get(tabId)
  if (pending) return pending
  const restartPromise = queueTabTransition(tabId, async () => {
    if (shuttingDown()) throw new Error('An update is installing; sessions cannot be restarted right now')
    // Re-read tab/profile fresh: this callback may run well after the
    // caller returned (queued behind another transition on the same tab),
    // by which point the tab could have been closed or its profile removed.
    let tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) throw new Error('This session tab no longer exists')
    // Restarting a remote tab used to work (the old PtySession.restart() just
    // replayed its original --connect argument verbatim), but this function
    // rebuilds args from a workspace profile's current settings, which a
    // remote connection has none of. Keep restart consistently unavailable for
    // remote tabs everywhere (menu/tray/button) rather than silently regress
    // one of those entry points to a runtime error.
    if (tab.remote) throw new Error('A remote session cannot be restarted')
    const managed = managedTabs.get(tabId)
    const workspaceProfileId = tab.workspaceProfileId
    const savedProfile = desktopConfig.profiles.find((candidate) => candidate.id === workspaceProfileId)
    if (!savedProfile) throw new Error('This session\'s workspace profile no longer exists')
    const sessionPermissionPreset = tab.sideChat
      ? 'read-only'
      : tab.sessionPermissionPreset ?? savedProfile.permissionPreset
    // The launch is rebuilt from the saved project, but the session keeps the worktree choice it started with.
    const profile = tab.sideChat
      ? sideChatProfile(savedProfile, copilotCapabilities)
      : { ...withSessionChoices(savedProfile, tab.launchWorktree === undefined ? {} : { worktree: tab.launchWorktree })!, permissionPreset: sessionPermissionPreset }

    const bestKnownSessionId = managed?.session.lastSessionId ?? tab.lastSessionId ?? null

    // Validate and build against the session's saved settings BEFORE
    // touching the existing process. buildSessionSpawnPlan can reject (an
    // unavailable resolution, a newly saved but unsupported launch option, a
    // credential-store failure) — that must not cost the user an otherwise
    // healthy, running session. Only the fresh/resume-dependent portion of
    // the resulting args (including --worktree and which resume id to use)
    // may need refreshing once the old process has actually stopped —
    // finalizeSessionArgs() recomputes just that slice, purely and
    // synchronously, from the *final* freshSession decision below, so
    // refreshing it never reintroduces a second point where this can fail
    // after the healthy process is already gone.
    const plan = await buildSessionSpawnPlan(profile, bestKnownSessionId ? 'auto-resume' : 'new', bestKnownSessionId, [], null, tab.title)
    plan.nameSession = tab.autoTitle !== true
    // A session started in an existing worktree runs there again while it is still one of the project's worktrees.
    const existingWorktree = tab.launchWorktreePath && !tab.sideChat ? await resolveLinkedWorktree(savedProfile.path, tab.launchWorktreePath) : null
    if (existingWorktree) plan.cwd = existingWorktree.root
    const worktreeGone = !existingWorktree && !!tab.launchWorktreePath && !tab.sideChat
    if (worktreeGone) void writeAppLog(`A session's worktree is no longer one of the project's; it restarts in the project folder: ${tab.launchWorktreePath}`).catch(() => {})
    plan.env = await prepareBrowserSessionEnvironment(browserSessionRoot(), tabId, plan.env)
    plan.env = await prepareMeetingSessionEnvironment(browserSessionPaths(browserSessionRoot(), tabId).directory, await meetingControl.register(tabId), plan.env)

    if (managed) await managed.session.stop()
    // Read the freshest known session id directly off the old session
    // object, before removing its listeners: PtySession.stop() can return as
    // soon as a force-kill timeout fires, ahead of the later 'exit' event
    // that would otherwise copy this into tabsState — relying on tabsState
    // alone here could still be reflecting an earlier cycle's id.
    let resumeSessionId = managed?.session.lastSessionId ?? bestKnownSessionId
    if (resumeSessionId && !await copilotSessionStored(resumeSessionId)) {
      plan.sessionId = resumeSessionId
      resumeSessionId = null
    }
    tab = tabsState.tabs.find((candidate) => candidate.id === tabId) ?? tab
    managed?.session.removeAllListeners()
    // Capture the terminal size as the very last step before constructing
    // the replacement — no further awaits happen between this line and
    // `new PtySession(...)` below, so whatever size is current at this exact
    // point (including a resize that landed anywhere up to now, via
    // desktop:resize-tab on this same old, still-referenced session) is what
    // the replacement actually gets. Without any managed session (a dormant
    // or unloaded tab, or a previously failed restart), use the size its
    // pane last reported; only a tab never shown falls back to PtySession's
    // 80x24 default, and its pane's first measurement resizes it.
    const dimensions = managed?.session.dimensions ?? terminalSizes.get(tabId)

    const resumeMode: ResumeMode = resumeSessionId ? 'auto-resume' : 'new'
    let session: PtySession
    let deterministicSessionId: string | null
    try {
      const finalized = finalizeSessionArgs(plan, resumeMode, resumeSessionId)
      deterministicSessionId = finalized.deterministicSessionId
      if (tab.sideChat) finalized.args.push('--mode=interactive')
      session = new PtySession({
        file: plan.file,
        args: finalized.args,
        cwd: plan.cwd,
        env: plan.env,
        spawnPty: spawnNodePty,
        worktreeTimeoutMinutes: desktopConfig.worktreeTimeoutMinutes,
        sessionId: deterministicSessionId,
        discoverSessionIdFromOutput: deterministicSessionId === null,
        ...(finalized.worktreeName ? { discoverSessionIdFromStore: { root: copilotSessionRoot({ ...process.env, ...plan.env }), since: Date.now(), launchCwd: plan.cwd, worktreeName: finalized.worktreeName,
          ...(plan.nameSession === false ? { timeoutMs: Number.POSITIVE_INFINITY } : {}) } } : {}),
        monitorSessionPermissions: true,
        ...(dimensions ? { cols: dimensions.cols, rows: dimensions.rows } : {}),
      })
    } catch (error) {
      // The old process is already gone; a validation failure here (for
      // example capabilities changing during the awaits above) must not leave
      // the tab looking alive with no process behind it.
      managedTabs.delete(tabId)
      tabsState = setTabStatus(tabsState, tabId, 'crashed')
      tabsState = setTabProcessId(tabsState, tabId, null)
      syncTabState()
      broadcastState()
      throw error
    }
    managedTabs.set(tabId, { session })
    trackSessionName(tabId, { ...process.env, ...plan.env }, false)
    tabsState = { ...tabsState, tabs: tabsState.tabs.map((candidate) => {
      if (candidate.id !== tabId) return candidate
      const { launchWorktreePath: _gone, unloaded: _resumed, ...rest } = candidate
      // It runs in the project folder now, so it is no longer a session of that worktree.
      return { ...rest, ...(worktreeGone || !candidate.launchWorktreePath ? {} : { launchWorktreePath: candidate.launchWorktreePath }),
        activity: null, activityDetail: null, sessionCwd: null, worktree: null }
    }) }
    sessionCwdGenerations.set(tabId, (sessionCwdGenerations.get(tabId) ?? 0) + 1)
    sessionWorktreeGitDirs.delete(tabId)
    tabsState = setTabStatus(tabsState, tabId, 'starting')
    tabsState = setTabLaunchConfig(tabsState, tabId, {
      cliVersion: plan.cliVersion,
      sessionPermissionPreset,
      sessionPermissionMode: tab.sessionPermissionMode,
      permissionWarning: tab.sideChat ? SIDE_CHAT_PERMISSION_WARNING : permissionCompatibilityWarning(sessionPermissionPreset, copilotCapabilities),
      canFork: !tab.sideChat && supportsSessionFork(state.resolution?.version ?? null),
    })
    // deterministicSessionId is already correct by construction: it's the
    // id finalizeSessionArgs actually baked into args above, computed from
    // the final (post-stop) freshSession decision rather than a frozen
    // pre-stop guess.
    tabsState = setTabSessionId(tabsState, tabId, deterministicSessionId)
    syncTabState()
    broadcastState()
    refreshMenus()
    wireSessionEvents(tabId, session)

    try {
      await session.start()
      scheduleCopilotResolutionRefresh()
    } catch (error) {
      managedTabs.delete(tabId)
      tabsState = setTabStatus(tabsState, tabId, 'crashed')
      // The old process's PID is still sitting in tabsState from its own
      // last 'status' event ('stopping', emitted with the still-live PID
      // just before the kill) — its own exit is 'expected' and emits no
      // further status update to clear it, and the replacement above never
      // reached 'running' to overwrite it. Without this, diagnostics and
      // the tab UI would keep pointing at a PID that no longer exists.
      tabsState = setTabProcessId(tabsState, tabId, null)
      syncTabState()
      broadcastState()
      throw error
    }
    persistProfileTabs()
    return snapshot()
  })
  pendingRestarts.set(tabId, restartPromise)
  void restartPromise.catch(() => {}).finally(() => {
    if (pendingRestarts.get(tabId) === restartPromise) pendingRestarts.delete(tabId)
  })
  return restartPromise
}

/** Lists a saved tab without starting it: its process starts the first time it is shown (`wakeDormantTab`), so a launch
 * with many saved tabs starts one Copilot process instead of all of them. */
function addDormantSessionTab(profile: WorkspaceProfile, candidate: RestoredTab): string {
  assertWorkspaceListed(profile)
  const id = `tab-${nextTabSequence++}`
  const parent = candidate.sideParentSessionId
    ? tabsState.tabs.find((tab) => tab.workspaceProfileId === profile.id && !tab.sideChat && tab.lastSessionId === candidate.sideParentSessionId)
    : undefined
  const sessionPermissionPreset = candidate.sideChat ? 'read-only' : candidate.sessionPermissionPreset ?? profile.permissionPreset
  tabsState = addDormantTab(tabsState, {
    id,
    title: candidate.title.trim().slice(0, 120) || profile.name,
    browserProfileId: selectBrowserProfileId(candidate.browserProfileId, tabsState.tabs.map(tab => tab.browserProfileId)),
    workspaceProfileId: profile.id,
    lastSessionId: candidate.lastSessionId,
    sessionPermissionPreset,
    sessionPermissionMode: candidate.sideChat ? null : candidate.sessionPermissionMode ?? null,
    permissionWarning: candidate.sideChat ? SIDE_CHAT_PERMISSION_WARNING : permissionCompatibilityWarning(sessionPermissionPreset, copilotCapabilities),
    remote: false,
    cliVersion: null,
    ...(candidate.sideChat ? { sideChat: true as const } : {}),
    ...(parent && !tabsState.tabs.some((tab) => tab.sideParentTabId === parent.id) ? { sideParentTabId: parent.id } : {}),
    privateOverrides: candidate.privateOverrides === true,
    launchWorktree: !candidate.sideChat && (candidate.launchWorktree ?? profile.launch.worktree === true),
    ...(candidate.launchWorktreePath && !candidate.sideChat ? { launchWorktreePath: candidate.launchWorktreePath } : {}),
    // A saved tab from an older release has no flag; one still titled with the project's name was never renamed.
    autoTitle: candidate.autoTitle ?? candidate.title === profile.name,
    renamePending: candidate.renamePending === true,
  })
  profilesWithSessionTabs.add(profile.id)
  if (candidate.lastSessionId) {
    const reading = applyDormantSessionCwd(id, candidate.lastSessionId)
      .catch((error) => void writeAppLog(`Could not read a saved session's folder: ${String(error)}`).catch(() => {}))
      .finally(() => dormantFolderReads.delete(id))
    dormantFolderReads.set(id, reading)
  }
  return id
}

const wakingTabs = new Map<string, Promise<void>>()

/** Starts a dormant tab's process, resuming its saved conversation the way Restart does. A failure leaves the tab
 * crashed, with its Restart button, rather than retrying each time it is shown. Settles once the start is over. */
function wakeDormantTab(tabId: string): Promise<void> {
  const pending = wakingTabs.get(tabId)
  if (pending) return pending
  const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
  // An unloaded tab was stopped on purpose: it waits for Resume.
  if (shuttingDown() || tab?.status !== 'dormant' || tab.unloaded) return Promise.resolve()
  const waking = restartSessionTab(tabId).then(() => {}, (error) => {
    void writeAppLog(`Could not start restored session ${tabId}: ${String(error)}`).catch(() => {})
    if (tabsState.tabs.find((tab) => tab.id === tabId)?.status !== 'dormant') return
    tabsState = setTabStatus(tabsState, tabId, 'crashed')
    syncTabState()
    broadcastState()
    refreshMenus()
  }).finally(() => wakingTabs.delete(tabId))
  wakingTabs.set(tabId, waking)
  return waking
}

const sessionCatalogCache: SessionCatalogCache = new Map()

const sameOrInside = isSameOrInside

/** The open project a stored session belongs to: one whose folder holds where it ran, or whose repository it ran in a
 * linked worktree of (then it resumes in that worktree). */
async function projectForSession(session: StoredSession): Promise<{ profile: WorkspaceProfile; worktreePath?: string } | null> {
  if (!session.cwd) return null
  const holding = desktopConfig.profiles.filter((profile) => sameOrInside(session.cwd!, profile.path))
  // The innermost project wins when projects are nested.
  const inside = holding.sort((left, right) => right.path.length - left.path.length)[0]
  if (inside) return { profile: inside }
  for (const profile of desktopConfig.profiles) {
    const worktree = await resolveLinkedWorktree(profile.path, session.cwd).catch(() => null)
    if (worktree) return { profile, worktreePath: worktree.root }
  }
  return null
}

async function listSessionHistory(): Promise<SessionHistoryEntry[]> {
  const sessions = await listStoredSessions(copilotSessionRoot(process.env), { cache: sessionCatalogCache })
  return Promise.all(sessions.map(async (session) => ({
    ...session,
    openTabId: tabsState.tabs.find((tab) => !tab.remote && tab.lastSessionId === session.sessionId)?.id ?? null,
    projectName: (await projectForSession(session))?.profile.name ?? null,
  })))
}

/** Shows a stored session: its tab when it is open, else a new tab that resumes it in its project, adding that project
 * (its repository's folder, or where it ran) when it is not open yet. */
async function openSessionFromHistory(sessionId: string): Promise<DesktopState> {
  if (!isForkSessionId(sessionId)) throw new Error('Invalid session id')
  const open = tabsState.tabs.find((tab) => !tab.remote && tab.lastSessionId === sessionId)
  if (open) return activateSessionTab(open.id)
  if (!isCopilotResolved()) throw new Error('Copilot CLI is not available yet')
  if (tabsState.tabs.length >= MAX_SESSION_TABS) throw new Error(`Close or unload a session tab first: no more than ${MAX_SESSION_TABS} can be open`)
  const session = (await listStoredSessions(copilotSessionRoot(process.env), { cache: sessionCatalogCache, limit: Number.POSITIVE_INFINITY }))
    .find((candidate) => candidate.sessionId === sessionId)
  if (!session?.cwd) throw new Error('That session is no longer stored')
  let target = await projectForSession(session)
  if (!target) {
    const folder = session.gitRoot && sameOrInside(session.cwd, session.gitRoot) ? session.gitRoot : session.cwd
    if (!await stat(folder).then((info) => info.isDirectory(), () => false)) throw new Error(`The folder that session ran in no longer exists: ${folder}`)
    target = { profile: activateWorkspaceProfile(desktopConfig, folder, workspacesInUse()) }
    syncWorkspaceState()
    await persistConfig()
  }
  // Its project's saved tabs come first. Startup may not have listed them yet, and adding a tab before they are listed
  // would save the project with only this one; listing them starts none of them.
  if (target.profile.tabs.length > 0) await restoreTabsForProfile(target.profile, false)
  // Opened meanwhile, or one of those saved tabs: show that tab instead of a second one.
  const opened = tabsState.tabs.find((tab) => !tab.remote && tab.lastSessionId === sessionId)
  if (opened) return activateSessionTab(opened.id)
  const tabId = addDormantSessionTab(target.profile, {
    title: session.name ?? session.firstPrompt ?? target.profile.name,
    lastSessionId: sessionId,
    autoTitle: !session.userNamed,
    // It resumes in the folder it ran in, never in a new worktree.
    launchWorktree: false,
    ...(target.worktreePath ? { launchWorktreePath: target.worktreePath } : {}),
  })
  persistProfileTabs()
  activateSessionTab(tabId)
  await wakingTabs.get(tabId)
  return snapshot()
}

/** `activate`: show this project's last saved tab; restoring other projects' tabs in the background leaves focus alone. */
async function restoreTabsForProfile(profile = activeWorkspaceProfile(desktopConfig), activate = true): Promise<void> {
  if (!profile || !state.resolution || state.resolution.version === null) return
  const pending = pendingProfileRestores.get(profile.id)
  if (pending) return pending
  if (tabsState.tabs.some((tab) => tab.workspaceProfileId === profile.id) && !unrestoredProfileTabs.get(profile.id)?.length) return
  if (!unrestoredProfileTabs.has(profile.id) && profile.tabs.length > 0) {
    unrestoredProfileTabs.set(profile.id, [...profile.tabs])
  }
  const operation = (async () => {
    const restored = [...(unrestoredProfileTabs.get(profile.id) ?? [])]
    // Move only a parent that follows its child; keep already adjacent pairs
    // and all other saved tabs in their existing order.
    for (let index = 0; index < restored.length; index++) {
      const parentId = restored[index]!.sideParentSessionId
      if (!parentId) continue
      const parentIndex = restored.findIndex(tab => !tab.sideChat && tab.lastSessionId === parentId)
      if (parentIndex > index) restored.splice(index, 0, ...restored.splice(parentIndex, 1))
    }
    // A fresh tab for an empty workspace is not a saved session to retain.
    if (!restored.length) {
      try { await createSessionTab(profile, 'new', null, [], null, profile.name) }
      catch (error) { await writeAppLog(`Failed to start a session for ${profile.path}: ${String(error)}`) }
      return
    }
    let last: string | null = null
    for (const candidate of restored) {
      if (shuttingDown() || tabsState.tabs.length >= MAX_SESSION_TABS) break
      try { last = addDormantSessionTab(profile, candidate) }
      catch (error) { await writeAppLog(`Failed to restore tab for ${profile.path}: ${String(error)}`); continue }
      const remaining = (unrestoredProfileTabs.get(profile.id) ?? []).filter(saved => saved !== candidate)
      if (remaining.length) unrestoredProfileTabs.set(profile.id, remaining)
      else unrestoredProfileTabs.delete(profile.id)
    }
    if (activate && last) {
      tabsState = activateTab(tabsState, last)
      desktopConfig.activeProfileId = profile.id
      syncWorkspaceState()
    }
    // Showing the active tab wakes it; a restore that showed its tab is over once that tab has started. One that only
    // listed its tabs does not wait for another project's tab on screen.
    syncTabState()
    persistProfileTabs()
    broadcastState()
    refreshMenus()
    if (!activate) return
    const visible = visibleSessionTabs(tabsState)
    await Promise.all([visible.main?.id, visible.side?.id].flatMap(id => id ? [wakingTabs.get(id)] : []))
  })()
  pendingProfileRestores.set(profile.id, operation)
  try {
    await operation
  } finally {
    if (pendingProfileRestores.get(profile.id) === operation) pendingProfileRestores.delete(profile.id)
  }
}

async function restoreSavedWorkspaceTabs(): Promise<void> {
  const activeProfile = activeWorkspaceProfile(desktopConfig)
  if (!activeProfile) return
  const profiles = [activeProfile, ...desktopConfig.profiles.filter(profile => profile.id !== activeProfile.id)]
    .filter(profile => profile.tabs.length > 0)
  // Do not spend a saved session's slot on a fresh tab in an empty workspace.
  if (!profiles.length) profiles.push(activeProfile)
  await restoreTabsForProfile(profiles[0])
  for (const profile of profiles.slice(1)) await restoreTabsForProfile(profile, false)
  desktopConfig.activeProfileId = tabsState.tabs.find(tab => tab.id === tabsState.activeTabId)?.workspaceProfileId ?? activeProfile.id
  syncWorkspaceState()
  syncTabState()
  persistProfileTabs()
  broadcastState()
  refreshMenus()
  await restoreMeetings().catch((error) => writeAppLog(`Could not restore meetings: ${String(error)}`))
}

/**
 * Meetings that were open when the app closed go on: each saved session is found among the restored tabs by its Copilot
 * session id, and the tabs taking part are started, since a meeting cannot wait for each of them to be shown.
 */
async function restoreMeetings(): Promise<void> {
  await restoreGuestSeats()
  try {
    let entries
    try { entries = await readdir(meetingRoot(), { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !MEETING_ID_PATTERN.test(entry.name)) continue
      const folder = join(meetingRoot(), entry.name)
      let saved: unknown
      try { saved = JSON.parse(await readFile(join(folder, MEETING_STATE_FILE), 'utf8')) } catch { continue }
      const transcript = await readFile(join(folder, 'transcript.md'), 'utf8').catch(() => '')
      const tabs = meetingHub.restore(saved, transcript, (sessionId) => {
        // A guest comes back with its seat, if the seat is still open and belongs to this meeting.
        if (GUEST_ID_PATTERN.test(sessionId)) {
          const seat = guestMailbox.seat(sessionId)
          return seat && seat.closed === null && seat.joined && seat.meetingId === entry.name ? { tabId: seat.id, title: `${seat.name} (guest)`, folder: null } : null
        }
        const tab = tabsState.tabs.find((candidate) => candidate.lastSessionId === sessionId && !candidate.remote && !candidate.unloaded)
        return tab ? { tabId: tab.id, title: tab.title, folder: tab.sessionCwd ?? null } : null
      })
      for (const tabId of tabs ?? []) if (!GUEST_ID_PATTERN.test(tabId)) observe(wakeDormantTab(tabId), 'Could not start a session of a restored meeting')
    }
  } finally {
    guestsReady = true
    guestMailbox.closeEnded((id) => meetingHub.isOpen(id))
    await startGuestMcp()
  }
}

function observe(operation: Promise<unknown>, context: string): void {
  void operation.catch((error) => writeAppLog(`${context}: ${String(error)}`))
}

async function selectWorkspace(): Promise<DesktopState> {
  if (!mainWindow) return snapshot()
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a Copilot workspace',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: activeWorkspaceProfile(desktopConfig)?.path ?? app.getPath('home'),
  })
  const workspace = selection.filePaths[0]
  if (selection.canceled || !workspace) return snapshot()
  let profile: WorkspaceProfile
  try {
    profile = activateWorkspaceProfile(
      desktopConfig,
      workspace,
      workspacesInUse(),
    )
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Workspace limit reached',
      message: error instanceof Error ? error.message : String(error),
    })
    return snapshot()
  }
  syncWorkspaceState()
  await persistConfig()
  broadcastState()
  refreshMenus()
  if (isCopilotResolved()) await createSessionTab(profile, 'new')
  return snapshot()
}

async function activateProfile(profileId: string): Promise<DesktopState> {
  const profile = desktopConfig.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error('The selected workspace profile no longer exists')
  desktopConfig.activeProfileId = profile.id
  syncWorkspaceState()
  await persistConfig()
  broadcastState()
  // Tabs from an inactive profile keep running rather than closing, so
  // switching TO a profile that already has tabs must switch the active tab
  // to one of them — otherwise activeProfileId and activeTabId/terminal
  // input can end up pointing at two different profiles.
  const activeTabBelongsToProfile = tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId)?.workspaceProfileId === profile.id
  if (!activeTabBelongsToProfile) {
    const firstProfileTab = tabsState.tabs.find((tab) => tab.workspaceProfileId === profile.id)
    if (firstProfileTab) {
      activateSessionTab(firstProfileTab.id)
    } else if (isCopilotResolved()) {
      await restoreTabsForProfile()
    }
  }
  return snapshot()
}

/** Forgets a workspace with no sessions open in it. Its folder is not touched. */
async function removeWorkspace(profileId: string): Promise<void> {
  let removed: RemovedWorkspaceProfile | null = null
  // Checked and applied when this save's turn comes, so a session opened in the
  // meantime still blocks it.
  await persistConfig(() => {
    const profile = desktopConfig.profiles.find((candidate) => candidate.id === profileId)
    if (!profile) throw new Error('The selected workspace profile no longer exists')
    const open = tabsState.tabs.filter((tab) => tab.workspaceProfileId === profileId).length
    if (open > 0) {
      throw new Error(`Close the ${open === 1 ? 'session' : `${open} sessions`} open in ${profile.name} before removing it`)
    }
    // Its tab is registered only after the launch is prepared, so it is not in tabsState yet.
    if (startingWorkspaceSessions.has(profileId)) {
      throw new Error(`A session is starting in ${profile.name}. Close it once it opens, then remove the workspace`)
    }
    // The active session's workspace takes over, so the sidebar and the session stay in step.
    const activeTabProfileId = tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId)?.workspaceProfileId ?? null
    removed = removeWorkspaceProfile(desktopConfig, profileId, activeTabProfileId)
    profilesWithSessionTabs.delete(profileId)
    unrestoredProfileTabs.delete(profileId)
    syncWorkspaceState()
  }, () => {
    if (!removed) return
    restoreWorkspaceProfile(desktopConfig, removed)
    syncWorkspaceState()
    broadcastState()
    refreshMenus()
  })
  broadcastState()
  refreshMenus()
}

async function updateWorkspaceProfile(
  profileId: string,
  name: string,
  permissionPreset: PermissionPreset,
  defaultResumeMode: ResumeMode,
  launch: SessionLaunchConfig,
): Promise<void> {
  const profile = desktopConfig.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error('The selected workspace profile no longer exists')
  const normalizedName = name.trim()
  if (!normalizedName || normalizedName.length > 100) throw new Error('Workspace name must contain 1–100 characters')
  if (!isPermissionPreset(permissionPreset)) throw new Error('Invalid permission preset')
  if (!isResumeMode(defaultResumeMode)) throw new Error('Invalid resume mode')
  profile.name = normalizedName
  profile.permissionPreset = permissionPreset
  profile.defaultResumeMode = defaultResumeMode
  profile.launch = normalizeSessionLaunchConfig(launch)
  syncWorkspaceState()
  await persistConfig()
  broadcastState()
}

async function retryResolution(restoreAllWorkspaces = false): Promise<DesktopState> {
  const probe = await probeCopilotResolution()
  state.resolution = probe.resolution
  copilotResolutionRefreshFailureState = EMPTY_RESOLUTION_REFRESH_FAILURE_STATE
  await recheckCopilotCapabilities()
  broadcastState()
  broadcastCopilotSettingsState()
  if (state.resolution.version !== null && desktopConfig.activeProfileId && tabsState.tabs.length === 0) {
    if (restoreAllWorkspaces) await restoreSavedWorkspaceTabs()
    else await restoreTabsForProfile()
  }
  return snapshot()
}

/** Share the executable/version probe across manual and background checks so
 * a Settings recheck cannot race the post-session-start refresh. */
async function probeCopilotResolution(): Promise<{ resolution: CopilotResolution; sequence: number }> {
  if (copilotResolutionProbePromise) return copilotResolutionProbePromise
  const sequence = ++copilotResolutionProbeSequence
  const probe = resolveCopilotBinary().then((resolution) => ({ resolution, sequence }))
  copilotResolutionProbePromise = probe
  try {
    return await probe
  } finally {
    if (copilotResolutionProbePromise === probe) copilotResolutionProbePromise = null
  }
}

/** Re-resolve the executable without disturbing running processes. Copilot's
 * native updater may replace the on-disk CLI at session start; existing PTYs
 * keep their captured version while future sessions use the refreshed one. */
async function refreshCopilotResolutionIfChanged(): Promise<boolean> {
  if (migrationService?.exclusive) return false
  const previousVersion = state.resolution?.version ?? null
  const probe = await probeCopilotResolution()
  const next = probe.resolution
  const previousFailureState = copilotResolutionRefreshFailureState
  copilotResolutionRefreshFailureState = trackResolutionRefreshFailure(
    state.resolution,
    next,
    previousFailureState,
    probe.sequence,
  )
  const countedFailure = copilotResolutionRefreshFailureState !== previousFailureState
  if (!shouldAdoptRefreshedResolution(state.resolution, next, copilotResolutionRefreshFailureState.consecutiveFailures)) {
    if (countedFailure && !sameCopilotResolution(state.resolution, next) && next.version === null) {
      await writeAppLog(
        `Ignored transient Copilot CLI refresh failure (${copilotResolutionRefreshFailureState.consecutiveFailures}/${TRANSIENT_REFRESH_FAILURE_TOLERANCE}): ${next.error ?? 'version probe failed'}`,
      ).catch(() => {})
    }
    return false
  }
  state.resolution = next
  copilotResolutionRefreshFailureState = EMPTY_RESOLUTION_REFRESH_FAILURE_STATE
  await recheckCopilotCapabilities()
  broadcastState()
  broadcastCopilotSettingsState()
  if (previousVersion && next.version && previousVersion !== next.version) {
    await writeAppLog(`Detected Copilot CLI version change: ${previousVersion} -> ${next.version}`).catch(() => {})
  }
  return true
}

function scheduleCopilotResolutionRefresh(attempt = 0): void {
  const delayMs = COPILOT_RESOLUTION_REFRESH_DELAYS_MS[attempt]
  if (delayMs === undefined) return
  if (copilotResolutionRefreshTimer) clearTimeout(copilotResolutionRefreshTimer)
  copilotResolutionRefreshTimer = setTimeout(() => {
    copilotResolutionRefreshTimer = null
    void refreshCopilotResolutionIfChanged()
      .then((changed) => {
        if (!changed) scheduleCopilotResolutionRefresh(attempt + 1)
      })
      .catch((error) => {
        void writeAppLog(`Failed to refresh Copilot CLI version: ${String(error)}`).catch(() => {})
        scheduleCopilotResolutionRefresh(attempt + 1)
      })
  }, delayMs)
  copilotResolutionRefreshTimer.unref()
}

async function recheckCopilotCapabilities(): Promise<void> {
  const resolution = state.resolution
  if (!resolution || resolution.version === null) {
    capabilityProbeGeneration += 1
    copilotCapabilities = { ...EMPTY_COPILOT_CAPABILITIES }
    return
  }
  if (capabilityProbe?.resolution === resolution) {
    await capabilityProbe.promise
    return
  }

  const generation = ++capabilityProbeGeneration
  const promise = discoverCopilotCapabilities(resolution)
  capabilityProbe = { resolution, generation, promise }
  try {
    const discovered = await promise
    if (capabilityProbeGeneration === generation && state.resolution === resolution) {
      copilotCapabilities = discovered
    }
  } finally {
    if (capabilityProbe?.generation === generation) capabilityProbe = null
  }
}

async function maintainCopilotCli(operation: 'install' | 'update'): Promise<void> {
  if (copilotMaintenance.status === 'running') throw new Error('A Copilot CLI maintenance operation is already running')
  if (managedTabs.size > 0) throw new Error('Close all running Copilot sessions before installing or updating the CLI')
  const current = state.resolution
  if (operation === 'update' && (!current || current.version === null)) {
    throw new Error('Copilot CLI is not installed; use Install first')
  }
  copilotMaintenance = {
    status: 'running',
    operation,
    message: operation === 'install' ? 'Installing @github/copilot…' : 'Updating Copilot CLI…',
  }
  try {
    await bestEffortUsage(usageService?.flush())
    const output = operation === 'install'
      ? await installCopilotCli()
      : await updateCopilotCli(current!)
    await bestEffortUsage(usageService?.collect())
    await retryResolution()
    if (!state.resolution || state.resolution.version === null) {
      throw new Error('The command completed, but Copilot CLI still could not be resolved')
    }
    copilotMaintenance = {
      status: 'succeeded',
      operation,
      message: `${operation === 'install' ? 'Installed' : 'Updated'} Copilot CLI ${state.resolution.version}.${output ? ` ${output.slice(-500)}` : ''}`,
    }
  } catch (error) {
    copilotMaintenance = {
      status: 'failed',
      operation,
      message: error instanceof Error ? error.message : String(error),
    }
    throw error
  }
}

function resolvedCopilot(): CopilotResolution {
  const resolution = state.resolution
  if (!resolution || resolution.version === null) throw new Error('Install Copilot CLI before managing Copilot resources')
  return resolution
}

function resourceCopilotEnvironment(): NodeJS.ProcessEnv {
  // Resource discovery and installation must not inherit provider or GitHub
  // credentials. Private authenticated installs remain available directly in
  // Copilot CLI, where the user can make that trust decision explicitly.
  return withoutSensitiveEnvironment(process.env)
}

async function refreshCopilotResources(environment?: NodeJS.ProcessEnv): Promise<void> {
  if (!copilotCapabilities.plugins) throw new Error('This Copilot CLI version does not expose plugin management; update it first')
  const previousOutput = copilotResources.output
  copilotResources = { status: 'loading', output: copilotResources.output, message: 'Loading Copilot resources…' }
  try {
    const result = await runCopilotCommand(resolvedCopilot(), ['plugins', 'list', '--json'], {
      cwd: activeWorkspaceProfile(desktopConfig)?.path,
      env: environment ?? resourceCopilotEnvironment(),
    })
    const output = (result.stdout || result.stderr).trim().slice(0, 500_000)
    copilotResources = {
      status: 'ready',
      output,
      message: output ? 'Resources discovered for the active workspace.' : 'No Copilot resources were reported.',
    }
  } catch (error) {
    copilotResources = {
      status: 'error',
      output: previousOutput,
      message: error instanceof Error ? error.message : String(error),
    }
    throw error
  }
}

async function runCopilotResourceMutation(args: string[]): Promise<void> {
  const environment = resourceCopilotEnvironment()
  await runCopilotCommand(resolvedCopilot(), args, {
    cwd: activeWorkspaceProfile(desktopConfig)?.path,
    timeout: 2 * 60_000,
    env: environment,
  })
  try {
    await refreshCopilotResources(environment)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    copilotResources = {
      ...copilotResources,
      status: 'error',
      message: `The change succeeded, but resources could not be refreshed: ${message}`,
    }
    void writeAppLog(`Copilot resource mutation succeeded but refresh failed: ${message}`).catch(() => {})
  }
}

function installApplicationMenu(): void {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const focusedPopoutId = focusedWindow ? sessionWindowId(focusedWindow.webContents) : undefined
  const menuTabId = focusedPopoutId ?? tabsState.activeTabId
  const mac = process.platform === 'darwin'
  const settingsItem = { label: mac ? 'Settings…' : 'Desktop Settings…', accelerator: 'CmdOrCtrl+,', click: () => observe(showSettingsWindow(), 'Could not open Settings') }
  const quitItem = { label: mac ? 'Quit Copilot CLI Desktop' : 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => void requestExplicitQuit() }
  const menu = Menu.buildFromTemplate([
    // macOS puts About, Settings and Quit in the application menu, and its copy and paste keys work only through an Edit menu.
    ...(mac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        settingsItem,
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        quitItem,
      ],
    }, { role: 'editMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => observe(selectWorkspace(), 'Could not open workspace') },
        {
          label: 'New Session Tab',
          accelerator: 'CmdOrCtrl+T',
          enabled: !installInProgress && desktopConfig.activeProfileId !== null && tabsState.tabs.length < MAX_SESSION_TABS,
          click: () => requestNewSession(false),
        },
        {
          label: 'Host a Meeting from an Outside Agent…',
          click: () => observe(inviteHostFromMenu(), 'Could not make a host invitation'),
        },
        {
          label: 'Close Session Tab',
          accelerator: 'CmdOrCtrl+W',
          enabled: tabsState.activeTabId !== null,
          click: () => {
            const focused = BrowserWindow.getFocusedWindow()
            const poppedOut = focused ? sessionWindowId(focused.webContents) : undefined
            if (poppedOut) dockSessionTab(poppedOut)
            else if (tabsState.activeTabId) observe(closeSessionTab(tabsState.activeTabId), 'Could not close session tab')
          },
        },
        {
          label: 'Resume Session…',
          enabled: !installInProgress && desktopConfig.activeProfileId !== null && tabsState.tabs.length < MAX_SESSION_TABS,
          click: () => observe(createSessionTab(undefined, 'picker'), 'Could not open session picker'),
        },
        {
          label: 'New Session with Attachments…',
          enabled: !installInProgress && desktopConfig.activeProfileId !== null && tabsState.tabs.length < MAX_SESSION_TABS,
          click: () => requestNewSession(true),
        },
        {
          label: 'Restart Active Session',
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: !shuttingDown() && tabsState.tabs.some(tab => tab.id === menuTabId && !tab.remote),
          click: () => menuTabId && observe(restartSessionTab(menuTabId), 'Could not restart session tab'),
        },
        {
          label: 'Session History…',
          accelerator: 'CmdOrCtrl+Shift+H',
          enabled: !installInProgress,
          click: () => requestSessionHistory(),
        },
        {
          label: 'Unload Active Session',
          enabled: !shuttingDown() && tabsState.tabs.some(tab => tab.id === menuTabId && !tab.remote && tab.status !== 'dormant'),
          click: () => menuTabId && observe(unloadSessionTab(menuTabId), 'Could not unload session tab'),
        },
        ...(mac ? [] : [settingsItem, { type: 'separator' as const }, quitItem]),
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Group Sessions',
          submenu: [
            { label: 'By Workspace', type: 'radio', checked: sidebarView.group === 'workspace', click: () => requestSidebarView({ group: 'workspace' }) },
            { label: 'In One List', type: 'radio', checked: sidebarView.group === 'list', click: () => requestSidebarView({ group: 'list' }) },
          ],
        },
        {
          label: 'Order Sessions',
          submenu: [
            { label: 'Manually', type: 'radio', checked: sidebarView.order === 'manual', click: () => requestSidebarView({ order: 'manual' }) },
            { label: 'By Last Updated', type: 'radio', checked: sidebarView.order === 'last-updated', click: () => requestSidebarView({ order: 'last-updated' }) },
          ],
        },
        { type: 'separator' },
        ...(!app.isPackaged ? [
          { role: 'reload' as const },
          { role: 'toggleDevTools' as const },
          { type: 'separator' as const },
        ] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Show Active Session Log',
          enabled: tabsState.activeTabId !== null,
          click: () => tabsState.activeTabId && observe(showSessionLog(tabsState.activeTabId), 'Could not show session log'),
        },
        { label: 'Show Application Log', click: () => observe(showApplicationLog(), 'Could not show application log') },
        { label: 'Copy Diagnostics', click: copyDiagnosticsToClipboard },
        { type: 'separator' },
        { label: 'Open Releases', click: () => observe(shell.openExternal(RELEASES_URL), 'Could not open releases') },
        ...(mac ? [] : [{ role: 'about' as const }]),
      ],
    },
    ...(mac ? [{ role: 'windowMenu' as const }] : []),
  ])
  Menu.setApplicationMenu(menu)
  // On Windows/Linux this setter installs the menu on every existing window.
  // Remove it again from pop-outs, including its main-window accelerators.
  for (const window of sessionWindows.values()) if (!window.isDestroyed()) window.setMenu(null)
}

function createWindow(
  showOnReady = true,
  packageSmokeCallbacks?: { didFinishLoad: () => void; didFailLoad: (description: string) => void },
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b1020',
    icon: iconPath(),
    title: 'Copilot CLI Desktop',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  })
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  let mainFrameLoadFailed = false
  if (packageSmokeCallbacks) {
    window.webContents.once('did-fail-load', (_event, _errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      mainFrameLoadFailed = true
      packageSmokeCallbacks.didFailLoad(errorDescription)
    })
    window.webContents.once('did-finish-load', () => {
      if (!mainFrameLoadFailed) packageSmokeCallbacks.didFinishLoad()
    })
  }
  window.once('ready-to-show', () => {
    if (showOnReady) window.show()
  })
  window.on('focus', refreshMenus)
  window.on('focus', () => { if (desktopConfig.activeProfileId) gitService?.requestRefresh(desktopConfig.activeProfileId) })
  // A hidden window (tray mode) or a minimized one must not keep running git.
  window.on('hide', () => gitService?.setPaused(true))
  // Ctrl+Shift+G toggles the Git panel. Handled here, before the page sees the key, so the terminal never receives ^G.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt || !input.shift || !(input.control || input.meta)) return
    if (input.key.toLowerCase() !== 'g') return
    event.preventDefault()
    toggleGitPanel()
  })
  window.on('minimize', () => gitService?.setPaused(true))
  window.on('show', () => gitService?.setPaused(false))
  window.on('restore', () => gitService?.setPaused(false))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== shellUrl()) event.preventDefault()
  })
  window.on('close', (event) => {
    if (explicitQuitRequested || desktopConfig.closeBehavior === 'quit') return
    if (desktopConfig.closeBehavior === 'tray' && tray && !tray.isDestroyed()) {
      event.preventDefault()
      hideWindowToTray(window)
      return
    }
    event.preventDefault()
    observe(promptForWindowClose(window), 'Could not show close confirmation')
  })
  window.on('closed', () => {
    finishClosePrompt(window, closePromptAbort)
    mainWindow = null
    // Auxiliary windows must not keep the app alive after closing the main
    // window with Quit selected. before-quit owns all session cleanup.
    if (!explicitQuitRequested) app.quit()
  })
  observe(window.loadFile(rendererPath('index.html')), 'Could not load application window')
  return window
}

async function showSettingsWindow(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  const window = new BrowserWindow({
    width: 760,
    height: 760,
    minWidth: 600,
    minHeight: 560,
    show: false,
    backgroundColor: '#07101e',
    icon: iconPath(),
    title: 'Desktop Settings',
    webPreferences: {
      preload: settingsPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  })
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  settingsWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== settingsUrl()) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (settingsWindow === window) { migrationService?.cancel(); settingsWindow = null }
  })
  await window.loadFile(rendererPath('settings.html'))
}

interface DesktopSettingsSnapshot extends DesktopPreferences {
  launchAtLogin: boolean
  launchAtLoginAvailable: boolean
  globalShortcutRegistered: boolean
  globalShortcutAccelerator: string
  credentials: Awaited<ReturnType<SecureCredentialStore['status']>> | null
  update: DesktopUpdateState
  profiles: WorkspaceProfile[]
  activeProfileId: string | null
  rollbackVersion: string | null
  access: Awaited<ReturnType<typeof readAccessStatus>>
  provider: CopilotProviderConfig
  cliVersion: string | null
  cliCapabilities: CopilotCapabilities
  cliMaintenance: CopilotMaintenanceState
  cliAutoUpdate: CopilotAutoUpdateState
  resources: CopilotResourcesState
}

function copilotUserSettingsPath(): string {
  const configDirectory = process.env.COPILOT_HOME || join(app.getPath('home'), '.copilot')
  return join(configDirectory, 'settings.json')
}

function settingsPreferences(): DesktopPreferences {
  return {
    closeBehavior: desktopConfig.closeBehavior,
    trayEnabled: desktopConfig.trayEnabled,
    notifications: desktopConfig.notifications,
    automaticUpdateChecks: desktopConfig.automaticUpdateChecks,
    globalShortcutEnabled: desktopConfig.globalShortcutEnabled,
    browserProfile: desktopConfig.browserProfile,
    browserOverrides: desktopConfig.browserOverrides,
    worktreeTimeoutMinutes: desktopConfig.worktreeTimeoutMinutes,
    worktreeCleanup: desktopConfig.worktreeCleanup,
    meetingMaxRounds: desktopConfig.meetingMaxRounds,
    meetingRoundTimeoutMinutes: desktopConfig.meetingRoundTimeoutMinutes,
    meetingDiscussion: desktopConfig.meetingDiscussion,
  }
}

function broadcastSettingsPreferences(): void {
  const window = settingsWindow
  if (!window || window.isDestroyed() || window.webContents.getURL() !== settingsUrl()) return
  window.webContents.send('desktop-settings:preferences-changed', settingsPreferences())
}

async function settingsSnapshot(): Promise<DesktopSettingsSnapshot> {
  const activeProfile = activeWorkspaceProfile(desktopConfig)
  const [credentials, access, cliAutoUpdate] = await Promise.all([
    credentialStore ? credentialStore.status() : Promise.resolve(null),
    readAccessStatus(activeProfile?.permissionPreset ?? 'default', copilotCapabilities),
    readCopilotAutoUpdate(copilotUserSettingsPath()),
  ])
  return {
    ...settingsPreferences(),
    launchAtLogin: launchAtLoginEnabled(),
    launchAtLoginAvailable: launchAtLoginAvailable(),
    globalShortcutRegistered: globalShortcut.isRegistered(GLOBAL_TOGGLE_SHORTCUT),
    globalShortcutAccelerator: GLOBAL_TOGGLE_SHORTCUT_LABEL,
    credentials,
    profiles: desktopConfig.profiles.map((profile) => ({ ...profile })),
    activeProfileId: desktopConfig.activeProfileId,
    rollbackVersion: desktopConfig.rollbackVersion,
    access,
    provider: { ...desktopConfig.provider },
    cliVersion: state.resolution?.version ?? null,
    cliCapabilities: { ...copilotCapabilities },
    cliMaintenance: { ...copilotMaintenance },
    cliAutoUpdate,
    resources: { ...copilotResources },
    update: updateController?.snapshot ?? {
      status: 'unavailable',
      currentVersion: app.getVersion(),
      availableVersion: null,
      downloadPercent: null,
      message: 'Update service is not initialized.',
      canCheck: false,
      canDownload: false,
      canInstall: false,
    },
  }
}

function broadcastUpdateState(update: DesktopUpdateState): void {
  const window = settingsWindow
  if (window && !window.isDestroyed() && isLauncherShellUrl(window.webContents.getURL(), settingsUrl())) {
    window.webContents.send('desktop-settings:update-state-changed', update)
  }
}

function broadcastCopilotSettingsState(): void {
  const window = settingsWindow
  if (window && !window.isDestroyed() && isLauncherShellUrl(window.webContents.getURL(), settingsUrl())) {
    window.webContents.send('desktop-settings:copilot-state-changed', {
      cliVersion: state.resolution?.version ?? null,
      cliCapabilities: { ...copilotCapabilities },
      cliMaintenance: { ...copilotMaintenance },
    })
  }
}

function scheduleAutomaticUpdateCheck(delayMs = 15_000): void {
  if (updateCheckTimer) clearTimeout(updateCheckTimer)
  updateCheckTimer = null
  if (!desktopConfig.automaticUpdateChecks || !updateController) return
  updateCheckTimer = setTimeout(() => {
    updateCheckTimer = null
    const operation = !installInProgress && updateController?.snapshot.canCheck ? updateController.check() : Promise.resolve()
    void operation.catch((error) => writeAppLog(`Automatic update check failed: ${String(error)}`))
      .finally(() => scheduleAutomaticUpdateCheck(6 * 60 * 60 * 1_000))
  }, delayMs)
  updateCheckTimer.unref()
}

async function stopAllSessions(): Promise<void> {
  // Route every stop through the same per-tab queue restart/close use, so
  // this can't snapshot managedTabs out from under an in-flight restart —
  // stopping the old process it's about to replace while missing the
  // replacement it goes on to register right after, orphaning a process
  // that survives this "stop everything" call entirely. Tabs with a
  // transition already queued (but not yet in managedTabs, e.g. a restart
  // that hasn't reached managedTabs.set() yet) are included too.
  const tabIds = new Set([...managedTabs.keys(), ...tabTransitionQueue.keys()])
  await Promise.all([...tabIds].map((tabId) => queueTabTransition(tabId, async () => {
    const managed = managedTabs.get(tabId)
    if (!managed) return
    await managed.session.stop().catch(() => {})
    managed.session.removeAllListeners()
    managedTabs.delete(tabId)
  })))
}

// --- IPC: main window -------------------------------------------------
function browserForSender(event: IpcMainInvokeEvent, tabId: unknown): BrowserDebug {
  assertTrustedIpcSender(event)
  if (!isSessionTabId(tabId) || !tabsState.tabs.some(tab => tab.id === tabId)) {
    throw new Error('Unknown browser session')
  }
  const owner = sessionWindows.get(tabId) ?? mainWindow
  if (!owner || owner.isDestroyed() || !ownsSessionTerminal(event, tabId) || shuttingDown()) {
    throw new Error('Browser controls are only available in the owning session window')
  }
  let browser = sessionBrowsers.get(tabId)
  if (!browser) {
    if (closingBrowserTabs.has(tabId)) throw new Error('Browser session is closing')
    const tab = tabsState.tabs.find(tab => tab.id === tabId)!
    // Unloading freed this browser; a poll from a panel still on screen must not bring it back before Resume.
    if (tab.unloaded) throw new Error('This session is unloaded; resume it to use its browser')
    const paths = browserSessionPaths(browserSessionRoot(), tabId)
    // The tab's own settings keep its last page; the browser profile setting decides whose cookies and storage it uses.
    const profile = browserProfilePaths(app.getPath('userData'), tab.browserProfileId!)
    const partitionProfileId = desktopConfig.browserProfile === 'shared' ? SHARED_BROWSER_PROFILE_ID : tab.browserProfileId!
    const partition = browserProfilePaths(app.getPath('userData'), partitionProfileId).partition
    // Before BrowserDebug creates the partition's session, which reads Preferences only once; an open session keeps its own.
    const partitionOpen = [...sessionBrowsers.values()].some(other => other.partition === partition)
    // A session with Local Overrides of its own runs DevTools in its own partition (its folders) and keeps its page
    // partition's DevTools settings (the on/off switch) out of the shared ones. On the shared browser profile every session's
    // pages use one partition, so the switch is shared; the folder is still its own.
    const privateOverrides = tab.privateOverrides === true
    const privateSettings = privateOverrides && partitionProfileId !== SHARED_BROWSER_PROFILE_ID
    try { shareDevtoolsSettings(app.getPath('userData'), partitionOpen ? undefined : partitionProfileId, { private: privateSettings }) }
    catch (error) { logBrowserError(`Could not share DevTools settings: ${String(error)}`) }
    browser = new BrowserDebug(owner, profile.settings, { endpointPath: paths.endpoint, partition, tabId,
      history: sharedBrowserHistory(), sitePermissions: sharedSitePermissions(), zoom: sharedBrowserZoom(),
      onAppShortcut: () => toggleGitPanel(), reportError: logBrowserError, ...(privateOverrides ? { devtoolsPartition: profile.devtoolsPartition } : {}) })
    sessionBrowsers.set(tabId, browser)
  }
  browser.setOwner(owner)
  return browser
}

ipcMain.handle('desktop:browser-open', (event, tabId: unknown) => browserForSender(event, tabId).open())
ipcMain.handle('desktop:browser-state', (event, tabId: unknown) => browserForSender(event, tabId).snapshot)
ipcMain.handle('desktop:browser-navigate', (event, tabId: unknown, url: unknown) => {
  const browser = browserForSender(event, tabId)
  if (typeof url !== 'string' || url.length > 8192) throw new Error('Invalid browser URL')
  return browser.navigate(url)
})
ipcMain.handle('desktop:browser-action', (event, tabId: unknown, action: unknown) => {
  const browser = browserForSender(event, tabId)
  if (typeof action !== 'string') throw new Error('Invalid browser action')
  return browser.action(action)
})
ipcMain.handle('desktop:browser-pick', (event, tabId: unknown) => browserForSender(event, tabId).pickElement())
ipcMain.handle('desktop:browser-pick-many', async (event, tabId: unknown) => {
  const browser = browserForSender(event, tabId)
  await browser.pickElement(text => { if (!event.sender.isDestroyed()) event.sender.send('desktop:browser-picked', tabId, text) })
})
ipcMain.handle('desktop:browser-dialog', (event, tabId: unknown, accept: unknown) => {
  const browser = browserForSender(event, tabId)
  if (typeof accept !== 'boolean') throw new Error('Invalid dialog answer')
  return browser.answerDialog(accept)
})
ipcMain.handle('desktop:browser-screenshot', (event, tabId: unknown) => browserForSender(event, tabId).screenshotToClipboard())
ipcMain.handle('desktop:browser-find', (event, tabId: unknown, text: unknown, forward: unknown, next: unknown) => {
  const browser = browserForSender(event, tabId)
  if (typeof text !== 'string' || text.length > 500 || typeof forward !== 'boolean' || typeof next !== 'boolean') throw new Error('Invalid find request')
  return browser.find(text, forward, next)
})
ipcMain.handle('desktop:browser-find-stop', (event, tabId: unknown) => browserForSender(event, tabId).stopFind())
ipcMain.handle('desktop:browser-pick-cancel', (event, tabId: unknown) => { browserForSender(event, tabId).cancelPick() })
ipcMain.handle('desktop:browser-export', async (event, tabId: unknown, kind: unknown) => {
  const browser = browserForSender(event, tabId)
  if (kind !== 'console' && kind !== 'network') throw new Error('Invalid browser export')
  const data = JSON.stringify(browser.snapshot[kind], null, 2)
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed()) throw new Error('Browser window has closed')
  const result = await dialog.showSaveDialog(owner, { title: `Save captured ${kind} log`,
    defaultPath: `browser-${kind}-${new Date().toISOString().replaceAll(':', '-')}.json`,
    filters: [{ name: 'JSON log', extensions: ['json'] }] })
  if (!result.canceled && result.filePath) await writeFileAtomic(result.filePath, data)
})
ipcMain.handle('desktop:browser-bounds', (event, tabId: unknown, bounds: unknown) => {
  assertTrustedIpcSender(event)
  // Ignore old renderer cleanup after a tab was closed or moved to another window.
  if (bounds === null && isSessionTabId(tabId) && (!tabsState.tabs.some(tab => tab.id === tabId) || !ownsSessionTerminal(event, tabId))) return
  const browser = browserForSender(event, tabId)
  if (bounds !== null) {
    if (!bounds || typeof bounds !== 'object' || !['x', 'y', 'width', 'height'].every(key => {
      const value = (bounds as Record<string, unknown>)[key]
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 20000
    })) throw new Error('Invalid browser bounds')
  }
  const visible = visibleSessionTabs(tabsState)
  if (bounds !== null && event.sender === mainWindow?.webContents && tabId !== visible.main?.id && tabId !== visible.side?.id) return
  browser.setBounds(bounds as BrowserBounds | null)
})

// pty IPC channels (write/resize) validate the sender against the launcher
// shell URL like every other handler; the tabId itself is passed explicitly
// by the renderer; only the current terminal owner may write or resize it.
ipcMain.handle('desktop:get-state', (event) => {
  assertTrustedIpcSender(event)
  return snapshot(sessionWindowId(event.sender))
})
registerGitIpc({
  ipcMain: ipcMain as unknown as Parameters<typeof registerGitIpc>[0]['ipcMain'],
  service: gitServiceInstance,
  assertTrustedSender: (event: GitIpcEvent) => assertTrustedIpcSender(event as unknown as IpcMainInvokeEvent),
  isMainWindowSender: (event: GitIpcEvent) => mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.webContents.id === event.sender.id,
})
ipcMain.handle('desktop:pop-out-tab', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (!isSessionTabId(tabId)) throw new Error('Invalid session tab')
  return popOutSessionTab(tabId)
})
ipcMain.handle('desktop:dock-tab', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (!isSessionTabId(tabId)) throw new Error('Invalid session tab')
  return dockSessionTab(tabId)
})
ipcMain.handle('desktop:sidebar-view-changed', (event, view: unknown) => {
  assertTrustedIpcSender(event)
  const { group, order } = (view ?? {}) as Partial<Record<keyof SidebarView, unknown>>
  if ((group !== 'workspace' && group !== 'list') || (order !== 'manual' && order !== 'last-updated')) throw new Error('Invalid sidebar view')
  sidebarView = { group, order }
  refreshMenus()
})
ipcMain.handle('desktop:select-workspace', (event) => {
  assertTrustedIpcSender(event)
  return selectWorkspace()
})
ipcMain.handle('desktop:activate-profile', (event, profileId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof profileId !== 'string') throw new Error('Invalid workspace profile')
  return activateProfile(profileId)
})
ipcMain.handle('desktop:remove-profile', async (event, profileId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof profileId !== 'string') throw new Error('Invalid workspace profile')
  await removeWorkspace(profileId)
  return snapshot()
})
ipcMain.handle('desktop:create-tab', (event, resumeMode: unknown, profileId: unknown, title: unknown, options: unknown) => {
  assertTrustedIpcSender(event)
  const override = isResumeMode(resumeMode) ? resumeMode : null
  const sessionTitle = newSessionTitle(title)
  const choices = newSessionOptions(options)
  if (profileId === undefined) return createSessionTab(withSessionChoices(activeWorkspaceProfile(desktopConfig), choices), override, null, [], null, sessionTitle, dialogChoices(choices))
  if (typeof profileId !== 'string') throw new Error('Invalid workspace profile')
  const profile = desktopConfig.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error('The selected workspace profile no longer exists')
  return createSessionTab(withSessionChoices(profile, choices), override, null, [], null, sessionTitle, dialogChoices(choices))
})
ipcMain.handle('desktop:list-session-worktrees', async (event, profileId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof profileId !== 'string') throw new Error('Invalid workspace profile')
  const profile = desktopConfig.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error('The selected workspace profile no longer exists')
  return (await listLinkedWorktrees(profile.path)).map(({ root, name, branch }): SessionWorktreeInfo => ({ path: root, name, branch }))
})
ipcMain.handle('desktop:create-tab-with-attachments', (event, title: unknown, options: unknown) => {
  assertTrustedIpcSender(event)
  return createSessionWithAttachments(newSessionTitle(title), newSessionOptions(options))
})
ipcMain.handle('desktop:fan-out', (event, profileId: unknown, label: unknown, count: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof profileId !== 'string') throw new Error('Invalid workspace profile')
  const profile = desktopConfig.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error('The selected workspace profile no longer exists')
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > 120) throw new Error('Invalid fan-out label')
  if (typeof count !== 'number') throw new Error('Invalid session count')
  return fanOutSessions(profile, label.trim(), count)
})
ipcMain.handle('desktop:activate-tab', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string') throw new Error('Invalid session tab')
  return activateSessionTab(tabId)
})
ipcMain.handle('desktop:rename-tab', (event, tabId: unknown, title: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string' || typeof title !== 'string') throw new Error('Invalid session title')
  return renameSessionTab(tabId, title)
})
ipcMain.handle('desktop:close-tab', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string') throw new Error('Invalid session tab')
  return closeSessionTab(tabId)
})
ipcMain.handle('desktop:list-session-history', (event) => {
  assertTrustedIpcSender(event)
  return listSessionHistory()
})
ipcMain.handle('desktop:open-session-history', (event, sessionId: unknown) => {
  assertTrustedIpcSender(event)
  if (!isForkSessionId(sessionId)) throw new Error('Invalid session id')
  return openSessionFromHistory(sessionId)
})
ipcMain.handle('desktop:unload-tab', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string') throw new Error('Invalid session tab')
  return unloadSessionTab(tabId)
})
ipcMain.handle('desktop:restart-tab', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string') throw new Error('Invalid session tab')
  return restartSessionTab(tabId)
})
ipcMain.handle('desktop:fork-side-chat', (event, tabId: unknown, sourceSessionId: unknown, title: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string' || typeof sourceSessionId !== 'string' || typeof title !== 'string' || title.length > 120) {
    throw new Error('Invalid side-chat request')
  }
  return forkSideChat(tabId, sourceSessionId, title)
})
ipcMain.handle('desktop:write-tab', (event, tabId: unknown, data: unknown, gitCursorContext?: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string' || typeof data !== 'string') throw new Error('Invalid pty input')
  if (!ownsSessionTerminal(event, tabId)) return { gitCursorContextAttached: false }
  const held = heldInput.get(tabId)
  if (held) { held.push(data); return { gitCursorContextAttached: false } }
  const draft = promptDrafts.get(tabId)
  const tab = tabsState.tabs.find(candidate => candidate.id === tabId)
  const session = managedTabs.get(tabId)?.session
  const idle = session?.activity === 'idle' || (session?.activity === null && session.recentOutputText.includes('open sidebar'))
  if (data === '\r' && typeof gitCursorContext === 'string' && gitCursorContext.trim() && gitCursorContext.length <= 8_000
    && draft?.canAttachContext && tab?.status === 'running' && !tab.remote && session?.bracketedPaste && idle) {
    // This Enter belongs to the person. Append one bracketed excerpt to their existing draft, then submit once it has
    // landed, holding subsequent input just as sendSessionTask does. No cursor movement or draft replacement is needed.
    const paste = taskPasteSequence(`\n\n${gitCursorContext}`)
    const queued: string[] = []
    heldInput.set(tabId, queued)
    draft.note(paste)
    session.write(paste)
    setTimeout(() => {
      if (heldInput.get(tabId) !== queued) return
      heldInput.delete(tabId)
      if (managedTabs.get(tabId)?.session !== session) return
      session.write('\r')
      draft.note('\r')
      for (const input of queued) { draft.note(input); session.write(input) }
    }, 300)
    return { gitCursorContextAttached: true }
  }
  promptDrafts.get(tabId)?.note(data)
  managedTabs.get(tabId)?.session.write(data)
  return { gitCursorContextAttached: false }
})
/** The person's controls for a meeting: stop it, let a paused one go on, add a session, open its transcript. */
ipcMain.handle('desktop:meeting-action', async (event, meetingId: unknown, action: unknown, tabId: unknown, role: unknown): Promise<void> => {
  assertTrustedIpcSender(event)
  if (typeof meetingId !== 'string' || !MEETING_ID_PATTERN.test(meetingId)) throw new Error('Invalid meeting')
  if (action === 'stop') meetingHub.stop(meetingId)
  else if (action === 'resume') meetingHub.resume(meetingId)
  else if (action === 'remove') {
    // An outside agent, joined or only invited: it leaves the round, and its token answers why from now on.
    const seat = typeof tabId === 'string' ? guestMailbox.seat(tabId) : null
    if (!seat || seat.meetingId !== meetingId) throw new Error('That guest is not in this meeting')
    if (seat.joined) meetingHub.leave(seat.id)
    guestMailbox.close(seat.id, 'The person removed you from the meeting.')
  } else if (action === 'join') {
    if (!isSessionTabId(tabId)) throw new Error('Invalid session')
    const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.remote) throw new Error('Only a local session can join a meeting')
    // Nothing can be typed into a session without a running CLI: it would sit in the round as a reviewer that never answers.
    if (tab.unloaded || !managedTabs.has(tabId) || (tab.status !== 'running' && tab.status !== 'approval-needed')) {
      throw new Error(`"${tab.title}" is not running. Resume it, then add it to the meeting.`)
    }
    if (role !== undefined && role !== null && (typeof role !== 'string' || role.length > 200)) throw new Error('Invalid role')
    try { meetingHub.join(meetingParty(tabId), meetingId, { role: role || null, usage: meetingReaders.get(tabId)?.usage ?? null }) }
    catch (error) { throw error instanceof MeetingError ? new Error(error.message) : error }
  } else if (action === 'transcript') {
    const folder = meetingHub.folderOf(meetingId)
    if (!folder) throw new Error('That meeting is no longer listed')
    const failure = await shell.openPath(join(folder, 'transcript.md'))
    if (failure) throw new Error(failure)
  } else throw new Error('Invalid meeting action')
})

/**
 * The person invites an outside agent (Claude Code, Codex CLI, …) to review: a seat with its own token, and the invitation
 * to paste into that agent, also put on the clipboard. Only the person can do this; no model can add a guest.
 */
ipcMain.handle('desktop:meeting-invite', async (event, meetingId: unknown, name: unknown, role: unknown): Promise<string> => {
  assertTrustedIpcSender(event)
  if (typeof meetingId !== 'string' || !MEETING_ID_PATTERN.test(meetingId)) throw new Error('Invalid meeting')
  if (typeof name !== 'string' || name.length > 200) throw new Error('Invalid name')
  if (role !== undefined && role !== null && (typeof role !== 'string' || role.length > 200)) throw new Error('Invalid role')
  const meeting = meetingViews().find((candidate) => candidate.id === meetingId)
  if (!meeting || meeting.stage === 'closed') throw new Error(`There is no open meeting ${meetingId}.`)
  if (meeting.participants.length + (meeting.invited?.length ?? 0) >= MAX_MEETING_PARTICIPANTS) {
    throw new Error(`Meeting ${meetingId} already has ${MAX_MEETING_PARTICIPANTS} reviewers and invitations.`)
  }
  // The endpoint file must be there before the guest's first call, even if no session has started the server yet.
  await meetingControl.port()
  await guestEndpointWrite
  const { seat, token } = guestMailbox.invite(meetingId, name, typeof role === 'string' ? role : null)
  await mkdir(guestSeatFolder(guestRoot(), seat.id), { recursive: true })
  const helper = join(guestRoot(), process.platform === 'win32' ? 'meeting-guest.ps1' : 'meeting-guest.sh')
  const invitation = guestInvitation({ meetingId, role: seat.role, token, helper: guestHelperCommand(helper), tools: guestMcp.url() !== null })
  clipboard.writeText(invitation)
  return invitation
})

/**
 * A host invitation: a seat whose outside agent may start one meeting of its own. Only the person makes one (this IPC, or
 * File → Host a Meeting from an Outside Agent…). `folder` is the project the person picked, whose changes the desktop
 * may attach; null for none.
 */
async function inviteHost(folder: string | null): Promise<string> {
  await meetingControl.port()
  await guestEndpointWrite
  const { seat, token } = guestMailbox.invite('', 'Outside agent', null, { kind: 'host', folder })
  const helper = join(guestRoot(), process.platform === 'win32' ? 'meeting-guest.ps1' : 'meeting-guest.sh')
  const invitation = guestHostInvitation({ token, helper: guestHelperCommand(helper), tools: guestMcp.url() !== null, folder: seat.folder })
  clipboard.writeText(invitation)
  return invitation
}

ipcMain.handle('desktop:meeting-host-invite', async (event, folder: unknown): Promise<string> => {
  assertTrustedIpcSender(event)
  if (folder !== null && (typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 4096)) throw new Error('Invalid folder')
  if (folder !== null && !(await stat(folder).then((info) => info.isDirectory(), () => false))) throw new Error(`${folder} is not a folder`)
  return inviteHost(folder)
})

/** The menu's way to a host invitation: ask whether to attach a project's changes, then copy the invitation. */
async function inviteHostFromMenu(): Promise<void> {
  const window = BrowserWindow.getFocusedWindow() ?? undefined
  const options = {
    type: 'question' as const,
    title: 'Host a meeting from an outside agent',
    message: 'Let an outside agent, such as Claude Code, host a review meeting?',
    detail: 'You get an invitation to paste into the agent. It starts the meeting and answers the reviewers you add. To let it attach its uncommitted changes, pick its project folder.',
    buttons: ['Pick a Project Folder…', 'No Changes', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  }
  const choice = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  if (choice.response === 2) return
  let folder: string | null = null
  if (choice.response === 0) {
    const picked = window
      ? await dialog.showOpenDialog(window, { title: 'The agent\'s project folder', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: 'The agent\'s project folder', properties: ['openDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return
    folder = picked.filePaths[0]
  }
  await inviteHost(folder)
  const done = {
    type: 'info' as const,
    title: 'Host invitation copied',
    message: 'The host invitation is on the clipboard.',
    detail: 'Paste it into the agent on this computer, with what you want reviewed. Unused, it expires in 15 minutes. Once the agent starts the meeting, its bar appears here: add the reviewers from it.',
  }
  if (window) await dialog.showMessageBox(window, done)
  else await dialog.showMessageBox(done)
}

// Resolve with Copilot: the task goes to the session, and the repository is claimed for it in main, so the panel's writes
// there are refused while it works, however often the panel is closed and reopened.
ipcMain.handle('desktop:git-resolve', (event, profileId: unknown, repoId: unknown, tabId: unknown, text: unknown): SessionTaskSend => {
  assertTrustedIpcSender(event)
  if (typeof profileId !== 'string' || !/^[0-9a-f]{16}$/.test(profileId) || typeof repoId !== 'string' || !/^repo-[1-9]\d{0,8}$/.test(repoId)
    || !isSessionTabId(tabId) || typeof text !== 'string' || text.trim() === '') throw new Error('Invalid session task')
  // Only the window that shows the session's terminal may type into it, as for its keystrokes.
  if (!ownsSessionTerminal(event, tabId)) return { result: 'refused', message: 'This session is open in another window.' }
  const service = gitServiceInstance()
  if (!service) return { result: 'refused', message: 'The Git panel has stopped.' }
  const folder = service.repoFolder(event.sender.id, profileId, repoId)
  const title = tabsState.tabs.find((tab) => tab.id === tabId)?.title ?? 'A session'
  const decision = gitResolvers.request(folder, tabId, title, sessionStateOf, () => sendSessionTask(tabId, text))
  if (decision.result !== 'refused') service.requestRefresh(profileId)
  return decision
})
ipcMain.handle('desktop:resize-tab', (event, tabId: unknown, cols: unknown, rows: unknown) => {
  assertTrustedIpcSender(event)
  if (
    !isSessionTabId(tabId)
    || typeof cols !== 'number'
    || typeof rows !== 'number'
    || !Number.isFinite(cols)
    || !Number.isFinite(rows)
    || cols < 1 || rows < 1 || cols > 1_000 || rows > 1_000
  ) {
    throw new Error('Invalid pty resize request')
  }
  if (!ownsSessionTerminal(event, tabId) || !tabsState.tabs.some((tab) => tab.id === tabId)) return
  const size = { cols: Math.max(1, Math.round(cols)), rows: Math.max(1, Math.round(rows)) }
  // Kept even when the tab has no process yet: a dormant tab's pane measures itself before its process starts.
  terminalSizes.set(tabId, size)
  managedTabs.get(tabId)?.session.resize(size.cols, size.rows)
})
ipcMain.handle('desktop:get-tab-backlog', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string') throw new Error('Invalid session tab')
  return managedTabs.get(tabId)?.session.recentOutputText ?? ''
})
ipcMain.handle('desktop:get-tab-snapshot', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (!isSessionTabId(tabId)) throw new Error('Invalid session tab')
  return { data: managedTabs.get(tabId)?.session.recentOutputText ?? '', sequence: sessionOutputSequences.get(tabId) ?? 0 }
})
ipcMain.handle('desktop:open-settings', (event) => {
  assertTrustedIpcSender(event, true)
  return showSettingsWindow()
})
ipcMain.handle('desktop:show-session-log', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (!isSessionTabId(tabId) || !tabsState.tabs.some((tab) => tab.id === tabId)) throw new Error('Invalid session tab')
  return showSessionLog(tabId)
})
ipcMain.handle('desktop:copy-diagnostics', (event) => {
  assertTrustedIpcSender(event)
  copyDiagnosticsToClipboard()
})
ipcMain.handle('desktop:copy-text', (event, text: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof text !== 'string') throw new Error('Invalid clipboard text')
  // Keep an accidentally huge terminal selection from blocking Electron's
  // main process while still allowing comfortably large command output.
  if (text.length > 1_000_000) throw new Error('Clipboard text is too large')
  clipboard.writeText(text)
})
ipcMain.handle('desktop:show-terminal-context-menu', (event, text: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof text !== 'string' || text.length === 0) throw new Error('Invalid clipboard text')
  if (text.length > 1_000_000) throw new Error('Clipboard text is too large')
  const owner = BrowserWindow.fromWebContents(event.sender)
  Menu.buildFromTemplate([
    { label: 'Copy', click: () => clipboard.writeText(text) },
  ]).popup(owner ? { window: owner } : {})
})
ipcMain.handle('desktop:retry-resolution', (event) => {
  assertTrustedIpcSender(event)
  return retryResolution()
})
ipcMain.handle('desktop:install-copilot', async (event) => {
  assertTrustedIpcSender(event)
  await maintainCopilotCli('install')
  return snapshot()
})
ipcMain.handle('desktop:connect-remote-session', (event, sessionId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof sessionId !== 'string' || !/^[0-9A-Za-z-]{6,128}$/.test(sessionId)) {
    throw new Error('Enter a valid remote session or task ID')
  }
  return createSessionTab(undefined, 'new', null, [], sessionId)
})
ipcMain.handle('desktop:open-external-url', async (event, url: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof url !== 'string' || url.length === 0 || url.length > 8_192) throw new Error('Invalid URL')
  const parsed = parseSafeHttpUrl(url)
  await shell.openExternal(parsed.href)
})
async function pathExists(candidate: string, timeoutMs = 3_000): Promise<boolean> {
  // Even local removable or offline storage can leave `access` pending. Fail
  // closed on a timeout rather than leaving this IPC request open indefinitely.
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      access(candidate).then(() => true, () => false),
      new Promise<boolean>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
ipcMain.handle('desktop:reveal-path', async (event, tabId: unknown, candidate: unknown): Promise<RevealPathResult> => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string' || typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4_096) {
    throw new Error('Invalid file path')
  }
  if (!isSessionTabId(tabId) || !isLocalFilesystemPath(candidate)) throw new Error('Only local file paths can be revealed')
  const tab = tabsState.tabs.find((item) => item.id === tabId)
  if (!tab) throw new Error('Invalid session tab')
  const owningProfile = desktopConfig.profiles.find((profile) => profile.id === tab.workspaceProfileId)
  if (!owningProfile) throw new Error('The session workspace is unavailable')
  const baseDirectory = owningProfile.path
  const resolved = resolve(baseDirectory, candidate)
  if (!isPathWithinRoot(baseDirectory, resolved)) return { ok: false, reason: 'outside-workspace' }
  // A path-shaped token is not necessarily a real file (e.g. a diff header).
  // Report ordinary misses as a result so the renderer can give quiet feedback.
  if (!(await pathExists(resolved))) return { ok: false, reason: 'missing' }
  shell.showItemInFolder(resolved)
  return { ok: true }
})

// --- IPC: settings window ----------------------------------------------
ipcMain.handle('desktop-settings:get', (event) => {
  assertTrustedSettingsSender(event, true)
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:update-preferences', async (event, preferences: unknown) => {
  assertTrustedSettingsSender(event)
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new Error('Invalid desktop preferences')
  }
  const values = preferences as Record<string, unknown>
  const allowedKeys = new Set<keyof DesktopPreferences>([
    'closeBehavior',
    'trayEnabled',
    'notifications',
    'automaticUpdateChecks',
    'globalShortcutEnabled',
    'browserProfile',
    'browserOverrides',
    'worktreeTimeoutMinutes',
    'worktreeCleanup',
    'meetingMaxRounds',
    'meetingRoundTimeoutMinutes',
    'meetingDiscussion',
  ])
  const keys = Object.keys(values)
  if (keys.length === 0 || keys.some((key) => !allowedKeys.has(key as keyof DesktopPreferences))) {
    throw new Error('Invalid desktop preferences')
  }
  if (
    ('closeBehavior' in values && !isCloseBehavior(values.closeBehavior))
    || ('trayEnabled' in values && typeof values.trayEnabled !== 'boolean')
    || ('notifications' in values && typeof values.notifications !== 'boolean')
    || ('automaticUpdateChecks' in values && typeof values.automaticUpdateChecks !== 'boolean')
    || ('globalShortcutEnabled' in values && typeof values.globalShortcutEnabled !== 'boolean')
    || ('browserProfile' in values && !isBrowserProfileMode(values.browserProfile))
    || ('browserOverrides' in values && !isBrowserOverridesMode(values.browserOverrides))
    || ('worktreeTimeoutMinutes' in values && !isWorktreeTimeoutMinutes(values.worktreeTimeoutMinutes))
    || ('worktreeCleanup' in values && !isWorktreeCleanupMode(values.worktreeCleanup))
    || ('meetingMaxRounds' in values && !isMeetingMaxRounds(values.meetingMaxRounds))
    || ('meetingRoundTimeoutMinutes' in values && !isMeetingRoundTimeoutMinutes(values.meetingRoundTimeoutMinutes))
    || ('meetingDiscussion' in values && typeof values.meetingDiscussion !== 'boolean')
  ) {
    throw new Error('Invalid desktop preferences')
  }

  let before: DesktopPreferences | null = null
  let applied: DesktopPreferences | null = null
  let updateChecksChanged = false
  let shortcutChanged = false
  let overridesChanged = false
  // The change is made when this save's turn in the write queue comes, not now, so no
  // other write can carry it to disk unless this save's own write succeeds.
  await persistConfig(() => {
    before = settingsPreferences()
    updateChecksChanged = typeof values.automaticUpdateChecks === 'boolean'
      && desktopConfig.automaticUpdateChecks !== values.automaticUpdateChecks
    shortcutChanged = typeof values.globalShortcutEnabled === 'boolean'
      && desktopConfig.globalShortcutEnabled !== values.globalShortcutEnabled
    if (isCloseBehavior(values.closeBehavior)) desktopConfig.closeBehavior = values.closeBehavior
    if (typeof values.trayEnabled === 'boolean') desktopConfig.trayEnabled = values.trayEnabled
    if (typeof values.notifications === 'boolean') desktopConfig.notifications = values.notifications
    if (typeof values.automaticUpdateChecks === 'boolean') {
      desktopConfig.automaticUpdateChecks = values.automaticUpdateChecks
    }
    if (typeof values.globalShortcutEnabled === 'boolean') {
      desktopConfig.globalShortcutEnabled = values.globalShortcutEnabled
    }
    // Browsers already open keep their profile until their session closes or the app restarts.
    if (isBrowserProfileMode(values.browserProfile)) desktopConfig.browserProfile = values.browserProfile
    // Only new sessions follow it; the new-session dialog shows it as its default.
    overridesChanged = isBrowserOverridesMode(values.browserOverrides) && desktopConfig.browserOverrides !== values.browserOverrides
    if (isBrowserOverridesMode(values.browserOverrides)) desktopConfig.browserOverrides = values.browserOverrides
    if (isWorktreeTimeoutMinutes(values.worktreeTimeoutMinutes)) desktopConfig.worktreeTimeoutMinutes = values.worktreeTimeoutMinutes
    if (isWorktreeCleanupMode(values.worktreeCleanup)) desktopConfig.worktreeCleanup = values.worktreeCleanup
    // Open meetings keep their round limit; the round timeout applies from the next round.
    if (isMeetingMaxRounds(values.meetingMaxRounds)) desktopConfig.meetingMaxRounds = values.meetingMaxRounds
    if (isMeetingRoundTimeoutMinutes(values.meetingRoundTimeoutMinutes)) desktopConfig.meetingRoundTimeoutMinutes = values.meetingRoundTimeoutMinutes
    // Read when a round's reviews are all in, so it applies to open meetings from their next round.
    if (typeof values.meetingDiscussion === 'boolean') desktopConfig.meetingDiscussion = values.meetingDiscussion
    // A remembered tray action is unusable without a tray icon. Move back to
    // the explicit prompt and restore a hidden window before persisting.
    if (!desktopConfig.trayEnabled && desktopConfig.closeBehavior === 'tray') {
      desktopConfig.closeBehavior = 'ask'
    }
    if (shortcutChanged) applyGlobalShortcut(desktopConfig.globalShortcutEnabled)
    updateTrayVisibility()
    applied = settingsPreferences()
  }, () => {
    // Settings reads this in-memory config, so an unsaved change would otherwise
    // keep showing, keep taking effect, and be written by the next save.
    // When applying the change threw partway, undo whatever it had set.
    if (!before) return
    Object.assign(desktopConfig, preferenceRollback(before, applied ?? settingsPreferences(), settingsPreferences()))
    if (shortcutChanged) applyGlobalShortcut(desktopConfig.globalShortcutEnabled)
    updateTrayVisibility()
    broadcastSettingsPreferences()
  })
  broadcastSettingsPreferences()
  if (overridesChanged) broadcastState()
  if (updateChecksChanged) scheduleAutomaticUpdateCheck(1_000)
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:clear-shared-browser-data', async (event) => {
  assertTrustedSettingsSender(event)
  const userData = app.getPath('userData')
  const { partition } = browserProfilePaths(userData, SHARED_BROWSER_PROFILE_ID)
  // Signs every session out of the shared profile; open pages stay where they are.
  if (![...sessionBrowsers.values()].some(browser => browser.partition === partition) && !await browserProfileHasPartition(userData, SHARED_BROWSER_PROFILE_ID)) return
  let failed = false
  await clearBrowserStorage(electronSession.fromPartition(partition), message => { failed = true; logBrowserError(message) })
  if (failed) throw new Error('Some shared browser data could not be cleared. See the app log.')
})
ipcMain.handle('desktop-settings:clear-browser-history', async (event) => {
  assertTrustedSettingsSender(event)
  const history = sharedBrowserHistory()
  history.clear()
  await history.flush()
})
ipcMain.handle('desktop-settings:set-launch-at-login', (event, enabled: unknown) => {
  assertTrustedSettingsSender(event)
  if (typeof enabled !== 'boolean') throw new Error('Invalid launch-at-login preference')
  setLaunchAtLogin(enabled)
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:update-workspace-profile', async (
  event,
  profileId: unknown,
  name: unknown,
  permissionPreset: unknown,
  defaultResumeMode: unknown,
  launch: unknown,
) => {
  assertTrustedSettingsSender(event)
  if (
    typeof profileId !== 'string'
    || typeof name !== 'string'
    || typeof permissionPreset !== 'string'
    || typeof defaultResumeMode !== 'string'
    || !launch
    || typeof launch !== 'object'
    || Array.isArray(launch)
  ) {
    throw new Error('Invalid workspace profile')
  }
  await updateWorkspaceProfile(
    profileId,
    name,
    permissionPreset as PermissionPreset,
    defaultResumeMode as ResumeMode,
    launch as SessionLaunchConfig,
  )
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:remove-workspace-profile', async (event, profileId: unknown) => {
  assertTrustedSettingsSender(event)
  if (typeof profileId !== 'string') throw new Error('Invalid workspace profile')
  await removeWorkspace(profileId)
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:update-provider', async (event, provider: unknown) => {
  assertTrustedSettingsSender(event)
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error('Invalid Copilot provider configuration')
  }
  const value = provider as Record<string, unknown>
  if (
    !isCopilotProviderType(value.type)
    || typeof value.baseUrl !== 'string'
    || typeof value.model !== 'string'
    || typeof value.offline !== 'boolean'
  ) {
    throw new Error('Invalid Copilot provider configuration')
  }
  const next: CopilotProviderConfig = {
    type: value.type,
    baseUrl: value.baseUrl.trim().slice(0, 2_048),
    model: value.model.trim().slice(0, 200),
    offline: value.offline,
  }
  validateProviderConfig(next)
  desktopConfig.provider = next
  await persistConfig()
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:check-for-updates', async (event) => {
  assertTrustedSettingsSender(event)
  if (installInProgress) throw new Error('An update installation is already in progress')
  await updateController?.check()
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:download-update', async (event) => {
  assertTrustedSettingsSender(event)
  if (installInProgress) throw new Error('An update installation is already in progress')
  await updateController?.download()
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:install-update', async (event) => {
  assertTrustedSettingsSender(event)
  if (installInProgress) throw new Error('An update installation is already in progress')
  if (quittingAllSessions || explicitQuitRequested) throw new Error('The app is shutting down')
  if (!updateController?.snapshot.canInstall) throw new Error('No downloaded update is ready to install')
  installInProgress = true
  preparingUpdate = true
  updatePreparationFailed = false
  refreshMenus()
  try {
    await withShutdownDeadline(stopAllSessions().then(() => configWriteQueue))
    if (quittingAllSessions) { preparingUpdate = false; return }
    // Flush before the installer can launch, retaining the service until before-quit.
    // A failed or no-op installer therefore never requires a second database owner.
    try {
      usageService?.pauseCollection()
      await withShutdownDeadline(usageService?.flush() ?? Promise.resolve())
    } catch (error) {
      if (!(error instanceof UsageServiceUnavailableError)) throw error
      await writeAppLog(`Usage unavailable during update preparation: ${String(error)}`).catch(() => {})
    }
    preparingUpdate = false
    if (quittingAllSessions) return
    if (updatePreparationFailed) throw new Error('The updater failed while preparing installation')
    explicitQuitRequested = true
    dismissClosePromptForUpdate()
    // quitAndInstall can return without quitting or emitting an error.
    updateQuitTimer = setTimeout(recoverUpdateAttempt, 10_000)
    updateQuitTimer.unref()
    updateController.install()
  } catch (error) {
    preparingUpdate = false
    recoverUpdateAttempt()
    if (quittingAllSessions) return
    throw error
  }
})
ipcMain.handle('desktop-settings:open-releases', async (event) => {
  assertTrustedSettingsSender(event)
  await shell.openExternal(RELEASES_URL)
})
ipcMain.handle('desktop-settings:open-rollback-release', async (event) => {
  assertTrustedSettingsSender(event)
  const version = desktopConfig.rollbackVersion
  if (!version || !/^[0-9A-Za-z.+-]{1,50}$/.test(version)) throw new Error('No previous desktop release is recorded')
  await shell.openExternal(`${RELEASES_URL}/tag/v${encodeURIComponent(version)}`)
})
ipcMain.handle('desktop-settings:save-credential', async (event, name: unknown, secret: unknown) => {
  assertTrustedSettingsSender(event)
  if (!isCredentialName(name) || typeof secret !== 'string') throw new Error('Invalid protected credential')
  if (!credentialStore) throw new Error('Protected credential storage is not initialized')
  await credentialStore.saveCredential(name as CredentialName, secret)
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:delete-credential', async (event, name: unknown) => {
  assertTrustedSettingsSender(event)
  if (!isCredentialName(name)) throw new Error('Invalid protected credential')
  if (!credentialStore) throw new Error('Protected credential storage is not initialized')
  await credentialStore.deleteCredential(name as CredentialName)
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:install-copilot', async (event) => {
  assertTrustedSettingsSender(event)
  await maintainCopilotCli('install')
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:update-copilot', async (event) => {
  assertTrustedSettingsSender(event)
  await maintainCopilotCli('update')
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:set-copilot-auto-update', async (event, enabled: unknown, channel: unknown) => {
  assertTrustedSettingsSender(event)
  if (typeof enabled !== 'boolean' || !isCopilotUpdateChannel(channel)) {
    throw new Error('Invalid Copilot CLI update preference')
  }
  await writeCopilotAutoUpdate(copilotUserSettingsPath(), enabled, channel)
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:recheck-copilot-capabilities', async (event) => {
  assertTrustedSettingsSender(event)
  await recheckCopilotCapabilities()
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:refresh-copilot-resources', async (event) => {
  assertTrustedSettingsSender(event)
  await refreshCopilotResources()
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:mutate-copilot-resource', async (
  event,
  action: unknown,
  kind: unknown,
  name: unknown,
) => {
  assertTrustedSettingsSender(event)
  if (!isCopilotResourceAction(action) || !isCopilotResourceKind(kind) || typeof name !== 'string') {
    throw new Error('Invalid Copilot resource operation')
  }
  await runCopilotResourceMutation(buildResourceMutationArgs(action, kind, name))
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:install-copilot-plugin', async (event, source: unknown) => {
  assertTrustedSettingsSender(event)
  if (typeof source !== 'string') throw new Error('Invalid plugin source')
  await runCopilotResourceMutation(buildPluginInstallArgs(source))
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:install-copilot-skill', async (event, source: unknown, project: unknown) => {
  assertTrustedSettingsSender(event)
  if (typeof source !== 'string' || typeof project !== 'boolean') throw new Error('Invalid skill source')
  await runCopilotResourceMutation(buildSkillInstallArgs(source, project))
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:add-copilot-mcp', async (
  event,
  name: unknown,
  url: unknown,
  transport: unknown,
) => {
  assertTrustedSettingsSender(event)
  if (typeof name !== 'string' || typeof url !== 'string' || (transport !== 'http' && transport !== 'sse')) {
    throw new Error('Invalid MCP server configuration')
  }
  await runCopilotResourceMutation(buildRemoteMcpAddArgs(name, url, transport))
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:open-copilot-config', async (event) => {
  assertTrustedSettingsSender(event)
  const configDirectory = process.env.COPILOT_HOME || join(app.getPath('home'), '.copilot')
  await mkdir(configDirectory, { recursive: true })
  const error = await shell.openPath(configDirectory)
  if (error) throw new Error(error)
})

ipcMain.handle('desktop-settings:usage-report', async (event, month: unknown, scope: unknown, timezone: unknown) => {
  assertTrustedSettingsSender(event)
  if (typeof month !== 'string' || (scope !== 'all' && scope !== 'app') || (timezone !== undefined && (typeof timezone !== 'string' || timezone.length > 100))) throw new Error('Invalid usage query')
  if (!usageService) throw new Error('Usage collection is unavailable')
  return usageService.report(month, scope, timezone)
})
ipcMain.handle('desktop-settings:usage-refresh', async (event) => {
  assertTrustedSettingsSender(event)
  if (!usageService) throw new Error('Usage collection is unavailable')
  await usageService.collect()
})
ipcMain.handle('desktop-settings:usage-export', async (event) => {
  assertTrustedSettingsSender(event)
  if (!usageService) throw new Error('Usage collection is unavailable')
  const result = await dialog.showSaveDialog({ title: 'Export usage backup', defaultPath: `copilot-usage-${new Date().toISOString().slice(0,10)}.sqlite`, filters: [{ name: 'Usage database', extensions: ['sqlite'] }] })
  if (!result.canceled && result.filePath) await usageService.exportTo(result.filePath)
  return !result.canceled
})
ipcMain.handle('desktop-settings:usage-restore', async (event) => {
  assertTrustedSettingsSender(event)
  if (!usageService) throw new Error('Usage collection is unavailable')
  const result = await dialog.showOpenDialog({ title: 'Restore usage backup (merge with saved usage)', properties: ['openFile'], filters: [{ name: 'Usage database', extensions: ['sqlite'] }] })
  if (!result.canceled && result.filePaths[0]) await usageService.restoreFrom(result.filePaths[0])
  return !result.canceled
})

function getMigrationService(): MigrationService {
  if (!migrationService) throw new Error('Migration is not ready')
  return migrationService
}
async function migrationRequest<T>(event: IpcMainInvokeEvent, operation: (service: MigrationService) => Promise<T>): Promise<T | null> {
  const service = getMigrationService()
  try { return await operation(service) }
  catch (error) {
    if (event.sender.isDestroyed() && service.isCancellation(error)) return null
    throw error
  }
}
ipcMain.handle('desktop-settings:migration-inventory', (event, selection: MigrationSelection) => {
  assertTrustedSettingsSender(event, true)
  return migrationRequest(event, (service) => service.inventory(selection))
})
ipcMain.handle('desktop-settings:migration-export', async (event, selection: MigrationSelection) => {
  assertTrustedSettingsSender(event, true)
  const result = await dialog.showSaveDialog({ title: 'Export Copilot migration archive', defaultPath: `copilot-migration-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'Migration archive', extensions: ['zip'] }] })
  if (result.canceled || !result.filePath) return false
  const exported = await migrationRequest(event, async (service) => { await service.export(result.filePath!, selection); return true })
  if (!exported) return false
  shell.showItemInFolder(result.filePath)
  return true
})
ipcMain.handle('desktop-settings:migration-open', async (event) => {
  assertTrustedSettingsSender(event, true)
  const result = await dialog.showOpenDialog({ title: 'Select Copilot migration archive', properties: ['openFile'], filters: [{ name: 'Migration archive', extensions: ['zip'] }] })
  if (result.canceled || !result.filePaths[0]) return null
  return migrationRequest(event, (service) => service.open(result.filePaths[0]!))
})
ipcMain.handle('desktop-settings:migration-map', async (event, id: unknown) => {
  assertTrustedSettingsSender(event, true)
  if (typeof id !== 'string') throw new Error('Invalid project')
  const result = await dialog.showOpenDialog({ title: 'Choose destination workspace', properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  getMigrationService().mapProject(id, result.filePaths[0])
  return result.filePaths[0]
})
ipcMain.handle('desktop-settings:migration-preview', (event, choices: MigrationChoices) => {
  assertTrustedSettingsSender(event, true)
  return migrationRequest(event, (service) => service.preview(choices))
})
ipcMain.handle('desktop-settings:migration-apply', (event, id: unknown) => {
  assertTrustedSettingsSender(event, true)
  if (typeof id !== 'string') throw new Error('Invalid import preview')
  return migrationRequest(event, (service) => service.apply(id))
})
ipcMain.handle('desktop-settings:migration-cancel', (event) => {
  assertTrustedSettingsSender(event, true)
  getMigrationService().cancel()
})
ipcMain.handle('desktop-settings:migration-status', async (event) => {
  assertTrustedSettingsSender(event, true)
  await getMigrationService().ensureBackups()
  return getMigrationService().status()
})
ipcMain.handle('desktop-settings:migration-recover', (event) => {
  assertTrustedSettingsSender(event, true)
  return migrationRequest(event, (service) => service.recover())
})
ipcMain.handle('desktop-settings:migration-dismiss-recovery', (event, id: unknown, sha256: unknown) => {
  assertTrustedSettingsSender(event, true)
  if (typeof id !== 'string' || typeof sha256 !== 'string') throw new Error('Invalid recovery journal selection')
  return migrationRequest(event, (service) => service.dismissRecovery(id, sha256))
})
ipcMain.handle('desktop-settings:migration-backups', (event) => {
  assertTrustedSettingsSender(event, true)
  return getMigrationService().refreshBackups()
})
ipcMain.handle('desktop-settings:migration-delete-backup', (event, id: unknown, token: unknown) => {
  assertTrustedSettingsSender(event, true)
  if (typeof id !== 'string' || typeof token !== 'string') throw new Error('Invalid backup selection')
  return migrationRequest(event, (service) => service.deleteBackup(id, token))
})

function checkMigrationIdle(): void {
  if (managedTabs.size || tabTransitionQueue.size || pendingSessionCreations) throw new Error('Close every Desktop session before importing or recovering migration data. Tray sessions also count.')
  if (installInProgress || copilotMaintenance.status === 'running' || copilotResources.status === 'loading') throw new Error('Wait for updates and resource operations to finish')
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => restoreMainWindow())
  app.on('activate', restoreMainWindow)

  app.whenReady().then(async () => {
    // Opened from Finder or a launcher, the app lacks the PATH the person's shell sets up, where the Copilot CLI and Git live.
    if (process.platform !== 'win32') process.env.PATH = await desktopPosixPath()
    setInterval(() => observe(refreshWorktreeBranches(), 'Could not read a worktree branch'), WORKTREE_BRANCH_POLL_MS).unref()
    setInterval(() => observe(refreshSessionNames(), 'Could not read session names'), SESSION_NAME_POLL_MS).unref()
    app.setName('Copilot CLI Desktop')
    const recovery = await recoverMigrationReport(app.getPath('userData'))
    migrationService = new MigrationService({
      roots: { copilot: process.env.COPILOT_HOME || join(app.getPath('home'), '.copilot'), agentSkills: join(app.getPath('home'), '.agents', 'skills'), desktop: app.getPath('userData') },
      appVersion: app.getVersion(), cliVersion: () => state.resolution?.version ?? null,
      assertIdle: async () => {
        checkMigrationIdle()
        await configWriteQueue
        await assertMigrationWritersStopped()
      },
      checkIdle: checkMigrationIdle,
      flushSettings: async () => { await configWriteQueue },
      plugins: async (signal) => {
        const result = await runCopilotCommand(resolvedCopilot(), ['plugins', 'list', '--json'], { env: resourceCopilotEnvironment(), signal })
        return JSON.parse(result.stdout) as unknown
      },
      exportUsage: async (path) => { if (!usageService) throw new Error('Usage unavailable'); await usageService.exportTo(path) },
      restoreUsage: async (path) => { if (!usageService) throw new Error('Usage unavailable'); await usageService.restoreFrom(path) },
      progress: (progress) => {
        if (settingsWindow && !settingsWindow.isDestroyed() && isLauncherShellUrl(settingsWindow.webContents.getURL(), settingsUrl())) settingsWindow.webContents.send('desktop-settings:migration-progress', progress)
      },
      reloaded: async () => {
        desktopConfig = await readDesktopConfig(configPath())
        profilesWithSessionTabs.clear()
        unrestoredProfileTabs.clear()
        syncWorkspaceState(); broadcastState(); broadcastSettingsPreferences(); updateTrayVisibility()
      },
    })
    migrationService.recoveryIssues = recovery.issues
    migrationService.recoveryJournals = recovery.journals
    for (const issue of recovery.issues) void writeAppLog(issue)
    startUsageCollection()
    state.desktopVersion = app.getVersion()
    await pruneSessionLogDirectories(join(app.getPath('userData'), 'logs', 'sessions'))
      .catch((error) => writeAppLog(`Could not prune old session logs: ${String(error)}`))
    let desktopConfigMigrated = false
    let desktopConfigUnparseable = false
    desktopConfig = await readDesktopConfig(configPath(), (message) => {
      desktopConfigMigrated = true
      void writeAppLog(message)
    }, () => { desktopConfigUnparseable = true })
    const recoveryMarker = join(app.getPath('userData'), 'config-recovery.json')
    // Never replace the unreadable file unless an independent, verified backup exists, and keep
    // browser data (referenced only by that file) until the backup is restored or deleted.
    const configRecovery = await resolveConfigRecovery(configPath(), recoveryMarker, desktopConfigUnparseable)
    const recoveryHold = configRecovery.hold
    configWritesBlocked = configRecovery.writesBlocked
    if (configRecovery.newlyPreserved && recoveryHold) {
      void writeAppLog(`desktop.json could not be parsed; defaults are in use. The original was kept at ${recoveryHold}`)
      showNotification(
        'Copilot CLI Desktop settings were reset',
        `Your settings file was unreadable. It was saved as ${basename(recoveryHold)} in the app data folder. Browser data is kept until you restore or delete that file.`,
      )
    } else if (configRecovery.writesBlocked) {
      void writeAppLog('desktop.json could not be parsed and could not be backed up; settings changes will not be saved this launch')
      showNotification(
        'Copilot CLI Desktop could not save settings',
        'Your settings file was unreadable and could not be backed up, so it was left untouched. Changes will not be saved until it is fixed or removed.',
      )
    } else if (recoveryHold) {
      showNotification(
        'Copilot CLI Desktop settings recovery pending',
        `Browser data is kept while ${basename(recoveryHold)} exists. Restore or delete it when you are done.`,
      )
    }
    if (recordDesktopVersion(desktopConfig, app.getVersion()) || desktopConfigMigrated) await persistConfig()
    // Keep DevTools settings from sessions closed last launch before their partitions are pruned.
    try { shareDevtoolsSettings(app.getPath('userData')) }
    catch (error) { void writeAppLog(`Could not share DevTools settings: ${String(error)}`).catch(() => {}) }
    // Browser profiles referenced only by an unreadable or recovered config must survive until the hold is released.
    if (!recoveryHold && !configWritesBlocked) {
      await pruneBrowserProfiles(app.getPath('userData'), desktopConfig.profiles.flatMap(profile => profile.tabs.map(tab => tab.browserProfileId)))
        .catch(error => writeAppLog(`Could not prune old browser profiles: ${String(error)}`))
    }
    await pruneBrowserLaunches(app.getPath('userData'), launchId)
      .catch(error => writeAppLog(`Could not prune old browser helpers: ${String(error)}`))
    await pruneMeetingFolders(meetingRoot(), Date.now())
    syncWorkspaceState()

    updateController = new DesktopUpdateController(
      // In-app updates: the Windows installer, and a Linux AppImage. A .deb updates through its package manager, and macOS
      // can only replace a signed app.
      app.isPackaged && (process.platform === 'win32' || (process.platform === 'linux' && process.env.APPIMAGE)) ? autoUpdater as unknown as UpdateAdapter : null,
      app.getVersion(),
      ...(app.isPackaged ? ['Get new versions from the Releases page (Help → Open Releases).'] : []),
    )
    updateController.on('state-changed', (update: DesktopUpdateState) => {
      if (installInProgress && update.status === 'error') {
        recoverUpdateAttempt()
      }
      broadcastUpdateState(update)
      if (update.status === 'available') {
        showNotification(
          'Copilot CLI Desktop update available',
          `Version ${update.availableVersion ?? 'new'} is ready to download.`,
          () => observe(showSettingsWindow(), 'Could not open Settings'),
        )
      }
    })

    credentialStore = new SecureCredentialStore(protectedCredentialPath(), protectedStorage(safeStorage), (message) => void writeAppLog(message))

    const startHidden = process.argv.includes(BACKGROUND_START_ARGUMENT)
    const packageSmokeTest = app.isPackaged && process.env[PACKAGE_SMOKE_ENVIRONMENT] === '1'
    mainWindow = createWindow(!startHidden, packageSmokeTest
      ? {
        didFinishLoad: () => {
          // Loading the renderer alone cannot detect a worker missing from app.asar.
          void (async () => {
            await usageService?.collect()
            await usageService?.stop()
            usageService = null
            process.stderr.write(`${PACKAGE_SMOKE_READY_MARKER}\n`)
            setTimeout(() => app.exit(0), 250)
          })().catch((error) => {
            process.stderr.write(`[package-smoke] usage-worker-failed: ${String(error)}\n`)
            app.exit(1)
          })
        },
        didFailLoad: (description) => {
          process.stderr.write(`[package-smoke] renderer-load-failed: ${description}\n`)
          setTimeout(() => app.exit(1), 250)
        },
      }
      : undefined)
    updateTrayVisibility()
    installApplicationMenu()
    applyGlobalShortcut(desktopConfig.globalShortcutEnabled)

    await retryResolution(true)
    scheduleAutomaticUpdateCheck()
  }).catch((error) => {
    dialog.showErrorBox('Copilot CLI Desktop failed to start', String(error))
    app.quit()
  })
}

app.on('before-quit', (event) => {
  explicitQuitRequested = true
  // Stop the Git panel first: it aborts every git process it started and refuses new ones.
  gitServiceStopped = true
  void gitService?.dispose()
  if (installInProgress && !preparingUpdate) dismissClosePromptForUpdate()
  if (closePromptWindow && !closePromptWindow.isDestroyed()) {
    event.preventDefault()
    quitAfterClosePrompt = true
    return
  }
  if (quittingAllSessions) {
    if (!usageQuitCleanupComplete) event.preventDefault()
    return
  }
  clearTimeout(updateQuitTimer)
  if (managedTabs.size === 0 && !usageService && sessionBrowsers.size === 0) return
  event.preventDefault()
  quittingAllSessions = true
  // Each stopped session's 'exit' handler persists its final resume id via
  // persistProfileTabs()/persistConfig() without awaiting the write —
  // reading configWriteQueue here (after those synchronous handlers have
  // already re-chained it) and awaiting it ensures Electron does not exit
  // before that last write actually lands on disk.
  const service = usageService
  void withShutdownDeadline(stopAllSessions()
    .then(() => configWriteQueue)
    .finally(async () => {
      usageService = null
      meetingHub.dispose()
      // Open meetings are saved as they stand, for the next start to restore.
      await Promise.allSettled([service?.stop(), meetingControl.close(), guestMcp.close(), ...meetingWrites.values(), guestSeatsWrite, ...[...sessionBrowsers.values()].map(browser => browser.dispose())])
      sessionBrowsers.clear()
      await removeBrowserLaunch(app.getPath('userData'), launchId)
        .catch(error => writeAppLog(`Could not remove browser helpers on quit: ${String(error)}`))
    }))
    .catch((error) => {
      void writeAppLog(`Shutdown cleanup failed: ${String(error)}`).catch(() => {})
      void service?.abort().catch(() => {})
    })
    .finally(() => { usageQuitCleanupComplete = true; app.quit() })
})

app.on('will-quit', () => {
  if (updateCheckTimer) clearTimeout(updateCheckTimer)
  if (copilotResolutionRefreshTimer) clearTimeout(copilotResolutionRefreshTimer)
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (explicitQuitRequested || desktopConfig.closeBehavior !== 'tray' || !tray) app.quit()
})
