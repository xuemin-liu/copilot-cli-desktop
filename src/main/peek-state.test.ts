import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeWorkspaceRegularTab,
  applyPeekReviewerRequest,
  clearPeekForActivatedTab,
  resolveCloseShortcutAction,
  resolveCompactVisibleTabId,
  resolveToolPanelPromptTarget,
} from '../renderer/peek-state.js'
import { closeTab, resolvePeekHostAndTab, visibleSessionTabs } from './session-tab-machine.js'
import { terminalLayout } from '../renderer/tool-dock-state.js'
import type { DesktopSessionTab } from './types.js'

function makeTab(id: string, workspaceProfileId: string, extra: Partial<DesktopSessionTab> = {}): DesktopSessionTab {
  return {
    id,
    title: id,
    workspaceProfileId,
    lastSessionId: null,
    status: 'running',
    processId: 100,
    cliVersion: '1.0.114',
    sessionPermissionPreset: 'default',
    sessionPermissionMode: null,
    permissionWarning: null,
    remote: false,
    lastActivityAt: 1000,
    ...extra,
  }
}

test('activeWorkspaceRegularTab ignores tempReviewer and foreign-workspace activeTabId', () => {
  const hostWs1 = makeTab('tab-ws1', 'ws-1')
  const revWs2 = makeTab('rev-ws2', 'ws-2', {
    tempReviewer: { groupId: 'g1', hostTabId: null, seatId: 's1', cli: 'claude', repository: 'o/r', prLabel: 'Meeting M1', prNumber: null, prUrl: null, meetingId: 'M1' },
  })
  assert.equal(activeWorkspaceRegularTab([hostWs1, revWs2], 'tab-ws1', 'ws-1')?.id, 'tab-ws1')
  assert.equal(activeWorkspaceRegularTab([hostWs1, revWs2], 'tab-ws1', 'ws-2'), null, 'retained foreign activeTabId is ignored in ws-2')
  assert.equal(activeWorkspaceRegularTab([hostWs1, revWs2], 'rev-ws2', 'ws-2'), null, 'tempReviewer is never a closeable regular tab')
})

test('resolveCloseShortcutAction hides focused peek (hosted or standalone) and never closes a retained foreign tab', () => {
  assert.deepEqual(
    resolveCloseShortcutAction({ activeWorkspaceTabId: 'tab-1', effectiveFocusedPeekTabId: 'rev-1' }),
    { kind: 'hide-peek', tabId: 'rev-1' },
  )
  assert.deepEqual(
    resolveCloseShortcutAction({ activeWorkspaceTabId: null, effectiveFocusedPeekTabId: 'rev-standalone' }),
    { kind: 'hide-peek', tabId: 'rev-standalone' },
  )
  assert.deepEqual(
    resolveCloseShortcutAction({ activeWorkspaceTabId: null, effectiveFocusedPeekTabId: null }),
    { kind: 'none' },
  )
  assert.deepEqual(
    resolveCloseShortcutAction({ activeWorkspaceTabId: 'tab-1', effectiveFocusedPeekTabId: null }),
    { kind: 'close-tab', tabId: 'tab-1' },
  )
})

test('resolveToolPanelPromptTarget preserves sideChat targeting, excludes tempReviewer, and checks live/popped-out state', () => {
  const host = makeTab('tab-host', 'ws-1')
  const side = makeTab('tab-side', 'ws-1', { sideChat: true, sideParentTabId: 'tab-host' })
  const revHosted = makeTab('tab-rev', 'ws-1', {
    cli: 'claude',
    tempReviewer: { groupId: 'g1', hostTabId: 'tab-host', seatId: 's1', cli: 'claude', repository: 'o/r', prLabel: 'PR #1', prNumber: 1, prUrl: null },
  })
  const revStandalone = makeTab('tab-solo', 'ws-2', {
    cli: 'codex',
    tempReviewer: { groupId: 'g2', hostTabId: null, seatId: 's2', cli: 'codex', repository: 'o/r', prLabel: 'PR #2', prNumber: 2, prUrl: null },
  })

  // Side chat focused -> targets side chat (preserving sideChat prompt insertion and blocker behavior):
  assert.equal(
    resolveToolPanelPromptTarget({ projectProfileId: 'ws-1', activeProfileId: 'ws-1', activeTabId: 'tab-side', sessions: [host, side, revHosted], visibleMain: host })?.id,
    'tab-side',
  )
  // Host active while peeking reviewer -> targets host:
  assert.equal(
    resolveToolPanelPromptTarget({ projectProfileId: 'ws-1', activeProfileId: 'ws-1', activeTabId: 'tab-host', sessions: [host, side, revHosted], visibleMain: host })?.id,
    'tab-host',
  )
  // Even if activeTabId were a tempReviewer, falls back to visible host (never targets reviewer):
  assert.equal(
    resolveToolPanelPromptTarget({ projectProfileId: 'ws-1', activeProfileId: 'ws-1', activeTabId: 'tab-rev', sessions: [host, side, revHosted], visibleMain: host })?.id,
    'tab-host',
  )
  // Standalone tempReviewer yields no prompt target:
  assert.equal(
    resolveToolPanelPromptTarget({ projectProfileId: 'ws-2', activeProfileId: 'ws-2', activeTabId: 'tab-solo', sessions: [revStandalone], visibleMain: revStandalone }),
    undefined,
  )
  assert.equal(
    resolveToolPanelPromptTarget({ projectProfileId: 'ws-2', activeProfileId: 'ws-2', activeTabId: null, sessions: [revStandalone], visibleMain: revStandalone }),
    undefined,
  )
  // Popped-out or non-live host still yields undefined:
  assert.equal(
    resolveToolPanelPromptTarget({ projectProfileId: 'ws-1', activeProfileId: 'ws-1', activeTabId: 'tab-host', sessions: [host], visibleMain: host, poppedOutTabIds: ['tab-host'] }),
    undefined,
  )
  const dormantHost = makeTab('tab-host', 'ws-1', { status: 'dormant' })
  assert.equal(
    resolveToolPanelPromptTarget({ projectProfileId: 'ws-1', activeProfileId: 'ws-1', activeTabId: 'tab-host', sessions: [dormantHost], visibleMain: dormantHost }),
    undefined,
  )
})

test('reselecting a side chat during a reviewer peek clears the host peek so compact layout shows the side chat and closes it', () => {
  const host = makeTab('tab-host', 'ws-1')
  const side = makeTab('tab-side', 'ws-1', { sideChat: true, sideParentTabId: 'tab-host' })
  const reviewer = makeTab('tab-rev', 'ws-1', {
    cli: 'claude',
    tempReviewer: { groupId: 'g1', hostTabId: 'tab-host', seatId: 's1', cli: 'claude', repository: 'o/r', prLabel: 'PR #1', prNumber: 1, prUrl: null },
  })
  const tabs = [host, side, reviewer]
  const compact = terminalLayout(760, true, 55)
  assert.equal(compact.single, true, '760px uses compact single-pane layout')

  // While side chat is active and reviewer is peeked + focused, compact view shows reviewer and Ctrl+W hides the peek:
  const peekedByHost: Readonly<Record<string, string | null>> = { 'tab-host': 'tab-rev' }
  const before = resolvePeekHostAndTab({ tabs, activeTabId: 'tab-side' }, peekedByHost, 'ws-1')
  assert.equal(before.peekTabId, 'tab-rev')
  const beforeVisible = visibleSessionTabs({ tabs, activeTabId: 'tab-side' }, before.peekTabId, 'ws-1')
  assert.equal(
    resolveCompactVisibleTabId({ main: beforeVisible.main, side: beforeVisible.side, focusedTabId: 'tab-rev', single: compact.single }),
    'tab-rev',
  )
  assert.deepEqual(
    resolveCloseShortcutAction({ activeWorkspaceTabId: 'tab-side', effectiveFocusedPeekTabId: 'tab-rev' }),
    { kind: 'hide-peek', tabId: 'tab-rev' },
  )

  // Reselecting the side chat clears its host's peek so Side becomes the visible pane at 760px and Ctrl+W targets Side:
  const afterSideSelect = clearPeekForActivatedTab(peekedByHost, tabs, 'tab-side')
  const resolvedAfterSide = resolvePeekHostAndTab({ tabs, activeTabId: 'tab-side' }, afterSideSelect, 'ws-1')
  assert.equal(resolvedAfterSide.peekTabId, null)
  const visibleAfterSide = visibleSessionTabs({ tabs, activeTabId: 'tab-side' }, resolvedAfterSide.peekTabId, 'ws-1')
  assert.equal(visibleAfterSide.main?.id, 'tab-host')
  assert.equal(visibleAfterSide.side?.id, 'tab-side')
  assert.equal(
    resolveCompactVisibleTabId({ main: visibleAfterSide.main, side: visibleAfterSide.side, focusedTabId: 'tab-side', single: compact.single }),
    'tab-side',
    'compact single-pane view displays the reselected side chat instead of falling back to host',
  )
  assert.deepEqual(
    resolveCloseShortcutAction({ activeWorkspaceTabId: 'tab-side', effectiveFocusedPeekTabId: null }),
    { kind: 'close-tab', tabId: 'tab-side' },
    'Ctrl+W closes the visible side chat',
  )

  // Selecting the host itself preserves the host's peek entry:
  assert.equal(clearPeekForActivatedTab(peekedByHost, tabs, 'tab-host')['tab-host'], 'tab-rev')
})

test('carrying a standalone reviewer peek to a restored host clears the profile key so Hide + close host stays hidden', () => {
  const reviewer = makeTab('tab-rev', 'ws-1', {
    cli: 'claude',
    tempReviewer: { groupId: 'g1', hostTabId: null, seatId: 's1', cli: 'claude', repository: 'o/r', prLabel: 'PR #1', prNumber: 1, prUrl: null },
  })
  const restoredHost = makeTab('tab-host', 'ws-1')

  // 1. Standalone peek is opened under profile:ws-1 before the saved host restores:
  let peekByHost = applyPeekReviewerRequest({}, [reviewer], { tabId: 'tab-rev', peekKey: 'profile:ws-1' }, 'ws-1')
  assert.equal(resolvePeekHostAndTab({ tabs: [reviewer], activeTabId: null }, peekByHost, 'ws-1').peekTabId, 'tab-rev')

  // 2. Saved host restores and main re-anchors the peek to tab-host in the same state update (clearing profile:ws-1):
  peekByHost = applyPeekReviewerRequest(peekByHost, [reviewer, restoredHost], { tabId: 'tab-rev', peekKey: 'tab-host' }, 'ws-1')
  assert.equal(peekByHost['profile:ws-1'], null, 'stale profile key is cleared when moving peek to host key')
  assert.equal(resolvePeekHostAndTab({ tabs: [reviewer, restoredHost], activeTabId: 'tab-host' }, peekByHost, 'ws-1').peekTabId, 'tab-rev')

  // 3. User clicks Hide (clears tab-host) and then closes the restored host tab:
  peekByHost = { ...peekByHost, 'tab-host': null }
  const afterClose = closeTab({ tabs: [reviewer, restoredHost], activeTabId: 'tab-host' }, 'tab-host')
  const resolvedAfterClose = resolvePeekHostAndTab(afterClose, peekByHost, 'ws-1')
  assert.equal(resolvedAfterClose.peekKey, 'profile:ws-1')
  assert.equal(resolvedAfterClose.peekTabId, null, 'hidden reviewer does not reappear as a standalone pane after host closes')
  assert.deepEqual(visibleSessionTabs(afterClose, resolvedAfterClose.peekTabId, 'ws-1'), { main: null, side: null })
})
