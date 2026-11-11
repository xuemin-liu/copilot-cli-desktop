import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import type { DesktopSessionTab } from '../../main/types.js'

export interface StoppedNoticeContent {
  heading: string
  text: string | null
  /** The label of the button that starts the session again, or null where it cannot be started from here. */
  action: string | null
  showLog: boolean
}

type NoticeTab = Pick<DesktopSessionTab, 'status' | 'remote'>

/** A session without a process: its terminal takes no input until it is resumed or restarted. */
export function sessionStopped(tab: NoticeTab): boolean {
  return tab.status === 'dormant' || tab.status === 'crashed' || tab.status === 'completed'
}

/** What to say over a terminal whose session has no process, or null for one that runs. The text makes no promise
 * about the conversation: a restart resumes it only when the CLI still has it stored. */
export function stoppedNoticeContent(tab: NoticeTab): StoppedNoticeContent | null {
  if (tab.status === 'starting') return { heading: 'Starting…', text: null, action: null, showLog: false }
  if (!sessionStopped(tab)) return null
  // A remote tab cannot be restarted here. Only its connection is known to have ended, not the remote session.
  if (tab.remote) return { heading: 'The connection to this remote session ended', text: 'Close this tab and connect again to continue.', action: null, showLog: false }
  if (tab.status === 'dormant') return { heading: 'This session is not running', text: 'Resume to start it again.', action: 'Resume session', showLog: false }
  if (tab.status === 'crashed') return { heading: 'This session stopped unexpectedly', text: 'Restart to start it again.', action: 'Restart session', showLog: true }
  return { heading: 'This session has ended', text: 'Restart to start it again.', action: 'Restart session', showLog: false }
}

export interface SessionStoppedNoticeProps {
  tab: NoticeTab
  /** The terminal still shows text: the notice is a bar under it, not a card over it. */
  hasText: boolean
  /** The pane is on screen and is the one that has the keyboard. Only then does the button take the focus. */
  focused: boolean
  onRestart: () => void
  onShowLog: () => void
}

export function SessionStoppedNotice({ tab, hasText, focused, onRestart, onShowLog }: SessionStoppedNoticeProps): JSX.Element | null {
  const content = stoppedNoticeContent(tab)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const wasFocused = useRef(false)
  const action = content?.action ?? null
  useEffect(() => {
    const becameFocused = focused && !wasFocused.current
    wasFocused.current = focused
    if (!focused || !action) return
    // Selecting the pane gives its button the focus, so Enter resumes. When the session stops while the pane is
    // already selected, take the focus only from the pane itself: never from a field elsewhere the person types in.
    const current = document.activeElement
    const pane = rootRef.current?.closest('.session-pane, .session-window')
    if (becameFocused || !current || current === document.body || pane?.contains(current)) buttonRef.current?.focus()
  }, [focused, action])
  // A session that is starting says so only over an empty terminal; a bar would resize a restarting one twice.
  if (!content || (tab.status === 'starting' && hasText)) return null
  const buttons = (content.action || content.showLog) && <div className="session-stopped-actions">
    {content.action && <button ref={buttonRef} type="button" className="primary-button" onClick={onRestart}>{content.action}</button>}
    {content.showLog && <button type="button" onClick={onShowLog}>Show log</button>}
  </div>
  return <div ref={rootRef} className={`session-stopped-notice ${hasText ? 'session-stopped-bar' : 'session-stopped-overlay'}`} role="status">
    <div className="session-stopped-card">
      <p className="session-stopped-heading">{content.heading}</p>
      {content.text && <p className="session-stopped-text">{content.text}</p>}
      {buttons}
    </div>
  </div>
}
