import type { PermissionPreset } from './permission-presets.js'
import type { ResumeMode } from './resume-args.js'
import type { SessionLaunchConfig } from './session-launch.js'

/** Lifecycle status of one spawned `copilot` pty session. */
export type SessionLifecycleStatus =
  | 'starting'
  | 'running'
  | 'approval-needed'
  | 'stopping'
  | 'completed'
  | 'crashed'

export interface RestoredTab {
  title: string
  lastSessionId: string | null
}

export interface WorkspaceProfile {
  id: string
  name: string
  path: string
  permissionPreset: PermissionPreset
  defaultResumeMode: ResumeMode
  launch: SessionLaunchConfig
  tabs: RestoredTab[]
}

export interface DesktopSessionTab {
  id: string
  title: string
  workspaceProfileId: string
  lastSessionId: string | null
  status: SessionLifecycleStatus
  processId: number | null
  /** Last local lifecycle, output, or user-activation activity for sidebar ordering. */
  lastActivityAt: number
}

export type CopilotResolutionKind = 'direct' | 'gh-wrapped'

export interface CopilotResolution {
  kind: CopilotResolutionKind
  command: string
  prefixArgs: string[]
  resolvedPath: string | null
  version: string | null
  error: string | null
  /** Directories that must be prepended to PATH when launching this command. */
  pathAdditions?: string[]
}

export interface DesktopState {
  desktopVersion: string
  resolution: CopilotResolution | null
  profiles: WorkspaceProfile[]
  activeProfileId: string | null
  tabs: DesktopSessionTab[]
  activeTabId: string | null
  maxSessionTabs: number
  recentLogs: string[]
  error: string | null
}

/** Desktop event surfaced to the renderer/tray/notifications layer. */
export type DesktopEvent =
  | { type: 'approval-needed'; tabId: string }
  | { type: 'session-completed'; tabId: string }
  | { type: 'session-crashed'; tabId: string; message: string }
