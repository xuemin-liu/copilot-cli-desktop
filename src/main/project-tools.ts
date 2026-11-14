import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
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
import { removeToolTab, type BrowserConnection, type ProjectTools, type ToolsAction, type ToolsState, type ToolTab } from './tool-tabs.js'

interface Group { browser: BrowserDebug; generation: string }
const liveSession = (status: string | undefined): boolean => status === 'running' || status === 'approval-needed'
interface Bridge { server: Server; token: string; endpoint: string; profileId: string; connected: boolean; pageId: number | null; revision: number }
interface Options {
  userData: string
  owner(): BrowserWindow | null
  project(id: string): { name: string; path: string | null } | undefined
  session(id: string): { workspaceProfileId: string; status: string } | undefined
  defaults(): { shared: boolean; overrides: 'shared' | 'private' }
  browserOptions(): Partial<NonNullable<ConstructorParameters<typeof BrowserDebug>[2]>>
  changed(): void
  error(error: unknown): void
}

/** Owns project tabs and browser lifetimes. Only explicit add/select restores a runtime. */
export class ProjectToolService {
  private readonly projects = new Map<string, ProjectTools>()
  private readonly groups = new Map<string, Group>()
  private readonly bridges = new Map<string, Bridge>()
  private writing = Promise.resolve()
  private readonly file: string
  private stopping = false
  private shownProject: string | null = null
  private readonly initializedPartitions = new Set<string>()
  readonly profileRecoveryRequired: boolean = false
  constructor(private readonly options: Options) {
    this.file = join(options.userData, 'workspace-tool-tabs-v2.json')
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; projects?: unknown }
      if (saved.version !== 2 || !Array.isArray(saved.projects)) throw new Error('Invalid tool tabs manifest; browser profiles were preserved')
      for (const candidate of saved.projects) {
        if (!candidate || typeof candidate.profileId !== 'string' || !options.project(candidate.profileId)) continue
        const browserProfileId = normalizeBrowserProfileId(candidate.browserProfileId)
        if (!browserProfileId || !Array.isArray(candidate.tabs)) continue
        const tabs: ToolTab[] = []
        for (const entry of candidate.tabs.slice(0, 128)) {
          if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || tabs.some(tab => tab.id === entry.id)) continue
          if (entry.kind === 'git' && !tabs.some(tab => tab.kind === 'git')) tabs.push({ id: entry.id, kind: 'git', title: 'Git' })
          if (entry.kind === 'browser') {
            let url: string | null = null
            try { url = typeof entry.url === 'string' ? restorableUrl(entry.url) : null } catch { /* Invalid saved URL. */ }
            tabs.push({ id: entry.id, kind: 'browser', title: 'Browser', ...(url ? { url } : {}) })
          }
        }
        this.projects.set(candidate.profileId, { profileId: candidate.profileId, browserProfileId, tabs,
          overrides: candidate.overrides === 'private' ? 'private' : 'shared',
          activeId: tabs.some(tab => tab.id === candidate.activeId) ? candidate.activeId : tabs[0]?.id ?? null,
          visible: candidate.visible === true && tabs.length > 0, width: this.width(candidate.width) })
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.profileRecoveryRequired = true; options.error(error) } }
  }
  private width(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(320, Math.min(2400, value)) : 420 }
  profileIds(): string[] { return [...this.projects.values()].map(project => project.browserProfileId) }
  hasPartition(partition: string): boolean { return [...this.groups.values()].some(group => group.browser.partition === partition) }
  canConnect(sessionId: string, profileId: string): boolean {
    const bridge = this.bridges.get(sessionId), session = this.options.session(sessionId)
    return bridge?.profileId === profileId && session?.workspaceProfileId === profileId && liveSession(session.status)
  }
  private project(id: string, width?: number): ProjectTools {
    if (!this.options.project(id)) throw new Error('Workspace no longer exists')
    let project = this.projects.get(id)
    if (!project) {
      project = { profileId: id, browserProfileId: randomUUID(), overrides: this.options.defaults().overrides,
        tabs: [], activeId: null, visible: false, width: this.width(width) }
      this.projects.set(id, project)
    }
    return project
  }
  state(): ToolsState {
    const connections: BrowserConnection[] = [...this.bridges].filter(([, bridge]) => bridge.connected)
      .map(([sessionId, bridge]) => ({ sessionId, profileId: bridge.profileId, pageId: bridge.pageId }))
    return structuredClone({ projects: [...this.projects.values()], connections, recent: this.options.browserOptions().history?.list() ?? [] })
  }
  private save(): void {
    if (this.stopping) return
    const projects = [...this.projects.values()].map(project => ({ ...project, tabs: project.tabs.filter(tab => tab.kind !== 'new').map(tab => {
      let url: string | null = null
      try { url = tab.url ? restorableUrl(tab.url) : null } catch { /* Blank or invalid URL. */ }
      return { id: tab.id, kind: tab.kind, ...(url ? { url } : {}) }
    }) }))
    const text = JSON.stringify({ version: 2, projects })
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
        notify: name => {
          const active = project.tabs.find(entry => entry.pageId === this.groups.get(project.profileId)?.browser.snapshot.activePageId)
          if (active?.resource && !owner.isDestroyed()) owner.webContents.send('desktop:browser-shortcut', active.resource, name)
        },
        onNewTab: () => { void this.action(project.profileId, { type: 'add', kind: 'new' }).catch(this.options.error) },
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
  private reconcile(profileId: string): void {
    if (this.stopping) return
    const project = this.projects.get(profileId), group = this.groups.get(profileId)
    if (!project || !group) return
    const pages = group.browser.pageList()
    let removed = false
    for (const tab of [...project.tabs]) {
      if (tab.pageId !== undefined && !pages.some(page => page.id === tab.pageId)) {
        for (const bridge of this.bridges.values()) if (bridge.profileId === profileId && bridge.pageId === tab.pageId) { bridge.pageId = null; bridge.revision++ }
        removeToolTab(project, tab.id)
        removed = true
      }
    }
    for (const page of pages) {
      let tab = project.tabs.find(tab => tab.pageId === page.id)
      if (!tab) { tab = { id: randomUUID(), kind: 'browser', title: page.title }; project.tabs.push(tab) }
      Object.assign(tab, { pageId: page.id, resource: `tool:${tab.id}`, title: page.title, url: page.url, detached: Boolean(page.window), error: page.error })
    }
    if (!pages.length) { this.groups.delete(profileId); void group.browser.dispose().catch(this.options.error) }
    else {
      const selected = project.tabs.find(tab => tab.id === project.activeId)
      if (selected?.pageId !== undefined) group.browser.selectUiPage(selected.pageId)
      if (!project.visible || this.shownProject !== profileId || selected?.kind !== 'browser') group.browser.setBounds(null)
    }
    if (removed && project.visible && this.shownProject === profileId) {
      const selected = project.tabs.find(tab => tab.id === project.activeId)
      if (selected) { try { this.ensurePage(project, selected) } catch (error) { this.options.error(error) } }
    }
    this.save()
  }
  /** Switch projects without destroying live pages; restore only the selected page. */
  showProject(profileId: string | null, initialWidth?: number): void {
    this.shownProject = profileId
    for (const [id, group] of this.groups) if (id !== profileId) group.browser.setBounds(null)
    if (!profileId) return
    const project = this.project(profileId, initialWidth)
    const tab = project.tabs.find(tab => tab.id === project.activeId)
    if (project.visible && tab) this.ensurePage(project, tab)
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
  async action(profileId: string, action: ToolsAction): Promise<ToolsState> {
    if (this.stopping) throw new Error('App is closing')
    const project = this.project(profileId)
    if (action.type === 'add') {
      if (!['new', 'browser', 'git'].includes(action.kind)) throw new Error('Unknown tool type')
      if (action.kind === 'git' && !this.options.project(profileId)?.path) throw new Error('Git requires a project folder')
      if (action.sessionId) this.requireBridge(project, action.sessionId)
      let tab = action.kind === 'git' ? project.tabs.find(tab => tab.kind === 'git') : undefined
      if (!tab) {
        tab = { id: randomUUID(), kind: action.kind, title: action.kind === 'new' ? 'New tab' : action.kind === 'git' ? 'Git' : 'Browser' }
        if (action.url) { tab.url = parseBrowserAddress(action.url).href }
        this.ensurePage(project, tab)
        project.tabs.push(tab)
      }
      if (action.replaceId && project.tabs.find(entry => entry.id === action.replaceId)?.kind === 'new') removeToolTab(project, action.replaceId)
      project.activeId = tab.id; project.visible = true
      if (action.sessionId && tab.kind === 'browser') this.connect(project, tab, action.sessionId)
    } else if (action.type === 'visible') {
      project.visible = action.visible && project.tabs.length > 0
      const selected = project.tabs.find(tab => tab.id === project.activeId)
      if (project.visible && selected) this.ensurePage(project, selected)
      if (!project.visible) this.groups.get(profileId)?.browser.setBounds(null)
    } else if (action.type === 'width') project.width = this.width(action.width)
    else if (action.type === 'disconnect') {
      const bridge = this.bridges.get(action.sessionId)
      if (bridge?.profileId !== profileId) throw new Error('Session does not belong to this project')
      bridge.connected = false; bridge.pageId = null; bridge.revision++
    }
    else if (action.type === 'overrides') {
      if (!['private', 'shared'].includes(action.mode)) throw new Error('Invalid overrides mode')
      project.overrides = action.mode
    } else {
      const tab = project.tabs.find(tab => tab.id === action.id); if (!tab) throw new Error('Tab already closed')
      if (action.type === 'select') {
        this.ensurePage(project, tab); project.activeId = tab.id; project.visible = true
      } else if (action.type === 'close') {
        if (tab.pageId !== undefined) {
          const group = this.groups.get(profileId)
          if (group && !await group.browser.closePage(tab.pageId)) return this.state()
        }
        removeToolTab(project, tab.id)
      } else if (action.type === 'connect') {
        if (action.sessionId === null) {
          for (const bridge of this.bridges.values()) if (bridge.profileId === profileId && bridge.pageId === tab.pageId) { bridge.connected = false; bridge.pageId = null; bridge.revision++ }
        } else this.connect(project, tab, action.sessionId)
      } else if (tab.resource) {
        const { browser } = this.resource(tab.resource)
        if (action.type === 'pop-out') browser.popOutPage(tab.pageId!)
        else if (action.type === 'return') browser.returnPage(tab.pageId!)
        else throw new Error('Unknown tab action')
      }
    }
    const selected = project.tabs.find(tab => tab.id === project.activeId)
    if (action.type === 'close' && project.visible && this.shownProject === profileId && selected) this.ensurePage(project, selected)
    const group = this.groups.get(profileId)
    if (project.visible && selected?.pageId !== undefined && group?.browser.hasPage(selected.pageId)) group.browser.selectUiPage(selected.pageId)
    else group?.browser.setBounds(null)
    this.save()
    // Browser initialization must not block independent tools or prevent closing a failed page.
    // Keep failed browser navigation gated until its group is closed and explicitly reopened.
    if (action.type === 'add' && action.kind === 'browser') await group?.browser.ready
    return this.state()
  }
  private connect(project: ProjectTools, tab: ToolTab, sessionId: string): void {
    const bridge = this.requireBridge(project, sessionId)
    if (tab.pageId === undefined) throw new Error('Open this Browser tab before connecting')
    bridge.connected = true; bridge.pageId = tab.pageId; bridge.revision++
  }
  private requireBridge(project: ProjectTools, sessionId: string): Bridge {
    const session = this.options.session(sessionId), bridge = this.bridges.get(sessionId)
    if (!session || session.workspaceProfileId !== project.profileId || !liveSession(session.status) || !bridge || bridge.profileId !== project.profileId) throw new Error('Choose a running CLI session in this project; reconnect after Resume.')
    return bridge
  }
  async startBridge(sessionId: string, profileId: string, endpoint: string): Promise<void> {
    await this.stopBridge(sessionId)
    const token = randomBytes(32).toString('hex')
    const bridge: Bridge = { server: null as unknown as Server, token, endpoint, profileId, connected: false, pageId: null, revision: 0 }
    const server = createServer((request, response) => {
      const fail = (status: number, message: string): void => { if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ message })) }
      const port = (server.address() as { port: number }).port
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) { fail(403, 'Forbidden'); return }
      if (!constantTimeTokenEqual(request.headers.authorization ?? '', `Bearer ${token}`)) { fail(401, 'Unauthorized'); return }
      if (!liveSession(this.options.session(sessionId)?.status)) { fail(409, 'CLI session is not running; resume it and reconnect.'); return }
      const group = this.groups.get(profileId), revision = bridge.revision
      if (!bridge.connected) { fail(409, 'No browser connected. Open a Browser tab and choose Connect to session; reconnect after Resume.'); return }
      if (!group) { fail(409, 'No browser pages open. Add a Browser tab, then run tabs and select a page ID.'); return }
      const cursor: BrowserCursor = {
        active: () => bridge.pageId ?? 0,
        select: id => { if (!group.browser.hasPage(id)) throw new Error('Browser page closed'); bridge.pageId = id; this.options.changed() },
        validate: () => { if (!liveSession(this.options.session(sessionId)?.status) || this.bridges.get(sessionId) !== bridge || !bridge.connected || bridge.revision !== revision || this.groups.get(profileId) !== group) throw new Error('Browser connection changed; reconnect or retry the command.') },
      }
      try { group.browser.serveControl(request, response, { port, token, cursor }) }
      catch (error) { fail(409, error instanceof Error ? error.message : 'Browser unavailable') }
    })
    bridge.server = server
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    this.bridges.set(sessionId, bridge)
    try { await writeFileAtomic(endpoint, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token })) }
    catch (error) { await this.stopBridge(sessionId); throw error }
  }
  async stopBridge(sessionId: string): Promise<void> {
    const bridge = this.bridges.get(sessionId); if (!bridge) return
    this.bridges.delete(sessionId); bridge.revision++; bridge.connected = false
    bridge.server.closeAllConnections(); bridge.server.close()
    try { if (JSON.parse(await readFile(bridge.endpoint, 'utf8')).token === bridge.token) await rm(bridge.endpoint, { force: true }) } catch { /* Already removed. */ }
    this.options.changed()
  }
  async removeProject(id: string): Promise<void> {
    const group = this.groups.get(id); this.groups.delete(id)
    for (const [sessionId, bridge] of this.bridges) if (bridge.profileId === id) await this.stopBridge(sessionId)
    if (group) await group.browser.dispose()
    this.projects.delete(id); this.save()
  }
  async dispose(): Promise<void> {
    this.stopping = true
    await this.writing.catch(this.options.error)
    await Promise.all([...this.bridges.keys()].map(id => this.stopBridge(id)))
    await Promise.all([...this.groups.values()].map(group => group.browser.dispose()))
    this.groups.clear()
  }
}
