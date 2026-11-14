import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { DesktopSessionTab } from '../../main/types.js'
import { visibleSessionTabs } from '../../main/session-tab-machine.js'
import type { ToolDockPreferences, WorkspaceTool } from '../tool-dock-state.js'
import { terminalLayout } from '../tool-dock-state.js'
import { BrowserPanel } from './BrowserPanel.js'
import { ProjectDock } from './ProjectDock.js'

/** Mount once on first use; hiding a tool must not discard its drafts. */
function RetainedTool({ shown, children }: { shown: boolean; children: ReactNode }): JSX.Element | null {
  const [used, setUsed] = useState(shown)
  if (shown && !used) setUsed(true)
  return used || shown ? <>{children}</> : null
}

export interface WorkspaceToolDockProps {
  children: ReactNode
  prefs: ToolDockPreferences
  onChange(prefs: ToolDockPreferences): void
  onClose(): void
  tabs: DesktopSessionTab[]
  activeTabId: string | null
  profileId: string
  gitAvailable: boolean
  git: ReactNode
  browserChoice: string | null
  onBrowserChoice(id: string): void
  onActivate(id: string): void
  browserPoppedOutTabIds: string[]
  poppedOutTabIds: string[]
  obscured: boolean
  onError(error: unknown): void
}

export function WorkspaceToolDock(props: WorkspaceToolDockProps): JSX.Element {
  const { prefs, onChange, tabs, activeTabId, children } = props
  const { main, side } = visibleSessionTabs({ tabs, activeTabId })
  return <ProjectDock open={prefs.open} width={prefs.width} twoTerminals={side !== null}
    onWidthChange={width => onChange({ ...prefs, width })}
    panel={layout => <WorkspaceTools {...props} main={main} side={side} {...layout} />}>
    {children}
  </ProjectDock>
}

function WorkspaceTools({ prefs, onChange, onClose, tabs, activeTabId, profileId, gitAvailable, git, browserChoice, onBrowserChoice,
  onActivate, browserPoppedOutTabIds, poppedOutTabIds, obscured, onError, main, side, takeover, mainWidth }: WorkspaceToolDockProps & {
    main: DesktopSessionTab | null; side: DesktopSessionTab | null; takeover: boolean; mainWidth: number
  }): JSX.Element {
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set())
  const single = terminalLayout(mainWidth, side !== null, 50).single
  const pair = [main, side].filter((tab): tab is DesktopSessionTab => tab !== null)
  const target = single ? pair.find(tab => tab.id === activeTabId) ?? main
    : pair.find(tab => tab.id === browserChoice) ?? main
  const popped = target !== null && browserPoppedOutTabIds.includes(target.id)
  const sessionElsewhere = target !== null && poppedOutTabIds.includes(target.id)
  const browserShown = prefs.open && prefs.tool === 'browser'
  const enabled = browserShown && target !== null && target.status !== 'dormant' && !popped && !sessionElsewhere
  useEffect(() => {
    if (!enabled || !target) return
    setVisited(previous => previous.has(target.id) ? previous : new Set([...previous, target.id]))
  }, [enabled, target?.id])
  useEffect(() => {
    if (main && !pair.some(tab => tab.id === browserChoice)) onBrowserChoice(main.id)
  }, [main?.id, side?.id]) // A focus change within the pair must not change the browser.
  const select = (tool: WorkspaceTool): void => onChange({ ...prefs, open: true, tool })
  const tools: WorkspaceTool[] = gitAvailable ? ['browser', 'git'] : ['browser']
  const request = (operation: Promise<unknown>): void => { void operation.catch(onError) }
  return <aside className="workspace-tools" aria-label="Workspace tools">
    <header className="workspace-tools-header">
      <div role="tablist" aria-label="Workspace tools" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = tools.indexOf(prefs.tool)
        const next = event.key === 'Home' ? tools[0]! : event.key === 'End' ? tools.at(-1)!
          : tools[(index + (event.key === 'ArrowLeft' ? -1 : 1) + tools.length) % tools.length]!
        select(next)
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-tool="${next}"]`)?.focus()
      }}>
        {(['browser', 'git'] as const).map(tool => <button key={tool} id={`workspace-tool-${tool}`} type="button" role="tab" data-tool={tool}
          aria-selected={prefs.tool === tool} aria-controls={`workspace-panel-${tool}`} tabIndex={prefs.tool === tool || !gitAvailable && tool === 'browser' ? 0 : -1}
          disabled={tool === 'git' && !gitAvailable} title={tool === 'git' && !gitAvailable ? 'Git is unavailable in a general workspace' : undefined}
          onClick={() => select(tool)}>{tool === 'browser' ? 'Browser' : 'Git'}</button>)}
      </div>
      <button type="button" className="workspace-tools-close" aria-label={takeover ? 'Back to CLI' : 'Collapse tools panel'} onClick={onClose}>{takeover ? 'Back to CLI' : '×'}</button>
    </header>
    <div id="workspace-panel-browser" className="workspace-tool-content" role="tabpanel" aria-labelledby="workspace-tool-browser" hidden={!browserShown}>
      <div className="workspace-browser-context">
        <label>Session <select aria-label="Browser session" value={target?.id ?? ''} disabled={!target} onChange={event => {
          onBrowserChoice(event.target.value)
          if (single) onActivate(event.target.value)
        }}>
          {!target && <option value="">No session</option>}
          {pair.map(tab => <option key={tab.id} value={tab.id}>{tab.sideChat ? 'Side chat: ' : ''}{tab.title}</option>)}
        </select></label>
        {target && !sessionElsewhere && target.status !== 'dormant' && <>
          <button type="button" aria-label={popped ? 'Show browser window' : 'Open browser in new window'}
            onClick={() => request(window.copilotDesktop.popOutBrowser(target.id))}>{popped ? 'Show window' : '⧉'}</button>
          {popped && <button type="button" aria-label="Bring browser back to this window" onClick={() => request(window.copilotDesktop.dockBrowser(target.id))}>↙</button>}
        </>}
      </div>
      {!target ? <p className="tool-empty">Start a session to use Browser.</p>
        : sessionElsewhere ? <p className="tool-empty">This session is open in another window.</p>
        : popped ? <p className="tool-empty">This browser is open in another window.</p>
        : target.status === 'dormant' ? <p className="tool-empty">Start this session to use Browser.</p> : null}
      {tabs.filter(tab => visited.has(tab.id) || enabled && tab.id === target?.id).map(tab =>
        <BrowserPanel key={tab.id} tabId={tab.id} sessionTitle={tab.title} active={enabled && tab.id === target?.id} obscured={obscured} />)}
    </div>
    <div id="workspace-panel-git" className="workspace-tool-content" role="tabpanel" aria-labelledby="workspace-tool-git" hidden={!prefs.open || prefs.tool !== 'git'}>
      {gitAvailable ? <RetainedTool key={profileId} shown={prefs.open && prefs.tool === 'git'}>{git}</RetainedTool>
        : <p className="tool-empty">Git is unavailable in a general workspace. Select Browser or return to the CLI.</p>}
    </div>
  </aside>
}
