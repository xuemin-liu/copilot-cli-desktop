/** Persistent panel IDs are independent of Chromium page IDs and CLI session IDs. */
export type TerminalKind = 'local' | 'wsl' | 'ssh'
export type ToolTabKind = 'new' | 'browser' | 'git' | 'file' | TerminalKind
/** The file a File tab shows. `root` is the workspace folder or one worktree, chosen by the main process; `path` is under it.
 * `line` and `column` are where the last click pointed, and `jump` counts those clicks so the same line can be shown again. */
export interface ToolFile { root: string; path: string; line?: number; column?: number; jump?: number }
export interface TerminalConfig { name?: string; host?: string; username?: string; port?: number; identityFile?: string; distro?: string; connectionId?: string; temporary?: boolean; transport?: 'native' | 'managed' }
export const isTerminalKind = (kind: string): kind is TerminalKind => ['local', 'wsl', 'ssh'].includes(kind)
export interface ToolTab {
  id: string
  kind: ToolTabKind
  title: string
  label?: string
  color?: string
  url?: string
  pageId?: number
  resource?: string
  /** The page is in its own window: the strip hides this record and the panel never selects it. */
  detached?: boolean
  loading?: boolean
  error?: string
  /** Persistent desktop session identity. Absent on shared workspace tabs. */
  ownerId?: string | undefined
  gitSelectionKey?: string
  localCwd?: string
  terminal?: TerminalConfig
  file?: ToolFile
}
export interface PanelLayout { activeId: string | null; visible: boolean }
export interface ProjectTools extends PanelLayout {
  ownerId?: string | undefined
  profileId: string
  browserProfileId: string
  overrides: 'shared' | 'private'
  tabs: ToolTab[]
  width: number
  broadcast?: boolean
}
export interface BrowserConnection { sessionId: string; profileId: string; pageId: number | null }
export interface ToolsState { projects: ProjectTools[]; connections: BrowserConnection[]; recent?: string[] }
export type ToolsAction = { expectedOwnerId?: string | null } & (
  | { type: 'add'; kind: ToolTabKind; replaceId?: string; url?: string; terminal?: TerminalConfig }
  | { type: 'select' | 'close' | 'promote' | 'pop-out' | 'return'; id: string }
  | { type: 'visible'; visible: boolean }
  | { type: 'width'; width: number }
  | { type: 'metadata'; id: string; label?: string; color?: string | null }
  | { type: 'reorder'; id: string; beforeId: string }
  | { type: 'broadcast'; enabled: boolean }
  | { type: 'save-connection'; id: string }
  | { type: 'overrides'; mode: 'shared' | 'private' }
)

/** Workspace tabs precede the selected main session's tabs in the strip. */
export function panelTabs(project: ProjectTools): ToolTab[] {
  const shared = project.tabs.filter(tab => !tab.ownerId)
  return project.ownerId ? shared.concat(project.tabs.filter(tab => tab.ownerId === project.ownerId)) : shared
}

/** The tab the panel shows in place of tabs[index]: the nearest docked tab to the right, then to the left.
 * A tab whose page is in its own window is never shown in the panel, so it is skipped, as is `skipId`. */
export function dockedNeighbor(tabs: readonly ToolTab[], index: number, skipId?: string): string | null {
  const shown = (tab: ToolTab | undefined): tab is ToolTab => tab !== undefined && !tab.detached && tab.id !== skipId
  for (let i = Math.max(0, index); i < tabs.length; i++) if (shown(tabs[i])) return tabs[i]!.id
  for (let i = Math.min(index, tabs.length) - 1; i >= 0; i--) if (shown(tabs[i])) return tabs[i]!.id
  return null
}

/** The strip lists docked tabs only; its indexes are positions in that list, not in project.tabs. */
export function dockedReorder(tabs: readonly ToolTab[], from: number, to: number): { id: string; beforeId: string } | null {
  const docked = tabs.filter(tab => !tab.detached)
  const first = docked[from], last = docked[to]
  return first && last ? { id: first.id, beforeId: last.id } : null
}

export function removeToolTab(project: ProjectTools, id: string): void {
  const index = project.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  const visibleIndex = panelTabs(project).findIndex(tab => tab.id === id)
  const [removed] = project.tabs.splice(index, 1)
  if (project.activeId === id) project.activeId = dockedNeighbor(panelTabs(project), visibleIndex)
  // Closing the last docked tab hides the panel; a page closing in its own window leaves the panel as it is.
  if (visibleIndex >= 0 && !removed!.detached && !panelTabs(project).some(tab => !tab.detached)) project.visible = false
}

export function panelButtonLabel(project: Pick<ProjectTools, 'tabs' | 'visible'> | undefined): string {
  return !project?.tabs.length ? 'New tab' : project.visible ? 'Hide tabs' : 'Show tabs'
}
