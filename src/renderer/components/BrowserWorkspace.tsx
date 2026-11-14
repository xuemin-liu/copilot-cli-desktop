import { useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { DesktopSessionTab } from '../../main/types.js'
import { errorMessage } from '../errors.js'
import { BrowserIcon } from './Icons.js'
import { BrowserPanel } from './BrowserPanel.js'

export function BrowserWorkspace({ children, tabId, active = true, obscured = false, poppedOut = false, renderHeader }: {
  children: ReactNode; tabId: string; active?: boolean; obscured?: boolean;
  /** The browser is in its own window, so the terminal keeps the whole width here. */
  poppedOut?: boolean;
  renderHeader?: (browserToggle: ReactNode) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [split, setSplit] = useState(50)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const wasPoppedOut = useRef(poppedOut)
  // A browser that comes back from its own window opens beside the terminal again.
  useEffect(() => {
    if (wasPoppedOut.current && !poppedOut) setOpen(true)
    wasPoppedOut.current = poppedOut
  }, [poppedOut])
  const request = (promise: Promise<unknown>): void => { setError(null); void promise.catch(error => setError(errorMessage(error))) }
  const changeSplit = (value: number): void => setSplit(Math.min(75, Math.max(25, value)))
  const shown = open && !poppedOut
  const toggleLabel = poppedOut ? 'Show browser window' : open ? 'Hide browser' : 'Open browser'
  const toggle = <>
    <button type="button" className="icon-button session-browser-toggle" aria-expanded={shown} aria-label={toggleLabel} title={toggleLabel} disabled={!active}
      onClick={() => poppedOut ? request(window.copilotDesktop.popOutBrowser(tabId)) : setOpen(value => !value)}><BrowserIcon /></button>
    {poppedOut
      ? <button type="button" className="icon-button" aria-label="Bring browser back to this window" title="Bring browser back to this window" disabled={!active}
        onClick={() => request(window.copilotDesktop.dockBrowser(tabId))}>↙</button>
      : open && <button type="button" className="icon-button" aria-label="Open browser in new window" title="Open browser in new window" disabled={!active}
        onClick={() => request(window.copilotDesktop.popOutBrowser(tabId))}>⧉</button>}
    {error && <span className="browser-workspace-error" role="alert" title={error}>{error}</span>}
  </>
  return <div className="browser-workspace">
    {renderHeader ? renderHeader(toggle) : <div className="browser-workspace-toolbar">{toggle}</div>}
    <div ref={root} className="browser-workspace-content" style={{ gridTemplateColumns: shown && active ? `minmax(0, ${split}fr) 6px minmax(0, ${100 - split}fr)` : 'minmax(0, 1fr)' }}>
      <div className="browser-terminal-workspace">{children}</div>
      {shown && <><div className="side-chat-divider" style={{ display: active ? undefined : 'none' }} role="separator" tabIndex={0} aria-label="Resize browser" aria-orientation="vertical" aria-valuenow={split} aria-valuemin={25} aria-valuemax={75}
        onPointerDown={event => { event.preventDefault(); dragging.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => { if (dragging.current !== event.pointerId) return; const b = root.current?.getBoundingClientRect(); if (b?.width) changeSplit((event.clientX - b.left) / b.width * 100) }}
        onPointerUp={event => { dragging.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
        onLostPointerCapture={() => { dragging.current = null }}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); changeSplit(event.key === 'Home' ? 25 : event.key === 'End' ? 75 : split + (event.key === 'ArrowLeft' ? -2 : 2)) } }} />
        <BrowserPanel tabId={tabId} active={active} obscured={obscured} /></>}
    </div>
  </div>
}

/** A session's browser alone in its own window. Returning it (or closing the window) shows it beside the terminal again. */
export function BrowserOnlyWindow({ tab, onReturn }: { tab: DesktopSessionTab; onReturn: () => void }): JSX.Element {
  return <main className="browser-only-window" aria-label={`Browser window: ${tab.title}`}>
    <header className="session-pane-header">
      <span className="session-pane-title" title={tab.title}><BrowserIcon /> {tab.title}</span>
      <button type="button" onClick={onReturn} title="Show the browser beside the session's terminal again (Ctrl+W)">Return browser to session</button>
    </header>
    <BrowserPanel tabId={tab.id} active={tab.status !== 'dormant'} obscured={false} detached />
  </main>
}
