import type { PermissionPreset } from './permission-presets.js'
import type { SessionPermissionMode } from './permission-modes.js'
import type { ResumeMode } from './resume-args.js'
import type { SessionLaunchConfig } from './session-launch.js'
import type { SessionActivity } from './session-activity.js'
import type { ActivityDetail } from './activity-label.js'
import type { MeetingView } from './meeting.js'
import type { OtherCli, ReviewerCli } from './session-cli.js'
import type { IncompatibleField, OtherCliConfig, PerCliConfig } from './agent-cli-settings.js'

export type RevealPathResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'outside-workspace' }

/** Lifecycle status of one spawned `copilot` pty session. */
export type SessionLifecycleStatus =
  /** Shown as Not running: restored from the saved tabs or unloaded. It has no process until it is resumed. */
  | 'dormant'
  | 'starting'
  | 'running'
  | 'approval-needed'
  | 'stopping'
  | 'completed'
  | 'crashed'

export interface RestoredTab {
  title: string
  lastSessionId: string | null
  /** The CLI the tab runs when it is not Copilot; `lastSessionId` is then that CLI's own session id. */
  cli?: OtherCli
  /** For a non-Copilot tab: the permission/model settings snapshotted from the profile when the tab was created, so a
   * later profile edit never changes how this tab relaunches. Absent in older configs — those tabs stay CLI-managed. */
  otherCliConfig?: PerCliConfig
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
  /** The tab on screen when it was saved: a restart shows it again instead of the project's last tab. */
  active?: true
}

export interface WorkspaceProfile {
  id: string
  name: string
  path: string
  permissionPreset: PermissionPreset
  defaultResumeMode: ResumeMode
  launch: SessionLaunchConfig
  /** Per-CLI permission/model settings for non-Copilot sessions. Absent = each other CLI uses its own defaults. */
  otherCli?: OtherCliConfig
  /** Optional per-workspace override of allowed temporary PR reviewer CLIs; absent inherits the global setting. */
  reviewerClis?: ReviewerCli[]
  tabs: RestoredTab[]
  /** For work with no project behind it, in a folder the desktop made. Saved. */
  general?: true
}

export interface DesktopSessionTab {
  id: string
  title: string
  /** Set when the tab runs another CLI (Claude Code, Codex CLI) instead of Copilot: a terminal for it in the project
   * folder, without the desktop's Copilot features (permission presets, meetings as a tab, side chats, tasks). Saved. */
  cli?: OtherCli
  /** For a non-Copilot tab: the permission/model settings this session launches with, snapshotted from the profile
   * at creation and reused verbatim on restart/restore. Absent for Copilot tabs and pre-feature saved tabs. */
  otherCliConfig?: PerCliConfig
  /** The saved settings this tab's last start or restart could not apply, so it did not launch with them. The tab keeps
   * its old process, if any, until the user clears those fields. Runtime-only. */
  otherCliBlocked?: IncompatibleField[]
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
  fanOutGroupId?: string
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
  /** Ephemeral PR reviewer session owned by `hostTabId`; hidden from the main sidebar list and never persisted. */
  tempReviewer?: TempReviewerTabInfo
}

export interface TempReviewerTabInfo {
  groupId: string
  hostTabId: string | null
  cli: ReviewerCli
  repository: string
  prLabel: string
  prNumber: number | null
  prUrl: string | null
  /** Set for a reviewer of a review meeting, which has no pull request: the meeting it was started for. */
  meetingId?: string
}

export type TempReviewerSeatVerdict =
  | 'starting'
  | 'reviewing'
  | 'approved'
  | 'findings'
  | 'incomplete'
  | 'timed-out'
  | 'failed'
  | 'stopped'

export interface TempReviewerSeatView {
  cli: ReviewerCli
  tabId: string | null
  verdict: TempReviewerSeatVerdict
  checkedOut: string | null
  needsAttention: boolean
  error: string | null
  keptCheckoutPath: string | null
}

export interface TempReviewerGroupView {
  id: string
  hostTabId: string | null
  profileId: string
  repository: string
  prLabel: string
  prNumber: number | null
  prUrl: string | null
  round: number
  head: string
  base: string
  stage: 'starting' | 'active' | 'ended'
  outcome: 'approved' | 'merged' | 'closed' | 'stopped' | null
  seats: TempReviewerSeatView[]
  notice: string | null
  /** Set for the hidden reviewers of a review meeting: the bar words itself for a meeting, not a pull request. */
  meetingId?: string
}

/** A session Copilot stored, as the History list shows it. Everything but the last two fields is data the CLI wrote. */
export interface SessionHistoryEntry {
  sessionId: string
  name: string | null
  userNamed: boolean
  cwd: string | null
  gitRoot: string | null
  repository: string | null
  branch: string | null
  createdAt: number | null
  /** Last write to the session's files: when it was last used. */
  updatedAt: number
  firstPrompt: string | null
  lastPrompt: string | null
  /** The tab it is open in, if any. */
  openTabId: string | null
  /** The open project it belongs to (its folder, or a worktree of its repository); null when opening it adds one. */
  projectName: string | null
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

export interface DesktopControlTabView {
  enabled: boolean
  promptsBlocked: boolean
  paused: boolean
  approvedApps: Array<{ key: string; name: string }>
  fullScreen: boolean
  log: Array<{ at: string; command: string; app?: string; result: 'ok' | 'refused' | 'failed'; message: string }>
}

export interface DesktopState {
  workflowDeliveries?: import('./workflow-deliveries.js').WorkflowDelivery[]
  workflowDeliveryError?: string | null
  workflowTasks?: import('./workflow-types.js').WorkflowTask[]
  workflowFollowupDefaults?: import('./workflow-followups.js').FollowupDefault[]
  workflowFollowups?: import('./workflow-followups.js').FollowupGrant[]
  /** PR-loop replies that are not settled yet (pr-loop-posts.ts). */
  workflowPrPosts?: PrPostView[]
  workflowPrPostsError?: string | null
  workflowFollowupError?: string | null
  workflowAutomation?: {rules:import('./workflow-automations.js').AutomationRule[];previews:import('./workflow-automations.js').AutomationPreview[]}
  workflowAutomaticPaused?:boolean
  workflowPausedProjects?:string[]
  workflowAutomationError?:string|null
  workflowError?: string | null
  /** Runtime window placement, never persisted as session configuration. */
  poppedOutTabIds?: string[]
  windowSessionId?: string
  desktopVersion: string
  resolution: CopilotResolution | null
  profiles: WorkspaceProfile[]
  activeProfileId: string | null
  tabs: DesktopSessionTab[]
  activeTabId: string | null
  sessionNavigation?: { back: boolean; forward: boolean }
  maxSessionTabs: number
  recentLogs: string[]
  error: string | null
  /** The new-session dialog's default: new sessions keep their own Local Overrides (Settings → Session browser). */
  newSessionPrivateOverrides?: boolean
  /** Review meetings between sessions, open ones and recently closed ones. Runtime-only. */
  meetings?: MeetingView[]
  /** Temporary PR reviewer groups attached to host fix-pr sessions. Runtime-only. */
  tempReviewerGroups?: TempReviewerGroupView[]
  /** Where outside agents reach the meeting tools over MCP; null when the port was taken. Runtime-only. */
  meetingToolsUrl?: string | null
  /** Desktop control is allowed in Settings on this platform. Runtime-only. */
  desktopControlAllowed?: boolean
  /** Sessions that started with desktop control's helper, so the person can turn it on for them. Runtime-only. */
  desktopControlReadyTabIds?: string[]
  /** Per session: whether desktop control is on, its approved apps and its recent actions. Runtime-only. */
  desktopControl?: Record<string, DesktopControlTabView>
}

/** Desktop event surfaced to the renderer/tray/notifications layer. */
export type DesktopEvent =
  | { type: 'approval-needed'; tabId: string }
  | { type: 'session-completed'; tabId: string }
  | { type: 'session-crashed'; tabId: string; message: string }

export interface PrPostView { id: string; grantId: string; state: 'intent' | 'uncertain'; kind: 'reply' | 'comment' | 'review' | 'approval'; target: number | null; createdAt: number }

/** An open pull request the new-PR queue may review. `reason`: why it cannot be reviewed here. */
export interface ReviewCandidate { number: number; title: string; author: string; url: string; reason: string | null
  /** When GitHub says the PR was opened (ms): the new-PR queue reviews only PRs opened after it was turned on. */
  createdAt: number }
