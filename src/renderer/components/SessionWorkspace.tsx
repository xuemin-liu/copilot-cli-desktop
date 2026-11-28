import { useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { DesktopSessionTab } from '../../main/types.js'
import { visibleSessionTabs } from '../../main/session-tab-machine.js'
import { sessionCliLabel } from '../../main/session-cli.js'
import { SessionTerminal } from './SessionTerminal.js'
import { terminalLayout } from '../tool-dock-state.js'
import { BrowserIcon, GitBranchIcon, SideChatIcon } from './Icons.js'
import { DesktopControlPanel, DesktopControlToggle } from './DesktopControlPanel.js'
import type { DesktopControlTabView } from '../../main/types.js'

interface SessionWorkspaceProps {
  tabs: DesktopSessionTab[]
  activeTabId: string | null
  activeProfileId?: string | null
  canOpenTab: boolean
  onActivate: (tabId: string) => void
  onFork: (tab: DesktopSessionTab) => void
  onClose: (tabId: string) => void
  onRestart: (tabId: string) => void
  /** Clear the named saved settings of a tab that could not launch with them, then start it again. */
  onUseCliSettings?: (tabId: string, keys: string[]) => void
  onShowLog: (tabId: string) => void
  onCreate: () => void
  /** Project tools live in the existing session toolbar; also available with no sessions. */
  toolsControl?: ReactNode
  poppedOutTabIds?: string[]
  onPopOut?: (tabId: string) => void
  /** Browser controls select a session in the shared tools dock. */
  browserOpenId?: string | null
  onOpenBrowser?: (tabId: string) => void
  /** Git panel toggle in the main session's header. Omitted where the panel is not available. */
  gitOpen?: boolean
  onToggleGit?: () => void
  /** Desktop control: allowed in Settings, which sessions started with its helper, and each session's state. */
  desktopControlAllowed?: boolean
  desktopControlReadyTabIds?: string[]
  desktopControl?: Record<string, DesktopControlTabView>
  /** Optional temporary reviewer tab being peeked in the right-hand split pane without leaving the host tab. */
  peekTabId?: string | null
  /** Renderer-local keyboard focus when the user focuses a peeked temporary reviewer pane. */
  focusedPeekTabId?: string | null
  onFocusPeek?: (tabId: string | null) => void
  onClearPeek?: () => void
}

function savedSplit(): number {
  try {
    const value = Number(localStorage.getItem('side-chat-split') ?? 55)
    return Number.isFinite(value) ? Math.min(75, Math.max(25, value)) : 55
  } catch { return 55 }
}

export function SessionWorkspace({ tabs, activeTabId, activeProfileId = null, canOpenTab, onActivate, onFork, onClose, onRestart, onUseCliSettings, onShowLog, onCreate, toolsControl, poppedOutTabIds = [], onPopOut, browserOpenId = null, onOpenBrowser, gitOpen = false, onToggleGit, desktopControlAllowed = false, desktopControlReadyTabIds = [], desktopControl = {}, peekTabId = null, focusedPeekTabId = null, onFocusPeek, onClearPeek }: SessionWorkspaceProps): JSX.Element {
  const { main, side } = visibleSessionTabs({ tabs, activeTabId }, peekTabId, activeProfileId)
  const effectiveFocusedPeekId = focusedPeekTabId && focusedPeekTabId === peekTabId ? focusedPeekTabId : null
  const focusedTabId = effectiveFocusedPeekId ?? activeTabId
  const activatePane = (tab: DesktopSessionTab): void => {
    if (tab.tempReviewer) {
      onFocusPeek?.(tab.id)
      return
    }
    if (effectiveFocusedPeekId !== null) onFocusPeek?.(null)
    if (tab.id !== activeTabId) onActivate(tab.id)
  }
  const [split, setSplit] = useState(savedSplit)
  const [desktopPanels, setDesktopPanels] = useState<ReadonlySet<string>>(new Set())
  const toggleDesktopPanel = (tabId: string): void => setDesktopPanels(open => {
    const next = new Set(open)
    if (!next.delete(tabId)) next.add(tabId)
    return next
  })
  const areaRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  useEffect(() => {
    const element = areaRef.current
    if (!element) return
    const measure = (): void => {
      const width = Math.round(element.getBoundingClientRect().width)
      if (width > 0) setAvailable(width)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])
  const layout = terminalLayout(available, side !== null, split)
  const showSplit = side !== null && !layout.single
  const standaloneReviewer = Boolean(main?.tempReviewer && !side)
  const hasTopBar = Boolean((side && layout.single) || (standaloneReviewer && toolsControl))
  const compactActiveId = side && layout.single
    ? (focusedTabId === side.id ? side.id : main?.id ?? null)
    : null
  const dragging = useRef<number | null>(null)
  const updateSplit = (value: number): void => {
    const next = Math.min(75, Math.max(25, value))
    setSplit(next)
    try { localStorage.setItem('side-chat-split', String(next)) } catch { /* Keep the in-memory size. */ }
  }

  return (
    <div ref={areaRef} className={`terminal-area${showSplit ? ' terminal-area-split' : ''}`}
      style={{ gridTemplateColumns: showSplit ? `minmax(0, ${layout.split}fr) 6px minmax(0, ${100 - layout.split}fr)` : 'minmax(0, 1fr)', gridTemplateRows: hasTopBar ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)' }}>
      {side && layout.single && <nav className="compact-session-switch" aria-label="Visible terminal">
        {[main, side].map(tab => tab && <button type="button" key={tab.id} aria-pressed={tab.id === compactActiveId} onClick={() => activatePane(tab)}>{tab.tempReviewer ? 'Temp reviewer: ' : tab.sideChat ? 'Side chat: ' : ''}{tab.title}</button>)}
      </nav>}
      {standaloneReviewer && toolsControl && (
        <div className="standalone-tools-bar" role="toolbar" aria-label="Workspace tools">
          {toolsControl}
        </div>
      )}
      {!main && !side && (
        <div className="empty-state">
          <p>No sessions are open.</p>
          <button type="button" onClick={onCreate}>Start a session</button>
          {toolsControl}
        </div>
      )}
      {/* Keep every terminal under the same keyed parent. Docking, focusing,
          hiding, and closing a neighbor must not remount another xterm. */}
      {tabs.map((tab) => {
        const visible = layout.single && side ? tab.id === compactActiveId : tab.id === main?.id || tab.id === side?.id
        const focused = tab.id === focusedTabId
        const busy = tab.status === 'starting' || tab.status === 'stopping'
        return (
          <section key={tab.id} className={`session-pane${visible ? ' session-pane-visible' : ''}${focused ? ' session-pane-focused' : ''}`}
            style={{ gridColumn: showSplit && tab.id === side?.id ? 3 : 1, gridRow: hasTopBar ? 2 : 1 }}
            aria-label={`${tab.tempReviewer ? 'Temporary reviewer' : tab.sideChat ? 'Side chat' : 'Main session'}: ${tab.title}`}
            onFocusCapture={() => { if (!focused) activatePane(tab) }}
            onPointerDown={() => { if (!focused) activatePane(tab) }}>
            <header className="session-pane-header">
              <span className="session-pane-title" title={tab.title}>{tab.title}
                {tab.cli && <span className="session-cli-chip" title={`This tab runs ${sessionCliLabel(tab.cli)}${tab.cliVersion ? ` ${tab.cliVersion}` : ''}`}>{sessionCliLabel(tab.cli)}</span>}
                {tab.worktree && <span className="session-worktree-chip" title={`Worktree ${tab.worktree.path}`}>⎇ {tab.worktree.branch ?? tab.worktree.name}</span>}
              </span>
              {!tab.tempReviewer && toolsControl}
              {onToggleGit && !tab.sideChat && !tab.tempReviewer && (
                <button type="button" className="icon-button session-git-toggle" aria-pressed={gitOpen} aria-label={gitOpen ? 'Hide Git panel' : 'Show Git panel'}
                  title="Git (Ctrl+Shift+G)" onClick={onToggleGit}><GitBranchIcon /></button>
              )}
              {onOpenBrowser && !tab.tempReviewer && <button type="button" className="icon-button session-browser-toggle" aria-expanded={browserOpenId === tab.id} aria-label="Open browser"
                title="Browser" onClick={() => onOpenBrowser(tab.id)}><BrowserIcon /></button>}
              {(desktopControlAllowed || desktopControl[tab.id]?.enabled) && !tab.sideChat && !tab.remote && !tab.cli && !tab.tempReviewer && (
                <DesktopControlToggle view={desktopControl[tab.id]} open={desktopPanels.has(tab.id)} onToggle={() => toggleDesktopPanel(tab.id)} />
              )}
              {onPopOut && !tab.tempReviewer && <button type="button" className="icon-button" title="Open in new window" aria-label={`Open ${tab.title} in new window`} onClick={() => onPopOut(tab.id)}>↗</button>}
              {tab.tempReviewer ? (
                <>
                  <span className="side-chat-badge" title={`Temporary reviewer for ${tab.tempReviewer.repository} ${tab.tempReviewer.prLabel}`}>Temp reviewer</span>
                  {onClearPeek && peekTabId === tab.id && (
                    <button type="button" className="meeting-bar-button" onClick={onClearPeek}
                      aria-label={`Hide ${tab.title}`} title="Hide reviewer pane — keep the review running in the background">Hide</button>
                  )}
                </>
              ) : tab.sideChat ? (
                <span className="side-chat-badge" title={tab.permissionWarning ?? 'Only file-view and search tools are exposed to the model; not an OS sandbox.'}>Read/search only</span>
              ) : !tab.remote && !tab.cli && (
                <button type="button" className="icon-button session-fork" aria-label="Fork into side chat" disabled={busy || !canOpenTab || side !== null || !tab.canFork || tab.status === 'dormant' || tab.status === 'completed' || tab.status === 'crashed'}
                  title={!tab.canFork ? 'Requires Copilot CLI 1.0.82 or newer; update and restart this session' : side ? 'Close the existing side chat before forking again' : 'Copy saved conversation history into an independent right-hand pane'}
                  onClick={() => onFork(tab)}><SideChatIcon /></button>
              )}
              {!tab.remote && !tab.tempReviewer && (
                <button type="button" className="icon-button session-restart" disabled={busy} onClick={() => onRestart(tab.id)}
                  aria-label={`Restart ${tab.title}`}
                  title="Restart this session with its saved settings, keeping the same conversation">↻</button>
              )}
              <button type="button" className="icon-button session-close" onClick={() => onClose(tab.id)}
                aria-label={`Close ${tab.sideChat ? 'side chat ' : ''}${tab.title}`}
                title={tab.sideChat ? 'Close side chat — keep the main session running' : 'Close session'}>×</button>
            </header>
            {tab.cli && tab.otherCliBlocked && tab.otherCliBlocked.length > 0 && (
              <div className="other-cli-blocked" role="alert">
                <p>
                  {sessionCliLabel(tab.cli)} did not start with this tab&rsquo;s saved settings:{' '}
                  {tab.otherCliBlocked.map((field) => `${field.label} “${field.value}” (${field.reason})`).join('; ')}.
                  {tab.status !== 'dormant' && tab.status !== 'crashed' && tab.status !== 'completed' ? ' The current session keeps running.' : ''}
                </p>
                {onUseCliSettings && (
                  <button type="button" disabled={busy}
                    onClick={() => onUseCliSettings(tab.id, tab.otherCliBlocked!.map((field) => field.key))}>
                    Use {sessionCliLabel(tab.cli)} settings for {tab.otherCliBlocked.length === 1 ? 'this' : 'these'} and start
                  </button>
                )}
              </div>
            )}
            {desktopPanels.has(tab.id) && !tab.sideChat && !tab.remote && !tab.cli && !tab.tempReviewer && (desktopControlAllowed || desktopControl[tab.id]?.enabled) && (
              <DesktopControlPanel tab={tab} allowed={desktopControlAllowed} ready={desktopControlReadyTabIds.includes(tab.id)} view={desktopControl[tab.id]} />
            )}
            {/* A popped-out session shows its terminal and its stopped notice in its own window only. */}
            {poppedOutTabIds.includes(tab.id) ? (
              <div className="session-terminal">
                <div className="empty-state"><p>This session is open in another window.</p>
                  <button type="button" onClick={() => onActivate(tab.id)}>Show session window</button>
                </div>
              </div>
            ) : <SessionTerminal tab={tab} active={visible} focused={focused} onRestart={() => onRestart(tab.id)} onShowLog={() => onShowLog(tab.id)} />}
          </section>
        )
      })}
      {showSplit && (
        <div className="side-chat-divider" role="separator" aria-label="Resize side chat" aria-orientation="vertical"
          aria-valuenow={Math.round(layout.split)} aria-valuemin={25} aria-valuemax={75} tabIndex={0}
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
