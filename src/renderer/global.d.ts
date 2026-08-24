import type { DesktopState } from '../main/types.js'
import type { PermissionPreset } from '../main/permission-presets.js'
import type { ResumeMode } from '../main/resume-args.js'
import type { CredentialName } from '../main/secure-credentials.js'
import type { AccessStatus } from '../main/access-status.js'
import type { CopilotProviderConfig } from '../main/provider-config.js'

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
  createTabWithAttachments(): Promise<DesktopState>
  activateTab(tabId: string): Promise<DesktopState>
  renameTab(tabId: string, title: string): Promise<DesktopState>
  closeTab(tabId: string): Promise<DesktopState>
  restartTab(tabId: string): Promise<DesktopState>
  writeTab(tabId: string, data: string): Promise<void>
  resizeTab(tabId: string, cols: number, rows: number): Promise<void>
  getTabBacklog(tabId: string): Promise<string>
  openSettings(): Promise<void>
  showSessionLog(tabId: string): Promise<void>
  copyDiagnostics(): Promise<void>
  retryResolution(): Promise<DesktopState>
  onStateChanged(listener: (state: DesktopState) => void): () => void
  onTabOutput(listener: (payload: TabOutputPayload) => void): () => void
  onTabExit(listener: (payload: TabExitPayload) => void): () => void
}

export interface DesktopSettingsSnapshot {
  closeToTray: boolean
  trayEnabled: boolean
  notifications: boolean
  automaticUpdateChecks: boolean
  launchAtLogin: boolean
  launchAtLoginAvailable: boolean
  globalShortcutEnabled: boolean
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
}

export interface CopilotDesktopSettingsBridge {
  get(): Promise<DesktopSettingsSnapshot>
  updatePreferences(preferences: {
    closeToTray: boolean
    trayEnabled: boolean
    notifications: boolean
    automaticUpdateChecks: boolean
    globalShortcutEnabled: boolean
  }): Promise<DesktopSettingsSnapshot>
  setLaunchAtLogin(enabled: boolean): Promise<DesktopSettingsSnapshot>
  updateWorkspaceProfile(
    profileId: string,
    name: string,
    permissionPreset: PermissionPreset,
    defaultResumeMode: ResumeMode,
  ): Promise<DesktopSettingsSnapshot>
  updateProvider(provider: CopilotProviderConfig): Promise<DesktopSettingsSnapshot>
  checkForUpdates(): Promise<DesktopSettingsSnapshot>
  downloadUpdate(): Promise<DesktopSettingsSnapshot>
  installUpdate(): Promise<void>
  openReleases(): Promise<void>
  openRollbackRelease(): Promise<void>
  saveCredential(name: CredentialName, secret: string): Promise<DesktopSettingsSnapshot>
  deleteCredential(name: CredentialName): Promise<DesktopSettingsSnapshot>
  onUpdateStateChanged(listener: (state: DesktopSettingsSnapshot['update']) => void): () => void
}

declare global {
  interface Window {
    copilotDesktop: CopilotDesktopBridge
    copilotDesktopSettings: CopilotDesktopSettingsBridge
  }
}

export {}
