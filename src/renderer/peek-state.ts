import type { DesktopSessionTab } from '../main/types.js'

/**
 * The active regular (non-tempReviewer) tab belonging to the selected workspace. A retained `activeTabId` from another
 * workspace is ignored so close shortcuts never terminate an invisible session in a different workspace.
 */
export function activeWorkspaceRegularTab(
  tabs: readonly DesktopSessionTab[],
  activeTabId: string | null,
  activeProfileId: string | null,
): DesktopSessionTab | null {
  if (!activeTabId || !activeProfileId) return null
  const tab = tabs.find((candidate) => candidate.id === activeTabId)
  if (!tab || tab.tempReviewer || tab.workspaceProfileId !== activeProfileId) return null
  return tab
}

export type CloseShortcutAction =
  | { kind: 'hide-peek'; tabId: string }
  | { kind: 'close-tab'; tabId: string }
  | { kind: 'none' }

export function resolveCloseShortcutAction(input: {
  activeWorkspaceTabId: string | null
  effectiveFocusedPeekTabId: string | null
}): CloseShortcutAction {
  if (input.effectiveFocusedPeekTabId) return { kind: 'hide-peek', tabId: input.effectiveFocusedPeekTabId }
  if (input.activeWorkspaceTabId) return { kind: 'close-tab', tabId: input.activeWorkspaceTabId }
  return { kind: 'none' }
}

/**
 * Clears any host-anchored reviewer peek that would otherwise keep an explicitly activated side chat hidden behind
 * the peek pane (in both split and compact layouts).
 */
export function clearPeekForActivatedTab(
  peekByHost: Readonly<Record<string, string | null>>,
  tabs: readonly DesktopSessionTab[],
  tabId: string,
): Readonly<Record<string, string | null>> {
  const tab = tabs.find((candidate) => candidate.id === tabId)
  if (!tab?.sideChat || !tab.sideParentTabId) return peekByHost
  if (!peekByHost[tab.sideParentTabId]) return peekByHost
  return { ...peekByHost, [tab.sideParentTabId]: null }
}

/**
 * Applies a main-process peek request (`{ tabId, peekKey }`). When anchoring a reviewer onto a host tab (rather than
 * `profile:<id>`), clears any stale `profile:<workspaceProfileId>` entry in the same update so hiding the reviewer and
 * later closing the host does not resurrect the old standalone peek.
 */
export function applyPeekReviewerRequest(
  peekByHost: Readonly<Record<string, string | null>>,
  tabs: readonly DesktopSessionTab[],
  request: { tabId: string; peekKey: string },
  activeProfileId: string | null = null,
): Readonly<Record<string, string | null>> {
  const next: Record<string, string | null> = { ...peekByHost, [request.peekKey]: request.tabId }
  if (!request.peekKey.startsWith('profile:')) {
    const workspaceProfileId = tabs.find((candidate) => candidate.id === request.tabId)?.workspaceProfileId ?? activeProfileId
    if (workspaceProfileId) {
      const profileKey = `profile:${workspaceProfileId}`
      if (profileKey in next) next[profileKey] = null
    }
  }
  return next
}

/**
 * Resolves which terminal is visible in SessionWorkspace's single-pane compact layout.
 */
export function resolveCompactVisibleTabId(input: {
  main: DesktopSessionTab | null
  side: DesktopSessionTab | null
  focusedTabId: string | null
  single: boolean
}): string | null {
  if (!input.side || !input.single) return null
  return input.focusedTabId === input.side.id ? input.side.id : input.main?.id ?? null
}

/**
 * Resolves which session tab in a project workspace receives "Add to prompt" / Git resolve actions from the tools
 * panel. Preserves regular tabs and focused side chats, excludes temporary reviewers (falling back to the non-reviewer
 * visible host when activeTabId were ever a tempReviewer), and respects live / not-popped-out eligibility checks.
 */
export function resolveToolPanelPromptTarget(input: {
  projectProfileId: string
  activeProfileId: string | null
  activeTabId: string | null
  sessions: readonly DesktopSessionTab[]
  visibleMain: DesktopSessionTab | null
  poppedOutTabIds?: readonly string[] | undefined
}): DesktopSessionTab | undefined {
  if (input.activeProfileId !== input.projectProfileId) return undefined
  const activeSession = input.sessions.find((tab) => tab.id === input.activeTabId)
  const candidate = activeSession?.tempReviewer
    ? (input.visibleMain && !input.visibleMain.tempReviewer && !input.visibleMain.reviewer && input.visibleMain.workspaceProfileId === input.projectProfileId ? input.visibleMain : undefined)
    : activeSession
  if (!candidate || candidate.tempReviewer || candidate.reviewer) return undefined
  if (['dormant', 'completed', 'crashed'].includes(candidate.status)) return undefined
  if ((input.poppedOutTabIds ?? []).includes(candidate.id)) return undefined
  return candidate
}
