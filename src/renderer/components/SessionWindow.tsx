import { useState } from 'react'
import type { JSX } from 'react'
import type { DesktopControlTabView, DesktopSessionTab } from '../../main/types.js'
import { DesktopControlPanel, DesktopControlToggle } from './DesktopControlPanel.js'
import { SessionTerminal } from './SessionTerminal.js'
import { OperationError } from './OperationError.js'

export function SessionWindow({ tab, browserPoppedOut = false, error, onReturn, onRestart, onShowLog, onDismissError, desktopControl }: {
  tab: DesktopSessionTab
  browserPoppedOut?: boolean
  desktopControl?: { allowed: boolean; ready: boolean; view: DesktopControlTabView | undefined }
  error: string | null
  onReturn: () => void
  onRestart: () => void
  onShowLog: () => void
  onDismissError?: () => void
}): JSX.Element {
  const [browserError, setBrowserError] = useState<string | null>(null)
  const [desktopPanel, setDesktopPanel] = useState(false)
  const showDesktop = desktopControl !== undefined && !tab.sideChat && !tab.remote && !tab.cli && (desktopControl.allowed || desktopControl.view?.enabled === true)
  const status = tab.status === 'running' ? (tab.activity === 'working' ? 'Working' : tab.activity === 'idle' ? 'Idle' : 'Open') : tab.status === 'dormant' ? 'Not running' : tab.status
  return <main className="session-window" aria-label={`Session window: ${tab.title}`}>
    <header className="session-pane-header">
      <span className="session-pane-title" title={tab.title}>{tab.title}</span>
      <button type="button" onClick={() => { void window.copilotDesktop.showBrowserInMain(tab.id).catch(error => setBrowserError(String(error))) }}>Show browser in main window</button>
      {showDesktop && <DesktopControlToggle view={desktopControl!.view} open={desktopPanel} onToggle={() => setDesktopPanel(open => !open)} />}
      <span role="status">{status}</span>
      {tab.sideChat && <span className="side-chat-badge" title={tab.permissionWarning ?? undefined}>Read/search only</span>}
      {!tab.remote && <button type="button" className="icon-button" aria-label={`Restart ${tab.title}`} title="Restart session"
        disabled={tab.status === 'starting' || tab.status === 'stopping'} onClick={onRestart}>↻</button>}
      <button type="button" onClick={onReturn} title="Return without stopping the session (Ctrl+W)">Return to main window</button>
    </header>
    {showDesktop && desktopPanel && <DesktopControlPanel tab={tab} allowed={desktopControl!.allowed} ready={desktopControl!.ready} view={desktopControl!.view} />}
    {browserError && <OperationError message={browserError} onDismiss={() => setBrowserError(null)} />}
    {error && <OperationError message={error} {...(onDismissError ? { onDismiss: onDismissError } : {})} />}
    <SessionTerminal tab={tab} active onRestart={onRestart} onShowLog={onShowLog} />

  </main>
}
