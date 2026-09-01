import { randomUUID } from 'node:crypto'
import { access, appendFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron'
import electronUpdater from 'electron-updater'
import { readAccessStatus } from './access-status.js'
import {
  DEFAULT_DESKTOP_CONFIG,
  activateWorkspaceProfile,
  activeWorkspaceProfile,
  isCloseBehavior,
  readDesktopConfig,
  recordDesktopVersion,
  writeDesktopConfig,
  type CloseBehavior,
  type DesktopConfig,
  type DesktopPreferences,
} from './desktop-config.js'
import { formatDesktopDiagnostics } from './desktop-diagnostics.js'
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
import { spawnNodePty } from './node-pty-backend.js'
import { PERMISSION_PRESET_INFO, buildPermissionArgs, isPermissionPreset, permissionCompatibilityWarning, type PermissionPreset } from './permission-presets.js'
import {
  isCopilotProviderType,
  providerEnvironment,
  validateProviderConfig,
  type CopilotProviderConfig,
} from './provider-config.js'
import { PtySession, type PtySessionExit } from './pty-session.js'
import { supportsSessionFork, isForkSessionId } from './copilot-rpc.js'
import { forkSessionSnapshot } from './session-fork.js'
import { sideChatProfile, SIDE_CHAT_PERMISSION_WARNING } from './side-chat.js'
import { resolveCopilotBinary, withCopilotPathAdditions } from './resolve-copilot.js'
import { buildResumeArgs, isResumeMode, type ResumeMode } from './resume-args.js'
import {
  buildSessionLaunchArgs,
  normalizeSessionLaunchConfig,
  type SessionLaunchConfig,
} from './session-launch.js'
import { SecureCredentialStore, isCredentialName, secretEnvArgs, type CredentialName } from './secure-credentials.js'
import {
  EMPTY_TABS_STATE,
  activateTab,
  closeTab,
  createTab,
  renameTab,
  setTabLaunchConfig,
  setTabProcessId,
  setTabSessionId,
  setTabStatus,
  touchTab,
  type TabsState,
} from './session-tab-machine.js'
import type { CopilotResolution, DesktopEvent, DesktopState, WorkspaceProfile } from './types.js'
import { DesktopUpdateController, type DesktopUpdateState, type UpdateAdapter } from './update-controller.js'
import { truncateUtf8 } from './utf8.js'

const { autoUpdater } = electronUpdater
const BACKGROUND_START_ARGUMENT = '--background'
const GLOBAL_TOGGLE_SHORTCUT = 'CommandOrControl+Alt+H'
const GLOBAL_TOGGLE_SHORTCUT_LABEL = process.platform === 'darwin' ? 'Command+Alt+H' : 'Ctrl+Alt+H'
const RELEASES_URL = 'https://github.com/xuemin-liu/copilot-cli-desktop/releases'
const MAX_SESSION_TABS = 20
const COPILOT_RESOLUTION_REFRESH_DELAY_MS = 10_000
const COPILOT_RESOLUTION_REFRESH_RETRY_MS = 60_000

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let credentialStore: SecureCredentialStore | null = null
let updateController: DesktopUpdateController | null = null
let updateCheckTimer: NodeJS.Timeout | null = null
let copilotResolutionRefreshTimer: NodeJS.Timeout | null = null
let copilotResolutionRefreshPromise: Promise<boolean> | null = null
let installInProgress = false
let quittingAllSessions = false
let explicitQuitRequested = false
let trayHintShown = false
let closePromptWindow: BrowserWindow | null = null
let quitAfterClosePrompt = false
let desktopConfig: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG }
let configWriteQueue: Promise<void> = Promise.resolve()
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
const activityBroadcastTimers = new Map<string, NodeJS.Timeout>()

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
  return installInProgress || quittingAllSessions
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

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  if (!isLauncherShellUrl(event.senderFrame?.url, shellUrl())) {
    throw new Error('Desktop IPC request rejected from an untrusted renderer')
  }
}

function assertTrustedSettingsSender(event: IpcMainInvokeEvent): void {
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

function sessionLogPath(tabId: string): string {
  return join(app.getPath('userData'), 'logs', 'sessions', launchId, `${tabId}.log`)
}

function appLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'app.log')
}

async function writeAppLog(line: string): Promise<void> {
  await mkdir(dirname(appLogPath()), { recursive: true })
  await appendFile(appLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8').catch(() => {})
}

const MAX_SESSION_LOG_BYTES = 5 * 1024 * 1024
const sessionLogBytesWritten = new Map<string, number>()

async function writeSessionLog(tabId: string, chunk: string): Promise<void> {
  const written = sessionLogBytesWritten.get(tabId) ?? 0
  if (written >= MAX_SESSION_LOG_BYTES) return
  const filename = sessionLogPath(tabId)
  await mkdir(dirname(filename), { recursive: true })
  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  if (written + chunkBytes <= MAX_SESSION_LOG_BYTES) {
    await appendFile(filename, chunk, 'utf8').catch(() => {})
    sessionLogBytesWritten.set(tabId, written + chunkBytes)
    return
  }
  const truncated = truncateUtf8(chunk, MAX_SESSION_LOG_BYTES - written)
  await appendFile(filename, `${truncated}\n[log truncated at ${MAX_SESSION_LOG_BYTES} bytes]\n`, 'utf8').catch(() => {})
  sessionLogBytesWritten.set(tabId, MAX_SESSION_LOG_BYTES)
}

function snapshot(): DesktopState {
  return {
    ...state,
    profiles: state.profiles.map((profile) => ({ ...profile, tabs: profile.tabs.map((tab) => ({ ...tab })) })),
    tabs: state.tabs.map((tab) => ({ ...tab })),
    recentLogs: [...state.recentLogs],
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
  const window = mainWindow
  if (window && !window.isDestroyed() && isLauncherShellUrl(window.webContents.getURL(), shellUrl())) {
    window.webContents.send('desktop:state-changed', snapshot())
  }
}

async function persistConfig(): Promise<void> {
  const nextConfig = structuredClone(desktopConfig)
  const operation = configWriteQueue.then(() => writeDesktopConfig(configPath(), nextConfig))
  configWriteQueue = operation.catch(() => {})
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
    profile.tabs = tabsState.tabs
      .filter((tab) => tab.workspaceProfileId === profile.id)
      .map((tab) => {
        const parentSessionId = tabsState.tabs.find((parent) => parent.id === tab.sideParentTabId)?.lastSessionId
        return {
          title: tab.title,
          lastSessionId: tab.lastSessionId,
          ...(tab.sideChat ? { sideChat: true as const } : {}),
          ...(parentSessionId ? { sideParentSessionId: parentSessionId } : {}),
        }
      })
  }
  void persistConfig().catch((error) => void writeAppLog(`Failed to save session tabs: ${String(error)}`))
}

function loginItemOptions(): { path: string; args: string[] } {
  return { path: process.execPath, args: [BACKGROUND_START_ARGUMENT] }
}

function launchAtLoginAvailable(): boolean {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
}

function launchAtLoginEnabled(): boolean {
  if (!launchAtLoginAvailable()) return false
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin
}

function setLaunchAtLogin(enabled: boolean): void {
  if (!launchAtLoginAvailable()) throw new Error('Launch at login is available in installed builds.')
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions() })
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

function finishClosePrompt(window: BrowserWindow): void {
  if (closePromptWindow !== window) return
  closePromptWindow = null
  const shouldResumeQuit = quitAfterClosePrompt && explicitQuitRequested
  quitAfterClosePrompt = false
  if (shouldResumeQuit) setImmediate(() => app.quit())
}

async function promptForWindowClose(window: BrowserWindow): Promise<void> {
  if (closePromptWindow || window.isDestroyed()) return
  closePromptWindow = window
  try {
    const canMinimizeToTray = tray !== null && !tray.isDestroyed()
    const buttons = canMinimizeToTray
      ? ['Exit application', 'Minimize to tray', 'Cancel']
      : ['Exit application', 'Cancel']
    const result = await dialog.showMessageBox(window, {
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
    finishClosePrompt(window)
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
  const preset = activeWorkspaceProfile(desktopConfig)?.permissionPreset ?? 'default'
  return PERMISSION_PRESET_INFO[preset].label
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Copilot CLI Desktop', click: restoreMainWindow },
    { label: trayStatusLabel(), enabled: false },
    { label: `Configured startup access: ${activeAccessLabel()}`, enabled: false },
    { type: 'separator' },
    {
      label: 'New Session Tab',
      enabled: !installInProgress && desktopConfig.activeProfileId !== null && tabsState.tabs.length < MAX_SESSION_TABS,
      click: () => void createSessionTab().catch((error) => void writeAppLog(String(error))),
    },
    {
      label: 'Restart Active Session',
      enabled: !shuttingDown() && activeTabIsRestartable(),
      click: () => tabsState.activeTabId && void restartSessionTab(tabsState.activeTabId).catch((error) => void writeAppLog(String(error))),
    },
    {
      label: 'Show Active Session Log',
      enabled: tabsState.activeTabId !== null,
      click: () => tabsState.activeTabId && void showSessionLog(tabsState.activeTabId),
    },
    { label: 'Desktop Settings…', click: () => void showSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => void requestExplicitQuit() },
  ]))
}

function updateTrayVisibility(): void {
  if (desktopConfig.trayEnabled && !tray) {
    tray = new Tray(iconPath())
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
  await mkdir(dirname(filename), { recursive: true })
  await appendFile(filename, '', 'utf8')
  shell.showItemInFolder(filename)
}

async function showApplicationLog(): Promise<void> {
  const filename = appLogPath()
  await mkdir(dirname(filename), { recursive: true })
  await appendFile(filename, '', 'utf8')
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
  const window = mainWindow
  const isFocusedOnThisTab = Boolean(window?.isFocused()) && tabsState.activeTabId === tabId
  if (isFocusedOnThisTab) return
  const openTab = (): void => {
    if (tabsState.tabs.some((candidate) => candidate.id === tabId)) {
      tabsState = activateTab(tabsState, tabId)
      syncTabState()
      broadcastState()
    }
    restoreMainWindow()
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
  permissionArgs: string[]
  secretArgs: string[]
  connectSessionId: string | null
  sessionTitle: string
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
 * Shared by session creation and restart so a restart picks up whatever is
 * currently saved instead of whatever was saved when the tab was first
 * opened.
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
  validateLaunchOptions(profile.launch, connectSessionId, !connectSessionId && resumeMode === 'new')
  const vaultEnvironment = credentialStore ? await credentialStore.resolveEnvironment() : {}
  const configuredEnvironment = providerEnvironment(desktopConfig.provider, { ...process.env, ...vaultEnvironment })
  const environment = withCopilotPathAdditions(
    { ...configuredEnvironment, ...vaultEnvironment },
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
    permissionArgs: buildPermissionArgs(profile.permissionPreset, profile.path, copilotCapabilities),
    // PtySession merges process.env into this session's environment (see
    // pty-session.ts), so secretEnvArgs must see that same merged view to
    // also protect a credential that was only ever ambient, not vault-saved.
    secretArgs: secretEnvArgs({ ...process.env, ...environment }),
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
): { args: string[]; deterministicSessionId: string | null } {
  const freshSession = !plan.connectSessionId && resumeMode === 'new'
  validateLaunchOptions(plan.launch, plan.connectSessionId, freshSession)
  const launchArgs = buildSessionLaunchArgs(
    plan.connectSessionId ? { ...plan.launch, remoteControl: 'inherit', remoteExport: 'inherit' } : plan.launch,
    freshSession,
  )
  const deterministicSessionId = freshSession && copilotCapabilities.sessionIdentity ? randomUUID() : restoreLastSessionId
  const identity = plan.connectSessionId
    ? [`--connect=${plan.connectSessionId}`]
    : freshSession && deterministicSessionId
      ? ['--session-id', deterministicSessionId, '--name', plan.sessionTitle]
      : buildResumeArgs({ mode: resumeMode, lastSessionId: restoreLastSessionId })
  const args = [
    ...plan.prefixArgs,
    // Copilot's top navigation (Sessions, Issues, Pull requests, Gists) is
    // mouse-driven. Enable its terminal mouse protocol explicitly so clicks
    // continue to work even if the CLI's default or saved setting is off.
    '--mouse=on',
    ...identity,
    ...plan.attachmentPaths.flatMap((path) => ['--attachment', path]),
    ...launchArgs,
    ...plan.permissionArgs,
    ...plan.secretArgs,
  ]
  return { args, deterministicSessionId }
}

/** Wires a session's lifecycle events to tab state for the given tab id.
 * Shared by session creation and restart, since a restarted tab keeps its
 * id but is backed by a brand-new `PtySession` instance. */
function wireSessionEvents(id: string, session: PtySession): void {
  session.on('status', (status) => {
    tabsState = setTabStatus(tabsState, id, status)
    tabsState = setTabProcessId(tabsState, id, session.processId)
    syncTabState()
    refreshMenus()
    broadcastState()
  })
  session.on('log', (chunk: string) => {
    tabsState = touchTab(tabsState, id)
    scheduleActivityBroadcast(id)
    void writeSessionLog(id, chunk)
    const window = mainWindow
    if (window && !window.isDestroyed()) window.webContents.send('desktop:tab-output', { tabId: id, data: chunk })
  })
  session.on('desktop-event', (event: DesktopEvent) => handleDesktopEvent(id, event))
  session.on('exit', (exit: PtySessionExit) => {
    if (session.lastSessionId) {
      tabsState = setTabSessionId(tabsState, id, session.lastSessionId)
    }
    syncTabState()
    persistProfileTabs()
    broadcastState()
    const window = mainWindow
    if (window && !window.isDestroyed()) window.webContents.send('desktop:tab-exit', { tabId: id, exit })
  })
}

async function createSessionTab(
  profile: WorkspaceProfile | null = activeWorkspaceProfile(desktopConfig),
  resumeModeOverride: ResumeMode | null = null,
  restoreLastSessionId: string | null = null,
  attachmentPaths: string[] = [],
  connectSessionId: string | null = null,
  titleOverride: string | null = null,
  sideOptions: { sideChat?: true; sideParentTabId?: string } = {},
): Promise<DesktopState> {
  if (!profile) throw new Error('Select a workspace before starting a session')
  if (sideOptions.sideChat) profile = sideChatProfile(profile, copilotCapabilities)
  if (tabsState.tabs.length >= MAX_SESSION_TABS) throw new Error(`No more than ${MAX_SESSION_TABS} session tabs can be open`)
  if (shuttingDown()) throw new Error('The app is shutting down or updating; new sessions cannot be started right now')

  const id = `tab-${nextTabSequence++}`
  const resumeMode = resumeModeOverride ?? profile.defaultResumeMode
  const sessionTitle = titleOverride?.trim().slice(0, 120) || profile.name
  const plan = await buildSessionSpawnPlan(profile, resumeMode, restoreLastSessionId, attachmentPaths, connectSessionId, sessionTitle)
  // Recheck after credential resolution: another creation or shutdown may
  // have completed during the await. Register the new tab synchronously.
  if (shuttingDown()) throw new Error('The app is shutting down or updating')
  if (tabsState.tabs.length >= MAX_SESSION_TABS) throw new Error(`No more than ${MAX_SESSION_TABS} session tabs can be open`)
  const { args, deterministicSessionId } = finalizeSessionArgs(plan, resumeMode, restoreLastSessionId)
  if (sideOptions.sideChat) args.push('--mode=interactive')

  const session = new PtySession({
    file: plan.file,
    args,
    cwd: plan.cwd,
    env: plan.env,
    spawnPty: spawnNodePty,
  })
  managedTabs.set(id, { session })
  tabsState = createTab(tabsState, {
    id,
    title: connectSessionId ? `Remote ${connectSessionId.slice(0, 12)}` : sessionTitle,
    workspaceProfileId: profile.id,
    launchedPermissionPreset: connectSessionId ? null : profile.permissionPreset,
    permissionWarning: sideOptions.sideChat ? SIDE_CHAT_PERMISSION_WARNING : connectSessionId ? null : permissionCompatibilityWarning(profile.permissionPreset, copilotCapabilities),
    remote: connectSessionId !== null,
    cliVersion: plan.cliVersion,
    lastSessionId: deterministicSessionId,
    ...sideOptions,
    canFork: !connectSessionId && !sideOptions.sideChat && supportsSessionFork(state.resolution?.version ?? null),
  })
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
      tabsState = closeTab(tabsState, id)
      managedTabs.delete(id)
    }
    syncTabState()
    broadcastState()
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

async function createSessionWithAttachments(): Promise<DesktopState> {
  if (!mainWindow) return snapshot()
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach files to a new Copilot session',
    properties: ['openFile', 'multiSelections'],
    defaultPath: activeWorkspaceProfile(desktopConfig)?.path ?? app.getPath('home'),
  })
  if (selection.canceled || selection.filePaths.length === 0) return snapshot()
  return createSessionTab(undefined, 'new', null, selection.filePaths.slice(0, 20))
}

function activateSessionTab(tabId: string): DesktopState {
  tabsState = activateTab(tabsState, tabId)
  syncTabState()
  restoreMainWindow()
  broadcastState()
  refreshMenus()
  return snapshot()
}

function renameSessionTab(tabId: string, title: string): DesktopState {
  tabsState = renameTab(tabsState, tabId, title)
  syncTabState()
  persistProfileTabs()
  broadcastState()
  refreshMenus()
  return snapshot()
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
    const activityTimer = activityBroadcastTimers.get(tabId)
    if (activityTimer) clearTimeout(activityTimer)
    activityBroadcastTimers.delete(tabId)
    const managed = managedTabs.get(tabId)
    if (managed) {
      await managed.session.stop().catch((error) => void writeAppLog(`Failed to stop session ${tabId}: ${String(error)}`))
      managed.session.removeAllListeners()
      managedTabs.delete(tabId)
    }
    tabsState = closeTab(tabsState, tabId)
    syncTabState()
    persistProfileTabs()
    sessionLogBytesWritten.delete(tabId)
    broadcastState()
    refreshMenus()
    return snapshot()
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
    const tab = tabsState.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) throw new Error('This session tab no longer exists')
    // Restarting a remote tab used to work (the old PtySession.restart() just
    // replayed its original --connect argument verbatim), but this function
    // rebuilds args from a workspace profile's current settings, which a
    // remote connection has none of. Keep restart consistently unavailable for
    // remote tabs everywhere (menu/tray/button) rather than silently regress
    // one of those entry points to a runtime error.
    if (tab.remote) throw new Error('A remote session cannot be restarted')
    const savedProfile = desktopConfig.profiles.find((candidate) => candidate.id === tab.workspaceProfileId)
    if (!savedProfile) throw new Error('This session\'s workspace profile no longer exists')
    const profile = tab.sideChat ? sideChatProfile(savedProfile, copilotCapabilities) : savedProfile

    const managed = managedTabs.get(tabId)
    const bestKnownSessionId = managed?.session.lastSessionId ?? tab.lastSessionId ?? null

    // Validate and build against the profile's *current* settings BEFORE
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

    if (managed) await managed.session.stop()
    // Read the freshest known session id directly off the old session
    // object, before removing its listeners: PtySession.stop() can return as
    // soon as a force-kill timeout fires, ahead of the later 'exit' event
    // that would otherwise copy this into tabsState — relying on tabsState
    // alone here could still be reflecting an earlier cycle's id.
    const resumeSessionId = managed?.session.lastSessionId ?? bestKnownSessionId
    managed?.session.removeAllListeners()
    // Capture the terminal size as the very last step before constructing
    // the replacement — no further awaits happen between this line and
    // `new PtySession(...)` below, so whatever size is current at this exact
    // point (including a resize that landed anywhere up to now, via
    // desktop:resize-tab on this same old, still-referenced session) is what
    // the replacement actually gets. Without any managed session (a
    // previously failed restart left none), fall back to undefined so
    // PtySession uses its 80x24 default.
    const dimensions = managed?.session.dimensions

    const resumeMode: ResumeMode = resumeSessionId ? 'auto-resume' : 'new'
    const { args, deterministicSessionId } = finalizeSessionArgs(plan, resumeMode, resumeSessionId)
    if (tab.sideChat) args.push('--mode=interactive')
    const session = new PtySession({
      file: plan.file,
      args,
      cwd: plan.cwd,
      env: plan.env,
      spawnPty: spawnNodePty,
      ...(dimensions ? { cols: dimensions.cols, rows: dimensions.rows } : {}),
    })
    managedTabs.set(tabId, { session })
    tabsState = setTabStatus(tabsState, tabId, 'starting')
    tabsState = setTabLaunchConfig(tabsState, tabId, {
      cliVersion: plan.cliVersion,
      launchedPermissionPreset: profile.permissionPreset,
      permissionWarning: tab.sideChat ? SIDE_CHAT_PERMISSION_WARNING : permissionCompatibilityWarning(profile.permissionPreset, copilotCapabilities),
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

async function restoreTabsForActiveProfile(): Promise<void> {
  const profile = activeWorkspaceProfile(desktopConfig)
  if (!profile || !state.resolution || state.resolution.version === null) return
  const restored: WorkspaceProfile['tabs'] = profile.tabs.length > 0 ? [...profile.tabs] : [{ title: profile.name, lastSessionId: null }]
  for (const candidate of restored.slice(0, MAX_SESSION_TABS)) {
    const mode: ResumeMode = candidate.lastSessionId ? 'auto-resume' : 'new'
    try {
      // Parents are normally saved first. An unavailable parent leaves the
      // fork as an independent restricted tab instead of dropping it.
      const parent = candidate.sideParentSessionId
        ? tabsState.tabs.find((tab) => tab.workspaceProfileId === profile.id && !tab.sideChat && tab.lastSessionId === candidate.sideParentSessionId)
        : undefined
      await createSessionTab(profile, mode, candidate.lastSessionId, [], null, candidate.title, {
        ...(candidate.sideChat ? { sideChat: true as const } : {}),
        ...(parent && !tabsState.tabs.some((tab) => tab.sideParentTabId === parent.id) ? { sideParentTabId: parent.id } : {}),
      })
    } catch (error) {
      await writeAppLog(`Failed to restore tab for ${profile.path}: ${String(error)}`)
    }
  }
  syncTabState()
  broadcastState()
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
      new Set(tabsState.tabs.map((tab) => tab.workspaceProfileId)),
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
      tabsState = activateTab(tabsState, firstProfileTab.id)
      syncTabState()
      broadcastState()
      refreshMenus()
    } else if (isCopilotResolved()) {
      await restoreTabsForActiveProfile()
    }
  }
  return snapshot()
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

async function retryResolution(): Promise<DesktopState> {
  state.resolution = await resolveCopilotBinary()
  await recheckCopilotCapabilities()
  broadcastState()
  broadcastCopilotSettingsState()
  if (state.resolution.version !== null && desktopConfig.activeProfileId && tabsState.tabs.length === 0) {
    await restoreTabsForActiveProfile()
  }
  return snapshot()
}

function sameCopilotResolution(left: CopilotResolution | null, right: CopilotResolution): boolean {
  return left?.kind === right.kind
    && left.command === right.command
    && left.resolvedPath === right.resolvedPath
    && left.version === right.version
    && JSON.stringify(left.prefixArgs) === JSON.stringify(right.prefixArgs)
    && JSON.stringify(left.pathAdditions ?? []) === JSON.stringify(right.pathAdditions ?? [])
}

/** Re-resolve the executable without disturbing running processes. Copilot's
 * native updater may replace the on-disk CLI at session start; existing PTYs
 * keep their captured version while future sessions use the refreshed one. */
async function refreshCopilotResolutionIfChanged(): Promise<boolean> {
  if (copilotResolutionRefreshPromise) return copilotResolutionRefreshPromise
  const refresh = (async () => {
    const previousVersion = state.resolution?.version ?? null
    const next = await resolveCopilotBinary()
    if (sameCopilotResolution(state.resolution, next)) return false
    state.resolution = next
    await recheckCopilotCapabilities()
    broadcastState()
    broadcastCopilotSettingsState()
    if (previousVersion && next.version && previousVersion !== next.version) {
      await writeAppLog(`Detected Copilot CLI version change: ${previousVersion} -> ${next.version}`).catch(() => {})
    }
    return true
  })()
  copilotResolutionRefreshPromise = refresh
  try {
    return await refresh
  } finally {
    if (copilotResolutionRefreshPromise === refresh) copilotResolutionRefreshPromise = null
  }
}

function scheduleCopilotResolutionRefresh(
  delayMs = COPILOT_RESOLUTION_REFRESH_DELAY_MS,
  retryIfUnchanged = true,
): void {
  if (copilotResolutionRefreshTimer) clearTimeout(copilotResolutionRefreshTimer)
  copilotResolutionRefreshTimer = setTimeout(() => {
    copilotResolutionRefreshTimer = null
    void refreshCopilotResolutionIfChanged()
      .then((changed) => {
        if (!changed && retryIfUnchanged) {
          scheduleCopilotResolutionRefresh(COPILOT_RESOLUTION_REFRESH_RETRY_MS, false)
        }
      })
      .catch((error) => void writeAppLog(`Failed to refresh Copilot CLI version: ${String(error)}`).catch(() => {}))
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
    const output = operation === 'install'
      ? await installCopilotCli()
      : await updateCopilotCli(current!)
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

async function managedCopilotEnvironment(): Promise<NodeJS.ProcessEnv> {
  const vaultEnvironment = credentialStore ? await credentialStore.resolveEnvironment() : {}
  const provider = providerEnvironment(desktopConfig.provider, { ...process.env, ...vaultEnvironment })
  return { ...process.env, ...provider, ...vaultEnvironment }
}

async function refreshCopilotResources(environment?: NodeJS.ProcessEnv): Promise<void> {
  if (!copilotCapabilities.plugins) throw new Error('This Copilot CLI version does not expose plugin management; update it first')
  const previousOutput = copilotResources.output
  copilotResources = { status: 'loading', output: copilotResources.output, message: 'Loading Copilot resources…' }
  try {
    const result = await runCopilotCommand(resolvedCopilot(), ['plugins', 'list', '--json'], {
      cwd: activeWorkspaceProfile(desktopConfig)?.path,
      env: environment ?? await managedCopilotEnvironment(),
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
  const environment = await managedCopilotEnvironment()
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
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => void selectWorkspace() },
        {
          label: 'New Session Tab',
          accelerator: 'CmdOrCtrl+T',
          enabled: !installInProgress && desktopConfig.activeProfileId !== null && tabsState.tabs.length < MAX_SESSION_TABS,
          click: () => void createSessionTab().catch((error) => void writeAppLog(String(error))),
        },
        {
          label: 'Close Session Tab',
          accelerator: 'CmdOrCtrl+W',
          enabled: tabsState.activeTabId !== null,
          click: () => tabsState.activeTabId && void closeSessionTab(tabsState.activeTabId).catch((error) => void writeAppLog(String(error))),
        },
        {
          label: 'Resume Session…',
          enabled: !installInProgress && desktopConfig.activeProfileId !== null && tabsState.tabs.length < MAX_SESSION_TABS,
          click: () => void createSessionTab(undefined, 'picker').catch((error) => void writeAppLog(String(error))),
        },
        {
          label: 'New Session with Attachments…',
          enabled: !installInProgress && desktopConfig.activeProfileId !== null && tabsState.tabs.length < MAX_SESSION_TABS,
          click: () => void createSessionWithAttachments().catch((error) => void writeAppLog(String(error))),
        },
        {
          label: 'Restart Active Session',
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: !shuttingDown() && activeTabIsRestartable(),
          click: () => tabsState.activeTabId && void restartSessionTab(tabsState.activeTabId).catch((error) => void writeAppLog(String(error))),
        },
        { label: 'Desktop Settings…', accelerator: 'CmdOrCtrl+,', click: () => void showSettingsWindow() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => void requestExplicitQuit() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
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
          click: () => tabsState.activeTabId && void showSessionLog(tabsState.activeTabId),
        },
        { label: 'Show Application Log', click: () => void showApplicationLog() },
        { label: 'Copy Diagnostics', click: copyDiagnosticsToClipboard },
        { type: 'separator' },
        { label: 'Open Releases', click: () => void shell.openExternal(RELEASES_URL) },
        { role: 'about' },
      ],
    },
  ])
  Menu.setApplicationMenu(menu)
}

function createWindow(showOnReady = true): BrowserWindow {
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
    },
  })
  window.once('ready-to-show', () => {
    if (showOnReady) window.show()
  })
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
    void promptForWindowClose(window)
  })
  window.on('closed', () => {
    finishClosePrompt(window)
    mainWindow = null
  })
  void window.loadFile(rendererPath('index.html'))
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
    },
  })
  settingsWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== settingsUrl()) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = null
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
    const operation = updateController?.snapshot.canCheck ? updateController.check() : Promise.resolve()
    void operation.finally(() => scheduleAutomaticUpdateCheck(6 * 60 * 60 * 1_000))
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
// pty IPC channels (write/resize) validate the sender against the launcher
// shell URL like every other handler; the tabId itself is passed explicitly
// by the renderer because a single window hosts every tab's terminal pane.
ipcMain.handle('desktop:get-state', (event) => {
  assertTrustedIpcSender(event)
  return snapshot()
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
ipcMain.handle('desktop:create-tab', (event, resumeMode: unknown) => {
  assertTrustedIpcSender(event)
  const override = isResumeMode(resumeMode) ? resumeMode : null
  return createSessionTab(undefined, override)
})
ipcMain.handle('desktop:create-tab-with-attachments', (event) => {
  assertTrustedIpcSender(event)
  return createSessionWithAttachments()
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
ipcMain.handle('desktop:write-tab', (event, tabId: unknown, data: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string' || typeof data !== 'string') throw new Error('Invalid pty input')
  managedTabs.get(tabId)?.session.write(data)
})
ipcMain.handle('desktop:resize-tab', (event, tabId: unknown, cols: unknown, rows: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') {
    throw new Error('Invalid pty resize request')
  }
  managedTabs.get(tabId)?.session.resize(Math.max(1, Math.round(cols)), Math.max(1, Math.round(rows)))
})
ipcMain.handle('desktop:get-tab-backlog', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string') throw new Error('Invalid session tab')
  return managedTabs.get(tabId)?.session.recentOutputText ?? ''
})
ipcMain.handle('desktop:open-settings', (event) => {
  assertTrustedIpcSender(event)
  return showSettingsWindow()
})
ipcMain.handle('desktop:show-session-log', (event, tabId: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string') throw new Error('Invalid session tab')
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
ipcMain.handle('desktop:read-clipboard-text', (event) => {
  assertTrustedIpcSender(event)
  // Bound clipboard input before forwarding it to the terminal process.
  return clipboard.readText().slice(0, 1_000_000)
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
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL')
  }
  // Only ever hand the OS browser a link the terminal itself printed, and
  // only when it is a web URL — never a scheme that could launch another
  // local program (file:, mailto:, a custom app protocol, etc.).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https links can be opened')
  await shell.openExternal(parsed.href)
})
async function pathExists(candidate: string, timeoutMs = 3_000): Promise<boolean> {
  // A path a session prints can name a UNC/network location; a disconnected
  // or slow share can leave `access` pending for a long time. Fail closed on
  // a timeout rather than blocking this handler (and, if it were ever done
  // synchronously, the whole main-process event loop) indefinitely.
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
ipcMain.handle('desktop:reveal-path', async (event, tabId: unknown, candidate: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof tabId !== 'string' || typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4_096) {
    throw new Error('Invalid file path')
  }
  const tab = tabsState.tabs.find((item) => item.id === tabId)
  const owningProfile = tab ? desktopConfig.profiles.find((profile) => profile.id === tab.workspaceProfileId) : null
  const baseDirectory = owningProfile?.path ?? activeWorkspaceProfile(desktopConfig)?.path ?? app.getPath('home')
  const resolved = resolve(baseDirectory, candidate)
  // The text a session prints is not guaranteed to name a real file (it may
  // be prose that merely looks path-shaped). Silently do nothing rather than
  // opening Explorer to a location that doesn't exist.
  if (!(await pathExists(resolved))) return
  shell.showItemInFolder(resolved)
})

// --- IPC: settings window ----------------------------------------------
ipcMain.handle('desktop-settings:get', (event) => {
  assertTrustedSettingsSender(event)
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
  ) {
    throw new Error('Invalid desktop preferences')
  }

  const updateChecksChanged = typeof values.automaticUpdateChecks === 'boolean'
    && desktopConfig.automaticUpdateChecks !== values.automaticUpdateChecks
  const shortcutChanged = typeof values.globalShortcutEnabled === 'boolean'
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
  // A remembered tray action is unusable without a tray icon. Move back to
  // the explicit prompt and restore a hidden window before persisting.
  if (!desktopConfig.trayEnabled && desktopConfig.closeBehavior === 'tray') {
    desktopConfig.closeBehavior = 'ask'
  }
  if (shortcutChanged) applyGlobalShortcut(desktopConfig.globalShortcutEnabled)
  updateTrayVisibility()
  await persistConfig()
  broadcastSettingsPreferences()
  if (updateChecksChanged) scheduleAutomaticUpdateCheck(1_000)
  return settingsSnapshot()
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
  await updateController?.check()
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:download-update', async (event) => {
  assertTrustedSettingsSender(event)
  await updateController?.download()
  return settingsSnapshot()
})
ipcMain.handle('desktop-settings:install-update', async (event) => {
  assertTrustedSettingsSender(event)
  if (installInProgress) throw new Error('An update installation is already in progress')
  if (!updateController?.snapshot.canInstall) throw new Error('No downloaded update is ready to install')
  installInProgress = true
  refreshMenus()
  try {
    await stopAllSessions()
    explicitQuitRequested = true
    try {
      updateController.install()
    } catch (error) {
      explicitQuitRequested = false
      throw error
    }
  } catch (error) {
    installInProgress = false
    refreshMenus()
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => restoreMainWindow())
  app.on('activate', restoreMainWindow)

  app.whenReady().then(async () => {
    app.setName('Copilot CLI Desktop')
    state.desktopVersion = app.getVersion()
    desktopConfig = await readDesktopConfig(configPath())
    if (recordDesktopVersion(desktopConfig, app.getVersion())) await persistConfig()
    syncWorkspaceState()

    updateController = new DesktopUpdateController(
      app.isPackaged && process.platform === 'win32' ? autoUpdater as unknown as UpdateAdapter : null,
      app.getVersion(),
    )
    updateController.on('state-changed', (update: DesktopUpdateState) => {
      if (installInProgress && update.status === 'error') {
        installInProgress = false
        explicitQuitRequested = false
        refreshMenus()
      }
      broadcastUpdateState(update)
      if (update.status === 'available') {
        showNotification(
          'Copilot CLI Desktop update available',
          `Version ${update.availableVersion ?? 'new'} is ready to download.`,
          () => void showSettingsWindow(),
        )
      }
    })

    credentialStore = new SecureCredentialStore(protectedCredentialPath(), safeStorage)

    const startHidden = process.argv.includes(BACKGROUND_START_ARGUMENT)
    mainWindow = createWindow(!startHidden)
    updateTrayVisibility()
    installApplicationMenu()
    applyGlobalShortcut(desktopConfig.globalShortcutEnabled)

    await retryResolution()
    scheduleAutomaticUpdateCheck()
  }).catch((error) => {
    dialog.showErrorBox('Copilot CLI Desktop failed to start', String(error))
    app.quit()
  })
}

app.on('before-quit', (event) => {
  explicitQuitRequested = true
  if (closePromptWindow && !closePromptWindow.isDestroyed()) {
    event.preventDefault()
    quitAfterClosePrompt = true
    return
  }
  if (quittingAllSessions || managedTabs.size === 0) return
  event.preventDefault()
  quittingAllSessions = true
  // Each stopped session's 'exit' handler persists its final resume id via
  // persistProfileTabs()/persistConfig() without awaiting the write —
  // reading configWriteQueue here (after those synchronous handlers have
  // already re-chained it) and awaiting it ensures Electron does not exit
  // before that last write actually lands on disk.
  void stopAllSessions()
    .then(() => configWriteQueue)
    .finally(() => app.quit())
})

app.on('will-quit', () => {
  if (updateCheckTimer) clearTimeout(updateCheckTimer)
  if (copilotResolutionRefreshTimer) clearTimeout(copilotResolutionRefreshTimer)
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (explicitQuitRequested || desktopConfig.closeBehavior !== 'tray' || !tray) app.quit()
})
