import { useEffect, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { DesktopState } from '../../main/types.js'
import type { ProjectTools, ToolsAction, ToolsState, ToolTabKind } from '../../main/tool-tabs.js'
import { dockedReorder, isTerminalKind, panelTabs } from '../../main/tool-tabs.js'
import { visibleSessionTabs } from '../../main/session-tab-machine.js'
import { sessionTaskBlocker } from '../../main/session-task.js'
import { ProjectDock } from './ProjectDock.js'
import { BrowserPanel } from './BrowserPanel.js'
import { GitPanel } from './GitPanel.js'
import { isShortcutModifier, isWindows } from '../platform.js'
import { ToolTerminalPanel } from './ToolTerminalPanel.js'
import { projectTerminal, WorkspaceTabBar } from '../../../vendor/myterminal/desktop-renderer.mjs'
import { MyTerminalConnections } from './MyTerminalConnections.js'

/** Adding another tool requires an adapter here, not a permanent slot in the layout. */
export const TOOL_TYPES: readonly { kind: Exclude<ToolTabKind, 'new'>; label: string; description: string }[] = [
  { kind: 'browser', label: 'Browser', description: 'Open a web page in a new tab' },
  { kind: 'git', label: 'Git', description: 'Changes, commits, branches and worktrees' },
  { kind: 'local', label: 'Local terminal', description: 'Open a shell in the session or workspace folder' },
  ...(isWindows ? [{ kind: 'wsl' as const, label: 'WSL terminal', description: 'Open a Linux shell in Windows Subsystem for Linux' }] : []),
  { kind: 'ssh', label: 'SSH', description: 'Saved connections, SFTP and tunnels, or OpenSSH' },
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
  // The panel can stay open with nothing docked, after its last tab moves to its own window.
  const visible = Boolean(project?.visible)
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
  const strip = panelTabs(project)
  const sessions = desktop.tabs.filter(tab => tab.workspaceProfileId === project.profileId)
  // A Git view keeps its draft and running operation after its tab closes. Reuse
  // that view when its owner reopens Git, and carry the same view through promotion.
  const [gitViews, setGitViews] = useState<GitToolView[]>([])
  const nextViews = reconcileGitViews(gitViews, project, sessions)
  if (nextViews !== gitViews) setGitViews(nextViews)
  const prompt = desktop.activeProfileId === project.profileId ? sessions.find(tab => tab.id === desktop.activeTabId && !['dormant', 'completed', 'crashed'].includes(tab.status) && !(desktop.poppedOutTabIds ?? []).includes(tab.id)) : undefined
  const promptTarget = prompt ? { id: prompt.id, title: prompt.title, cwd: prompt.sessionCwd ?? profile?.path ?? null,
    taskBlocker: sessionTaskBlocker({ cli: prompt.cli, status: prompt.status, preset: prompt.sessionPermissionPreset, sideChat: prompt.sideChat === true, remote: prompt.remote }) } : null
  const terminalProject = useMemo(() => projectTerminal(project.profileId), [project.profileId])
  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  const [distros, setDistros] = useState<string[]>([])
  useEffect(() => {
    terminalProject.store.setState({ activeTabId: project.activeId, broadcastMode: Boolean(project.broadcast) })
  }, [terminalProject, project.activeId, project.broadcast])
  const tabState = {
    // A page in its own window leaves the strip, as in Chrome; Return to panel in that window brings it back.
    tabs: strip.filter(tab => !tab.detached).map(tab => ({ id: tab.id, label: (project.ownerId && !tab.ownerId ? 'Workspace · ' : '') + (tab.label || tab.title), color: tab.color, terminal: isTerminalKind(tab.kind),
      isLocal: tab.kind !== 'ssh', config: tab.terminal?.temporary ? tab.terminal : null, sessionId: tab.terminal?.temporary ? null : tab.terminal?.connectionId })),
    activeTabId: project.activeId, broadcastMode: Boolean(project.broadcast),
    setActiveTab: (id: string) => action({ type: 'select', id }), closeTab: (id: string) => action({ type: 'close', id }),
    updateTab: (id: string, patch: {label?: string; color?: string | null}) => action({ type: 'metadata', id, ...patch }),
    reorderTabs: (from: number, to: number) => { const move = dockedReorder(strip, from, to); if (move) action({ type: 'reorder', ...move }) },
    toggleBroadcast: () => action({ type: 'broadcast', enabled: !project.broadcast }),
  }
  const [address, setAddress] = useState('')
  const [connection, setConnection] = useState<'wsl' | 'ssh' | null>(null)
  useEffect(() => {
    if (!isWindows || !shown || connection !== 'wsl') return
    let canceled = false
    void terminalProject.api.wsl.getDistros().then((values: string[]) => { if (!canceled) setDistros(values) }).catch(() => { if (!canceled) setDistros([]) })
    return () => { canceled = true }
  }, [terminalProject, shown, connection])
  const [host, setHost] = useState(''), [username, setUsername] = useState(''), [port, setPort] = useState(''), [identityFile, setIdentityFile] = useState(''), [distro, setDistro] = useState('')
  useEffect(() => { setConnection(null) }, [selected?.id])
  return <aside className="workspace-tools" aria-label="Workspace tools" hidden={!shown} onKeyDown={event => {
    if (!(event.target instanceof Element && event.target.closest('.tool-terminal-panel, input, textarea, [contenteditable="true"]')) && isShortcutModifier(event) && ['w', 't'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation()
      if (event.key.toLowerCase() === 't') action({ type: 'add', kind: 'new' })
      else if (project.activeId) action({ type: 'close', id: project.activeId })
    }
  }}>
    <div className="myterminal-embedded workspace-tabbar-host">
      <WorkspaceTabBar host={{ ...terminalProject, tabState, active: shown, onMenu: setTabMenuOpen,
        saveConnection: async (id: string) => { await window.copilotDesktop.toolsAction(project.profileId, { type: 'save-connection', id, expectedOwnerId: project.ownerId ?? null }); await terminalProject.load() },
        toolbar: <>{selected?.ownerId && selected.kind !== 'new' && <button type="button" title="Move this tab to the shared workspace" onClick={() => action({ type: 'promote', id: selected.id })}>Move to workspace</button>}<button type="button" aria-label="New tab" title="New tab" onClick={() => action({ type: 'add', kind: 'new' })}>+</button>
          <button type="button" aria-label="Hide tabs" title={takeover ? 'Hide tabs and return to CLI' : 'Hide tabs'} onClick={() => action({ type: 'visible', visible: false })}>▥</button></> }} />
    </div>
    {!selected && <div className="tool-empty-panel" role="status">
      <p>No tabs</p>
      <button type="button" onClick={() => action({ type: 'add', kind: 'new' })}>New tab</button>
    </div>}
    {selected?.kind === 'new' && <div id={`tool-content-${selected.id}`} role="tabpanel" className="tool-launcher">
      <h2>New tab</h2>
      <form onSubmit={event => { event.preventDefault(); action({ type: 'add', kind: 'browser', replaceId: selected.id, ...(address.trim() ? { url: address.trim() } : {}) }); setAddress('') }}>
        <input aria-label="New browser URL" placeholder="localhost:3000 or example.com" value={address} onChange={event => setAddress(event.target.value)} />
        <button type="submit">Open browser</button>
      </form>
      <div className="tool-launcher-types">{TOOL_TYPES.map(type => <button type="button" key={type.kind} disabled={type.kind === 'git' && Boolean(profile?.general)}
        title={type.kind === 'git' && profile?.general ? 'Git requires a project folder' : type.description}
        onClick={() => {
          if (type.kind === 'ssh' || type.kind === 'wsl') setConnection(type.kind)
          else action({ type: 'add', kind: type.kind, replaceId: selected.id })
        }}><strong>{type.label}</strong><span>{type.description}</span></button>)}</div>
      {connection === 'ssh' && <MyTerminalConnections profileId={project.profileId} connect={terminal => action({ type: 'add', kind: 'ssh', replaceId: selected.id, terminal })} />}
      {connection && <form className="tool-connection-form" aria-label={connection === 'ssh' ? 'SSH connection' : 'WSL connection'} onSubmit={event => {
        event.preventDefault()
        action({ type: 'add', kind: connection, replaceId: selected.id, terminal: connection === 'wsl' ? { ...(distro.trim() ? { distro: distro.trim() } : {}) }
          : { host: host.trim(), ...(username.trim() ? { username: username.trim() } : {}), ...(port ? { port: Number(port) } : {}), ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}) } })
      }}>
        <h3>{connection === 'ssh' ? 'OpenSSH (native)' : 'WSL terminal'}</h3>
        {connection === 'ssh' ? <>
          <label>Host or SSH config alias<input autoFocus required aria-label="SSH host" value={host} onChange={event => setHost(event.target.value)} placeholder="server.example.com" /></label>
          <label>User (optional)<input aria-label="SSH user" value={username} onChange={event => setUsername(event.target.value)} /></label>
          <label>Port (optional)<input aria-label="SSH port" type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label>
          <label>Identity file (optional)<input aria-label="SSH identity file" value={identityFile} onChange={event => setIdentityFile(event.target.value)} /></label>
          <p>Uses your SSH configuration and keys. Password and host verification prompts appear in the terminal.</p>
        </> : <label>Distribution (optional)<input autoFocus list={`wsl-distros-${project.profileId}`} aria-label="WSL distribution" placeholder="Default distribution" value={distro} onChange={event => setDistro(event.target.value)} /><datalist id={`wsl-distros-${project.profileId}`}>{distros.map(name => <option key={name} value={name} />)}</datalist></label>}
        <div><button type="submit">Connect</button><button type="button" onClick={() => setConnection(null)}>Cancel</button></div>
      </form>}
      {profile?.general && <p>Git is available in project workspaces.</p>}
      {!!tools.recent?.length && <div className="tool-recents"><h3>Recent pages</h3>{tools.recent.slice(0, 8).map(url => <button key={url} type="button" title={url}
        onClick={() => action({ type: 'add', kind: 'browser', replaceId: selected.id, url })}>{url}</button>)}</div>}
    </div>}
    {selected?.kind === 'browser' && <div className="tool-context">
        <button type="button" onClick={() => action({ type: 'pop-out', id: selected.id })}>Open in window</button>
        <details><summary>Browser settings</summary>
          <p>{selected.ownerId ? 'This browser tab belongs to its session.' : 'The active session can use this workspace tab.'}</p>
          <label>Local Overrides for this project <select aria-label="Project Local Overrides" value={project.overrides} onChange={event => action({ type: 'overrides', mode: event.target.value as 'shared' | 'private' })}>
            <option value="shared">Shared settings</option><option value="private">Private project settings</option>
          </select></label><p>Applies after all project browser tabs close and a browser is opened again.</p>
        </details>
    </div>}
    {selected?.kind === 'browser' && !selected.resource && <button type="button" onClick={() => action({ type: 'select', id: selected.id })}>Open browser page</button>}
    {project.tabs.filter(tab => tab.kind === 'browser' && tab.resource).map(tab => <div key={tab.id} id={`tool-content-${tab.id}`} className="tool-browser-host" hidden={!shown || selected?.id !== tab.id} role="tabpanel">
      <BrowserPanel tabId={tab.resource!} sessionTitle={tab.title} independent promptTargetId={prompt?.id ?? null}
        active={shown && selected?.id === tab.id} obscured={obscured || tabMenuOpen} />
    </div>)}
    {nextViews.map(view => {
      const owner = sessions.find(session => view.ownerId && session.browserProfileId === view.ownerId)
      const active = shown && view.tabId !== null && view.tabId === selected?.id
      return <div key={view.key} className="tool-git-host" hidden={!active} role="tabpanel" id={view.tabId ? `tool-content-${view.tabId}` : undefined}>
        <GitPanel embedded active={active} profileId={project.profileId} selectionKey={view.selectionKey} promptTarget={promptTarget}
          sessionWorktreePath={owner?.worktree?.path ?? owner?.launchWorktreePath}
          worktreeSessions={sessions.flatMap(tab => tab.worktree ? [{ path: tab.worktree.path, title: tab.title }] : [])}
          onClose={() => { if (view.tabId) action({ type: 'close', id: view.tabId }) }} />
      </div>
    })}
    {project.tabs.filter(tab => isTerminalKind(tab.kind)).map(tab => <div key={tab.id} id={`tool-content-${tab.id}`} className="tool-terminal-host" hidden={!shown || selected?.id !== tab.id} role="tabpanel">
      <ToolTerminalPanel profileId={project.profileId} tab={tab} active={shown && selected?.id === tab.id} promptTargetId={prompt?.id ?? null} />
    </div>)}
  </aside>
}

interface GitToolView { key: string; tabId: string | null; ownerId: string | undefined; selectionKey: string }
function reconcileGitViews(previous: GitToolView[], project: ProjectTools, sessions: DesktopState['tabs']): GitToolView[] {
  const tabs = project.tabs.filter(tab => tab.kind === 'git')
  const views = previous.flatMap(view => {
    const tab = tabs.find(tab => tab.id === view.tabId)
    if (tab) return [view.ownerId === tab.ownerId ? view : { ...view, ownerId: tab.ownerId }]
    if (view.ownerId && !sessions.some(session => session.browserProfileId === view.ownerId)) return []
    return [view.tabId === null ? view : { ...view, tabId: null }]
  })
  for (const tab of tabs) {
    if (views.some(view => view.tabId === tab.id)) continue
    const closed = views.findIndex(view => view.tabId === null && view.ownerId === tab.ownerId)
    if (closed >= 0) views[closed] = { ...views[closed]!, tabId: tab.id, selectionKey: tab.gitSelectionKey ?? project.profileId }
    else views.push({ key: tab.id, tabId: tab.id, ownerId: tab.ownerId, selectionKey: tab.gitSelectionKey ?? project.profileId })
  }
  return views.length === previous.length && views.every((view, i) => view === previous[i]) ? previous : views
}
