import { useState } from 'react'
import type { JSX } from 'react'
import type { DesktopSessionTab } from '../../main/types.js'
import { TerminalPane } from './TerminalPane.js'
import { SessionStoppedNotice, sessionStopped, stoppedNoticeContent } from './SessionStoppedNotice.js'

export interface SessionTerminalProps {
  tab: DesktopSessionTab
  /** The pane is on screen. */
  active: boolean
  focused?: boolean
  onRestart: () => void
  onShowLog: () => void
}

/** A session's terminal with the notice that explains it when the session has no process. The terminal stays
 * mounted under the notice, so output from before the session stopped is kept. */
export function SessionTerminal({ tab, active, focused = active, onRestart, onShowLog }: SessionTerminalProps): JSX.Element {
  const [hasText, setHasText] = useState(false)
  const notice = stoppedNoticeContent(tab) !== null && !(tab.status === 'starting' && hasText)
  return <div className={`session-terminal${notice && hasText ? ' session-terminal-with-bar' : ''}`}>
    <TerminalPane tabId={tab.id} active={active} focused={focused} sessionProcessId={tab.processId}
      stopped={sessionStopped(tab)} onHasTextChange={setHasText} />
    <SessionStoppedNotice tab={tab} hasText={hasText} focused={active && focused} onRestart={onRestart} onShowLog={onShowLog} />
  </div>
}
