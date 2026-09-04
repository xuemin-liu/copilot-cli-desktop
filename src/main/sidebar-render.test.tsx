import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_SESSION_LAUNCH_CONFIG } from './session-launch.js'
import type { DesktopSessionTab, WorkspaceProfile } from './types.js'
import { Sidebar } from '../renderer/components/Sidebar.js'
import { SIDE_CHAT_PERMISSION_WARNING } from './side-chat.js'

function renderAccess(profiles: WorkspaceProfile[], tab: DesktopSessionTab): string {
  return renderToStaticMarkup(
    <Sidebar
      profiles={profiles}
      tabs={[tab]}
      installedCliVersion="1.0.82"
      activeProfileId={profiles[0]?.id ?? null}
      activeTabId={tab.id}
      canOpenTab
      collapsed={false}
      onToggleCollapsed={() => undefined}
      onSelectWorkspace={() => undefined}
      onActivateProfile={() => undefined}
      onActivateTab={() => undefined}
      onRenameTab={() => undefined}
      onCreateTab={() => undefined}
      onCreateTabWithAttachments={() => undefined}
      onResumePicker={() => undefined}
      onConnectRemote={() => undefined}
      onOpenSettings={() => undefined}
    />,
  )
}

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
      onCreateTab={() => undefined}
      onCreateTabWithAttachments={() => undefined}
      onResumePicker={() => undefined}
      onConnectRemote={() => undefined}
      onOpenSettings={() => undefined}
    />,
  )

  assert.match(markup, /New Session/)
  assert.match(markup, /Workspaces/)
  assert.match(markup, /copilot-cli-desktop/)
  assert.match(markup, /Review pull request/)
  assert.match(markup, /Running/)
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
    cliVersion: '1.0.82',
    remote: true, lastActivityAt: 123,
  })
  const stoppedMarkup = renderAccess(profiles, {
    id: 'stopped', title: 'Stopped', workspaceProfileId: 'workspace-1', lastSessionId: null,
    status: 'completed', processId: null, sessionPermissionPreset: 'full-access', permissionWarning: null,
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
      permissionWarning: SIDE_CHAT_PERMISSION_WARNING, remote: false, cliVersion: '1.0.82', lastActivityAt: 123, sideChat: true,
    })
    assert.match(markup, /Restricted \(explicit read\/search allowlist\)/)
    assert.doesNotMatch(markup, /Full computer access/)
    assert.doesNotMatch(markup, /Legacy restricted mode/)
  }
})
