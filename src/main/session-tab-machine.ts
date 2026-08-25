import type { PermissionPreset } from './permission-presets.js'
import type { DesktopSessionTab, SessionLifecycleStatus } from './types.js'

export const MAX_SESSION_TABS = 20

export interface TabsState {
  tabs: DesktopSessionTab[]
  activeTabId: string | null
}

export const EMPTY_TABS_STATE: TabsState = { tabs: [], activeTabId: null }

export interface NewTabInput {
  id: string
  title: string
  workspaceProfileId: string
  permissionPreset?: PermissionPreset
  lastSessionId?: string | null
  lastActivityAt?: number
}

export function createTab(state: TabsState, input: NewTabInput): TabsState {
  if (state.tabs.length >= MAX_SESSION_TABS) {
    throw new Error(`No more than ${MAX_SESSION_TABS} session tabs can be open`)
  }
  if (state.tabs.some((tab) => tab.id === input.id)) {
    throw new Error(`A session tab with id ${input.id} already exists`)
  }
  const tab: DesktopSessionTab = {
    id: input.id,
    title: input.title,
    workspaceProfileId: input.workspaceProfileId,
    lastSessionId: input.lastSessionId ?? null,
    status: 'starting',
    processId: null,
    permissionPreset: input.permissionPreset ?? 'default',
    lastActivityAt: input.lastActivityAt ?? Date.now(),
  }
  return { tabs: [...state.tabs, tab], activeTabId: input.id }
}

export function closeTab(state: TabsState, tabId: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId)
  if (index === -1) return state
  const tabs = state.tabs.filter((tab) => tab.id !== tabId)
  let activeTabId = state.activeTabId
  if (activeTabId === tabId) {
    // Prefer the tab that slid into the closed tab's position (the "next"
    // tab); fall back to the one before it; otherwise no tab is active.
    activeTabId = tabs[index]?.id ?? tabs[index - 1]?.id ?? null
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

export function renameTab(state: TabsState, tabId: string, title: string): TabsState {
  const normalized = title.trim().slice(0, 120) || 'Copilot'
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: normalized, lastActivityAt: Date.now() } : tab)),
  }
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

export function canOpenAnotherTab(state: TabsState): boolean {
  return state.tabs.length < MAX_SESSION_TABS
}
