import type { DesktopState, RevealPathResult, FanOutResult, SessionHistoryEntry, SessionWorktreeInfo, SidebarView } from '../main/types.js'
import type { BrowserBounds, BrowserCaptureSetting, BrowserDebugState, BrowserViewMode } from '../main/browser-debug-types.js'
import type { PermissionPreset } from '../main/permission-presets.js'
import type { ResumeMode } from '../main/resume-args.js'
import type { NewSessionOptions } from '../main/session-name.js'
import type { CredentialName } from '../main/secure-credentials.js'
import type { AccessStatus } from '../main/access-status.js'
import type { CopilotProviderConfig } from '../main/provider-config.js'
import type { SessionLaunchConfig } from '../main/session-launch.js'
import type { CopilotCapabilities } from '../main/copilot-command.js'
import type { CopilotMaintenanceState } from '../main/copilot-maintenance.js'
import type { CopilotResourceAction, CopilotResourceKind, CopilotResourcesState } from '../main/copilot-resources.js'
import type { DesktopPreferences } from '../main/desktop-config.js'
import type { CopilotAutoUpdateState, CopilotUpdateChannel } from '../main/copilot-auto-update.js'
import type { SessionTaskSend } from '../main/session-task.js'
import type { GitBranchView, GitDiffView, GitHeadCommitView, GitLogEntry, GitOperationResult, GitProgressEvent, GitProjectView, GitRepoStatusView, GitWorktreeView } from '../main/git-types.js'
import type { MigrationChoices, MigrationInventory, MigrationPreview, MigrationProgress, MigrationProject, MigrationResult, MigrationSelection, MigrationStatus } from '../main/migration-types.js'

export interface TabOutputPayload {
  sequence: number
  tabId: string
  data: string
}

export interface TabExitPayload {
  tabId: string
  exit: { exitCode: number; signal: number | undefined; expected: boolean }
}

export interface CopilotDesktopBridge {
  browserOpen(tabId: string): Promise<BrowserDebugState>
  browserState(tabId: string): Promise<BrowserDebugState>
  browserNavigate(tabId: string, url: string): Promise<BrowserDebugState>
  browserAction(tabId: string, action: 'new-page' | 'back' | 'forward' | 'reload' | 'hard-reload' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'clear' | 'clear-console' | 'clear-network' | 'devtools' | `testing:${'on' | 'off'}` | `view:${BrowserViewMode}` | `${BrowserCaptureSetting}:${'on' | 'off'}` | `select-page:${number}` | `close-page:${number}` | 'forget-permissions' | `forget-permission:${number}`): Promise<BrowserDebugState>
  browserPick(tabId: string): Promise<string | null>
  browserPickCancel(tabId: string): Promise<void>
  browserPickMany(tabId: string): Promise<void>
  onBrowserPicked(listener: (tabId: string, text: string) => void): () => void
  browserScreenshot(tabId: string): Promise<{ redacted: boolean }>
  browserDialog(tabId: string, accept: boolean): Promise<BrowserDebugState>
  browserFind(tabId: string, text: string, forward: boolean, next: boolean): Promise<BrowserDebugState>
  browserFindStop(tabId: string): Promise<BrowserDebugState>
  onBrowserShortcut(listener: (tabId: string, name: 'find' | 'find-close') => void): () => void
  browserExport(tabId: string, kind: 'console' | 'network'): Promise<void>
  browserBounds(tabId: string, bounds: BrowserBounds | null): Promise<void>
  gitOpen(profileId: string): Promise<GitProjectView>
  gitClose(profileId: string): Promise<void>
  gitRescan(profileId: string): Promise<GitProjectView>
  gitTrust(profileId: string, repoId: string, configHash: string): Promise<GitProjectView>
  gitStatus(profileId: string, repoId: string): Promise<GitRepoStatusView>
  gitStage(profileId: string, repoId: string, entryIds: string[], generation: number): Promise<GitOperationResult>
  gitUnstage(profileId: string, repoId: string, entryIds: string[], generation: number): Promise<GitOperationResult>
  gitCommit(profileId: string, repoId: string, message: string, generation: number, approvedHooksHash: string | null): Promise<GitOperationResult>
  gitSync(profileId: string, repoId: string, operation: 'fetch' | 'pull' | 'push', remote: string | null, expected: { branch: string; headOid: string } | null): Promise<GitOperationResult>
  gitHeadCommit(profileId: string, repoId: string): Promise<GitHeadCommitView>
  gitAmend(profileId: string, repoId: string, message: string, generation: number, approvedHooksHash: string | null, expected: { branch: string | null; headOid: string }): Promise<GitOperationResult>
  gitDiscard(profileId: string, repoId: string, entryIds: string[], generation: number): Promise<GitOperationResult>
  gitBranches(profileId: string, repoId: string): Promise<GitBranchView[]>
  gitWorktrees(profileId: string, repoId: string): Promise<GitWorktreeView[]>
  gitWorktreeRemove(profileId: string, repoId: string, path: string): Promise<GitOperationResult>
  gitBranch(profileId: string, repoId: string, action: 'create' | 'switch', name: string, expected: { branch: string | null; headOid: string }): Promise<GitOperationResult>
  gitCancel(profileId: string, repoId: string): Promise<void>
  onGitProgress(listener: (payload: { profileId: string; event: GitProgressEvent }) => void): () => void
  gitDiff(profileId: string, repoId: string, entryId: string, staged: boolean, wholeFile?: boolean): Promise<GitDiffView>
  gitLog(profileId: string, repoId: string, limit: number, skip: number): Promise<GitLogEntry[]>
  onGitToggle(listener: () => void): () => void
  onGitChanged(listener: (payload: { profileId: string; view: GitProjectView }) => void): () => void
  getState(): Promise<DesktopState>
  selectWorkspace(): Promise<DesktopState>
  activateProfile(profileId: string): Promise<DesktopState>
  removeProfile(profileId: string): Promise<DesktopState>
  /** `title` names the session; empty or absent uses the project's name. */
  createTab(resumeMode?: ResumeMode | null, profileId?: string, title?: string | null, options?: NewSessionOptions | null): Promise<DesktopState>
  forkSideChat(tabId: string, sourceSessionId: string, title: string): Promise<DesktopState>
  createTabWithAttachments(title?: string | null, options?: NewSessionOptions | null): Promise<DesktopState>
  /** The project's existing linked worktrees a new session can start in, read from the filesystem. */
  listSessionWorktrees(profileId: string): Promise<SessionWorktreeInfo[]>
  /** The menu or tray asked for a new session; the renderer names it in its dialog first. */
  onNewSessionRequest(listener: (attachments: boolean) => void): () => void
  listSessionHistory(): Promise<SessionHistoryEntry[]>
  openSessionHistory(sessionId: string): Promise<DesktopState>
  onSessionHistoryRequest(listener: () => void): () => void
  /** The View menu picked a sidebar grouping or order. */
  onSidebarViewRequest(listener: (change: Partial<SidebarView>) => void): () => void
  /** Tells the main process the sidebar's current view so the View menu shows it checked. */
  reportSidebarView(view: SidebarView): Promise<void>
  fanOut(profileId: string, label: string, count: number): Promise<FanOutResult>
  connectRemoteSession(sessionId: string): Promise<DesktopState>
  activateTab(tabId: string): Promise<DesktopState>
  popOutTab(tabId: string): Promise<DesktopState>
  dockTab(tabId: string): Promise<DesktopState>
  popOutBrowser(tabId: string): Promise<DesktopState>
  dockBrowser(tabId: string): Promise<DesktopState>
  /** Turn desktop control on or off for a session; only the person can, from this window. */
  desktopControlSet(tabId: string, enabled: boolean): Promise<DesktopState>
  desktopControlResume(tabId: string): Promise<DesktopState>
  desktopControlRevoke(tabId: string, appKey: string): Promise<DesktopState>
  desktopControlFullScreen(tabId: string, allowed: boolean): Promise<DesktopState>
  /** From a session's browser window: paste into that session's prompt box in the window that shows its terminal. */
  browserInsertPrompt(tabId: string, detail: { text: string } | { image: true }): Promise<boolean>
  /** Answer whether a terminal pane in this window took the insert. */
  onInsertPromptRequest(listener: (detail: { tabId: string; text?: string; image?: true }) => boolean): () => void
  renameTab(tabId: string, title: string): Promise<DesktopState>
  closeTab(tabId: string): Promise<DesktopState>
  restartTab(tabId: string): Promise<DesktopState>
  unloadTab(tabId: string): Promise<DesktopState>
  writeTab(tabId: string, data: string, gitCursorContext?: string): Promise<{ gitCursorContextAttached: boolean }>
  /** Give the session the task of resolving a pull in the repository, and claim the repository for it until it has finished.
   * Typed and sent when that is safe; otherwise `busy`, and the caller pastes it. */
  gitResolve(profileId: string, repoId: string, tabId: string, text: string): Promise<SessionTaskSend>
  /** The person's controls for a review meeting between sessions. `join` adds the session `tabId` to it, reviewing as `role`;
   * `remove` takes out the outside agent whose seat id is `tabId`, joined or only invited. */
  meetingAction(meetingId: string, action: 'stop' | 'resume' | 'join' | 'remove' | 'transcript', tabId?: string, role?: string): Promise<void>
  /** Invite an outside agent to review: returns the invitation to paste into it, also put on the clipboard. `short`: the
   * agent has the meeting tools, so the invitation names only them (refused when the tools are not served). */
  meetingInvite(meetingId: string, name: string, role?: string, short?: boolean): Promise<string>
  /** Let an outside agent host a meeting: returns the host invitation, also put on the clipboard. `folder`: its project, or null. */
  meetingHostInvite(folder: string | null, short?: boolean): Promise<string>
  resizeTab(tabId: string, cols: number, rows: number): Promise<void>
  getTabBacklog(tabId: string): Promise<string>
  getTabSnapshot(tabId: string): Promise<{ data: string; sequence: number }>
  openSettings(): Promise<void>
  showSessionLog(tabId: string): Promise<void>
  copyText(text: string): Promise<void>
  showTerminalContextMenu(text: string): Promise<void>
  openExternalUrl(url: string): Promise<void>
  revealPath(tabId: string, path: string): Promise<RevealPathResult>
  copyDiagnostics(): Promise<void>
  retryResolution(): Promise<DesktopState>
  installCopilot(): Promise<DesktopState>
  onStateChanged(listener: (state: DesktopState) => void): () => void
  onTabOutput(listener: (payload: TabOutputPayload) => void): () => void
  onTabExit(listener: (payload: TabExitPayload) => void): () => void
}

export interface DesktopSettingsSnapshot extends DesktopPreferences {
  launchAtLogin: boolean
  launchAtLoginAvailable: boolean
  globalShortcutRegistered: boolean
  globalShortcutAccelerator: string
  credentials: {
    available: boolean
    storeError: boolean
    entries: Array<{ name: CredentialName; configured: boolean; source: 'environment' | 'protected-store' | 'none' }>
  } | null
  update: {
    status: string
    currentVersion: string
    availableVersion: string | null
    downloadPercent: number | null
    message: string
    canCheck: boolean
    canDownload: boolean
    canInstall: boolean
  }
  profiles: DesktopState['profiles']
  activeProfileId: string | null
  rollbackVersion: string | null
  access: AccessStatus
  provider: CopilotProviderConfig
  cliVersion: string | null
  cliCapabilities: CopilotCapabilities
  cliMaintenance: CopilotMaintenanceState
  cliAutoUpdate: CopilotAutoUpdateState
  resources: CopilotResourcesState
}

export interface CopilotDesktopSettingsBridge {
  migrationInventory(selection: MigrationSelection): Promise<MigrationInventory>
  migrationExport(selection: MigrationSelection): Promise<boolean>
  migrationOpen(): Promise<{ projects: MigrationProject[]; warnings: string[]; plugins: { name: string; source: string; version: string }[] } | null>
  migrationMap(id: string): Promise<string | null>
  migrationPreview(choices: MigrationChoices): Promise<MigrationPreview>
  migrationApply(id: string): Promise<MigrationResult>
  migrationCancel(): Promise<void>
  migrationStatus(): Promise<MigrationStatus>
  migrationRecover(): Promise<MigrationStatus>
  migrationDismissRecovery(id: string, sha256: string): Promise<MigrationStatus>
  migrationBackups(): Promise<MigrationStatus>
  migrationDeleteBackup(id: string, token: string): Promise<MigrationStatus>
  onMigrationProgress(listener: (progress: MigrationProgress) => void): () => void
  usageReport(month: string, scope: import('../main/usage-types.js').UsageScope, timezone?: string): Promise<import('../main/usage-types.js').UsageReport>
  refreshUsage(): Promise<void>
  exportUsage(): Promise<boolean>
  restoreUsage(): Promise<boolean>
  get(): Promise<DesktopSettingsSnapshot>
  updatePreferences(preferences: Partial<DesktopPreferences>): Promise<DesktopSettingsSnapshot>
  setLaunchAtLogin(enabled: boolean): Promise<DesktopSettingsSnapshot>
  clearSharedBrowserData(): Promise<void>
  clearBrowserHistory(): Promise<void>
  updateWorkspaceProfile(
    profileId: string,
    name: string,
    permissionPreset: PermissionPreset,
    defaultResumeMode: ResumeMode,
    launch: SessionLaunchConfig,
  ): Promise<DesktopSettingsSnapshot>
  removeWorkspaceProfile(profileId: string): Promise<DesktopSettingsSnapshot>
  updateProvider(provider: CopilotProviderConfig): Promise<DesktopSettingsSnapshot>
  checkForUpdates(): Promise<DesktopSettingsSnapshot>
  downloadUpdate(): Promise<DesktopSettingsSnapshot>
  installUpdate(): Promise<void>
  openReleases(): Promise<void>
  openRollbackRelease(): Promise<void>
  saveCredential(name: CredentialName, secret: string): Promise<DesktopSettingsSnapshot>
  deleteCredential(name: CredentialName): Promise<DesktopSettingsSnapshot>
  installCopilot(): Promise<DesktopSettingsSnapshot>
  updateCopilot(): Promise<DesktopSettingsSnapshot>
  setCopilotAutoUpdate(enabled: boolean, channel: CopilotUpdateChannel): Promise<DesktopSettingsSnapshot>
  recheckCopilotCapabilities(): Promise<DesktopSettingsSnapshot>
  refreshCopilotResources(): Promise<DesktopSettingsSnapshot>
  mutateCopilotResource(action: CopilotResourceAction, kind: CopilotResourceKind, name: string): Promise<DesktopSettingsSnapshot>
  installCopilotPlugin(source: string): Promise<DesktopSettingsSnapshot>
  installCopilotSkill(source: string, project: boolean): Promise<DesktopSettingsSnapshot>
  addCopilotMcp(name: string, url: string, transport: 'http' | 'sse'): Promise<DesktopSettingsSnapshot>
  openCopilotConfig(): Promise<void>
  onUpdateStateChanged(listener: (state: DesktopSettingsSnapshot['update']) => void): () => void
  onPreferencesChanged(listener: (preferences: DesktopPreferences) => void): () => void
  onCopilotStateChanged(
    listener: (state: Pick<DesktopSettingsSnapshot, 'cliVersion' | 'cliCapabilities' | 'cliMaintenance'>) => void,
  ): () => void
}

declare global {
  interface Window {
    copilotDesktop: CopilotDesktopBridge
    copilotDesktopSettings: CopilotDesktopSettingsBridge
  }
}

export {}
