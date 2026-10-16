import { insertIntoPrompt } from './prompt-insert.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { DesktopState, FanOutResult } from '../main/types.js'
import { DiagnosticsView } from './components/DiagnosticsView.js'
import { Sidebar } from './components/Sidebar.js'
import { SessionWorkspace } from './components/SessionWorkspace.js'
import { SessionWindow } from './components/SessionWindow.js'
import { GitPanel } from './components/GitPanel.js'
import { GIT_PANEL_DEFAULT_WIDTH, ProjectDock } from './components/ProjectDock.js'
import { OperationError } from './components/OperationError.js'
import { errorMessage } from './errors.js'
import { canOpenSessionTab, desktopViewMode } from './desktop-view-state.js'
import { MAX_SESSION_TITLE_CHARS, worktreeNamePrefix } from '../main/session-name.js'

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

function readStoredGitOpen(): boolean {
  try { return localStorage.getItem('git-panel-open') === 'true' } catch { return false }
}

function readStoredGitWidth(): number {
  try {
    const value = Number(localStorage.getItem('git-panel-width'))
    return Number.isFinite(value) && value > 0 ? value : GIT_PANEL_DEFAULT_WIDTH
  } catch { return GIT_PANEL_DEFAULT_WIDTH }
}

type InputDialog =
  | { kind: 'rename'; tabId: string; value: string; pending: boolean; error: string | null }
  | { kind: 'remote'; value: string; pending: boolean; error: string | null }
  | { kind: 'fork'; tabId: string; value: string; sourceSessionId: string; pending: boolean; error: string | null }
  | { kind: 'fan-out'; value: string; count: number; pending: boolean; error: string | null }
  /** Names a session before it starts; `profileId` null means the active project. */
  | { kind: 'new-session'; profileId: string | null; attachments: boolean; value: string; pending: boolean; error: string | null }

export function App(): JSX.Element {
  const [state, setState] = useState<DesktopState>(EMPTY_STATE)
  const [loading, setLoading] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const [sidebarProjectsOpen, setSidebarProjectsOpen] = useState(false)
  const [inputDialog, setInputDialog] = useState<InputDialog | null>(null)
  const [gitOpen, setGitOpen] = useState(readStoredGitOpen)
  const [gitWidth, setGitWidth] = useState(readStoredGitWidth)
  // True only while the workspace is on screen, so the shortcut cannot flip the saved state where no panel can show.
  const gitPanelAvailable = useRef(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [fanOutNotice, setFanOutNotice] = useState<string | null>(null)
  const canOpenTab = canOpenSessionTab(state.resolution, state.tabs.length, state.maxSessionTabs)
  const newSessionProfile = inputDialog?.kind === 'new-session'
    ? state.profiles.find((profile) => profile.id === (inputDialog.profileId ?? state.activeProfileId)) ?? null
    : null
  const newSessionDefault = newSessionProfile?.name ?? null
  // Only a fresh session gets one; 'continue' and the picker resume an earlier session where it ran.
  const newSessionWorktree = Boolean(newSessionProfile?.launch?.worktree)
    && (inputDialog?.kind === 'new-session' && inputDialog.attachments || newSessionProfile?.defaultResumeMode === 'new' || newSessionProfile?.defaultResumeMode === 'auto-resume')
  const handleOperation = (operation: Promise<DesktopState>): void => {
    setOperationError(null)
    void operation.catch((error: unknown) => setOperationError(errorMessage(error)))
  }
  const toggleGit = useCallback((): void => {
    setGitOpen((open) => {
      const next = !open
      try { localStorage.setItem('git-panel-open', String(next)) } catch { /* Keep the in-memory state. */ }
      return next
    })
  }, [])
  const changeGitWidth = (width: number): void => {
    setGitWidth(width)
    try { localStorage.setItem('git-panel-width', String(Math.round(width))) } catch { /* Keep the in-memory width. */ }
  }
  /** Every way to start a fresh session asks for its name first; an open dialog is left as it is. */
  const openNewSession = (profileId: string | null = null, attachments = false): void => {
    setInputDialog((current) => current ?? { kind: 'new-session', profileId, attachments, value: '', pending: false, error: null })
  }
  const requestTabRename = (tabId: string, currentTitle: string): void => {
    setInputDialog({ kind: 'rename', tabId, value: currentTitle, pending: false, error: null })
  }

  /** Start the sessions (main does that one by one), then paste the task into each prompt box once the CLI shows its prompt.
   * Nothing is sent: the person presses Enter in each session. A session that never gets ready is left alone and named. */
  const startFanOut = async (profileId: string, prompt: string, count: number): Promise<void> => {
    const label = `fan-out · ${prompt.replace(/\s+/g, ' ').slice(0, 40)}`
    let result: FanOutResult
    try {
      result = await window.copilotDesktop.fanOut(profileId, label, count)
    } catch (error) {
      setInputDialog((current) => current ? { ...current, pending: false, error: error instanceof Error ? error.message : String(error) } : current)
      return
    }
    setInputDialog(null)
    const notReady: string[] = []
    const elsewhere: string[] = []
    await Promise.all(result.tabIds.map(async (tabId) => {
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        let backlog = ''
        let poppedOut = false
        try {
          poppedOut = ((await window.copilotDesktop.getState()).poppedOutTabIds ?? []).includes(tabId)
          backlog = await window.copilotDesktop.getTabBacklog(tabId)
        } catch { break }
        // A session opened in its own window owns its terminal there; a paste from this window cannot reach it.
        if (poppedOut) { elsewhere.push(tabId); return }
        if (backlog.includes('open sidebar')) {
          // Delivery is the pane's acknowledgement, not the dispatch.
          if (!insertIntoPrompt(tabId, prompt)) elsewhere.push(tabId)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      notReady.push(tabId)
    }))
    const latest = await window.copilotDesktop.getState().catch(() => null)
    const names = (ids: string[]): string => ids.map((id) => latest?.tabs.find((tab) => tab.id === id)?.title ?? id).join(', ')
    const missed = notReady.length + elsewhere.length
    const notes = [
      `Started ${result.tabIds.length} of ${result.requested} sessions.`,
      result.stopped ? result.stopped : '',
      notReady.length > 0 ? `${names(notReady)} did not show a prompt in time, so the task was not pasted there.` : '',
      elsewhere.length > 0 ? `${names(elsewhere)} ${elsewhere.length === 1 ? 'is' : 'are'} open in a separate window, where this window cannot paste; paste the task there yourself.` : '',
      missed === 0 ? 'The task is in each prompt box; press Enter in each session to send it.' : `The task is in the other ${result.tabIds.length - missed} prompt box${result.tabIds.length - missed === 1 ? '' : 'es'}; press Enter there to send it.`,
    ].filter(Boolean)
    setOperationError(result.stopped || missed > 0 ? notes.join(' ') : null)
    setFanOutNotice(notes.join(' '))
  }

  const submitInputDialog = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!inputDialog || inputDialog.pending) return
    const value = inputDialog.value.trim()
    const finish = (request: Promise<unknown>): void => {
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
    if (inputDialog.kind === 'new-session') {
      // An empty name keeps the default shown in the box: the project's name.
      setInputDialog({ ...inputDialog, pending: true, error: null })
      finish(inputDialog.attachments
        ? window.copilotDesktop.createTabWithAttachments(value || null)
        : window.copilotDesktop.createTab(null, inputDialog.profileId ?? undefined, value || null))
      return
    }
    if (!value) {
      setInputDialog({ ...inputDialog, error: inputDialog.kind === 'remote' ? 'Enter a session or task ID.' : inputDialog.kind === 'fan-out' ? 'Enter the task to start in every session.' : 'Enter a session title.' })
      return
    }
    if (inputDialog.kind === 'fan-out') {
      if (!state.activeProfileId) return
      setInputDialog({ ...inputDialog, pending: true, error: null })
      void startFanOut(state.activeProfileId, value, inputDialog.count)
      return
    }
    setInputDialog({ ...inputDialog, pending: true, error: null })
    const request = inputDialog.kind === 'remote'
      ? window.copilotDesktop.connectRemoteSession(value)
      : inputDialog.kind === 'fork'
        ? window.copilotDesktop.forkSideChat(inputDialog.tabId, inputDialog.sourceSessionId.trim(), value)
      : window.copilotDesktop.renameTab(inputDialog.tabId, value)
    finish(request)
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

  // Ctrl+Shift+G is handled in the main process, before the terminal sees it, and arrives here.
  useEffect(() => window.copilotDesktop.onGitToggle(() => { if (gitPanelAvailable.current) toggleGit() }), [toggleGit])
  // The File menu and the tray ask here, so their sessions are named in the same dialog.
  useEffect(() => window.copilotDesktop.onNewSessionRequest((attachments) => openNewSession(null, attachments)), [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.ctrlKey || event.metaKey
      if (!modifier) return
      if (state.windowSessionId) {
        if (event.key.toLowerCase() === 'w') {
          event.preventDefault()
          event.stopPropagation()
          handleOperation(window.copilotDesktop.dockTab(state.windowSessionId))
        }
        return
      }
      if (event.key.toLowerCase() === 't') {
        event.preventDefault()
        if (canOpenTab) openNewSession()
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
    const capture = Boolean(state.windowSessionId)
    window.addEventListener('keydown', handleKeyDown, capture)
    return () => window.removeEventListener('keydown', handleKeyDown, capture)
  }, [canOpenTab, state.activeTabId, state.windowSessionId])

  if (state.windowSessionId) {
    const tab = state.tabs.find(tab => tab.id === state.windowSessionId)
    return tab ? <SessionWindow tab={tab} error={operationError}
      onDismissError={() => setOperationError(null)}
      onReturn={() => handleOperation(window.copilotDesktop.dockTab(tab.id))}
      onRestart={() => handleOperation(window.copilotDesktop.restartTab(tab.id))} /> : <div className="loading-screen">Returning session…</div>
  }

  // "Add to prompt" fills the active session's prompt box, unless that session lives in another window.
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
  const promptTarget = activeTab && !(state.poppedOutTabIds ?? []).includes(activeTab.id) && activeTab.status !== 'completed' && activeTab.status !== 'crashed'
    ? { id: activeTab.id, title: activeTab.title } : null

  const viewMode = desktopViewMode(loading, state.resolution, state.tabs.length > 0)
  gitPanelAvailable.current = viewMode === 'desktop' && state.activeProfileId !== null

  if (viewMode === 'loading') {
    return (
      <div className="loading-screen">
        <p>Resolving the copilot CLI…</p>
      </div>
    )
  }

  if (viewMode === 'diagnostics') {
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
        installedCliVersion={state.resolution?.version ?? null}
        activeProfileId={state.activeProfileId}
        activeTabId={state.activeTabId}
        canOpenTab={canOpenTab}
        collapsed={sidebarCollapsed}
        onProjectsOpenChange={setSidebarProjectsOpen}
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
        onPopOutTab={(tabId) => handleOperation(window.copilotDesktop.popOutTab(tabId))}
        onRenameTab={requestTabRename}
        onCloseTab={(tabId) => handleOperation(window.copilotDesktop.closeTab(tabId))}
        onRestartTab={(tabId) => handleOperation(window.copilotDesktop.restartTab(tabId))}
        onCreateTab={(profileId) => openNewSession(profileId)}
        onCreateTabWithAttachments={() => openNewSession(null, true)}
        onFanOut={() => setInputDialog({ kind: 'fan-out', value: '', count: 3, pending: false, error: null })}
        onOpenSettings={() => void window.copilotDesktop.openSettings()}
        onResumePicker={() => handleOperation(window.copilotDesktop.createTab('picker'))}
        onConnectRemote={() => setInputDialog({ kind: 'remote', value: '', pending: false, error: null })}
      />
      <main className="main-content">
        {state.resolution?.version === null && state.tabs.length > 0 && (
          <DiagnosticsView
            compact
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
        )}
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
          {operationError && <OperationError message={operationError} onDismiss={() => setOperationError(null)} />}
          <ProjectDock open={gitOpen} width={gitWidth} onWidthChange={changeGitWidth}
            panel={({ takeover }) => <GitPanel key={state.activeProfileId} profileId={state.activeProfileId!} takeover={takeover} onClose={toggleGit}
              promptTarget={promptTarget} sessionWorktreePath={activeTab?.worktree?.path ?? null}
              worktreeSessions={state.tabs.flatMap((tab) => tab.worktree ? [{ path: tab.worktree.path, title: tab.title }] : [])} />}>
          <SessionWorkspace tabs={state.tabs} activeTabId={state.activeTabId} canOpenTab={canOpenTab}
            gitOpen={gitOpen} onToggleGit={toggleGit}
            obscured={inputDialog !== null || sidebarProjectsOpen}
            poppedOutTabIds={state.poppedOutTabIds ?? []}
            onPopOut={(tabId) => handleOperation(window.copilotDesktop.popOutTab(tabId))}
            onActivate={(tabId) => handleOperation(window.copilotDesktop.activateTab(tabId))}
            onClose={(tabId) => handleOperation(window.copilotDesktop.closeTab(tabId))}
            onRestart={(tabId) => handleOperation(window.copilotDesktop.restartTab(tabId))}
            onCreate={() => openNewSession()}
            onFork={(tab) => setInputDialog({ kind: 'fork', tabId: tab.id, value: `Side: ${tab.title}`.slice(0, 120), sourceSessionId: tab.lastSessionId ?? '', pending: false, error: null })} />
          </ProjectDock>
          </>
        )}
      </main>
      {fanOutNotice && (
        <div className="fan-out-notice" role="status">
          <span>{fanOutNotice}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setFanOutNotice(null)}>×</button>
        </div>
      )}
      {inputDialog && (
        <div className="dialog-backdrop" role="presentation">
          <form className="input-dialog" role="dialog" aria-modal="true" aria-labelledby="input-dialog-title" onSubmit={submitInputDialog}
            onKeyDown={(event) => { if (event.key === 'Escape' && !inputDialog.pending) { event.preventDefault(); setInputDialog(null) } }}>
            <h2 id="input-dialog-title">
              {inputDialog.kind === 'remote' ? 'Connect to remote session' : inputDialog.kind === 'fork' ? 'Fork into side chat' : inputDialog.kind === 'fan-out' ? 'Fan out into several sessions' : inputDialog.kind === 'new-session' ? (inputDialog.attachments ? 'New session with attachments' : 'New session') : 'Rename session'}
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
            {inputDialog.kind === 'fan-out' && (
              <>
                <p>Starts the same task in several fresh sessions, each in its own Git worktree, one after another. The task is pasted into each prompt box; nothing is sent until you press Enter in each session.</p>
                <p className="fork-hint">Each session is a separate Copilot conversation and uses premium requests on its own.</p>
                <label htmlFor="fan-out-count">Sessions</label>
                <select id="fan-out-count" value={inputDialog.count} disabled={inputDialog.pending}
                  onChange={(event) => setInputDialog({ ...inputDialog, count: Number(event.target.value), error: null })}>
                  {[2, 3, 4, 5].map((n) => <option key={n} value={n} disabled={n > state.maxSessionTabs - state.tabs.length}>{n}</option>)}
                </select>
              </>
            )}
            <label htmlFor="input-dialog-value">
              {inputDialog.kind === 'remote' ? 'Remote Copilot session or task ID' : inputDialog.kind === 'fan-out' ? 'Task for every session' : inputDialog.kind === 'new-session' ? 'Session name' : 'Session title'}
            </label>
            <input
              id="input-dialog-value"
              type="text"
              autoFocus
              maxLength={inputDialog.kind === 'remote' ? 128 : inputDialog.kind === 'fan-out' ? 4000 : MAX_SESSION_TITLE_CHARS}
              value={inputDialog.value}
              placeholder={newSessionDefault ?? undefined}
              disabled={inputDialog.pending}
              onChange={(event) => setInputDialog({ ...inputDialog, value: event.target.value, error: null })}
            />
            {inputDialog.kind === 'new-session' && newSessionDefault !== null && (
              <p className="fork-hint">
                Leave it empty and Copilot names the session from your first prompt; until then the tab shows “{newSessionDefault}”.
                {newSessionWorktree && <> It starts in its own Git worktree and branch, <code>{worktreeNamePrefix(inputDialog.value.trim() || newSessionDefault)}-…</code>, named from this.</>}
              </p>
            )}
            {inputDialog.error && <p className="input-dialog-error" role="alert">{inputDialog.error}</p>}
            <div className="input-dialog-actions">
              <button type="button" disabled={inputDialog.pending} onClick={() => setInputDialog(null)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={inputDialog.pending}>
                {inputDialog.pending ? (inputDialog.kind === 'fan-out' ? 'Starting sessions…' : 'Working…') : inputDialog.kind === 'remote' ? 'Connect' : inputDialog.kind === 'fork' ? 'Fork side chat' : inputDialog.kind === 'fan-out' ? `Start ${inputDialog.count} sessions` : inputDialog.kind === 'new-session' ? (inputDialog.attachments ? 'Choose files…' : 'Start session') : 'Rename'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
