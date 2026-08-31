import { useEffect, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { DesktopState } from '../main/types.js'
import { DiagnosticsView } from './components/DiagnosticsView.js'
import { Sidebar } from './components/Sidebar.js'
import { TabBar } from './components/TabBar.js'
import { SessionWorkspace } from './components/SessionWorkspace.js'

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

type InputDialog =
  | { kind: 'rename'; tabId: string; value: string; pending: boolean; error: string | null }
  | { kind: 'remote'; value: string; pending: boolean; error: string | null }
  | { kind: 'fork'; tabId: string; value: string; sourceSessionId: string; pending: boolean; error: string | null }

export function App(): JSX.Element {
  const [state, setState] = useState<DesktopState>(EMPTY_STATE)
  const [loading, setLoading] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const [inputDialog, setInputDialog] = useState<InputDialog | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const handleOperation = (operation: Promise<DesktopState>): void => {
    setOperationError(null)
    void operation.catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error)))
  }
  const requestTabRename = (tabId: string, currentTitle: string): void => {
    setInputDialog({ kind: 'rename', tabId, value: currentTitle, pending: false, error: null })
  }

  const submitInputDialog = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!inputDialog || inputDialog.pending) return
    const value = inputDialog.value.trim()
    if (!value) {
      setInputDialog({ ...inputDialog, error: inputDialog.kind === 'remote' ? 'Enter a session or task ID.' : 'Enter a session title.' })
      return
    }
    setInputDialog({ ...inputDialog, pending: true, error: null })
    const request = inputDialog.kind === 'remote'
      ? window.copilotDesktop.connectRemoteSession(value)
      : inputDialog.kind === 'fork'
        ? window.copilotDesktop.forkSideChat(inputDialog.tabId, inputDialog.sourceSessionId.trim(), value)
      : window.copilotDesktop.renameTab(inputDialog.tabId, value)
    void request
      .then(() => setInputDialog(null))
      .catch((error: unknown) => {
        setInputDialog((current) => current ? {
          ...current,
          pending: false,
          error: error instanceof Error ? error.message : String(error),
        } : current)
      })
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
        window.copilotDesktop.closeTab(state.activeTabId).catch((error: unknown) => {
          console.error('Failed to close session tab', error)
        })
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
        onConnectRemote={() => setInputDialog({ kind: 'remote', value: '', pending: false, error: null })}
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
            onClose={(tabId) => {
              window.copilotDesktop.closeTab(tabId).catch((error: unknown) => {
                console.error('Failed to close session tab', error)
              })
            }}
            onRestart={(tabId) => {
              // The main process can still reject a restart (an update
              // installing, a tab closed out from under a queued restart) —
              // that rejection needs a handler here or it surfaces as an
              // unhandled promise rejection in the renderer.
              window.copilotDesktop.restartTab(tabId).catch((error: unknown) => {
                console.error('Failed to restart session tab', error)
              })
            }}
            onCreate={() => void window.copilotDesktop.createTab()}
          />
          {operationError && <div className="session-operation-error" role="alert">{operationError}<button type="button" onClick={() => setOperationError(null)} aria-label="Dismiss error">×</button></div>}
          <SessionWorkspace tabs={state.tabs} activeTabId={state.activeTabId} canOpenTab={state.tabs.length < state.maxSessionTabs}
            onActivate={(tabId) => handleOperation(window.copilotDesktop.activateTab(tabId))}
            onClose={(tabId) => handleOperation(window.copilotDesktop.closeTab(tabId))}
            onRestart={(tabId) => handleOperation(window.copilotDesktop.restartTab(tabId))}
            onCreate={() => handleOperation(window.copilotDesktop.createTab())}
            onFork={(tab) => setInputDialog({ kind: 'fork', tabId: tab.id, value: `Side: ${tab.title}`.slice(0, 120), sourceSessionId: tab.lastSessionId ?? '', pending: false, error: null })} />
          </>
        )}
      </main>
      {inputDialog && (
        <div className="dialog-backdrop" role="presentation">
          <form className="input-dialog" role="dialog" aria-modal="true" aria-labelledby="input-dialog-title" onSubmit={submitInputDialog}>
            <h2 id="input-dialog-title">
              {inputDialog.kind === 'remote' ? 'Connect to remote session' : inputDialog.kind === 'fork' ? 'Fork into side chat' : 'Rename session'}
            </h2>
            {inputDialog.kind === 'fork' && (
              <>
                <p>Copies saved history into a separate right-hand terminal. The main session keeps running; later messages are not merged.</p>
                <label htmlFor="fork-source-id">Source session UUID</label>
                <input id="fork-source-id" type="text" value={inputDialog.sourceSessionId} required maxLength={36} disabled={inputDialog.pending}
                  onChange={(event) => setInputDialog({ ...inputDialog, sourceSessionId: event.target.value, error: null })} />
                <p className="fork-hint">Last ID known to Desktop. If you used /fork, /resume, /new, or /clear inside Copilot, check /session and enter the current ID here.</p>
                <p className="fork-hint">Read/search tools only. Both sessions share files; this is not an OS sandbox and does not isolate local hooks or manually entered commands. Unfinished output may not yet be saved.</p>
              </>
            )}
            <label htmlFor="input-dialog-value">
              {inputDialog.kind === 'remote' ? 'Remote Copilot session or task ID' : 'Session title'}
            </label>
            <input
              id="input-dialog-value"
              type="text"
              autoFocus
              maxLength={inputDialog.kind === 'remote' ? 128 : 120}
              value={inputDialog.value}
              disabled={inputDialog.pending}
              onChange={(event) => setInputDialog({ ...inputDialog, value: event.target.value, error: null })}
            />
            {inputDialog.error && <p className="input-dialog-error" role="alert">{inputDialog.error}</p>}
            <div className="input-dialog-actions">
              <button type="button" disabled={inputDialog.pending} onClick={() => setInputDialog(null)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={inputDialog.pending}>
                {inputDialog.pending ? 'Working…' : inputDialog.kind === 'remote' ? 'Connect' : inputDialog.kind === 'fork' ? 'Fork side chat' : 'Rename'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
