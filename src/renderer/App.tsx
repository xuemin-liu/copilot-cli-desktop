import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { DesktopState } from '../main/types.js'
import { DiagnosticsView } from './components/DiagnosticsView.js'
import { Sidebar } from './components/Sidebar.js'
import { TabBar } from './components/TabBar.js'
import { TerminalPane } from './components/TerminalPane.js'

const EMPTY_STATE: DesktopState = {
  desktopVersion: 'unknown',
  resolution: null,
  profiles: [],
  activeProfileId: null,
  tabs: [],
  activeTabId: null,
  maxSessionTabs: 20,
  recentLogs: [],
  error: null,
}

export function App(): JSX.Element {
  const [state, setState] = useState<DesktopState>(EMPTY_STATE)
  const [loading, setLoading] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const requestTabRename = (tabId: string, currentTitle: string): void => {
    const title = window.prompt('Session title', currentTitle)
    if (title !== null) void window.copilotDesktop.renameTab(tabId, title)
  }

  useEffect(() => {
    let disposed = false
    void window.copilotDesktop.getState().then((initial) => {
      if (!disposed) {
        setState(initial)
        setLoading(false)
      }
    })
    const unsubscribe = window.copilotDesktop.onStateChanged((next) => setState(next))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.ctrlKey || event.metaKey
      if (!modifier) return
      if (event.key.toLowerCase() === 't') {
        event.preventDefault()
        void window.copilotDesktop.createTab()
      } else if (event.key.toLowerCase() === 'w' && state.activeTabId) {
        event.preventDefault()
        void window.copilotDesktop.closeTab(state.activeTabId)
      } else if (event.key === ',') {
        event.preventDefault()
        void window.copilotDesktop.openSettings()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [state.activeTabId])

  if (loading) {
    return (
      <div className="loading-screen">
        <p>Resolving the copilot CLI…</p>
      </div>
    )
  }

  if (!state.resolution || state.resolution.version === null) {
    return (
      <DiagnosticsView
        resolution={state.resolution}
        onRetry={async () => {
          const next = await window.copilotDesktop.retryResolution()
          setState(next)
        }}
        onInstall={async () => {
          const next = await window.copilotDesktop.installCopilot()
          setState(next)
        }}
        onCopyDiagnostics={() => window.copilotDesktop.copyDiagnostics()}
      />
    )
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? ' app-shell-sidebar-collapsed' : ''}`}>
      <Sidebar
        profiles={state.profiles}
        tabs={state.tabs}
        activeProfileId={state.activeProfileId}
        activeTabId={state.activeTabId}
        canOpenTab={state.tabs.length < state.maxSessionTabs}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => {
          setSidebarCollapsed((collapsed) => {
            const next = !collapsed
            localStorage.setItem('sidebar-collapsed', String(next))
            return next
          })
        }}
        onSelectWorkspace={() => void window.copilotDesktop.selectWorkspace()}
        onActivateProfile={(profileId) => void window.copilotDesktop.activateProfile(profileId)}
        onActivateTab={(tabId) => void window.copilotDesktop.activateTab(tabId)}
        onRenameTab={requestTabRename}
        onCreateTab={() => void window.copilotDesktop.createTab()}
        onCreateTabWithAttachments={() => void window.copilotDesktop.createTabWithAttachments()}
        onOpenSettings={() => void window.copilotDesktop.openSettings()}
        onResumePicker={() => void window.copilotDesktop.createTab('picker')}
        onConnectRemote={() => {
          const sessionId = window.prompt('Remote Copilot session or task ID')?.trim()
          if (sessionId) void window.copilotDesktop.connectRemoteSession(sessionId)
        }}
      />
      <main className="main-content">
        {state.activeProfileId === null ? (
          <div className="empty-state welcome-state">
            <div className="welcome-mark" aria-hidden="true">C</div>
            <h1>Start with a workspace</h1>
            <p>Choose a project folder to open GitHub Copilot CLI.</p>
            <button type="button" className="primary-button" onClick={() => void window.copilotDesktop.selectWorkspace()}>
              Choose workspace
            </button>
          </div>
        ) : (
          <>
          <TabBar
            tabs={state.tabs}
            activeTabId={state.activeTabId}
            canOpenTab={state.tabs.length < state.maxSessionTabs}
            onActivate={(tabId) => void window.copilotDesktop.activateTab(tabId)}
            onRename={requestTabRename}
            onClose={(tabId) => void window.copilotDesktop.closeTab(tabId)}
            onCreate={() => void window.copilotDesktop.createTab()}
          />
          <div className="terminal-area">
            {state.tabs.length === 0 && (
              <div className="empty-state">
                <p>No session tabs are open.</p>
                <button type="button" onClick={() => void window.copilotDesktop.createTab()}>
                  Start a session
                </button>
              </div>
            )}
            {state.tabs.map((tab) => (
              <TerminalPane key={tab.id} tabId={tab.id} active={tab.id === state.activeTabId} />
            ))}
            {(() => {
              // Restart the tab that actually crashed, not just whichever
              // tab happens to be active — otherwise this button can kill
              // and restart a healthy active session while an unrelated
              // background tab is the one that crashed.
              const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
              if (activeTab?.status !== 'crashed') return null
              return (
                <button
                  type="button"
                  className="restart-button"
                  onClick={() => void window.copilotDesktop.restartTab(activeTab.id)}
                >
                  Restart this session
                </button>
              )
            })()}
          </div>
          </>
        )}
      </main>
    </div>
  )
}
