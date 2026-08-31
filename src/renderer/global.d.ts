import type { DesktopState } from '../main/types.js'
import type { PermissionPreset } from '../main/permission-presets.js'
import type { ResumeMode } from '../main/resume-args.js'
import type { CredentialName } from '../main/secure-credentials.js'
import type { AccessStatus } from '../main/access-status.js'
import type { CopilotProviderConfig } from '../main/provider-config.js'
import type { SessionLaunchConfig } from '../main/session-launch.js'
import type { CopilotCapabilities } from '../main/copilot-command.js'
import type { CopilotMaintenanceState } from '../main/copilot-maintenance.js'
import type { CopilotResourceAction, CopilotResourceKind, CopilotResourcesState } from '../main/copilot-resources.js'
import type { DesktopPreferences } from '../main/desktop-config.js'

export interface TabOutputPayload {
  tabId: string
  data: string
}

export interface TabExitPayload {
  tabId: string
  exit: { exitCode: number; signal: number | undefined; expected: boolean }
}

export interface CopilotDesktopBridge {
  getState(): Promise<DesktopState>
  selectWorkspace(): Promise<DesktopState>
  activateProfile(profileId: string): Promise<DesktopState>
  createTab(resumeMode?: ResumeMode | null): Promise<DesktopState>
  forkSideChat(tabId: string, sourceSessionId: string, title: string): Promise<DesktopState>
  createTabWithAttachments(): Promise<DesktopState>
  connectRemoteSession(sessionId: string): Promise<DesktopState>
  activateTab(tabId: string): Promise<DesktopState>
  renameTab(tabId: string, title: string): Promise<DesktopState>
  closeTab(tabId: string): Promise<DesktopState>
  restartTab(tabId: string): Promise<DesktopState>
  writeTab(tabId: string, data: string): Promise<void>
  resizeTab(tabId: string, cols: number, rows: number): Promise<void>
  getTabBacklog(tabId: string): Promise<string>
  openSettings(): Promise<void>
  showSessionLog(tabId: string): Promise<void>
  copyText(text: string): Promise<void>
  readClipboardText(): Promise<string>
  showTerminalContextMenu(text: string): Promise<void>
  openExternalUrl(url: string): Promise<void>
  revealPath(tabId: string, path: string): Promise<void>
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
  resources: CopilotResourcesState
}

export interface CopilotDesktopSettingsBridge {
  get(): Promise<DesktopSettingsSnapshot>
  updatePreferences(preferences: Partial<DesktopPreferences>): Promise<DesktopSettingsSnapshot>
  setLaunchAtLogin(enabled: boolean): Promise<DesktopSettingsSnapshot>
  updateWorkspaceProfile(
    profileId: string,
    name: string,
    permissionPreset: PermissionPreset,
    defaultResumeMode: ResumeMode,
    launch: SessionLaunchConfig,
  ): Promise<DesktopSettingsSnapshot>
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
  recheckCopilotCapabilities(): Promise<DesktopSettingsSnapshot>
  refreshCopilotResources(): Promise<DesktopSettingsSnapshot>
  mutateCopilotResource(action: CopilotResourceAction, kind: CopilotResourceKind, name: string): Promise<DesktopSettingsSnapshot>
  installCopilotPlugin(source: string): Promise<DesktopSettingsSnapshot>
  installCopilotSkill(source: string, project: boolean): Promise<DesktopSettingsSnapshot>
  addCopilotMcp(name: string, url: string, transport: 'http' | 'sse'): Promise<DesktopSettingsSnapshot>
  openCopilotConfig(): Promise<void>
  onUpdateStateChanged(listener: (state: DesktopSettingsSnapshot['update']) => void): () => void
  onPreferencesChanged(listener: (preferences: DesktopPreferences) => void): () => void
}

declare global {
  interface Window {
    copilotDesktop: CopilotDesktopBridge
    copilotDesktopSettings: CopilotDesktopSettingsBridge
  }
}

export {}
