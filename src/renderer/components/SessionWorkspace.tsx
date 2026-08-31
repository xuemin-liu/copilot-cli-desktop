import { useRef, useState } from 'react'
import type { JSX } from 'react'
import type { DesktopSessionTab } from '../../main/types.js'
import { visibleSessionTabs } from '../../main/session-tab-machine.js'
import { TerminalPane } from './TerminalPane.js'

interface SessionWorkspaceProps {
  tabs: DesktopSessionTab[]
  activeTabId: string | null
  canOpenTab: boolean
  onActivate: (tabId: string) => void
  onFork: (tab: DesktopSessionTab) => void
  onClose: (tabId: string) => void
  onRestart: (tabId: string) => void
  onCreate: () => void
}

function savedSplit(): number {
  try {
    const value = Number(localStorage.getItem('side-chat-split') ?? 55)
    return Number.isFinite(value) ? Math.min(75, Math.max(25, value)) : 55
  } catch { return 55 }
}

export function SessionWorkspace({ tabs, activeTabId, canOpenTab, onActivate, onFork, onClose, onRestart, onCreate }: SessionWorkspaceProps): JSX.Element {
  const { main, side } = visibleSessionTabs({ tabs, activeTabId })
  const [split, setSplit] = useState(savedSplit)
  const areaRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const updateSplit = (value: number): void => {
    const next = Math.min(75, Math.max(25, value))
    setSplit(next)
    try { localStorage.setItem('side-chat-split', String(next)) } catch { /* Keep the in-memory size. */ }
  }

  return (
    <div ref={areaRef} className={`terminal-area${side ? ' terminal-area-split' : ''}`}
      style={{ gridTemplateColumns: side ? `minmax(0, ${split}fr) 6px minmax(0, ${100 - split}fr)` : 'minmax(0, 1fr)' }}>
      {tabs.length === 0 && (
        <div className="empty-state">
          <p>No session tabs are open.</p>
          <button type="button" onClick={onCreate}>Start a session</button>
        </div>
      )}
      {/* Keep every terminal under the same keyed parent. Docking, focusing,
          hiding, and closing a neighbor must not remount another xterm. */}
      {tabs.map((tab) => {
        const visible = tab.id === main?.id || tab.id === side?.id
        const focused = tab.id === activeTabId
        const busy = tab.status === 'starting' || tab.status === 'stopping'
        return (
          <section key={tab.id} className={`session-pane${visible ? ' session-pane-visible' : ''}${focused ? ' session-pane-focused' : ''}`}
            style={{ gridColumn: tab.id === side?.id ? 3 : 1 }}
            aria-label={`${tab.sideChat ? 'Side chat' : 'Main session'}: ${tab.title}`}
            onFocusCapture={() => { if (!focused) onActivate(tab.id) }}
            onPointerDown={() => { if (!focused) onActivate(tab.id) }}>
            <header className="session-pane-header">
              <span className="session-pane-title" title={tab.title}>{tab.title}</span>
              {tab.sideChat ? (
                <>
                  <span className="side-chat-badge" title={tab.permissionWarning ?? 'Only file-view and search tools are exposed to the model; not an OS sandbox.'}>Read/search only</span>
                  <button type="button" onClick={() => onClose(tab.id)} aria-label={`Close side chat ${tab.title}`} title="Close side chat — keep the main session running">×</button>
                </>
              ) : !tab.remote && (
                <button type="button" disabled={busy || !canOpenTab || side !== null || !tab.canFork || tab.status === 'completed' || tab.status === 'crashed'}
                  title={!tab.canFork ? 'Requires Copilot CLI 1.0.82 or newer; update and restart this tab' : side ? 'Close the existing side chat before forking again' : 'Copy saved conversation history into an independent right-hand pane'}
                  onClick={() => onFork(tab)}>Fork into side chat</button>
              )}
            </header>
            <div className="session-terminal">
              <TerminalPane tabId={tab.id} active={visible} focused={focused} sessionProcessId={tab.processId} />
              {tab.status === 'crashed' && !tab.remote && (
                <button type="button" className="restart-button" onClick={() => onRestart(tab.id)}>Restart this session</button>
              )}
            </div>
          </section>
        )
      })}
      {side && (
        <div className="side-chat-divider" role="separator" aria-label="Resize side chat" aria-orientation="vertical"
          aria-valuenow={Math.round(split)} aria-valuemin={25} aria-valuemax={75} tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault()
            dragging.current = event.pointerId
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (dragging.current !== event.pointerId) return
            const bounds = areaRef.current?.getBoundingClientRect()
            if (bounds?.width) updateSplit((event.clientX - bounds.left) / bounds.width * 100)
          }}
          onPointerUp={(event) => {
            dragging.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onLostPointerCapture={() => { dragging.current = null }}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            updateSplit(event.key === 'Home' ? 25 : event.key === 'End' ? 75 : split + (event.key === 'ArrowLeft' ? -2 : 2))
          }} />
      )}
    </div>
  )
}
