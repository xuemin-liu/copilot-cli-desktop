import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
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
        tabs: [],
      }]}
      tabs={[{
        id: 'tab-1',
        title: 'Review pull request',
        workspaceProfileId: 'workspace-1',
        lastSessionId: null,
        status: 'running',
        processId: 42,
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
