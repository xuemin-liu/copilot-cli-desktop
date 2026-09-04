import assert from 'node:assert/strict'
import test from 'node:test'
import { sideChatProfile } from './side-chat.js'
import { EMPTY_COPILOT_CAPABILITIES } from './copilot-command.js'
import { createWorkspaceProfile } from './desktop-config.js'
import { buildPermissionArgs } from './permission-presets.js'
import { buildSessionLaunchArgs } from './session-launch.js'
import { createTab, closeTab, activateTab, visibleSessionTabs, EMPTY_TABS_STATE } from './session-tab-machine.js'

test('side chats never inherit full access, autopilot, custom agent or remote launch settings', () => {
  const original = createWorkspaceProfile('C:\\work\\example', 'full-access')
  original.launch = { ...original.launch, mode: 'autopilot', agent: 'writer', worktree: true, remoteControl: 'enable', remoteExport: 'enable', model: 'example' }
  const capabilities = { ...EMPTY_COPILOT_CAPABILITIES, toolAllowlist: true }
  const profile = sideChatProfile(original, capabilities)
  assert.equal(profile.permissionPreset, 'read-only')
  assert.equal(profile.launch.mode, 'interactive')
  assert.equal(profile.launch.agent, '')
  assert.equal(profile.launch.worktree, false)
  assert.equal(profile.launch.model, 'example')
  assert.deepEqual(buildPermissionArgs(profile.permissionPreset, profile.path, capabilities), ['--available-tools=view,glob,grep,ask_user'])
  const args = buildSessionLaunchArgs(profile.launch, false)
  assert.ok(args.includes('--no-remote') && args.includes('--no-remote-export'))
  assert.equal(original.permissionPreset, 'full-access')
  assert.equal(original.launch.mode, 'autopilot')
  assert.throws(() => sideChatProfile(original, EMPTY_COPILOT_CAPABILITIES), /requires Copilot CLI tool allowlists/)
})

function pairedTabs() {
  const fields = { workspaceProfileId: 'ws', sessionPermissionPreset: 'read-only' as const, permissionWarning: null, remote: false, cliVersion: '1.0.82' }
  let state = createTab(EMPTY_TABS_STATE, { ...fields, id: 'main', title: 'Main' })
  state = createTab(state, { ...fields, id: 'other', title: 'Other' })
  return createTab(state, { ...fields, id: 'side', title: 'Side', sideChat: true, sideParentTabId: 'main' })
}

test('focus changes keep both linked terminals visible; unrelated tabs hide the pair', () => {
  const state = pairedTabs()
  for (const id of ['main', 'side']) {
    const visible = visibleSessionTabs(activateTab(state, id))
    assert.equal(visible.main?.id, 'main')
    assert.equal(visible.side?.id, 'side')
  }
  const other = visibleSessionTabs(activateTab(state, 'other'))
  assert.equal(other.main?.id, 'other')
  assert.equal(other.side, null)
})

test('closing the side returns focus to its parent without removing other tabs', () => {
  const state = closeTab(pairedTabs(), 'side')
  assert.deepEqual(state.tabs.map((tab) => tab.id), ['main', 'other'])
  assert.equal(state.activeTabId, 'main')
  assert.equal(visibleSessionTabs(state).side, null)
})

test('closing the main keeps its side chat as an independent restricted tab', () => {
  for (const focused of ['main', 'side']) {
    const state = closeTab(activateTab(pairedTabs(), focused), 'main')
    const side = state.tabs.find((tab) => tab.id === 'side')
    assert.equal(side?.sideChat, true)
    assert.equal(side?.sideParentTabId, undefined)
    assert.equal(visibleSessionTabs(state).main?.id, 'side')
    assert.equal(visibleSessionTabs(state).side, null)
  }
})
