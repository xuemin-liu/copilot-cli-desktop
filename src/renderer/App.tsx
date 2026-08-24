import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { DesktopState } from '../main/types.js'
import { DiagnosticsView } from './components/DiagnosticsView.js'
import { TabBar } from './components/TabBar.js'
import { TerminalPane } from './components/TerminalPane.js'
import { WorkspacePanel } from './components/WorkspacePanel.js'

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
        onCopyDiagnostics={() => window.copilotDesktop.copyDiagnostics()}
      />
    )
  }

  return (
    <div className="app-shell">
      <WorkspacePanel
        profiles={state.profiles}
        activeProfileId={state.activeProfileId}
        onSelectWorkspace={() => void window.copilotDesktop.selectWorkspace()}
        onActivateProfile={(profileId) => void window.copilotDesktop.activateProfile(profileId)}
        onOpenSettings={() => void window.copilotDesktop.openSettings()}
        onResumePicker={() => void window.copilotDesktop.createTab('picker')}
      />
      {state.activeProfileId === null ? (
        <div className="empty-state">
          <p>Choose a workspace folder to start a Copilot CLI session.</p>
        </div>
      ) : (
        <>
          <TabBar
            tabs={state.tabs}
            activeTabId={state.activeTabId}
            canOpenTab={state.tabs.length < state.maxSessionTabs}
            onActivate={(tabId) => void window.copilotDesktop.activateTab(tabId)}
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
    </div>
  )
}
