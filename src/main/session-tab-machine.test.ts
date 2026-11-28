import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_TABS_STATE,
  MAX_SESSION_TABS,
  activateTab,
  activeWorkspaceFor,
  addDormantTab,
  canOpenAnotherTab,
  closeTab,
  createBackgroundTab,
  createTab as createTabState,
  fanOutAvailableSlots,
  renameTab,
  resolvePeekHostAndTab,
  setTabLaunchConfig,
  setTabProcessId,
  setTabSessionId,
  setTabStatus,
  tabsForWorkspace,
  visibleSessionTabs,
  type NewTabInput,
  type TabsState,
} from './session-tab-machine.js'

function createTab(
  state: TabsState,
  input: Omit<NewTabInput, 'cliVersion' | 'sessionPermissionPreset' | 'permissionWarning' | 'remote'>,
  maxTabs?: number,
): TabsState {
  return createTabState(state, {
    ...input,
    cliVersion: '1.0.80',
    sessionPermissionPreset: 'default',
    sessionPermissionMode: null,
    permissionWarning: null,
    remote: false,
  }, maxTabs)
}

test('createTab adds a starting tab and makes it active', () => {
  const state = createTab(EMPTY_TABS_STATE, { id: 'tab-1', title: 'Copilot', workspaceProfileId: 'ws-1', lastActivityAt: 123 })
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeTabId, 'tab-1')
  assert.deepEqual(state.tabs[0], {
    id: 'tab-1',
    title: 'Copilot',
    workspaceProfileId: 'ws-1',
    lastSessionId: null,
    status: 'starting',
    processId: null,
    cliVersion: '1.0.80',
    sessionPermissionPreset: 'default',
    sessionPermissionMode: null,
    permissionWarning: null,
    remote: false,
    lastActivityAt: 123,
  })
})

test('addDormantTab lists a saved tab without starting it, and takes focus only when nothing has it', () => {
  const saved = { cliVersion: null, sessionPermissionPreset: 'default' as const, permissionWarning: null, remote: false }
  let state = addDormantTab(EMPTY_TABS_STATE, { ...saved, id: 'tab-1', title: 'First', workspaceProfileId: 'ws-1', lastSessionId: 'session-1' })
  assert.equal(state.activeTabId, 'tab-1')
  state = addDormantTab(state, { ...saved, id: 'tab-2', title: 'Second', workspaceProfileId: 'ws-2' })
  assert.equal(state.activeTabId, 'tab-1')
  assert.deepEqual(state.tabs.map((tab) => [tab.id, tab.status, tab.processId, tab.lastSessionId]), [
    ['tab-1', 'dormant', null, 'session-1'],
    ['tab-2', 'dormant', null, null],
  ])
  // A started session still takes focus from a dormant one.
  state = createTab(state, { id: 'tab-3', title: 'New', workspaceProfileId: 'ws-1' })
  assert.equal(state.activeTabId, 'tab-3')
})

test('addDormantTab counts toward MAX_SESSION_TABS', () => {
  let state = EMPTY_TABS_STATE
  for (let index = 0; index < MAX_SESSION_TABS; index++) {
    state = addDormantTab(state, { id: `tab-${index}`, title: 'Saved', workspaceProfileId: 'ws-1', cliVersion: null, sessionPermissionPreset: 'default', permissionWarning: null, remote: false })
  }
  assert.throws(() => createTab(state, { id: 'tab-extra', title: 'New', workspaceProfileId: 'ws-1' }), /No more than/)
})

test('createTab rejects a duplicate id', () => {
  const state = createTab(EMPTY_TABS_STATE, { id: 'tab-1', title: 'Copilot', workspaceProfileId: 'ws-1' })
  assert.throws(() => createTab(state, { id: 'tab-1', title: 'Copilot', workspaceProfileId: 'ws-1' }))
})

test('createTab enforces MAX_SESSION_TABS', () => {
  let state: TabsState = EMPTY_TABS_STATE
  for (let index = 0; index < MAX_SESSION_TABS; index += 1) {
    state = createTab(state, { id: `tab-${index}`, title: 'Copilot', workspaceProfileId: 'ws-1' })
  }
  assert.equal(canOpenAnotherTab(state), false)
  assert.throws(() => createTab(state, { id: 'tab-overflow', title: 'Copilot', workspaceProfileId: 'ws-1' }))
})

test('createTab and addDormantTab follow the limit they are given', () => {
  let state: TabsState = EMPTY_TABS_STATE
  for (let index = 0; index < 3; index += 1) state = createTab(state, { id: `tab-${index}`, title: 'Copilot', workspaceProfileId: 'ws-1' }, 3)
  assert.equal(canOpenAnotherTab(state, 3), false)
  assert.equal(canOpenAnotherTab(state, 4), true)
  assert.throws(() => createTab(state, { id: 'tab-x', title: 'Copilot', workspaceProfileId: 'ws-1' }, 3), /No more than 3/)
  assert.throws(() => addDormantTab(state, { id: 'tab-y', title: 'Saved', workspaceProfileId: 'ws-1', cliVersion: null, sessionPermissionPreset: 'default', permissionWarning: null, remote: false }, 3), /No more than 3/)
  assert.ok(createTab(state, { id: 'tab-z', title: 'Copilot', workspaceProfileId: 'ws-1' }, 25))
})

test('closeTab activates the tab that slid into the closed position', () => {
  let state: TabsState = EMPTY_TABS_STATE
  state = createTab(state, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'b', title: 'B', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'c', title: 'C', workspaceProfileId: 'ws-1' })
  state = activateTab(state, 'b')
  state = closeTab(state, 'b')
  assert.deepEqual(state.tabs.map((tab) => tab.id), ['a', 'c'])
  assert.equal(state.activeTabId, 'c')
})

test('closeTab falls back to the previous tab when closing the last tab', () => {
  let state: TabsState = EMPTY_TABS_STATE
  state = createTab(state, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'b', title: 'B', workspaceProfileId: 'ws-1' })
  state = closeTab(state, 'b')
  assert.equal(state.activeTabId, 'a')
})

test('closeTab leaves no active tab once the last one closes', () => {
  let state: TabsState = createTab(EMPTY_TABS_STATE, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  state = closeTab(state, 'a')
  assert.deepEqual(state.tabs, [])
  assert.equal(state.activeTabId, null)
})

test('closeTab on an unknown id is a no-op', () => {
  const state = createTab(EMPTY_TABS_STATE, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  assert.equal(closeTab(state, 'missing'), state)
})

test('the active project follows the active session, and stays when no session is active', () => {
  let state: TabsState = EMPTY_TABS_STATE
  state = createTab(state, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'b', title: 'B', workspaceProfileId: 'ws-2' })
  assert.equal(activeWorkspaceFor(activateTab(state, 'a'), 'ws-2'), 'ws-1')
  assert.equal(activeWorkspaceFor(activateTab(state, 'b'), 'ws-1'), 'ws-2')
  // Closing the last session of ws-2 moves to the session left on screen.
  assert.equal(activeWorkspaceFor(closeTab(activateTab(state, 'b'), 'b'), 'ws-2'), 'ws-1')
  assert.equal(activeWorkspaceFor(EMPTY_TABS_STATE, 'ws-2'), 'ws-2')
})

test('activateTab rejects an unknown id', () => {
  const state = createTab(EMPTY_TABS_STATE, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  assert.throws(() => activateTab(state, 'missing'))
})

test('setTabStatus, setTabProcessId, and setTabSessionId update only the matching tab', () => {
  let state: TabsState = EMPTY_TABS_STATE
  state = createTab(state, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'b', title: 'B', workspaceProfileId: 'ws-1' })
  state = setTabStatus(state, 'a', 'approval-needed')
  state = setTabProcessId(state, 'a', 4242)
  state = setTabSessionId(state, 'a', 'session-xyz')
  assert.equal(state.tabs[0]?.status, 'approval-needed')
  assert.equal(state.tabs[0]?.processId, 4242)
  assert.equal(state.tabs[0]?.lastSessionId, 'session-xyz')
  assert.equal(state.tabs[1]?.status, 'starting')
  assert.equal(state.tabs[1]?.processId, null)
})

test('setTabLaunchConfig updates only the matching tab\'s permission fields', () => {
  let state: TabsState = EMPTY_TABS_STATE
  state = createTab(state, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'b', title: 'B', workspaceProfileId: 'ws-1' })
  state = setTabLaunchConfig(state, 'a', {
    cliVersion: '1.0.82',
    sessionPermissionPreset: 'full-auto',
    sessionPermissionMode: 'allow-all',
    permissionWarning: 'be careful',
  })
  assert.equal(state.tabs[0]?.cliVersion, '1.0.82')
  assert.equal(state.tabs[0]?.sessionPermissionPreset, 'full-auto')
  assert.equal(state.tabs[0]?.sessionPermissionMode, 'allow-all')
  assert.equal(state.tabs[0]?.permissionWarning, 'be careful')
  assert.equal(state.tabs[1]?.sessionPermissionPreset, 'default')
  assert.equal(state.tabs[1]?.cliVersion, '1.0.80')
  assert.equal(state.tabs[1]?.permissionWarning, null)
})

test('renameTab trims, bounds, and falls back to a default title', () => {
  let state: TabsState = createTab(EMPTY_TABS_STATE, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  state = renameTab(state, 'a', '  Fix the bug  ')
  assert.equal(state.tabs[0]?.title, 'Fix the bug')
  state = renameTab(state, 'a', '   ')
  assert.equal(state.tabs[0]?.title, 'Copilot')
  state = renameTab(state, 'a', 'x'.repeat(200))
  assert.equal(state.tabs[0]?.title.length, 120)
})

test('tabsForWorkspace filters by workspace profile id', () => {
  let state: TabsState = EMPTY_TABS_STATE
  state = createTab(state, { id: 'a', title: 'A', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'b', title: 'B', workspaceProfileId: 'ws-2' })
  assert.deepEqual(tabsForWorkspace(state, 'ws-1').map((tab) => tab.id), ['a'])
  assert.deepEqual(tabsForWorkspace(state, 'ws-2').map((tab) => tab.id), ['b'])
})

test('createBackgroundTab preserves activeTabId, uses its own cap, and closeTab skips hidden reviewers', () => {
  let state = createTab(EMPTY_TABS_STATE, { id: 'host', title: 'Author', workspaceProfileId: 'ws-1' }, 1)
  assert.equal(canOpenAnotherTab(state, 1), false, 'regular tab limit reached')
  const meta = { groupId: 'g-1', hostTabId: 'host', seatId: 'seat-1', cli: 'claude' as const, repository: 'o/r', prLabel: 'PR #7', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' }
  state = createBackgroundTab(state, {
    id: 'rev-claude',
    title: 'Review #7 (Claude Code)',
    cli: 'claude',
    workspaceProfileId: 'ws-1',
    cliVersion: '2.1.0',
    sessionPermissionPreset: null,
    permissionWarning: null,
    remote: false,
    tempReviewer: meta,
  })
  assert.equal(state.activeTabId, 'host', 'background tab never steals focus')

  // Add a second regular tab under higher limit and verify closing it focuses host, never rev-claude:
  state = createTab(state, { id: 'other', title: 'Other', workspaceProfileId: 'ws-1' }, 5)
  assert.equal(state.activeTabId, 'other')
  const afterCloseOther = closeTab(state, 'other')
  assert.equal(afterCloseOther.activeTabId, 'host')

  // Directly focusing a tempReviewer and closing it returns focus to hostTabId:
  const focusedRev = activateTab(afterCloseOther, 'rev-claude')
  assert.equal(closeTab(focusedRev, 'rev-claude').activeTabId, 'host')
})

test('visibleSessionTabs supports non-destructive peekTabId without clobbering an existing sideChat', () => {
  let state = createTab(EMPTY_TABS_STATE, { id: 'host', title: 'Host', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'side', title: 'Side', workspaceProfileId: 'ws-1', sideChat: true, sideParentTabId: 'host' })
  state = activateTab(state, 'host')
  const meta = { groupId: 'g-1', hostTabId: 'host', seatId: 'seat-1', cli: 'codex' as const, repository: 'o/r', prLabel: 'PR #9', prNumber: 9, prUrl: 'https://github.com/o/r/pull/9' }
  state = createBackgroundTab(state, {
    id: 'rev-codex',
    title: 'Review #9 (Codex)',
    cli: 'codex',
    workspaceProfileId: 'ws-1',
    cliVersion: '0.172.0',
    sessionPermissionPreset: null,
    permissionWarning: null,
    remote: false,
    tempReviewer: meta,
  })

  // Without peek, host + sideChat remain visible:
  assert.deepEqual(
    { main: visibleSessionTabs(state).main?.id, side: visibleSessionTabs(state).side?.id },
    { main: 'host', side: 'side' },
  )
  // Peeking rev-codex shows host + rev-codex in split without touching sideParentTabId:
  assert.deepEqual(
    { main: visibleSessionTabs(state, 'rev-codex').main?.id, side: visibleSessionTabs(state, 'rev-codex').side?.id },
    { main: 'host', side: 'rev-codex' },
  )
  // Clearing peek or closing rev-codex restores sideChat automatically:
  const afterRevGone = closeTab(state, 'rev-codex')
  assert.deepEqual(
    { main: visibleSessionTabs(afterRevGone, 'rev-codex').main?.id, side: visibleSessionTabs(afterRevGone, 'rev-codex').side?.id },
    { main: 'host', side: 'side' },
  )

  // Moving focus into the peeked reviewer terminal keeps peek anchored to its host (host + rev-codex):
  const focusedReviewer = activateTab(state, 'rev-codex')
  const peekMap = { host: 'rev-codex' }
  const resolved = resolvePeekHostAndTab(focusedReviewer, peekMap)
  assert.deepEqual(resolved, { peekKey: 'host', hostTabId: 'host', peekTabId: 'rev-codex' })
  assert.deepEqual(
    { main: visibleSessionTabs(focusedReviewer, resolved.peekTabId).main?.id, side: visibleSessionTabs(focusedReviewer, resolved.peekTabId).side?.id },
    { main: 'host', side: 'rev-codex' },
  )
  // Without peekTabId (e.g. main-process callers or Hide in flight), a focused tempReviewer still resolves to host + sideChat, never main = reviewer:
  assert.deepEqual(
    { main: visibleSessionTabs(focusedReviewer).main?.id, side: visibleSessionTabs(focusedReviewer).side?.id },
    { main: 'host', side: 'side' },
  )
})

test('resolvePeekHostAndTab preserves second host tab for profile-scoped reviewer and isolates foreign-workspace activeTabId', () => {
  const profileMeta = { groupId: 'g-multi', hostTabId: null, seatId: 'seat-1', cli: 'claude' as const, repository: 'o/r', prLabel: 'Meeting AB12', prNumber: null, prUrl: null, meetingId: 'AB12' }
  let state = createTab(EMPTY_TABS_STATE, { id: 'tab-1', title: 'First', workspaceProfileId: 'ws-1' })
  state = createTab(state, { id: 'tab-2', title: 'Second', workspaceProfileId: 'ws-1' })
  state = createBackgroundTab(state, {
    id: 'rev-prof',
    title: 'Meeting AB12 · Claude Code',
    cli: 'claude',
    workspaceProfileId: 'ws-1',
    cliVersion: '2.1.0',
    sessionPermissionPreset: null,
    permissionWarning: null,
    remote: false,
    tempReviewer: profileMeta,
  })
  // tab-2 is active and peeks rev-prof; even if rev-prof were focused directly, peekKey stays on tab-2, not tab-1:
  const peekMap = { 'tab-2': 'rev-prof' }
  assert.deepEqual(resolvePeekHostAndTab(state, peekMap, 'ws-1'), { peekKey: 'tab-2', hostTabId: 'tab-2', peekTabId: 'rev-prof' })
  const focusedProfRev = activateTab(state, 'rev-prof')
  assert.deepEqual(resolvePeekHostAndTab(focusedProfRev, peekMap, 'ws-1'), { peekKey: 'tab-2', hostTabId: 'tab-2', peekTabId: 'rev-prof' })

  // Foreign-workspace activeTabId: ws-2 has only a standalone reviewer while activeTabId still points at ws-1's tab-2:
  const ws2Meta = { ...profileMeta, groupId: 'g-ws2', seatId: 'seat-ws2' }
  const crossWsState = createBackgroundTab(state, {
    id: 'rev-ws2',
    title: 'Meeting AB12 · Codex CLI',
    cli: 'codex',
    workspaceProfileId: 'ws-2',
    cliVersion: '0.172.0',
    sessionPermissionPreset: null,
    permissionWarning: null,
    remote: false,
    tempReviewer: ws2Meta,
  })
  const ws2Peek = { 'profile:ws-2': 'rev-ws2' }
  assert.deepEqual(resolvePeekHostAndTab(crossWsState, ws2Peek, 'ws-2'), { peekKey: 'profile:ws-2', hostTabId: null, peekTabId: 'rev-ws2' })
  assert.deepEqual(
    { main: visibleSessionTabs(crossWsState, 'rev-ws2', 'ws-2').main?.id, side: visibleSessionTabs(crossWsState, 'rev-ws2', 'ws-2').side },
    { main: 'rev-ws2', side: null },
  )
  assert.deepEqual(visibleSessionTabs(crossWsState, null, 'ws-2'), { main: null, side: null })
})

test('resolvePeekHostAndTab and visibleSessionTabs support profile-scoped (hostTabId: null) reviewers with or without open regular tabs', () => {
  const profileMeta = { groupId: 'g-prof', hostTabId: null, seatId: 'seat-2', cli: 'claude' as const, repository: 'omaha:3001/o/r', prLabel: 'PR #15', prNumber: 15, prUrl: 'http://omaha:3001/o/r/pulls/15' }

  // 1. No regular tabs open in workspace ws-1:
  let noHostState = createBackgroundTab(EMPTY_TABS_STATE, {
    id: 'rev-standalone',
    title: 'Review PR #15 · Claude Code',
    cli: 'claude',
    workspaceProfileId: 'ws-1',
    cliVersion: '2.1.0',
    sessionPermissionPreset: null,
    permissionWarning: null,
    remote: false,
    tempReviewer: profileMeta,
  })
  assert.equal(noHostState.activeTabId, null)
  assert.deepEqual(visibleSessionTabs(noHostState, null), { main: null, side: null })

  const standaloneResolved = resolvePeekHostAndTab(noHostState, { 'profile:ws-1': 'rev-standalone' }, 'ws-1')
  assert.deepEqual(standaloneResolved, { peekKey: 'profile:ws-1', hostTabId: null, peekTabId: 'rev-standalone' })
  assert.deepEqual(
    { main: visibleSessionTabs(noHostState, standaloneResolved.peekTabId).main?.id, side: visibleSessionTabs(noHostState, standaloneResolved.peekTabId).side },
    { main: 'rev-standalone', side: null },
  )

  // Clicking inside the standalone peeked terminal focuses it; hiding clears peek and hides the pane cleanly:
  const focusedStandalone = activateTab(noHostState, 'rev-standalone')
  const hiddenResolved = resolvePeekHostAndTab(focusedStandalone, { 'profile:ws-1': null }, 'ws-1')
  assert.deepEqual(hiddenResolved, { peekKey: 'profile:ws-1', hostTabId: null, peekTabId: null })
  assert.deepEqual(visibleSessionTabs(focusedStandalone, hiddenResolved.peekTabId), { main: null, side: null })

  // 2. Regular tab open in ws-1 alongside a profile-scoped reviewer:
  let withHostState = createTab(noHostState, { id: 'tab-1', title: 'Main', workspaceProfileId: 'ws-1' })
  const focusedProfileRev = activateTab(withHostState, 'rev-standalone')
  const resolvedWithHost = resolvePeekHostAndTab(focusedProfileRev, { 'tab-1': 'rev-standalone' }, 'ws-1')
  assert.deepEqual(resolvedWithHost, { peekKey: 'tab-1', hostTabId: 'tab-1', peekTabId: 'rev-standalone' })
  assert.deepEqual(
    { main: visibleSessionTabs(focusedProfileRev, resolvedWithHost.peekTabId).main?.id, side: visibleSessionTabs(focusedProfileRev, resolvedWithHost.peekTabId).side?.id },
    { main: 'tab-1', side: 'rev-standalone' },
  )
})

test('fanOutAvailableSlots ignores hidden temporary reviewer tabs when computing available regular tab slots', () => {
  let state = createTab(EMPTY_TABS_STATE, { id: 'host', title: 'Host', workspaceProfileId: 'ws-1' }, 3)
  state = createBackgroundTab(state, {
    id: 'rev-1',
    title: 'Review #12 · Claude Code',
    cli: 'claude',
    workspaceProfileId: 'ws-1',
    cliVersion: '2.1.0',
    sessionPermissionPreset: null,
    permissionWarning: null,
    remote: false,
    tempReviewer: { groupId: 'g-1', hostTabId: 'host', seatId: 'claude', cli: 'claude', repository: 'o/r', prLabel: 'PR #12', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' },
  })
  assert.equal(fanOutAvailableSlots(state, 3), 2, '1 regular host + 1 hidden reviewer under cap 3 leaves 2 fan-out slots')
})
