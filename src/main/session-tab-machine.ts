import type { PermissionPreset } from './permission-presets.js'
import type { SessionPermissionMode } from './permission-modes.js'
import type { DesktopSessionTab, SessionLifecycleStatus, TempReviewerTabInfo } from './types.js'
import type { OtherCli } from './session-cli.js'
import type { PerCliConfig } from './agent-cli-settings.js'

import { DEFAULT_MAX_SESSION_TABS } from './session-tab-limit.js'

/** The default limit; the app passes the one set in Settings. */
export const MAX_SESSION_TABS = DEFAULT_MAX_SESSION_TABS
/** Maximum concurrent hidden temporary PR reviewer tabs across active review runs. */
export const MAX_TEMP_REVIEWER_TABS = 3

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
}

export function regularTabCount(state: Pick<TabsState, 'tabs'>): number {
  return state.tabs.filter((tab) => !tab.tempReviewer).length
}

function tempReviewerTabCount(state: TabsState): number {
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

/**
 * Resolves the host tab ID and active peek reviewer tab ID regardless of whether focus is currently on the host tab,
 * its side chat, or the peeked reviewer terminal itself.
 */
export function resolvePeekHostAndTab(
  state: TabsState,
  peekByHost: Readonly<Record<string, string | null>>,
): { hostTabId: string | null; peekTabId: string | null } {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
  const hostTabId = active?.tempReviewer?.hostTabId ?? active?.sideParentTabId ?? state.activeTabId
  const candidate = hostTabId ? peekByHost[hostTabId] ?? null : null
  const peekTabId = hostTabId && candidate && state.tabs.some((tab) => tab.id === candidate && tab.tempReviewer?.hostTabId === hostTabId)
    ? candidate
    : null
  return { hostTabId, peekTabId }
}

/**
 * `activeTabId` is keyboard focus; a linked pair stays visible for either focus. When `peekTabId` names a live
 * temporary reviewer belonging to `main`, it temporarily occupies the right split pane without mutating `sideParentTabId`,
 * so closing the peek restores any existing `sideChat`.
 */
export function visibleSessionTabs(
  state: TabsState,
  peekTabId: string | null = null,
): { main: DesktopSessionTab | null; side: DesktopSessionTab | null } {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
  if (active?.tempReviewer) {
    const host = state.tabs.find((tab) => tab.id === active.tempReviewer!.hostTabId) ?? null
    const peek = host && peekTabId
      ? state.tabs.find((tab) => tab.id === peekTabId && tab.tempReviewer?.hostTabId === host.id) ?? null
      : null
    if (host && peek) return { main: host, side: peek }
    return { main: active, side: null }
  }
  const main = state.tabs.find((tab) => tab.id === active?.sideParentTabId) ?? active
  const peek = main && peekTabId
    ? state.tabs.find((tab) => tab.id === peekTabId && tab.tempReviewer?.hostTabId === main.id) ?? null
    : null
  const side = peek ?? (main ? state.tabs.find((tab) => tab.sideParentTabId === main.id) ?? null : null)
  return { main, side }
}
