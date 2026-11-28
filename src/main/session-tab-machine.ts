import type { PermissionPreset } from './permission-presets.js'
import type { SessionPermissionMode } from './permission-modes.js'
import type { DesktopSessionTab, SessionLifecycleStatus, TempReviewerTabInfo } from './types.js'
import type { OtherCli } from './session-cli.js'
import type { PerCliConfig } from './agent-cli-settings.js'

import { DEFAULT_MAX_SESSION_TABS, MAX_TEMP_REVIEWER_TABS } from './session-tab-limit.js'

/** The default limit; the app passes the one set in Settings. */
export const MAX_SESSION_TABS = DEFAULT_MAX_SESSION_TABS
export { MAX_TEMP_REVIEWER_TABS } from './session-tab-limit.js'

export interface TabsState {
  tabs: DesktopSessionTab[]
  activeTabId: string | null
}

export const EMPTY_TABS_STATE: TabsState = { tabs: [], activeTabId: null }

export interface NewTabInput {
  id: string
  title: string
  cli?: OtherCli
  otherCliConfig?: PerCliConfig
  browserProfileId?: string
  workspaceProfileId: string
  cliVersion: string | null
  sessionPermissionPreset: PermissionPreset | null
  sessionPermissionMode?: SessionPermissionMode | null
  permissionWarning: string | null
  remote: boolean
  lastSessionId?: string | null
  lastActivityAt?: number
  sideChat?: true
  sideParentTabId?: string
  canFork?: boolean
  /** Nobody named the session: the title follows the name Copilot gives it. */
  autoTitle?: boolean
  /** A rename made in the desktop that Copilot has not confirmed yet. */
  renamePending?: boolean
  launchWorktree?: boolean
  launchWorktreePath?: string
  privateOverrides?: boolean
  tempReviewer?: TempReviewerTabInfo
  reviewer?: true
}

export function regularTabCount(state: Pick<TabsState, 'tabs'>): number {
  return state.tabs.filter((tab) => !tab.tempReviewer).length
}

export function tempReviewerTabCount(state: Pick<TabsState, 'tabs'>): number {
  return state.tabs.filter((tab) => Boolean(tab.tempReviewer)).length
}

export function createTab(state: TabsState, input: NewTabInput, maxTabs = MAX_SESSION_TABS): TabsState {
  return { tabs: [...state.tabs, newTab(state, input, 'starting', maxTabs)], activeTabId: input.id }
}

/**
 * Starts a hidden temporary PR reviewer tab in the background: never steals `activeTabId`, and uses a dedicated
 * temporary-reviewer cap so spawning reviewers does not consume the user's normal session tab slots.
 */
export function createBackgroundTab(state: TabsState, input: NewTabInput, maxTempTabs = MAX_TEMP_REVIEWER_TABS): TabsState {
  if (!input.tempReviewer) throw new Error('Background reviewer tabs require tempReviewer metadata')
  if (tempReviewerTabCount(state) >= maxTempTabs) {
    throw new Error(`No more than ${maxTempTabs} temporary reviewer sessions can run at once`)
  }
  return {
    tabs: [...state.tabs, newTab(state, input, 'starting', Number.POSITIVE_INFINITY)],
    activeTabId: state.activeTabId,
  }
}

/** A saved tab listed without starting its process; it takes focus only when nothing else has it. */
export function addDormantTab(state: TabsState, input: NewTabInput, maxTabs = MAX_SESSION_TABS): TabsState {
  return { tabs: [...state.tabs, newTab(state, input, 'dormant', maxTabs)], activeTabId: state.activeTabId ?? input.id }
}

function newTab(state: TabsState, input: NewTabInput, status: SessionLifecycleStatus, maxTabs: number): DesktopSessionTab {
  if (!input.tempReviewer && regularTabCount(state) >= maxTabs) {
    throw new Error(`No more than ${maxTabs} session tabs can be open`)
  }
  if (state.tabs.some((tab) => tab.id === input.id)) {
    throw new Error(`A session tab with id ${input.id} already exists`)
  }
  return {
    id: input.id,
    title: input.title,
    ...(input.cli ? { cli: input.cli } : {}),
    ...(input.otherCliConfig ? { otherCliConfig: input.otherCliConfig } : {}),
    ...(input.browserProfileId ? { browserProfileId: input.browserProfileId } : {}),
    workspaceProfileId: input.workspaceProfileId,
    lastSessionId: input.lastSessionId ?? null,
    status,
    processId: null,
    cliVersion: input.cliVersion,
    sessionPermissionPreset: input.sessionPermissionPreset,
    sessionPermissionMode: input.sessionPermissionMode ?? null,
    permissionWarning: input.permissionWarning,
    remote: input.remote,
    lastActivityAt: input.lastActivityAt ?? Date.now(),
    ...(input.sideChat ? { sideChat: true as const } : {}),
    ...(input.sideParentTabId ? { sideParentTabId: input.sideParentTabId } : {}),
    ...(input.canFork !== undefined ? { canFork: input.canFork } : {}),
    ...(input.launchWorktree !== undefined ? { launchWorktree: input.launchWorktree } : {}),
    ...(input.launchWorktreePath ? { launchWorktreePath: input.launchWorktreePath } : {}),
    ...(input.privateOverrides ? { privateOverrides: true as const } : {}),
    ...(input.autoTitle !== undefined ? { autoTitle: input.autoTitle } : {}),
    ...(input.renamePending ? { renamePending: true as const } : {}),
    ...(input.tempReviewer ? { tempReviewer: input.tempReviewer } : {}),
    ...(input.reviewer ? { reviewer: true as const } : {}),
  }
}

export function closeTab(state: TabsState, tabId: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId)
  if (index === -1) return state
  const closing = state.tabs[index]
  const tabs = state.tabs.filter((tab) => tab.id !== tabId).map((tab) => {
    if (tab.sideParentTabId !== tabId) return tab
    const { sideParentTabId: _parent, ...detached } = tab
    return detached
  })
  let activeTabId = state.activeTabId
  if (activeTabId === tabId) {
    // Keep the surviving pane of a split in view. Closing a directly-focused temp reviewer returns to its host tab;
    // closing any tab never falls back to focusing a hidden tempReviewer tab.
    const hostId = closing?.tempReviewer?.hostTabId
    const parentId = closing?.sideParentTabId
    const childId = state.tabs.find((tab) => tab.sideParentTabId === tabId && !tab.tempReviewer)?.id
    const regularAfter = tabs.slice(index).find((tab) => !tab.tempReviewer)?.id
    const regularBefore = [...tabs.slice(0, index)].reverse().find((tab) => !tab.tempReviewer)?.id
    activeTabId = (hostId && tabs.some((tab) => tab.id === hostId && !tab.tempReviewer) ? hostId : null)
      ?? (parentId && tabs.some((tab) => tab.id === parentId && !tab.tempReviewer) ? parentId : null)
      ?? childId ?? regularAfter ?? regularBefore ?? null
  }
  return { tabs, activeTabId }
}

export function activateTab(state: TabsState, tabId: string): TabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) {
    throw new Error(`Session tab ${tabId} does not exist`)
  }
  return {
    ...state,
    activeTabId: tabId,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, lastActivityAt: Date.now() } : tab)),
  }
}

export function setTabStatus(state: TabsState, tabId: string, status: SessionLifecycleStatus): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, status, lastActivityAt: Date.now() } : tab)),
  }
}

export function setTabProcessId(state: TabsState, tabId: string, processId: number | null): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, processId } : tab)),
  }
}

export function setTabSessionId(state: TabsState, tabId: string, lastSessionId: string | null): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, lastSessionId, lastActivityAt: Date.now() } : tab)),
  }
}

/** Refreshes process metadata after a restart while preserving session-owned settings. */
export function setTabLaunchConfig(
  state: TabsState,
  tabId: string,
  config: {
    cliVersion: string | null
    sessionPermissionPreset: PermissionPreset | null
    sessionPermissionMode: SessionPermissionMode | null
    permissionWarning: string | null
    canFork?: boolean
  },
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...config } : tab)),
  }
}

export function setTabPermissionMode(
  state: TabsState,
  tabId: string,
  sessionPermissionMode: SessionPermissionMode,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (
      tab.id === tabId ? { ...tab, sessionPermissionMode, lastActivityAt: Date.now() } : tab
    )),
  }
}

/** Someone named the tab: from now on the session's Copilot name follows the tab, not the other way round. */
export function renameTab(state: TabsState, tabId: string, title: string): TabsState {
  const normalized = title.trim().slice(0, 120) || 'Copilot'
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: normalized, autoTitle: false, renamePending: true, lastActivityAt: Date.now() } : tab)),
  }
}

/** Copilot reports the name the tab was given: nothing more to send. */
export function confirmTabRename(state: TabsState, tabId: string): TabsState {
  return { ...state, tabs: state.tabs.map((tab) => {
    if (tab.id !== tabId || !tab.renamePending) return tab
    const { renamePending: _done, ...rest } = tab
    return rest
  }) }
}

/** Copilot named an unnamed session: the tab shows that name and keeps following it. Nobody did anything, so the tab's
 * place in the activity order stays. */
export function adoptCopilotTitle(state: TabsState, tabId: string, title: string): TabsState {
  const normalized = title.trim().slice(0, 120)
  if (!normalized) return state
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === tabId && tab.autoTitle ? { ...tab, title: normalized } : tab)) }
}

export function touchTab(state: TabsState, tabId: string, at = Date.now()): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, lastActivityAt: at } : tab)),
  }
}

export function tabsForWorkspace(state: TabsState, workspaceProfileId: string): DesktopSessionTab[] {
  return state.tabs.filter((tab) => tab.workspaceProfileId === workspaceProfileId)
}

/**
 * The project the window shows: the active session's own project, so the Git panel, worktree following and new sessions
 * match the session on screen. With no active session the current project stays.
 */
export function activeWorkspaceFor(state: TabsState, current: string | null): string | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId)?.workspaceProfileId ?? current
}

export function canOpenAnotherTab(state: TabsState, maxTabs = MAX_SESSION_TABS): boolean {
  return regularTabCount(state) < maxTabs
}

export function fanOutAvailableSlots(state: Pick<TabsState, 'tabs'>, maxTabs = MAX_SESSION_TABS): number {
  return Math.max(0, maxTabs - regularTabCount(state))
}

function belongsToHostTab(candidate: DesktopSessionTab, host: DesktopSessionTab): boolean {
  if (!candidate.tempReviewer) return false
  return candidate.tempReviewer.hostTabId === host.id
    || (candidate.tempReviewer.hostTabId === null && candidate.workspaceProfileId === host.workspaceProfileId)
}

function findHostForReviewer(
  state: TabsState,
  reviewerTab: DesktopSessionTab,
  peekByHost?: Readonly<Record<string, string | null>>,
): DesktopSessionTab | null {
  if (!reviewerTab.tempReviewer) return null
  if (reviewerTab.tempReviewer.hostTabId !== null) {
    return state.tabs.find((tab) => tab.id === reviewerTab.tempReviewer!.hostTabId && !tab.tempReviewer) ?? null
  }
  if (peekByHost) {
    const peekingHost = state.tabs.find((tab) => (
      !tab.tempReviewer
      && !tab.sideChat
      && tab.workspaceProfileId === reviewerTab.workspaceProfileId
      && peekByHost[tab.id] === reviewerTab.id
    ))
    if (peekingHost) return peekingHost
  }
  return state.tabs.find((tab) => !tab.tempReviewer && !tab.sideChat && tab.workspaceProfileId === reviewerTab.workspaceProfileId) ?? null
}

/**
 * Resolves the peek state key, host tab ID (when a regular tab exists), and active peek reviewer tab ID regardless of
 * whether focus is on the host tab, its side chat, the peeked reviewer terminal itself, or a workspace with no regular
 * tab open (`profile:<profileId>`). When `activeProfileId` is given, an `activeTabId` belonging to another workspace is
 * treated as absent in `activeProfileId`.
 */
export function resolvePeekHostAndTab(
  state: TabsState,
  peekByHost: Readonly<Record<string, string | null>>,
  activeProfileId: string | null = null,
): { peekKey: string | null; hostTabId: string | null; peekTabId: string | null } {
  const rawActive = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
  const active = rawActive && (!activeProfileId || rawActive.workspaceProfileId === activeProfileId) ? rawActive : null
  const hostTabId = active?.tempReviewer
    ? findHostForReviewer(state, active, peekByHost)?.id ?? null
    : active?.sideParentTabId ?? active?.id ?? null
  const hostTab = hostTabId
    ? state.tabs.find((tab) => tab.id === hostTabId && !tab.tempReviewer && (!activeProfileId || tab.workspaceProfileId === activeProfileId)) ?? null
    : null
  if (hostTab) {
    const peekKey = hostTab.id
    const candidate = peekByHost[peekKey] ?? null
    const peekTabId = candidate && state.tabs.some((tab) => tab.id === candidate && belongsToHostTab(tab, hostTab))
      ? candidate
      : null
    return { peekKey, hostTabId: hostTab.id, peekTabId }
  }
  const profileId = activeProfileId ?? active?.workspaceProfileId ?? null
  if (!profileId) return { peekKey: null, hostTabId: null, peekTabId: null }
  const peekKey = `profile:${profileId}`
  const candidate = peekByHost[peekKey] ?? null
  const peekTabId = candidate && state.tabs.some((tab) => (
    tab.id === candidate
    && Boolean(tab.tempReviewer)
    && tab.tempReviewer!.hostTabId === null
    && tab.workspaceProfileId === profileId
  ))
    ? candidate
    : null
  return { peekKey, hostTabId: null, peekTabId }
}

/**
 * `activeTabId` is keyboard focus; a linked pair stays visible for either focus. When `peekTabId` names a live
 * temporary reviewer belonging to `main`, it temporarily occupies the right split pane without mutating `sideParentTabId`,
 * so closing the peek restores any existing `sideChat`. When no regular host tab is open in the workspace, `peekTabId`
 * displays the peeked profile-scoped reviewer as `main` and hides it cleanly when cleared. When `activeProfileId` is
 * given, an `activeTabId` belonging to another workspace is treated as absent in `activeProfileId`.
 */
export function visibleSessionTabs(
  state: TabsState,
  peekTabId: string | null = null,
  activeProfileId: string | null = null,
): { main: DesktopSessionTab | null; side: DesktopSessionTab | null } {
  const rawActive = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
  const active = rawActive && (!activeProfileId || rawActive.workspaceProfileId === activeProfileId) ? rawActive : null
  const findStandalone = (): DesktopSessionTab | null => (
    peekTabId
      ? state.tabs.find((tab) => (
        tab.id === peekTabId
        && Boolean(tab.tempReviewer)
        && (!activeProfileId || tab.workspaceProfileId === activeProfileId)
      )) ?? null
      : null
  )
  if (active?.tempReviewer) {
    const host = findHostForReviewer(state, active)
    if (!host) {
      return { main: findStandalone(), side: null }
    }
    const peek = peekTabId
      ? state.tabs.find((tab) => tab.id === peekTabId && belongsToHostTab(tab, host)) ?? null
      : null
    if (peek) return { main: host, side: peek }
    return { main: host, side: state.tabs.find((tab) => tab.sideParentTabId === host.id) ?? null }
  }
  const main = state.tabs.find((tab) => tab.id === active?.sideParentTabId) ?? active
  if (!main) {
    return { main: findStandalone(), side: null }
  }
  const peek = peekTabId
    ? state.tabs.find((tab) => tab.id === peekTabId && belongsToHostTab(tab, main)) ?? null
    : null
  const side = peek ?? (state.tabs.find((tab) => tab.sideParentTabId === main.id) ?? null)
  return { main, side }
}
