import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeWorkspaceRegularTab,
  resolveCloseShortcutAction,
  resolveToolPanelPromptTarget,
} from '../renderer/peek-state.js'
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
