import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { DesktopState } from '../../main/types.js'
import type { ProjectTools, ToolsAction, ToolsState, ToolTabKind } from '../../main/tool-tabs.js'
import { visibleSessionTabs } from '../../main/session-tab-machine.js'
import { sessionTaskBlocker } from '../../main/session-task.js'
import { ProjectDock } from './ProjectDock.js'
import { BrowserPanel } from './BrowserPanel.js'
import { GitPanel } from './GitPanel.js'
import { isShortcutModifier } from '../platform.js'

/** Adding another tool requires an adapter here, not a permanent slot in the layout. */
export const TOOL_TYPES: readonly { kind: Exclude<ToolTabKind, 'new'>; label: string; description: string }[] = [
  { kind: 'browser', label: 'Browser', description: 'Open a web page in a new tab' },
  { kind: 'git', label: 'Git', description: 'Changes, commits, branches and worktrees' },
]
interface Props {
  children: ReactNode
  desktop: DesktopState
  tools: ToolsState
  obscured: boolean
  act(profileId: string, action: ToolsAction): void
}

export function ToolPanelWorkspace({ children, desktop, tools, obscured, act }: Props): JSX.Element {
  const project = tools.projects.find(project => project.profileId === desktop.activeProfileId)
  const { side } = visibleSessionTabs({ tabs: desktop.tabs, activeTabId: desktop.activeTabId })
  const visible = Boolean(project?.visible && project.tabs.length)
  return <div className="tool-panel-workspace">
    <ProjectDock open={visible} width={project?.width ?? 420} twoTerminals={Boolean(side)}
      onWidthChange={width => { if (project) act(project.profileId, { type: 'width', width }) }}
      panel={({ takeover }) => <>
        {tools.projects.map(entry => <ProjectToolsHost key={entry.profileId} project={entry} desktop={desktop} tools={tools}
          shown={entry.profileId === desktop.activeProfileId && visible} obscured={obscured} takeover={takeover} act={act} />)}
      </>}>{children}</ProjectDock>
  </div>
}

function ProjectToolsHost({ project, desktop, tools, shown, obscured, takeover, act }: Omit<Props, 'children'> & { project: ProjectTools; shown: boolean; takeover: boolean }): JSX.Element {
  const action = (value: ToolsAction): void => act(project.profileId, value)
  const selected = project.tabs.find(tab => tab.id === project.activeId)
  const profile = desktop.profiles.find(profile => profile.id === project.profileId)
  const [gitUsed, setGitUsed] = useState(project.tabs.some(tab => tab.kind === 'git'))
  useEffect(() => { if (project.tabs.some(tab => tab.kind === 'git')) setGitUsed(true) }, [project.tabs])
  const sessions = desktop.tabs.filter(tab => tab.workspaceProfileId === project.profileId)
  const prompt = sessions.find(tab => tab.id === desktop.activeTabId && !['dormant', 'completed', 'crashed'].includes(tab.status) && !(desktop.poppedOutTabIds ?? []).includes(tab.id))
  const promptTarget = prompt ? { id: prompt.id, title: prompt.title, cwd: prompt.sessionCwd ?? profile?.path ?? null,
    taskBlocker: sessionTaskBlocker({ cli: prompt.cli, status: prompt.status, preset: prompt.sessionPermissionPreset, sideChat: prompt.sideChat === true, remote: prompt.remote }) } : null
  const [address, setAddress] = useState('')
  return <aside className="workspace-tools" aria-label="Workspace tools" hidden={!shown} onKeyDown={event => {
    if (isShortcutModifier(event) && ['w', 't'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation()
      if (event.key.toLowerCase() === 't') action({ type: 'add', kind: 'new' })
      else if (project.activeId) action({ type: 'close', id: project.activeId })
    }
  }}>
    <header className="workspace-tools-header">
      <div role="tablist" aria-label="Workspace tabs" className="tool-tab-strip" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = project.tabs.findIndex(tab => tab.id === project.activeId)
        const next = event.key === 'Home' ? project.tabs[0] : event.key === 'End' ? project.tabs.at(-1)
          : project.tabs[(index + (event.key === 'ArrowLeft' ? -1 : 1) + project.tabs.length) % project.tabs.length]
        if (next) { action({ type: 'select', id: next.id }); event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab-id="${next.id}"]`)?.focus() }
      }}>
        {project.tabs.map(tab => <div className={`tool-tab${tab.id === project.activeId ? ' tool-tab-selected' : ''}`} key={tab.id}>
          <button type="button" role="tab" data-tab-id={tab.id} aria-selected={tab.id === project.activeId} aria-controls={`tool-content-${tab.id}`}
            tabIndex={tab.id === project.activeId ? 0 : -1} title={tab.error || tab.url || tab.title} onClick={() => action({ type: 'select', id: tab.id })}>
            {tab.error ? '⚠ ' : tab.kind === 'browser' ? '◎ ' : tab.kind === 'git' ? '⑂ ' : ''}{tab.title}</button>
          <button type="button" className="tool-tab-close" aria-label={`Close ${tab.title} tab`} onClick={() => action({ type: 'close', id: tab.id })}>×</button>
        </div>)}
      </div>
      <button type="button" aria-label="New tab" title="New tab" onClick={() => action({ type: 'add', kind: 'new' })}>+</button>
      <button type="button" aria-label="Hide tabs" title={takeover ? 'Hide tabs and return to CLI' : 'Hide tabs'} onClick={() => action({ type: 'visible', visible: false })}>▥</button>
    </header>
    {selected?.kind === 'new' && <div id={`tool-content-${selected.id}`} role="tabpanel" className="tool-launcher">
      <h2>New tab</h2>
      <form onSubmit={event => { event.preventDefault(); action({ type: 'add', kind: 'browser', replaceId: selected.id, ...(address.trim() ? { url: address.trim() } : {}) }); setAddress('') }}>
        <input aria-label="New browser URL" placeholder="localhost:3000 or example.com" value={address} onChange={event => setAddress(event.target.value)} />
        <button type="submit">Open browser</button>
      </form>
      <div className="tool-launcher-types">{TOOL_TYPES.map(type => <button type="button" key={type.kind} disabled={type.kind === 'git' && Boolean(profile?.general)}
        title={type.kind === 'git' && profile?.general ? 'Git requires a project folder' : type.description}
        onClick={() => action({ type: 'add', kind: type.kind, replaceId: selected.id })}><strong>{type.label}</strong><span>{type.description}</span></button>)}</div>
      {profile?.general && <p>Git is available in project workspaces.</p>}
      {!!tools.recent?.length && <div className="tool-recents"><h3>Recent pages</h3>{tools.recent.slice(0, 8).map(url => <button key={url} type="button" title={url}
        onClick={() => action({ type: 'add', kind: 'browser', replaceId: selected.id, url })}>{url}</button>)}</div>}
    </div>}
    {selected?.kind === 'browser' && <div className="tool-context">
        <label>Connect to session <select aria-label="Connect browser to session" value="" onChange={event => { if (event.target.value) action({ type: 'connect', id: selected.id, sessionId: event.target.value }) }}>
          <option value="">Choose a CLI session</option>
          {sessions.filter(tab => !tab.remote && !tab.cli && !['dormant', 'completed', 'crashed'].includes(tab.status)).map(tab => <option key={tab.id} value={tab.id}>{tab.title}</option>)}
        </select></label>
        {tools.connections.filter(connection => connection.profileId === project.profileId).map(connection => <span className="browser-connection" key={connection.sessionId}>
          {sessions.find(tab => tab.id === connection.sessionId)?.title ?? connection.sessionId}: {connection.pageId === null ? 'connected; select a page after reopening' : `page ${connection.pageId}`}
          <button type="button" aria-label={`Disconnect ${sessions.find(tab => tab.id === connection.sessionId)?.title ?? connection.sessionId}`} onClick={() => action({ type: 'disconnect', sessionId: connection.sessionId })}>Disconnect</button>
        </span>)}
        <button type="button" onClick={() => action({ type: selected.detached ? 'return' : 'pop-out', id: selected.id })}>{selected.detached ? 'Return to panel' : 'Open in window'}</button>
        <details><summary>Browser settings</summary>
          <p>Connecting a CLI gives it access to all browser pages in this project. Resume requires reconnecting.</p>
          <label>Local Overrides for this project <select aria-label="Project Local Overrides" value={project.overrides} onChange={event => action({ type: 'overrides', mode: event.target.value as 'shared' | 'private' })}>
            <option value="shared">Shared settings</option><option value="private">Private project settings</option>
          </select></label><p>Applies after all project browser tabs close and a browser is opened again.</p>
        </details>
    </div>}
    {project.tabs.filter(tab => tab.kind === 'browser' && tab.resource).map(tab => <div key={tab.id} id={`tool-content-${tab.id}`} className="tool-browser-host" hidden={!shown || selected?.id !== tab.id} role="tabpanel">
      <BrowserPanel tabId={tab.resource!} sessionTitle={tab.title} independent promptTargetId={prompt?.id ?? null}
        active={shown && selected?.id === tab.id} obscured={obscured} />
    </div>)}
    {gitUsed && <div className="tool-git-host" hidden={!shown || selected?.kind !== 'git'} role="tabpanel" id={selected?.kind === 'git' ? `tool-content-${selected.id}` : undefined}>
      <GitPanel profileId={project.profileId} embedded active={shown && selected?.kind === 'git'} promptTarget={promptTarget}
        worktreeSessions={sessions.flatMap(tab => tab.worktree ? [{ path: tab.worktree.path, title: tab.title }] : [])}
        onClose={() => { if (selected) action({ type: 'close', id: selected.id }) }} />
    </div>}
  </aside>
}
