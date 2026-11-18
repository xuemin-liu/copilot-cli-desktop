import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAbsolute, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { BrowserDebug } from './browser-debug.js'
import type { BrowserCursor } from './browser-reader.js'
import type { BrowserBounds } from './browser-debug-types.js'
import { browserProfilePaths, normalizeBrowserProfileId, SHARED_BROWSER_PROFILE_ID } from './browser-profile.js'
import { writeFileAtomic } from './atomic-file.js'
import { prepareProjectDevtoolsSettings, completeProjectDevtoolsSharing } from './browser-devtools-settings.js'
import { parseBrowserAddress } from './browser-url.js'
import { restorableUrl } from './browser-privacy.js'
import { constantTimeTokenEqual } from '../cli/runtime-core.js'
import { dockedNeighbor, isTerminalKind, removeToolTab, panelTabs, type PanelLayout, type BrowserConnection, type ProjectTools, type ToolsAction, type ToolsState, type ToolTab, type TerminalConfig } from './tool-tabs.js'
import { ToolTerminals, terminalLaunch } from './tool-terminal.js'
import { prepareToolTerminalEnvironment } from './browser-session.js'
import { writeToBroadcastTargets } from '../../vendor/myterminal/channels.mjs'
import MyTerminalServices from '../../vendor/myterminal/services.cjs'
import { createBellNotifier, createReconnectController } from '../../vendor/myterminal/lifecycle.cjs'

interface ToolActor {
  ownerId: string | undefined
  sessionId?: string
  workspaceAccess?: boolean
  localCwd?: string | undefined
}
interface PanelProject extends ProjectTools {
  layouts: Record<string, PanelLayout>
}
interface Group { browser: BrowserDebug; generation: string }
const liveSession = (status: string | undefined): boolean => status === 'running' || status === 'approval-needed'
interface Bridge { server: Server; token: string; endpoint: string; profileId: string; connected: boolean; pageId: number | null; uiPageId: number | null; revision: number }
interface Options {
  userData: string
  owner(): BrowserWindow | null
  project(id: string): { name: string; path: string | null } | undefined
  session(id: string): { workspaceProfileId: string; status: string; browserProfileId?: string; sessionCwd?: string | null; launchWorktreePath?: string; sideChat?: boolean; remote?: boolean; sessionPermissionPreset?: string | null } | undefined
  currentSession(): string | null
  currentProject?(): string | null
  activateProject?(id: string, ownerId?: string): Promise<unknown>
  defaults(): { shared: boolean; overrides: 'shared' | 'private' }
  browserOptions(): Partial<NonNullable<ConstructorParameters<typeof BrowserDebug>[2]>>
  changed(): void
  error(error: unknown): void
}

/** Owns project tabs and browser lifetimes. Only explicit add/select restores a runtime. */
export class ProjectToolService {
  private readonly projects = new Map<string, PanelProject>()
  private readonly groups = new Map<string, Group>()
  private readonly bridges = new Map<string, Bridge>()
  private readonly terminalServices = new Map<string, MyTerminalServices>()
  private readonly removedProjects = new Set<string>()
  /** Last user-chosen browser page per owner, independent of the selected tool tab. */
  private readonly focusPages = new Map<string, number>()
  private focusPage(project: ProjectTools, pageId: number): void {
    const tab = project.tabs.find(entry => entry.pageId === pageId)
    if (!tab) return
    this.focusPages.set(tab.ownerId ?? project.ownerId ?? project.profileId, pageId)
    if (!tab.ownerId) this.focusPages.set(project.profileId, pageId)
  }
  private readonly splits = new Map<string, { profileId: string; parentId: string; tab: ToolTab }>()
  private readonly terminalLifecycles = new Map<string, { profileId: string; bell(data: string): void; retry: ReturnType<typeof createReconnectController> }>()
  private readonly terminals = new ToolTerminals(undefined, {
    managed: (profileId, id, config, signal) => this.myTerminal(profileId).spawn(id, config.connectionId!, signal),
    started: (profileId, id) => { this.terminalLifecycles.get(id)?.retry.connected(); void this.myTerminal(profileId).started(id)?.catch(this.options.error) },
    output: (profileId, id, data) => { this.terminalServices.get(profileId)?.output(id, data); this.terminalLifecycles.get(id)?.bell(data) },
    streamed: (profileId, state) => { const owner = this.options.owner(); if (owner && !owner.isDestroyed()) owner.webContents.send('desktop:tool-terminal-output', profileId, state) },
    closed: (profileId, id, unexpected) => {
      this.terminalServices.get(profileId)?.closed(id)
      const lifecycle = this.terminalLifecycles.get(id)
      if (unexpected && this.terminalTab(profileId, id)?.terminal?.transport === 'managed') lifecycle?.retry.schedule()
      else { lifecycle?.retry.dispose(); this.terminalLifecycles.delete(id) }
    },
  })
  private readonly terminalBridges = new Map<string, Promise<{ server: Server; directory: string; env: NodeJS.ProcessEnv }>>()
  private readonly closingTerminalBridges = new Set<Promise<void>>()
  private readonly releasing = new Set<string>()
  private readonly suspendingPages = new Set<string>()
  private readonly cancelledStarts = new Set<string>()
  private readonly terminalStarts = new Map<string, Promise<unknown>>()
  private writing = Promise.resolve()
  private readonly file: string
  private stopping = false
  private shownProject: string | null = null
  private shownSessionLive = false
  private readonly initializedPartitions = new Set<string>()
  readonly profileRecoveryRequired: boolean = false
  constructor(private readonly options: Options) {
    this.file = join(options.userData, 'workspace-tool-tabs-v2.json')
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; projects?: unknown }
      if ((saved.version !== 2 && saved.version !== 3) || !Array.isArray(saved.projects)) throw new Error('Invalid tool tabs manifest; browser profiles were preserved')
      for (const candidate of saved.projects) {
        if (!candidate || typeof candidate.profileId !== 'string' || !options.project(candidate.profileId)) continue
        const browserProfileId = normalizeBrowserProfileId(candidate.browserProfileId)
        if (!browserProfileId || !Array.isArray(candidate.tabs)) continue
        const tabs: ToolTab[] = []
        const seenIds = new Set<string>()
        for (const entry of candidate.tabs) {
          if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || seenIds.has(entry.id)) continue
          const ownerId = normalizeBrowserProfileId(entry.ownerId)
          if (entry.ownerId !== undefined && !ownerId) continue
          const count = tabs.length
          if (entry.kind === 'git') {
            const tab: ToolTab = { id: entry.id, kind: 'git', title: 'Git' }
            const key = normalizeBrowserProfileId(entry.gitSelectionKey)
            if (key) tab.gitSelectionKey = key
            tabs.push(tab)
          }
          if (isTerminalKind(entry.kind) && !entry.terminal?.temporary) {
            try {
              const config = terminalLaunch(entry.kind, entry.terminal ?? {}, undefined, entry.kind === 'wsl' ? 'win32' : process.platform).config
              tabs.push({ id: entry.id, kind: entry.kind, title: this.terminalTitle(entry.kind, config), terminal: config })
            } catch { /* Ignore invalid saved terminal settings. Never restore live connections automatically. */ }
          }
          if (entry.kind === 'browser') {
            let url: string | null = null
            try { url = typeof entry.url === 'string' ? restorableUrl(entry.url) : null } catch { /* Invalid saved URL. */ }
            tabs.push({ id: entry.id, kind: 'browser', title: 'Browser', ...(url ? { url } : {}) })
          }
          const tab = tabs[count]
          if (!tab) continue
          seenIds.add(tab.id)
          if (ownerId) tab.ownerId = ownerId
          if (tab.kind === 'local' && typeof entry.localCwd === 'string' && isAbsolute(entry.localCwd)) tab.localCwd = entry.localCwd
          if (typeof entry.label === 'string') tab.label = entry.label.trim().slice(0, 128)
          if (typeof entry.color === 'string' && /^#[0-9a-f]{6}$/i.test(entry.color)) tab.color = entry.color
        }
        const layouts: Record<string, PanelLayout> = Object.create(null)
        for (const [key, value] of Object.entries(candidate.layouts ?? {})) {
          if (!normalizeBrowserProfileId(key) || !value || typeof value !== 'object') continue
          const layout = value as PanelLayout
          layouts[key] = { activeId: typeof layout.activeId === 'string' ? layout.activeId : null, visible: layout.visible === true }
        }
        this.projects.set(candidate.profileId, { profileId: candidate.profileId, browserProfileId, tabs, layouts,
          overrides: candidate.overrides === 'private' ? 'private' : 'shared',
          activeId: tabs.some(tab => !tab.ownerId && tab.id === candidate.activeId) ? candidate.activeId : tabs.find(tab => !tab.ownerId)?.id ?? null,
          visible: candidate.visible === true && tabs.some(tab => !tab.ownerId), width: this.width(candidate.width) })
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.profileRecoveryRequired = true; options.error(error) } }
  }
  private width(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(320, Math.min(2400, value)) : 420 }
  localTerminalFolders(): string[] {
    return [...this.projects.values()].flatMap(project => project.tabs.flatMap(tab => tab.localCwd ? [tab.localCwd] : []))
  }
  profileIds(): string[] { return [...this.projects.values()].map(project => project.browserProfileId) }
  hasPartition(partition: string): boolean { return [...this.groups.values()].some(group => group.browser.partition === partition) }
  // Runtime tab IDs are reallocated at startup. browserProfileId is the desktop tab's
  // persisted UUID even when all pages use the shared Chromium cookie partition.
  private ownerFor(sessionId: string | null, profileId: string): string | undefined {
    if (!sessionId) return undefined
    const session = this.options.session(sessionId)
    if (!session || session.sideChat || session.remote || session.workspaceProfileId !== profileId) return undefined
    return session.browserProfileId ?? sessionId
  }
  private foreground(profileId: string): string | undefined {
    return this.ownerFor(this.options.currentSession(), profileId)
  }
  private switchPanel(project: PanelProject): boolean {
    const owner = this.foreground(project.profileId)
    if (project.ownerId === owner || this.releasing.has(owner ?? '')) return false
    const previous = { activeId: project.activeId, visible: project.visible }
    project.layouts[project.ownerId ?? 'workspace'] = previous
    project.ownerId = owner
    const shared = project.layouts.workspace
    const saved = project.layouts[owner ?? 'workspace'] ?? shared
    const tabs = panelTabs(project)
    project.activeId = tabs.find(tab => !tab.detached && tab.id === saved?.activeId)?.id ?? dockedNeighbor(tabs, 0)
    project.visible = Boolean(saved?.visible && tabs.length)
    project.broadcast = false
    if (!project.visible || !previous.visible || previous.activeId !== project.activeId) {
      this.groups.get(project.profileId)?.browser.setBounds(null)
    }
    return true
  }
  private canAccess(tab: ToolTab, owner: string | undefined, profileId: string): boolean {
    return tab.ownerId ? tab.ownerId === owner : !owner || this.foreground(profileId) === owner
  }
  /** Resolve the pages addressable by each live session without opening a page. */
  private syncConnections(): boolean {
    const current = this.options.currentSession()
    let changed = false
    for (const [id, bridge] of this.bridges) {
      const session = this.options.session(id)
      const owner = this.ownerFor(id, bridge.profileId)
      const connected = Boolean(owner && session && liveSession(session.status) && !this.releasing.has(owner))
      const project = this.projects.get(bridge.profileId), group = this.groups.get(bridge.profileId)
      const focused = this.focusPages.get(owner ?? bridge.profileId) ?? this.focusPages.get(bridge.profileId)
      const pages = project?.tabs.filter(tab => tab.pageId !== undefined && this.canAccess(tab, owner, bridge.profileId)) ?? []
      const selected = pages.find(tab => tab.pageId === focused && (id === current || tab.ownerId === owner))?.pageId
        ?? pages.find(tab => tab.pageId === bridge.uiPageId)?.pageId
        ?? pages.find(tab => tab.id === project?.activeId)?.pageId ?? pages[0]?.pageId
      const pageId = connected && selected !== undefined && group?.browser.hasPage(selected) ? selected : null
      if (bridge.connected !== connected || bridge.uiPageId !== pageId ||
          (bridge.pageId !== null && !pages.some(tab => tab.pageId === bridge.pageId))) {
        const keepPrivateCursor = connected && id !== current && pages.some(tab => tab.ownerId === owner && tab.pageId === bridge.pageId)
        const nextPage = keepPrivateCursor ? bridge.pageId : pageId
        if (bridge.connected !== connected || bridge.pageId !== nextPage) bridge.revision++
        bridge.connected = connected; bridge.pageId = nextPage; bridge.uiPageId = pageId
        changed = true
      }
    }
    return changed
  }
  refreshConnections(): void {
    const project = this.shownProject ? this.projects.get(this.shownProject) : undefined
    const id = this.options.currentSession()
    const live = Boolean(id && liveSession(this.options.session(id)?.status))
    const resumed = !this.shownSessionLive && live
    this.shownSessionLive = live
    if (project && (this.switchPanel(project) || resumed)) {
      try { this.restoreSelected(project) } catch (error) { this.options.error(error) }
      this.syncConnections()
      this.save()
    } else if (this.syncConnections()) this.options.changed()
  }
  private restoreSelected(project: PanelProject): void {
    const tab = panelTabs(project).find(tab => tab.id === project.activeId)
    const session = this.options.currentSession()
    const live = session && liveSession(this.options.session(session)?.status)
    if (project.visible && tab && (!tab.ownerId || live || tab.pageId !== undefined) && !this.releasing.has(tab.ownerId ?? '')) {
      this.ensurePage(project, tab)
      if (tab.pageId !== undefined) this.groups.get(project.profileId)?.browser.selectUiPage(tab.pageId)
    }
  }
  /** Raise the window of the page this session's agent uses, if that page is in its own window. Returns whether it did. */
  showSessionWindow(sessionId: string): boolean {
    this.refreshConnections()
    const bridge = this.bridges.get(sessionId), group = bridge && this.groups.get(bridge.profileId)
    if (!bridge?.connected || !group || bridge.pageId === null || !group.browser.hasPage(bridge.pageId)) return false
    if (!this.projects.get(bridge.profileId)?.tabs.find(tab => tab.pageId === bridge.pageId)?.detached) return false
    group.browser.popOutPage(bridge.pageId)
    return true
  }
  private project(id: string, width?: number): PanelProject {
    if (this.removedProjects.has(id)) throw new Error('Workspace no longer exists')
    if (!this.options.project(id)) throw new Error('Workspace no longer exists')
    let project = this.projects.get(id)
    if (!project) {
      project = { profileId: id, browserProfileId: randomUUID(), overrides: this.options.defaults().overrides,
        tabs: [], layouts: Object.create(null), activeId: null, visible: false, width: this.width(width) }
      this.projects.set(id, project)
    }
    this.switchPanel(project)
    return project
  }
  state(): ToolsState {
    this.syncConnections()
    const connections: BrowserConnection[] = [...this.bridges].filter(([, bridge]) => bridge.connected)
      .map(([sessionId, bridge]) => ({ sessionId, profileId: bridge.profileId, pageId: bridge.pageId }))
    return structuredClone({ projects: [...this.projects.values()].map(({ layouts: _layouts, ...view }) => view), connections, recent: this.options.browserOptions().history?.list() ?? [] })
  }
  private save(): void {
    if (this.stopping) return
    const projects = [...this.projects.values()].map(project => {
      const layouts = { ...project.layouts, [project.ownerId ?? 'workspace']: { activeId: project.activeId, visible: project.visible } }
      const tabs = project.tabs.filter(tab => tab.kind !== 'new' && !tab.terminal?.temporary).map(tab => {
        let url: string | null = null
        try { url = tab.url ? restorableUrl(tab.url) : null } catch { /* Blank or invalid URL. */ }
        return { id: tab.id, kind: tab.kind, ownerId: tab.ownerId, localCwd: tab.localCwd, label: tab.label,
          color: tab.color, url: url ?? undefined, terminal: tab.terminal, gitSelectionKey: tab.gitSelectionKey }
      })
      const savedIds = new Set(tabs.map(tab => tab.id))
      for (const [key, layout] of Object.entries(layouts)) {
        if (layout.activeId && !savedIds.has(layout.activeId)) layouts[key] = { ...layout, activeId: null }
      }
      const { workspace = { activeId: null, visible: false }, ...sessions } = layouts
      return { profileId: project.profileId, browserProfileId: project.browserProfileId, overrides: project.overrides,
        width: project.width, ...workspace, layouts: sessions, tabs }
    })
    const text = JSON.stringify({ version: 3, projects })
    if (!this.profileRecoveryRequired) this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(this.file, text))
    void this.writing.catch(this.options.error)
    this.options.changed()
  }
  private limit(): string | null {
    const counts = [...this.groups].map(([id, group]) => ({ name: this.options.project(id)?.name ?? id, count: group.browser.pageCount }))
    return counts.reduce((sum, entry) => sum + entry.count, 0) < 32 ? null
      : `32 browser pages are already open. Close a page first. ${counts.filter(entry => entry.count).map(entry => `${entry.name}: ${entry.count}`).join(', ')}`
  }
  private ensurePage(project: ProjectTools, tab: ToolTab): void {
    if (tab.kind !== 'browser' || tab.pageId !== undefined) return
    const limit = this.limit(); if (limit) throw new Error(limit)
    let group = this.groups.get(project.profileId)
    if (!group) {
      const owner = this.options.owner(); if (!owner || owner.isDestroyed()) throw new Error('Main window unavailable')
      const profile = browserProfilePaths(this.options.userData, project.browserProfileId)
      const partitionId = this.options.defaults().shared ? SHARED_BROWSER_PROFILE_ID : project.browserProfileId
      const partition = browserProfilePaths(this.options.userData, partitionId).partition
      // Mark private page preferences before Chromium loads them so startup collection cannot leak them into shared settings.
      const sharedPreferences = prepareProjectDevtoolsSettings(this.options.userData, partitionId,
        partitionId !== SHARED_BROWSER_PROFILE_ID && project.overrides === 'private', this.initializedPartitions.has(partition))
      this.initializedPartitions.add(partition)
      const browser = new BrowserDebug(owner, profile.settings, { ...this.options.browserOptions(), partition,
        ...(project.overrides === 'private' ? { devtoolsPartition: profile.devtoolsPartition } : {}),
        projectMode: true, tabId: `project:${project.profileId}`, canCreatePage: () => this.limit(),
        panelAllowsDialog: pageId => {
          const tab = project.tabs.find(entry => entry.pageId === pageId)
          return this.shownProject === project.profileId && Boolean(tab && (!tab.ownerId || tab.ownerId === this.foreground(project.profileId)))
        },
        notify: name => {
          const active = project.tabs.find(entry => entry.pageId === this.groups.get(project.profileId)?.browser.snapshot.activePageId)
          if (active?.resource && !owner.isDestroyed()) owner.webContents.send('desktop:browser-shortcut', active.resource, name)
        },
        onNewTab: pageId => {
          const ownerId = project.tabs.find(tab => tab.pageId === pageId)?.ownerId
          void Promise.resolve(this.options.activateProject?.(project.profileId, ownerId))
            .then(() => this.action(project.profileId, { type: 'add', kind: 'new' })).catch(this.options.error)
        },
        onReturnToPanel: pageId => { void this.returnBrowserToPanel(project.profileId, pageId).catch(this.options.error) },
        onPageFocus: pageId => { this.focusPage(project, pageId); this.refreshConnections() },
        onPopup: (pageId, openerId) => {
          const opener = project.tabs.find(tab => tab.pageId === openerId)
          if (opener) project.tabs.push({ id: randomUUID(), kind: 'browser', title: 'Browser', ownerId: opener.ownerId, pageId })
        },
        changed: () => this.reconcile(project.profileId), endpointPath: join(this.options.userData, 'unused-project-control', randomUUID()) })
      browser.setBounds(null)
      group = { browser, generation: randomUUID() }
      this.groups.set(project.profileId, group)
      tab.pageId = browser.pageList()[0]!.id
      if (sharedPreferences) browser.initializePreferences(sharedPreferences,
        values => completeProjectDevtoolsSharing(this.options.userData, partitionId, values))
    } else tab.pageId = group.browser.createPage()
    tab.resource = `tool:${tab.id}`
    group.browser.selectUiPage(tab.pageId)
    if (tab.url) void group.browser.navigatePage(tab.pageId, tab.url).catch(this.options.error)
  }
  private async returnBrowserToPanel(profileId: string, pageId: number): Promise<void> {
    const ownerId = this.projects.get(profileId)?.tabs.find(tab => tab.pageId === pageId)?.ownerId
    await this.options.activateProject?.(profileId, ownerId)
    // Revalidate after activation: the workspace or page may have closed while awaiting it.
    const project = this.projects.get(profileId)
    const tab = project?.tabs.find(tab => tab.pageId === pageId)
    if (this.stopping || !tab || !this.groups.get(profileId)?.browser.hasPage(pageId)) return
    // Return docks, selects and shows the tab in one step; selecting a windowed tab only raises its window.
    await this.action(profileId, { type: 'return', id: tab.id })
    this.showProject(profileId)
    const owner = this.options.owner()
    if (owner && !owner.isDestroyed()) {
      if (owner.isMinimized()) owner.restore()
      owner.show(); owner.focus()
    }
  }
  private reconcile(profileId: string): void {
    if (this.stopping) return
    const project = this.projects.get(profileId), group = this.groups.get(profileId)
    if (!project || !group) return
    const pages = group.browser.pageList()
    let removed = false
    for (const tab of [...project.tabs]) {
      if (tab.pageId !== undefined && !pages.some(page => page.id === tab.pageId)) {
        for (const bridge of this.bridges.values()) if (bridge.profileId === profileId && bridge.pageId === tab.pageId) { bridge.pageId = null; bridge.revision++ }
        if (this.suspendingPages.has(tab.id)) {
          delete tab.pageId; delete tab.resource; delete tab.detached; delete tab.error
        } else removeToolTab(project, tab.id)
        removed = true
      }
    }
    for (const page of pages) {
      let tab = project.tabs.find(tab => tab.pageId === page.id)
      if (!tab) {
        const opener = group.browser.openerOf(page.id)
        const ownerId = project.tabs.find(entry => entry.pageId === opener)?.ownerId
        tab = { id: randomUUID(), kind: 'browser', title: page.title, ownerId }
        project.tabs.push(tab)
      }
      Object.assign(tab, { pageId: page.id, resource: `tool:${tab.id}`, title: page.title, url: page.url, detached: Boolean(page.window), error: page.error })
    }
    // The panel never shows a page that lives in its own window: move to the nearest docked tab instead.
    const visible = panelTabs(project)
    const activeIndex = visible.findIndex(tab => tab.id === project.activeId)
    const moved = activeIndex >= 0 && visible[activeIndex]!.detached === true
    if (moved) project.activeId = dockedNeighbor(visible, activeIndex, project.activeId!)
    if (!pages.length) { this.groups.delete(profileId); this.focusPages.delete(profileId); void group.browser.dispose().catch(this.options.error) }
    else {
      const selected = project.tabs.find(tab => tab.id === project.activeId)
      if (selected?.pageId !== undefined) group.browser.selectUiPage(selected.pageId)
      if (!project.visible || this.shownProject !== profileId || selected?.kind !== 'browser') group.browser.setBounds(null)
    }
    if ((removed || moved) && project.visible && this.shownProject === profileId) {
      const selected = project.tabs.find(tab => tab.id === project.activeId)
      if (selected && !this.releasing.has(selected.ownerId ?? '')) { try { this.restoreSelected(project) } catch (error) { this.options.error(error) } }
    }
    this.save()
  }
  /** Switch projects without destroying live pages; restore only the selected page. */
  showProject(profileId: string | null, initialWidth?: number): void {
    if (this.shownProject !== profileId) for (const project of this.projects.values()) project.broadcast = false
    this.shownProject = profileId
    for (const [id, group] of this.groups) if (id !== profileId) group.browser.setBounds(null)
    if (!profileId) return
    const project = this.project(profileId, initialWidth)
    this.restoreSelected(project)
    this.save()
  }
  resource(id: string): { browser: BrowserDebug; tab: ToolTab; project: ProjectTools } {
    if (!id.startsWith('tool:')) throw new Error('Browser page closed')
    for (const project of this.projects.values()) {
      const tab = project.tabs.find(tab => `tool:${tab.id}` === id)
      const group = this.groups.get(project.profileId)
      if (tab && group && tab.pageId !== undefined && group.browser.hasPage(tab.pageId)) return { browser: group.browser, tab, project }
    }
    throw new Error('Browser page closed. Add a new Browser tab to open one.')
  }
  bounds(id: string, bounds: BrowserBounds | null): void {
    let resource: ReturnType<ProjectToolService['resource']>
    try { resource = this.resource(id) } catch (error) { if (bounds === null) return; throw error }
    if (resource.browser.snapshot.activePageId !== resource.tab.pageId) return
    if (bounds && (!resource.project.visible || resource.project.activeId !== resource.tab.id || this.shownProject !== resource.project.profileId)) return
    resource.browser.setBounds(bounds)
  }
  async action(profileId: string, action: ToolsAction, actor?: ToolActor): Promise<ToolsState> {
    if (this.stopping) throw new Error('App is closing')
    const project = this.project(profileId)
    const owner = actor ? actor.ownerId : project.ownerId
    const foreground = owner === project.ownerId
    if (this.releasing.has(owner ?? '') || (!actor && this.releasing.has(this.foreground(profileId) ?? ''))) throw new Error('Session tools are closing')
    if (action.expectedOwnerId !== undefined && action.expectedOwnerId !== (project.ownerId ?? null)) throw new Error('The active session changed. Try again in its panel.')
    if (action.type === 'add') {
      if (!['new', 'browser', 'git'].includes(action.kind) && !isTerminalKind(action.kind)) throw new Error('Unknown tool type')
      if (action.kind === 'git' && !this.options.project(profileId)?.path) throw new Error('Git requires a project folder')
      const replacing = action.replaceId ? project.tabs.find(tab => tab.id === action.replaceId && tab.kind === 'new' && this.canAccess(tab, owner, profileId)) : undefined
      if (action.replaceId && !replacing) throw new Error('Launcher is no longer available')
      const currentId = actor ? actor.sessionId : this.options.currentSession()
      const session = currentId ? this.options.session(currentId) : undefined
      const workspaceOnly = !actor && session && ['dormant', 'completed', 'crashed'].includes(session.status)
      const newOwner = replacing ? replacing.ownerId : (workspaceOnly ? undefined : owner)
      let tab = action.kind === 'git' ? project.tabs.find(tab => tab.kind === 'git' && tab.ownerId === newOwner) : undefined
      if (!tab) {
        tab = { id: randomUUID(), ownerId: newOwner, kind: action.kind, title: action.kind === 'new' ? 'New tab' : action.kind === 'git' ? 'Git' : 'Browser' }
        if (action.kind === 'git' && newOwner) tab.gitSelectionKey = tab.id
        if (isTerminalKind(action.kind)) {
          if (action.kind === 'local') {
            const folder = actor?.localCwd ?? (newOwner && session?.workspaceProfileId === profileId && !session.remote ? session.sessionCwd ?? session.launchWorktreePath : undefined)
            if (folder && isAbsolute(folder)) tab.localCwd = folder
          }
          tab.terminal = terminalLaunch(action.kind, action.terminal ?? {}, this.options.project(profileId)?.path ?? undefined).config
          if (tab.terminal.transport === 'managed') Object.assign(tab.terminal, this.myTerminal(profileId).connectionMetadata(tab.terminal.connectionId!))
          tab.title = this.terminalTitle(action.kind, tab.terminal)
        }
        if (action.url) { tab.url = parseBrowserAddress(action.url).href }
        this.ensurePage(project, tab)
        project.tabs.push(tab)
      }
      if (action.replaceId && project.tabs.find(entry => entry.id === action.replaceId)?.kind === 'new') removeToolTab(project, action.replaceId)
      if (foreground) { project.activeId = tab.id; project.visible = true }
      else if (owner) project.layouts[owner] = { activeId: tab.id, visible: true }
      if (isTerminalKind(tab.kind)) { this.save(); await this.startTerminal(profileId, tab.id) }
    } else if (action.type === 'visible') {
      if (!action.visible) project.broadcast = false
      project.visible = action.visible && panelTabs(project).length > 0
      const selected = project.tabs.find(tab => tab.id === project.activeId)
      if (project.visible && selected) this.ensurePage(project, selected)
      if (!project.visible) this.groups.get(profileId)?.browser.setBounds(null)
    } else if (action.type === 'broadcast') {
      project.broadcast = action.enabled === true && project.visible && this.shownProject === profileId
    } else if (action.type === 'reorder') {
      const from = project.tabs.findIndex(tab => tab.id === action.id), to = project.tabs.findIndex(tab => tab.id === action.beforeId)
      if (from < 0 || to < 0) throw new Error('Tab already closed')
      if (project.tabs[from]!.ownerId !== project.tabs[to]!.ownerId || !this.canAccess(project.tabs[from]!, owner, profileId)) throw new Error('Reorder tabs within the same owner')
      if (project.tabs[from]!.detached || project.tabs[to]!.detached) throw new Error('That page is open in its own window')
      const [tab] = project.tabs.splice(from, 1); project.tabs.splice(to, 0, tab!)
    } else if (action.type === 'width') project.width = this.width(action.width)
    else if (action.type === 'overrides') {
      if (!['private', 'shared'].includes(action.mode)) throw new Error('Invalid overrides mode')
      project.overrides = action.mode
    } else {
      const tab = project.tabs.find(tab => tab.id === action.id); if (!tab || !this.canAccess(tab, owner, profileId)) throw new Error('Tab is unavailable in this panel')
      if (action.type === 'promote') {
        if (!tab.ownerId) throw new Error('Tab already belongs to the workspace')
        delete tab.ownerId
        for (const child of this.splits.values()) if (child.parentId === tab.id) delete child.tab.ownerId
        project.broadcast = false
      } else if (action.type === 'metadata') {
        if (action.label !== undefined) {
          if (typeof action.label !== 'string' || action.label.length > 128) throw new Error('Tab name must be at most 128 characters')
          tab.label = action.label.trim()
        }
        if (action.color !== undefined) {
          if (action.color !== null && (typeof action.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(action.color))) throw new Error('Invalid tab color')
          if (action.color === null) delete tab.color
          else tab.color = action.color
        }
      } else if (action.type === 'save-connection') {
        if (!tab.terminal?.temporary || !tab.terminal.connectionId) throw new Error('This connection is already saved')
        this.myTerminal(profileId).saveTemporary(tab.terminal.connectionId)
        delete tab.terminal.temporary
      } else if (action.type === 'select') {
        // A page in its own window stays there: choosing it raises that window and leaves the panel as it is.
        if (tab.detached && tab.resource) {
          this.resource(tab.resource).browser.popOutPage(tab.pageId!)
          this.focusPage(project, tab.pageId!)
        } else { this.ensurePage(project, tab); project.activeId = tab.id; project.visible = true }
      } else if (action.type === 'close') {
        this.closeSplit(profileId, tab.id)
        this.closeTerminal(profileId, tab.id)
        if (tab.pageId !== undefined) {
          const group = this.groups.get(profileId)
          if (group && !await group.browser.closePage(tab.pageId)) return this.state()
        }
        if (tab.terminal?.temporary && tab.terminal.connectionId) this.terminalServices.get(profileId)?.forgetTemporary(tab.terminal.connectionId)
        removeToolTab(project, tab.id)
      } else if (tab.resource) {
        const { browser } = this.resource(tab.resource)
        if (action.type === 'pop-out') browser.popOutPage(tab.pageId!)
        else if (action.type === 'return') browser.returnPage(tab.pageId!)
        else throw new Error('Unknown tab action')
        // The agent stays on the page that moved, wherever the panel goes next.
        this.focusPage(project, tab.pageId!)
        // Browser change notifications are queued. Refresh now so the IPC reply
        // cannot overwrite a newer notification with the old window ownership.
        // After a pop-out this also moves the panel to the nearest docked tab.
        this.reconcile(profileId)
        if (action.type === 'return') { project.activeId = tab.id; project.visible = true }
      }
    }
    const selected = project.tabs.find(tab => tab.id === project.activeId)
    if (action.type === 'close' && project.visible && this.shownProject === profileId && selected) this.restoreSelected(project)
    const group = this.groups.get(profileId)
    if (project.visible && selected?.pageId !== undefined && group?.browser.hasPage(selected.pageId)) group.browser.selectUiPage(selected.pageId)
    else group?.browser.setBounds(null)
    // Choosing or adding a browser tab points the agent at it; other changes leave its page alone.
    const chosen = !foreground ? null : action.type === 'select' ? action.id : action.type === 'add' ? project.activeId : null
    if (chosen && selected?.id === chosen && selected.kind === 'browser' && selected.pageId !== undefined && !selected.detached) this.focusPage(project, selected.pageId)
    this.save()
    // Browser initialization must not block independent tools or prevent closing a failed page.
    // Keep failed browser navigation gated until its group is closed and explicitly reopened.
    if (action.type === 'add' && action.kind === 'browser') await group?.browser.ready
    return this.state()
  }
  private terminalTitle(kind: string, config: TerminalConfig): string {
    // MyTerminal's saved/temporary session label, without copying credentials into tabs.
    return kind === 'ssh' ? config.name || `${config.username ? config.username + '@' : ''}${config.host}${config.port && config.port !== 22 ? ':' + config.port : ''}` : kind === 'wsl' ? `WSL${config.distro ? `: ${config.distro}` : ''}` : 'Local terminal'
  }
  private myTerminal(profileId: string): MyTerminalServices {
    if (this.stopping || this.removedProjects.has(profileId) || !this.options.project(profileId)) throw new Error('Workspace no longer exists')
    let services = this.terminalServices.get(profileId)
    if (!services) {
      const directory = this.terminalDataDirectory(profileId)
      services = new MyTerminalServices(directory, this.options.owner)
      this.terminalServices.set(profileId, services)
    }
    return services
  }
  private terminalDataDirectory(profileId: string): string {
    return join(this.options.userData, 'myterminal', createHash('sha256').update(profileId).digest('hex').slice(0, 24))
  }
  private terminalTab(profileId: string, id: string): ToolTab | undefined {
    return this.projects.get(profileId)?.tabs.find(tab => tab.id === id && isTerminalKind(tab.kind))
      ?? (this.splits.get(id)?.profileId === profileId ? this.splits.get(id)?.tab : undefined)
  }
  async terminalFeature(profileId: string, method: string, args: unknown[]): Promise<unknown> {
    if (method === 'sessions:connectTemporary') {
      const service = this.myTerminal(profileId), config = service.createTemporary(args[0])
      try { return await this.action(profileId, { type: 'add', kind: 'ssh', terminal: config, ...(typeof args[1] === 'string' ? { replaceId: args[1] } : {}) }) }
      catch (error) { if (!this.projects.get(profileId)?.tabs.some(tab => tab.terminal?.connectionId === config.connectionId)) service.forgetTemporary(config.connectionId!); throw error }
    }
    return this.myTerminal(profileId).invoke(method, args, id => {
      const tab = this.terminalTab(profileId, id)
      return Boolean(tab && this.canAccess(tab, this.foreground(profileId), profileId))
    })
  }
  terminalDrop(profileId: string, paths: string[]): void { this.myTerminal(profileId).authorizeDrop(paths) }
  private closeSplit(profileId: string, parentId: string): void {
    for (const [id, child] of this.splits) if (child.profileId === profileId && child.parentId === parentId) {
      this.splits.delete(id); this.closeTerminal(profileId, id)
    }
  }
  private closeTerminal(profileId: string, id: string): void {
    this.terminalLifecycles.get(id)?.retry.dispose()
    this.terminalLifecycles.delete(id)
    if (this.terminalStarts.has(id)) this.cancelledStarts.add(id)
    this.terminals.close(profileId, id)
    const closing = this.stopTerminalBridge(id)
    this.closingTerminalBridges.add(closing)
    void closing.finally(() => this.closingTerminalBridges.delete(closing)).catch(this.options.error)
  }
  private async terminalEnvironment(profileId: string, sourceId: string): Promise<NodeJS.ProcessEnv> {
    let pending = this.terminalBridges.get(sourceId)
    if (!pending) {
      pending = (async () => {
        const { directory, env } = await prepareToolTerminalEnvironment(join(this.options.userData, 'terminal-helpers'), message => this.options.error(message))
        const endpoint = env.COPILOT_DESKTOP_TERMINAL_STATE!, token = randomBytes(32).toString('hex')
        const server = createServer((request, response) => {
          const port = (server.address() as { port: number }).port
          if (request.url !== '/terminal' || request.headers.origin || request.headers.host !== `127.0.0.1:${port}` || !constantTimeTokenEqual(request.headers.authorization ?? '', `Bearer ${token}`)) {
            response.writeHead(403); response.end(); return
          }
          const origin = this.terminalTab(profileId, sourceId)
          const scope = { ownerId: origin?.ownerId, workspaceAccess: !origin?.ownerId, localCwd: origin?.localCwd }
          void this.serveTerminal(request, response, profileId, () => {
            if (this.stopping || !origin || this.terminalTab(profileId, sourceId) !== origin || origin.ownerId !== scope.ownerId ||
                this.releasing.has(origin.ownerId ?? '') || (!origin.ownerId && (this.options.currentProject?.() ?? this.shownProject) !== profileId)) throw new Error('Terminal owner is unavailable')
          }, scope)
        })
        server.requestTimeout = 15000
        try {
          await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
          await writeFileAtomic(endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token }))
        } catch (error) {
          if (server.listening) server.close()
          await rm(directory, { recursive: true, force: true })
          throw error
        }
        // A tool shell is not an agent session; do not inherit browser authority or instruction directories.
        delete env.COPILOT_DESKTOP_BROWSER_STATE; delete env.COPILOT_DESKTOP_BROWSER_HELPER; delete env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS
        if (process.platform === 'win32') env.WSLENV = [env.WSLENV, 'COPILOT_DESKTOP_TERMINAL_STATE', 'COPILOT_DESKTOP_TERMINAL_WINDOWS_HELPER', 'COPILOT_DESKTOP_TERMINAL_HELPER/p'].filter(Boolean).join(':')
        return { server, directory, env }
      })()
      this.terminalBridges.set(sourceId, pending)
      void pending.catch(() => { if (this.terminalBridges.get(sourceId) === pending) this.terminalBridges.delete(sourceId) })
    }
    return (await pending).env
  }
  private async stopTerminalBridge(sourceId: string): Promise<void> {
    const pending = this.terminalBridges.get(sourceId); this.terminalBridges.delete(sourceId)
    if (!pending) return
    try { const bridge = await pending; bridge.server.closeAllConnections(); bridge.server.close(); await rm(bridge.directory, { recursive: true, force: true }) }
    catch (error) { this.options.error(error) }
  }
  private async startTerminal(profileId: string, id: string): Promise<unknown> {
    if (this.releasing.has(this.terminalTab(profileId, id)?.ownerId ?? '')) throw new Error('Session tools are closing')
    const running = this.terminalStarts.get(id); if (running) return running
    const pending = (async () => {
      const env = await this.terminalEnvironment(profileId, id)
      const tab = this.terminalTab(profileId, id)
      if (this.stopping || this.cancelledStarts.has(id) || !tab || !isTerminalKind(tab.kind)) throw new Error('Terminal tab closed')
      if (tab.terminal?.transport === 'managed') {
        Object.assign(tab.terminal, this.myTerminal(profileId).connectionMetadata(tab.terminal.connectionId!))
        tab.title = this.terminalTitle(tab.kind, tab.terminal)
        this.save()
      }
      if (!this.terminalLifecycles.has(id)) {
        const retry = createReconnectController({ connect: () => {
          // Only restart a live managed connection that this lifecycle still owns.
          // Renderer/CLI commands retain their current-project authorization.
          if (this.stopping || this.terminalLifecycles.get(id)?.retry !== retry || !this.terminalTab(profileId, id)) return
          this.terminalLifecycles.delete(id)
          this.terminals.close(profileId, id)
          this.terminalLifecycles.set(id, lifecycle)
          void this.startTerminal(profileId, id).catch(this.options.error)
        } })
        const lifecycle = { profileId, retry, bell: createBellNotifier({
          focused: () => this.options.owner()?.isFocused() ?? false,
          label: () => { const current = this.terminalTab(profileId, id); return current?.label || current?.title || 'Terminal' },
          notify: (title, body) => { void this.terminalServices.get(profileId)?.invoke('notify:send', [title, body], () => false).catch(this.options.error) },
        }) }
        this.terminalLifecycles.set(id, lifecycle)
      }
      const terminalEnv = tab.kind === 'wsl' ? { ...env, COPILOT_DESKTOP_TERMINAL_HELPER: env.COPILOT_DESKTOP_TERMINAL_WSL_HELPER } : env
      return this.terminals.start(profileId, id, tab.kind, tab.terminal ?? {}, tab.localCwd ?? this.options.project(profileId)?.path ?? null, terminalEnv)
    })()
    this.terminalStarts.set(id, pending)
    try { return await pending } finally { this.terminalStarts.delete(id); this.cancelledStarts.delete(id) }
  }
  /** The renderer and authenticated helper share the same ownership and input checks. */
  async terminalAction(profileId: string, request: unknown, actor?: ToolActor): Promise<unknown> {
    if (this.stopping || !this.options.project(profileId)) throw new Error('Workspace no longer exists')
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid terminal request')
    const value = request as Record<string, unknown>, project = this.project(profileId)
    const owner = actor ? actor.ownerId : project.ownerId
    // Retained terminal components keep their buffers and sizes across panel switches.
    const backgroundRead = !actor && (value.action === 'read' || value.action === 'resize')
    const allowed = (tab: ToolTab): boolean => backgroundRead || (tab.ownerId ? tab.ownerId === owner
      : !actor || (actor.workspaceAccess ?? (owner !== undefined && owner === this.foreground(profileId))))
    if (this.releasing.has(owner ?? '')) throw new Error('Session tools are closing')
    if (value.action === 'list') return [...project.tabs.filter(tab => isTerminalKind(tab.kind) && allowed(tab)), ...[...this.splits.values()].filter(child => child.profileId === profileId && allowed(child.tab)).map(child => ({ ...child.tab, parentId: child.parentId }))].map(tab => {
      try { const { output: _output, ...state } = this.terminals.read(profileId, tab.id); return { ...tab, ...state } }
      catch { return { ...tab, status: 'disconnected' } }
    })
    if (value.action === 'create') {
      if (typeof value.kind !== 'string' || !isTerminalKind(value.kind)) throw new Error('Use local, wsl, or ssh')
      // Remember this operation's ID even if another request changes the selected tab during startup.
      const before = new Set(project.tabs.map(tab => tab.id))
      const operation = this.action(profileId, { type: 'add', kind: value.kind, terminal: (value.config ?? {}) as TerminalConfig }, actor)
      const created = project.tabs.find(tab => !before.has(tab.id))
      await operation
      if (!created || !project.tabs.includes(created)) throw new Error('Terminal closed during startup')
      return { ...created, ...this.terminals.read(profileId, created.id) }
    }
    if (typeof value.id !== 'string') throw new Error('A terminal ID is required')
    const tab = this.terminalTab(profileId, value.id)
    if (!tab || !allowed(tab)) throw new Error('Terminal does not belong to this session or workspace')
    if (value.action === 'broadcast') {
      if (!project.broadcast || !project.visible || this.shownProject !== profileId || project.activeId !== tab.id) throw new Error('Broadcast is not active for this terminal')
      if (typeof value.text !== 'string' || value.text.length > 65536) throw new Error('Input must be at most 64 KiB')
      const targets = project.tabs.filter(target => {
        if (target.ownerId !== tab.ownerId || !isTerminalKind(target.kind)) return false
        try { return this.terminals.read(profileId, target.id).status === 'running' } catch { return false }
      }).map(target => ({ channelId: target.id, isLocal: target.kind !== 'ssh' }))
      const write = (id: string, text: string): void => this.terminals.write(profileId, id, text)
      writeToBroadcastTargets(targets, value.text, { local: { write }, ssh: { write } })
      return { delivered: targets.map(target => target.channelId) }
    }
    if (value.action === 'split') {
      if (this.splits.has(tab.id)) throw new Error('This pane is already a split')
      const existing = [...this.splits.values()].find(child => child.parentId === tab.id)
      if (existing) return { id: existing.tab.id }
      const child = { ...tab, id: randomUUID(), title: `${tab.title} (split)` }
      this.splits.set(child.id, { profileId, parentId: tab.id, tab: child })
      await this.startTerminal(profileId, child.id)
      return { id: child.id }
    }
    if (value.action === 'unsplit') { this.closeSplit(profileId, tab.id); return { closed: true } }
    if (value.action === 'start') return this.startTerminal(profileId, tab.id)
    if (value.action === 'cancel-reconnect') { this.terminalLifecycles.get(tab.id)?.retry.cancel(); return { ok: true } }
    if (value.action === 'restart') {
      if (this.terminalStarts.has(tab.id)) throw new Error('Terminal is still starting; wait before reconnecting')
      this.closeTerminal(profileId, tab.id); return this.startTerminal(profileId, tab.id)
    }
    if (value.action === 'read') {
      if (value.cursor !== undefined && (typeof value.cursor !== 'number' || !Number.isSafeInteger(value.cursor) || value.cursor < 0)) throw new Error('Invalid output cursor')
      try {
        let cursor = value.cursor as number | undefined
        if (value.generation !== undefined) {
          if (typeof value.generation !== 'string') throw new Error('Invalid terminal generation')
          const snapshot = this.terminals.read(profileId, tab.id)
          if (snapshot.generation !== value.generation) cursor = 0
        }
        const splitId = [...this.splits.values()].find(child => child.parentId === tab.id && !this.terminalStarts.has(child.tab.id))?.tab.id
        return { ...this.terminals.read(profileId, tab.id, cursor), reconnectCountdown: this.terminalLifecycles.get(tab.id)?.retry.remaining ?? null, reconnectExhausted: this.terminalLifecycles.get(tab.id)?.retry.exhausted ?? false, ...(splitId ? { splitId } : {}) }
      }
      catch (error) {
        if (error instanceof Error && error.message === 'Terminal is not connected in this project') return { id: tab.id, generation: '', status: 'disconnected', output: '', cursor: 0, start: 0 }
        throw error
      }
    }
    if (value.action === 'close') {
      if (this.splits.has(tab.id)) { this.splits.delete(tab.id); this.closeTerminal(profileId, tab.id) }
      else await this.action(profileId, { type: 'close', id: tab.id }, actor)
      return { closed: true }
    }
    if (value.action === 'resize') this.terminals.resize(profileId, tab.id, value.cols as number, value.rows as number)
    else if (value.action === 'interrupt') this.terminals.write(profileId, tab.id, '\x03')
    else if (value.action === 'write') {
      if (typeof value.text !== 'string' || value.text.length > 64000) throw new Error('Input must be a string of at most 64000 characters')
      this.terminals.write(profileId, tab.id, value.text)
    } else throw new Error('Unknown terminal action')
    return { ok: true }
  }
  private async serveTerminal(request: IncomingMessage, response: ServerResponse, profileId: string, authorize: () => void, actor: ToolActor): Promise<void> {
    try {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      authorize()
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) { size += chunk.length; if (size > 131072) throw new Error('Request exceeds 128 KiB'); chunks.push(Buffer.from(chunk)) }
      // Session changes while an HTTP body arrives must revoke the pending operation.
      authorize()
      const result = await this.terminalAction(profileId, JSON.parse(Buffer.concat(chunks).toString('utf8')), actor)
      authorize()
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result))
    } catch (error) {
      if (!response.headersSent) response.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'Terminal request failed' }))
    }
  }
  async startBridge(sessionId: string, profileId: string, endpoint: string): Promise<void> {
    await this.stopBridge(sessionId)
    const token = randomBytes(32).toString('hex')
    const bridge: Bridge = { server: null as unknown as Server, token, endpoint, profileId, connected: false, pageId: null, uiPageId: null, revision: 0 }
    const server = createServer((request, response) => {
      const fail = (status: number, message: string): void => { if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ message })) }
      const port = (server.address() as { port: number }).port
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) { fail(403, 'Forbidden'); return }
      if (!constantTimeTokenEqual(request.headers.authorization ?? '', `Bearer ${token}`)) { fail(401, 'Unauthorized'); return }
      this.refreshConnections()
      if (request.url === '/terminal') {
        void this.serveTerminal(request, response, profileId, () => {
          this.refreshConnections()
          if (this.bridges.get(sessionId) !== bridge || !bridge.connected) throw new Error('Terminal control requires a live session in its owning project.')
          const session = this.options.session(sessionId)
          if (session?.sideChat || session?.remote || session?.sessionPermissionPreset === 'read-only') throw new Error('Terminal control is unavailable to read-only, side-chat, or remote sessions')
        }, { ownerId: this.ownerFor(sessionId, profileId), sessionId }); return
      }
      if (!liveSession(this.options.session(sessionId)?.status)) { fail(409, 'CLI session is not running; resume it to use the browser.'); return }
      const group = this.groups.get(profileId), revision = bridge.revision
      if (!bridge.connected) { fail(409, 'Browser control requires a live session in its owning project.'); return }
      if (!group) { fail(409, 'No browser pages open. Add a Browser tab, then run tabs and select a page ID.'); return }
      const allowsPage = (id: number): boolean => {
        const tab = this.projects.get(profileId)?.tabs.find(tab => tab.pageId === id)
        const owner = this.ownerFor(sessionId, profileId)
        return Boolean(owner && tab && this.canAccess(tab, owner, profileId))
      }
      const cursor: BrowserCursor = {
        allowsPage,
        active: () => bridge.pageId ?? 0,
        select: id => { if (!allowsPage(id) || !group.browser.hasPage(id)) throw new Error('Browser page closed'); bridge.pageId = id; this.options.changed() },
        validate: () => { this.syncConnections(); if (!liveSession(this.options.session(sessionId)?.status) || this.bridges.get(sessionId) !== bridge || !bridge.connected || bridge.revision !== revision || this.groups.get(profileId) !== group) throw new Error('Current session or browser page changed; retry from the active session.') },
      }
      try { group.browser.serveControl(request, response, { port, token, cursor }) }
      catch (error) { fail(409, error instanceof Error ? error.message : 'Browser unavailable') }
    })
    bridge.server = server
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    this.bridges.set(sessionId, bridge)
    try { await writeFileAtomic(endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token })) }
    catch (error) { await this.stopBridge(sessionId); throw error }
    this.refreshConnections()
  }
  async stopBridge(sessionId: string): Promise<void> {
    const bridge = this.bridges.get(sessionId); if (!bridge) return
    this.bridges.delete(sessionId); bridge.revision++; bridge.connected = false
    bridge.server.closeAllConnections(); bridge.server.close()
    try { if (JSON.parse(await readFile(bridge.endpoint, 'utf8')).token === bridge.token) await rm(bridge.endpoint, { force: true }) } catch { /* Already removed. */ }
    this.options.changed()
  }
  /** Close guarded pages before stopping shells or allowing worktree removal. A
   * cancelled close keeps the owner and its tab records, including pages already closed. */
  async releaseSession(sessionId: string, unload: boolean): Promise<(() => void) | null> {
    const session = this.options.session(sessionId)
    if (!session) return () => {}
    const profileId = session.workspaceProfileId, owner = this.ownerFor(sessionId, profileId)
    const project = this.projects.get(profileId)
    if (!owner) return () => {}
    this.releasing.add(owner)
    const finish = (): void => { this.releasing.delete(owner); this.refreshConnections() }
    if (!project) return finish
    try {
      const group = this.groups.get(profileId)
      // Include popups created while a beforeunload dialog is open.
      while (group) {
        this.reconcile(profileId)
        const tab = project.tabs.find(tab => tab.ownerId === owner && tab.pageId !== undefined)
        if (!tab || tab.pageId === undefined) break
        this.suspendingPages.add(tab.id)
        try {
          if (!await group.browser.closePage(tab.pageId)) { finish(); return null }
          delete tab.pageId; delete tab.resource; delete tab.detached; delete tab.error
        } finally { this.suspendingPages.delete(tab.id) }
      }
      for (const tab of [...project.tabs].filter(tab => tab.ownerId === owner)) {
        this.closeSplit(profileId, tab.id)
        this.closeTerminal(profileId, tab.id)
        if (!unload || tab.kind === 'new' || tab.terminal?.temporary) {
          if (tab.terminal?.temporary && tab.terminal.connectionId) this.terminalServices.get(profileId)?.forgetTemporary(tab.terminal.connectionId)
          removeToolTab(project, tab.id)
        }
      }
      if (!unload) {
        delete project.layouts[owner]
        this.focusPages.delete(owner)
        if (project.ownerId === owner) {
          delete project.ownerId
          const shared = project.layouts.workspace
          project.activeId = project.tabs.find(tab => !tab.ownerId && tab.id === shared?.activeId)?.id ?? dockedNeighbor(panelTabs(project), 0)
          project.visible = Boolean(project.activeId && shared?.visible)
          project.broadcast = false
        }
      }
      return finish
    } catch (error) {
      finish(); throw error
    } finally {
      this.save()
    }
  }
  async removeProject(id: string): Promise<void> {
    // Revoke pending starts before the first await; helper setup can complete during bridge shutdown.
    const terminalIds = [...(this.projects.get(id)?.tabs ?? []), ...[...this.splits.values()].filter(child => child.profileId === id).map(child => child.tab)].map(tab => tab.id)
    this.projects.delete(id)
    this.removedProjects.add(id)
    for (const [key, child] of this.splits) if (child.profileId === id) this.splits.delete(key)
    for (const [key, lifecycle] of this.terminalLifecycles) if (lifecycle.profileId === id) {
      lifecycle.retry.dispose(); this.terminalLifecycles.delete(key)
    }
    this.terminals.closeProject(id)
    const services = this.terminalServices.get(id); this.terminalServices.delete(id)
    await services?.dispose()
    // Only the app-owned, hashed project directory is removed. Custom log destinations remain untouched.
    await rm(this.terminalDataDirectory(id), { recursive: true, force: true })
    await Promise.all(terminalIds.map(key => this.stopTerminalBridge(key)))
    const group = this.groups.get(id); this.groups.delete(id); this.focusPages.delete(id)
    for (const [sessionId, bridge] of this.bridges) if (bridge.profileId === id) await this.stopBridge(sessionId)
    if (group) await group.browser.dispose()
    // The same folder receives the same ID when added again. Block it only until
    // cleanup succeeds; removed tabs and closed bridges still revoke old work.
    this.removedProjects.delete(id)
    this.save()
  }
  async dispose(): Promise<void> {
    this.stopping = true
    for (const lifecycle of this.terminalLifecycles.values()) lifecycle.retry.dispose()
    this.terminalLifecycles.clear()
    this.terminals.dispose()
    await Promise.all([...this.terminalServices.values()].map(service => service.dispose()))
    this.terminalServices.clear(); this.splits.clear()
    await Promise.all([...this.terminalBridges.keys()].map(id => this.stopTerminalBridge(id)))
    await Promise.all(this.closingTerminalBridges)
    await this.writing.catch(this.options.error)
    await Promise.all([...this.bridges.keys()].map(id => this.stopBridge(id)))
    await Promise.all([...this.groups.values()].map(group => group.browser.dispose()))
    this.groups.clear()
  }
}
