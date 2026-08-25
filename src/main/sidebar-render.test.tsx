import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_SESSION_LAUNCH_CONFIG } from './session-launch.js'
import type { DesktopSessionTab, WorkspaceProfile } from './types.js'
import { Sidebar } from '../renderer/components/Sidebar.js'

function renderAccess(profiles: WorkspaceProfile[], tab: DesktopSessionTab): string {
  return renderToStaticMarkup(
    <Sidebar
      profiles={profiles}
      tabs={[tab]}
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
        launchedPermissionPreset: 'default',
        permissionWarning: null,
        remote: false,
        lastActivityAt: 123,
      }]}
      activeProfileId="workspace-1"
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
        launchedPermissionPreset: 'default',
        permissionWarning: null,
        remote: false,
        lastActivityAt: 123,
      }]}
      activeProfileId="workspace-1"
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

  assert.match(markup, /Default \(prompt every time\)/)
  assert.match(markup, /Full computer access \(--allow-all\) applies to newly created sessions \(Restart keeps current access\)/)
})

test('Sidebar uses the active tab workspace and surfaces legacy restriction warnings', () => {
  const profiles: WorkspaceProfile[] = [
    { id: 'workspace-1', name: 'one', path: 'D:\\one', permissionPreset: 'default', defaultResumeMode: 'new', launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [] },
    { id: 'workspace-2', name: 'two', path: 'D:\\two', permissionPreset: 'read-only', defaultResumeMode: 'new', launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [] },
  ]
  const markup = renderAccess(profiles, {
    id: 'tab-2', title: 'Two', workspaceProfileId: 'workspace-2', lastSessionId: null,
    status: 'running', processId: 42, launchedPermissionPreset: 'read-only',
    permissionWarning: 'Only shell and write tools are denied.', remote: false, lastActivityAt: 123,
  })

  assert.match(markup, /Restricted \(explicit read\/search allowlist\)/)
  assert.match(markup, /Legacy restricted mode/)
  assert.doesNotMatch(markup, /Default \(prompt every time\)/)
})

test('Sidebar does not claim effective access for remote or stopped sessions', () => {
  const profiles: WorkspaceProfile[] = [{
    id: 'workspace-1', name: 'one', path: 'D:\\one', permissionPreset: 'full-access',
    defaultResumeMode: 'new', launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG }, tabs: [],
  }]
  const remoteMarkup = renderAccess(profiles, {
    id: 'remote', title: 'Remote', workspaceProfileId: 'workspace-1', lastSessionId: null,
    status: 'running', processId: 42, launchedPermissionPreset: null, permissionWarning: null,
    remote: true, lastActivityAt: 123,
  })
  const stoppedMarkup = renderAccess(profiles, {
    id: 'stopped', title: 'Stopped', workspaceProfileId: 'workspace-1', lastSessionId: null,
    status: 'completed', processId: null, launchedPermissionPreset: 'full-access', permissionWarning: null,
    remote: false, lastActivityAt: 123,
  })

  assert.match(remoteMarkup, /Remote session access unknown/)
  assert.doesNotMatch(remoteMarkup, />Full computer access \(--allow-all\)</)
  assert.match(stoppedMarkup, /Full computer access \(--allow-all\) applies to newly created sessions/)
})
