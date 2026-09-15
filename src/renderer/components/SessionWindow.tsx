import type { JSX } from 'react'
import type { DesktopSessionTab } from '../../main/types.js'
import { TerminalPane } from './TerminalPane.js'
import { OperationError } from './OperationError.js'

export function SessionWindow({ tab, error, onReturn, onRestart, onDismissError }: {
  tab: DesktopSessionTab
  error: string | null
  onReturn: () => void
  onRestart: () => void
  onDismissError?: () => void
}): JSX.Element {
  const status = tab.status === 'running' ? (tab.activity === 'working' ? 'Working' : tab.activity === 'idle' ? 'Idle' : 'Open') : tab.status
  return <main className="session-window" aria-label={`Session window: ${tab.title}`}>
    <header className="session-pane-header">
      <span className="session-pane-title" title={tab.title}>{tab.title}</span>
      <span role="status">{status}</span>
      {tab.sideChat && <span className="side-chat-badge" title={tab.permissionWarning ?? undefined}>Read/search only</span>}
      {!tab.remote && <button type="button" className="icon-button" aria-label={`Restart ${tab.title}`} title="Restart session"
        disabled={tab.status === 'starting' || tab.status === 'stopping'} onClick={onRestart}>↻</button>}
      <button type="button" onClick={onReturn} title="Return without stopping the session (Ctrl+W)">Return to main window</button>
    </header>
    {error && <OperationError message={error} {...(onDismissError ? { onDismiss: onDismissError } : {})} />}
    <div className="session-terminal"><TerminalPane tabId={tab.id} active sessionProcessId={tab.processId} /></div>
  </main>
}
