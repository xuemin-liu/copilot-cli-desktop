import { useState } from 'react'
import type { JSX } from 'react'
import type { DesktopControlTabView, DesktopSessionTab } from '../../main/types.js'
import { DesktopControlPanel, DesktopControlToggle } from './DesktopControlPanel.js'
import { TerminalPane } from './TerminalPane.js'
import { OperationError } from './OperationError.js'
import { BrowserWorkspace } from './BrowserWorkspace.js'

export function SessionWindow({ tab, browserPoppedOut = false, error, onReturn, onRestart, onDismissError, desktopControl }: {
  tab: DesktopSessionTab
  browserPoppedOut?: boolean
  desktopControl?: { allowed: boolean; ready: boolean; view: DesktopControlTabView | undefined }
  error: string | null
  onReturn: () => void
  onRestart: () => void
  onDismissError?: () => void
}): JSX.Element {
  const [desktopPanel, setDesktopPanel] = useState(false)
  const showDesktop = desktopControl !== undefined && !tab.sideChat && !tab.remote && (desktopControl.allowed || desktopControl.view?.enabled === true)
  const status = tab.status === 'running' ? (tab.activity === 'working' ? 'Working' : tab.activity === 'idle' ? 'Idle' : 'Open') : tab.status
  return <main className="session-window" aria-label={`Session window: ${tab.title}`}>
    <BrowserWorkspace tabId={tab.id} poppedOut={browserPoppedOut} renderHeader={browserToggle => <><header className="session-pane-header">
      <span className="session-pane-title" title={tab.title}>{tab.title}</span>
      {browserToggle}
      {showDesktop && <DesktopControlToggle view={desktopControl!.view} open={desktopPanel} onToggle={() => setDesktopPanel(open => !open)} />}
      <span role="status">{status}</span>
      {tab.sideChat && <span className="side-chat-badge" title={tab.permissionWarning ?? undefined}>Read/search only</span>}
      {!tab.remote && <button type="button" className="icon-button" aria-label={`Restart ${tab.title}`} title="Restart session"
        disabled={tab.status === 'starting' || tab.status === 'stopping'} onClick={onRestart}>↻</button>}
      <button type="button" onClick={onReturn} title="Return without stopping the session (Ctrl+W)">Return to main window</button>
    </header>
    {showDesktop && desktopPanel && <DesktopControlPanel tab={tab} allowed={desktopControl!.allowed} ready={desktopControl!.ready} view={desktopControl!.view} />}</>}>
    {error && <OperationError message={error} {...(onDismissError ? { onDismiss: onDismissError } : {})} />}
    <div className="session-terminal"><TerminalPane tabId={tab.id} active sessionProcessId={tab.processId} /></div>
    </BrowserWorkspace>
  </main>
}
