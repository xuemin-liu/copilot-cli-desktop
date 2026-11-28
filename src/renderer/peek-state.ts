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
    ? (input.visibleMain && !input.visibleMain.tempReviewer && input.visibleMain.workspaceProfileId === input.projectProfileId ? input.visibleMain : undefined)
    : activeSession
  if (!candidate || candidate.tempReviewer) return undefined
  if (['dormant', 'completed', 'crashed'].includes(candidate.status)) return undefined
  if ((input.poppedOutTabIds ?? []).includes(candidate.id)) return undefined
  return candidate
}
