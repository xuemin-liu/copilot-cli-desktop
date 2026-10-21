import type { PermissionPreset } from './permission-presets.js'
import type { SessionPermissionMode } from './permission-modes.js'
import type { ResumeMode } from './resume-args.js'
import type { SessionLaunchConfig } from './session-launch.js'
import type { SessionActivity } from './session-activity.js'
import type { ActivityDetail } from './activity-label.js'

export type RevealPathResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'outside-workspace' }

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
  browserProfileId?: string
  /** Session-owned launch bundle. Missing in config files written by older releases. */
  sessionPermissionPreset?: PermissionPreset
  sessionPermissionMode?: SessionPermissionMode
  sideChat?: true
  sideParentSessionId?: string
  /** Whether the session was started in its own Git worktree. Absent in config files written by older releases. */
  launchWorktree?: boolean
  /** The existing linked worktree the session was started in, when it was. Checked again before every launch. */
  launchWorktreePath?: string
  /** The session's browser keeps DevTools settings and Local Overrides to itself. */
  privateOverrides?: true
  /** The title follows Copilot's name for the session. Absent in config files written by older releases. */
  autoTitle?: boolean
  /** A rename made in the desktop that had not reached Copilot when the tab was saved. */
  renamePending?: true
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
  browserProfileId?: string
  workspaceProfileId: string
  lastSessionId: string | null
  status: SessionLifecycleStatus
  /** Observed task activity; absent when this process has no reliable evidence. */
  activity?: SessionActivity | null
  /** Running tools or thinking inside the current turn, for the sidebar's activity line. Runtime-only. */
  activityDetail?: ActivityDetail | null
  /** The folder the CLI reports the session runs in, from its event log. Runtime-only; data the CLI wrote. */
  sessionCwd?: string | null
  /** Set when `sessionCwd` is a linked worktree of a repository in the workspace folder. Runtime-only. */
  worktree?: SessionWorktreeInfo | null
  /** Sessions started together by one fan-out share this label. Runtime-only; not restored. */
  fanOutLabel?: string | null
  processId: number | null
  /** Copilot CLI executable version captured when this process was spawned. */
  cliVersion: string | null
  /** Launch-time permission bundle copied from the profile when this session was created. */
  sessionPermissionPreset: PermissionPreset | null
  /** Native Copilot approval mode observed from this session's structured event log. */
  sessionPermissionMode: SessionPermissionMode | null
  permissionWarning: string | null
  remote: boolean
  /** Restricted fork; preserved even when its parent tab is closed. */
  sideChat?: true
  sideParentTabId?: string
  canFork?: boolean
  /** Last local lifecycle, output, or user-activation activity for sidebar ordering. */
  lastActivityAt: number
  /** Whether the session was started in its own Git worktree: the choice made in the new-session dialog, or the project
   * setting at the time. A fresh restart (a session Copilot has not stored yet) and a restore keep it. Saved. */
  launchWorktree?: boolean
  /** The existing linked worktree of the project's repository the session was started in, chosen in the new-session
   * dialog. Restarts and restores launch there again while it is still one of the project's worktrees. Saved. */
  launchWorktreePath?: string
  /** The session's browser keeps DevTools settings and Local Overrides (its folder and its on/off switch) to itself instead
   * of using the ones every session shares. Chosen when the session starts; saved. */
  privateOverrides?: true
  /** Nobody named the session, so the title follows the name Copilot gives it; a rename in the desktop clears this and
   * renames the Copilot session instead. Saved. */
  autoTitle?: boolean
  /** Renamed in the desktop; `/rename` is typed into the session at the next safe moment, until Copilot reports the
   * name. Saved, so a rename made just before quitting reaches Copilot after the next start. */
  renamePending?: true
}

/** A session's worktree, as the tab and sidebar show it. */
export interface SessionWorktreeInfo {
  /** Canonical worktree folder. */
  path: string
  /** Its folder name. */
  name: string
  /** The checked-out branch, or null when detached. */
  branch: string | null
}

/** What a fan-out did: how many sessions it started, and why it stopped early when it did. */
export interface FanOutResult {
  tabIds: string[]
  requested: number
  /** Why fewer sessions than requested were started, if so. */
  stopped: string | null
  label: string
}

/** How the sidebar lists sessions; the renderer owns it, the View menu mirrors it. */
export interface SidebarView {
  group: 'workspace' | 'list'
  order: 'manual' | 'last-updated'
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
  /** Runtime window placement, never persisted as session configuration. */
  poppedOutTabIds?: string[]
  windowSessionId?: string
  desktopVersion: string
  resolution: CopilotResolution | null
  profiles: WorkspaceProfile[]
  activeProfileId: string | null
  tabs: DesktopSessionTab[]
  activeTabId: string | null
  maxSessionTabs: number
  recentLogs: string[]
  error: string | null
  /** The new-session dialog's default: new sessions keep their own Local Overrides (Settings → Session browser). */
  newSessionPrivateOverrides?: boolean
}

/** Desktop event surfaced to the renderer/tray/notifications layer. */
export type DesktopEvent =
  | { type: 'approval-needed'; tabId: string }
  | { type: 'session-completed'; tabId: string }
  | { type: 'session-crashed'; tabId: string; message: string }
