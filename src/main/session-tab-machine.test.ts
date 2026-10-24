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
  createTab as createTabState,
  renameTab,
  setTabLaunchConfig,
  setTabProcessId,
  setTabSessionId,
  setTabStatus,
  tabsForWorkspace,
  type NewTabInput,
  type TabsState,
} from './session-tab-machine.js'

function createTab(
  state: TabsState,
  input: Omit<NewTabInput, 'cliVersion' | 'sessionPermissionPreset' | 'permissionWarning' | 'remote'>,
): TabsState {
  return createTabState(state, {
    ...input,
    cliVersion: '1.0.80',
    sessionPermissionPreset: 'default',
    sessionPermissionMode: null,
    permissionWarning: null,
    remote: false,
  })
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
