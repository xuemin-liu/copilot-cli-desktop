import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_SESSION_LAUNCH_CONFIG } from './session-launch.js'
import type { DesktopSessionTab, WorkspaceProfile } from './types.js'
import { Sidebar } from '../renderer/components/Sidebar.js'
import { SIDE_CHAT_PERMISSION_WARNING } from './side-chat.js'

function renderAccess(profiles: WorkspaceProfile[], tab: DesktopSessionTab, collapsed = false, tabs = [tab]): string {
  return renderToStaticMarkup(
    <Sidebar
      profiles={profiles}
      tabs={tabs}
      installedCliVersion="1.0.82"
      activeProfileId={profiles[0]?.id ?? null}
      activeTabId={tab.id}
      canOpenTab
      collapsed={collapsed}
      onToggleCollapsed={() => undefined}
      onSelectWorkspace={() => undefined}
      onActivateProfile={() => undefined}
      onActivateTab={() => undefined}
      onRenameTab={() => undefined}
      onCloseTab={() => undefined}
      onRestartTab={() => undefined}
      onCreateTab={() => undefined}
      onCreateTabWithAttachments={() => undefined}
      onResumePicker={() => undefined}
      onConnectRemote={() => undefined}
      onOpenSettings={() => undefined}
    />,
  )
}

test('collapsed sidebar preserves workspace selection, named session navigation, and background actions', () => {
  const profiles: WorkspaceProfile[] = ['one', 'two'].map((id) => ({
    id, name: id, path: `D:\\${id}`, permissionPreset: 'default', defaultResumeMode: 'new',
    launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [],
  }))
  const active: DesktopSessionTab = {
    id: 'active', title: 'Active', workspaceProfileId: 'one', lastSessionId: null,
    status: 'running', processId: 42, cliVersion: '1.0.82', sessionPermissionPreset: 'default',
    sessionPermissionMode: null, permissionWarning: null, remote: false, lastActivityAt: 1,
  }
  const background = { ...active, id: 'background', title: 'Background', workspaceProfileId: 'two', status: 'starting' as const }
  const remote = { ...background, id: 'remote', title: 'Remote', remote: true }
  const markup = renderAccess(profiles, active, true, [active, background, remote])
  assert.match(markup, /aria-label="Workspaces"/)
  assert.match(markup, /aria-label="two"/)
  assert.match(markup, /sidebar-compact-sessions/)
  assert.match(markup, /aria-label="1: Active[^\"]*" aria-current="true"/)
  assert.match(markup, /sidebar-session-title">1</)
  assert.match(markup, /aria-label="Actions for Background"/)
  assert.match(markup, /aria-label="Actions for Background"[^>]*aria-expanded="false"/)
  assert.doesNotMatch(markup, /aria-label="Close Background"/)
  assert.doesNotMatch(markup, /aria-label="Restart Remote"/)
  assert.doesNotMatch(markup, /workspace-sessions-flat/)
})

test('sidebar distinguishes an open process, active work, idle, and approval', () => {
  const profile: WorkspaceProfile = { id: 'one', name: 'one', path: 'D:/one', permissionPreset: 'default', defaultResumeMode: 'new', launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [] }
  const tab: DesktopSessionTab = { id: 'one', title: 'Chat', workspaceProfileId: 'one', status: 'running', processId: 42, cliVersion: '1.0.82', sessionPermissionPreset: 'default', sessionPermissionMode: null, permissionWarning: null, remote: false, lastSessionId: null, lastActivityAt: 1 }
  for (const [activity, label] of [[null, 'Open'], ['working', 'Working'], ['idle', 'Idle']] as const) {
    assert.match(renderAccess([profile], { ...tab, activity }), new RegExp(`Chat — ${label}`))
    assert.match(renderAccess([profile], { ...tab, activity }, true), new RegExp(`Chat — ${label}`))
  }
  assert.match(renderAccess([profile], { ...tab, activity: 'idle', status: 'approval-needed' }), /Chat — Needs approval/)
})

test('compact navigation honors saved ordering and workspace grouping', () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let group = 'list'
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => key === 'sidebar-group-mode' ? group : key === 'sidebar-order-mode' ? 'last-updated' : null,
  } })
  try {
    const profiles: WorkspaceProfile[] = ['one', 'two'].map((id) => ({
      id, name: id, path: `D:\\${id}`, permissionPreset: 'default', defaultResumeMode: 'new',
      launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [],
    }))
    const older: DesktopSessionTab = {
      id: 'older', title: 'Older', workspaceProfileId: 'one', lastSessionId: null,
      status: 'running', processId: 42, cliVersion: '1.0.82', sessionPermissionPreset: 'default',
      sessionPermissionMode: null, permissionWarning: null, remote: false, lastActivityAt: 1,
    }
    const newest = { ...older, id: 'newest', title: 'Newest', workspaceProfileId: 'two', lastActivityAt: 3 }
    const middle = { ...older, id: 'middle', title: 'Middle', lastActivityAt: 2 }
    const tabs = [older, newest, middle]
    const flat = renderAccess(profiles, older, true, tabs)
    assert.match(flat, /aria-label="1: Newest/)
    assert.match(flat, /aria-label="2: Middle/)
    const expanded = renderAccess(profiles, older, false, tabs)
    assert.match(expanded, /aria-label="Workspaces"/)
    assert.match(expanded, /aria-label="two" title="two — D:\\two"/)
    assert.match(flat, /aria-label="two" title="two — D:\\two"/)
    group = 'workspace'
    const grouped = renderAccess(profiles, older, true, tabs)
    assert.match(grouped, /aria-label="1: Middle/)
    assert.match(grouped, /aria-label="2: Older/)
    assert.match(grouped, /aria-label="3: Newest/)
  } finally {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('Sidebar groups live sessions under their workspace and exposes primary actions', () => {
  const markup = renderToStaticMarkup(
    <Sidebar
      profiles={[{
        id: 'workspace-1',
        name: 'copilot-cli-desktop',
        path: 'D:\\work\\copilot-cli-desktop',
        permissionPreset: 'default',
        defaultResumeMode: 'new',
        launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG },
        tabs: [],
      }]}
      tabs={[{
        id: 'tab-1',
        title: 'Review pull request',
        workspaceProfileId: 'workspace-1',
        lastSessionId: null,
        status: 'running',
        processId: 42,
        cliVersion: '1.0.82',
        sessionPermissionPreset: 'default',
        sessionPermissionMode: null,
        permissionWarning: null,
        remote: false,
        lastActivityAt: 123,
      }]}
      activeProfileId="workspace-1"
      installedCliVersion="1.0.82"
      activeTabId="tab-1"
      canOpenTab
      collapsed={false}
      onToggleCollapsed={() => undefined}
      onSelectWorkspace={() => undefined}
      onActivateProfile={() => undefined}
      onActivateTab={() => undefined}
      onRenameTab={() => undefined}
      onCloseTab={() => undefined}
      onRestartTab={() => undefined}
      onCreateTab={() => undefined}
      onCreateTabWithAttachments={() => undefined}
      onResumePicker={() => undefined}
      onConnectRemote={() => undefined}
      onOpenSettings={() => undefined}
    />,
  )

  assert.match(markup, /aria-label="New session in copilot-cli-desktop"/)
  assert.match(markup, /title="New session in copilot-cli-desktop \(Ctrl\+T\)"/)
  assert.doesNotMatch(markup, /new-session-button/)
  assert.match(markup, /Workspaces/)
  assert.match(markup, /copilot-cli-desktop/)
  assert.match(markup, /Review pull request/)
  assert.match(markup, /Open/)
  assert.match(markup, /Settings/)
})

test('Sidebar shows current session access and marks changed access as applying to new sessions', () => {
  const markup = renderToStaticMarkup(
    <Sidebar
      profiles={[{
        id: 'workspace-1',
        name: 'workspace',
        path: 'D:\\work\\workspace',
        permissionPreset: 'full-access',
        defaultResumeMode: 'new',
        launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG },
        tabs: [],
      }]}
      tabs={[{
        id: 'tab-1',
        title: 'Existing session',
        workspaceProfileId: 'workspace-1',
        lastSessionId: null,
        status: 'running',
        processId: 42,
        cliVersion: '1.0.80',
        sessionPermissionPreset: 'default',
        sessionPermissionMode: null,
        permissionWarning: null,
        remote: false,
        lastActivityAt: 123,
      }]}
      activeProfileId="workspace-1"
      installedCliVersion="1.0.82"
      activeTabId="tab-1"
      canOpenTab
      collapsed={false}
      onToggleCollapsed={() => undefined}
      onSelectWorkspace={() => undefined}
      onActivateProfile={() => undefined}
      onActivateTab={() => undefined}
      onRenameTab={() => undefined}
      onCloseTab={() => undefined}
      onRestartTab={() => undefined}
      onCreateTab={() => undefined}
      onCreateTabWithAttachments={() => undefined}
      onResumePicker={() => undefined}
      onConnectRemote={() => undefined}
      onOpenSettings={() => undefined}
    />,
  )

  assert.match(markup, /Copilot default \(uses CLI setting\)/)
  assert.match(markup, /Profile default for new sessions: Full computer access \(--allow-all\)/)
  assert.match(markup, /Old CLI/)
  assert.match(markup, /restart this session to use 1\.0\.82/)
})

test('Sidebar uses the active tab workspace and surfaces legacy restriction warnings', () => {
  const profiles: WorkspaceProfile[] = [
    { id: 'workspace-1', name: 'one', path: 'D:\\one', permissionPreset: 'default', defaultResumeMode: 'new', launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [] },
    { id: 'workspace-2', name: 'two', path: 'D:\\two', permissionPreset: 'read-only', defaultResumeMode: 'new', launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [] },
  ]
  const markup = renderAccess(profiles, {
    id: 'tab-2', title: 'Two', workspaceProfileId: 'workspace-2', lastSessionId: null,
    status: 'running', processId: 42, sessionPermissionPreset: 'read-only',
    sessionPermissionMode: null,
    cliVersion: '1.0.82',
    permissionWarning: 'Only shell and write tools are denied.', remote: false, lastActivityAt: 123,
  })

  assert.match(markup, /Restricted \(explicit read\/search allowlist\)/)
  assert.match(markup, /Legacy restricted mode/)
  assert.doesNotMatch(markup, /Copilot default \(uses CLI setting\)/)
})

test('Sidebar shows persisted access for stopped sessions and unknown access for untouched remote sessions', () => {
  const profiles: WorkspaceProfile[] = [{
    id: 'workspace-1', name: 'one', path: 'D:\\one', permissionPreset: 'full-access',
    defaultResumeMode: 'new', launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [],
  }]
  const remoteMarkup = renderAccess(profiles, {
    id: 'remote', title: 'Remote', workspaceProfileId: 'workspace-1', lastSessionId: null,
    status: 'running', processId: 42, sessionPermissionPreset: null, permissionWarning: null,
    sessionPermissionMode: null,
    cliVersion: '1.0.82',
    remote: true, lastActivityAt: 123,
  })
  const stoppedMarkup = renderAccess(profiles, {
    id: 'stopped', title: 'Stopped', workspaceProfileId: 'workspace-1', lastSessionId: null,
    status: 'completed', processId: null, sessionPermissionPreset: 'full-access', permissionWarning: null,
    sessionPermissionMode: null,
    cliVersion: '1.0.82',
    remote: false, lastActivityAt: 123,
  })

  assert.match(remoteMarkup, /Remote session access unknown/)
  assert.doesNotMatch(remoteMarkup, />Full computer access \(--allow-all\)</)
  assert.match(stoppedMarkup, />Full computer access \(--allow-all\)</)
  assert.doesNotMatch(stoppedMarkup, /applies to newly created sessions/)
})

test('Sidebar keeps side chat access restricted even when its workspace allows full access', () => {
  const profiles: WorkspaceProfile[] = [{
    id: 'workspace-1', name: 'one', path: 'D:\\one', permissionPreset: 'full-access',
    defaultResumeMode: 'new', launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [],
  }]
  for (const status of ['running', 'crashed'] as const) {
    const markup = renderAccess(profiles, {
      id: 'side', title: 'Side', workspaceProfileId: 'workspace-1', lastSessionId: null,
      status, processId: status === 'running' ? 42 : null, sessionPermissionPreset: 'read-only',
      sessionPermissionMode: null,
      permissionWarning: SIDE_CHAT_PERMISSION_WARNING, remote: false, cliVersion: '1.0.82', lastActivityAt: 123, sideChat: true,
    })
    assert.match(markup, /Restricted \(explicit read\/search allowlist\)/)
    assert.doesNotMatch(markup, /Full computer access/)
    assert.doesNotMatch(markup, /Legacy restricted mode/)
  }

  const changedModeMarkup = renderAccess(profiles, {
    id: 'side-mode', title: 'Side mode', workspaceProfileId: 'workspace-1', lastSessionId: null,
    status: 'running', processId: 42, sessionPermissionPreset: 'read-only', sessionPermissionMode: 'allow-all',
    permissionWarning: SIDE_CHAT_PERMISSION_WARNING, remote: false, cliVersion: '1.0.82', lastActivityAt: 124, sideChat: true,
  })
  assert.match(changedModeMarkup, /Restricted tools · Allow all/)
  assert.match(changedModeMarkup, /sidebar-access-read-only/)
  assert.doesNotMatch(changedModeMarkup, />Full computer access/)
})
