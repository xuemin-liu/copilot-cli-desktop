import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_SESSION_LAUNCH_CONFIG } from './session-launch.js'
import { Sidebar } from '../renderer/components/Sidebar.js'

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
        permissionPreset: 'default',
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
        permissionPreset: 'default',
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
  assert.match(markup, /Full computer access \(--allow-all\) applies to new sessions/)
})
