/** Persistent panel IDs are independent of Chromium page IDs and CLI session IDs. */
export type ToolTabKind = 'new' | 'browser' | 'git'
export interface ToolTab {
  id: string
  kind: ToolTabKind
  title: string
  url?: string
  pageId?: number
  resource?: string
  detached?: boolean
  loading?: boolean
  error?: string
}
export interface ProjectTools {
  profileId: string
  browserProfileId: string
  overrides: 'shared' | 'private'
  tabs: ToolTab[]
  activeId: string | null
  visible: boolean
  width: number
}
export interface BrowserConnection { sessionId: string; profileId: string; pageId: number | null }
export interface ToolsState { projects: ProjectTools[]; connections: BrowserConnection[]; recent?: string[] }
export type ToolsAction =
  | { type: 'add'; kind: ToolTabKind; replaceId?: string; url?: string }
  | { type: 'select' | 'close' | 'pop-out' | 'return'; id: string }
  | { type: 'visible'; visible: boolean }
  | { type: 'width'; width: number }
  | { type: 'overrides'; mode: 'shared' | 'private' }

export function removeToolTab(project: ProjectTools, id: string): void {
  const index = project.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  project.tabs.splice(index, 1)
  if (project.activeId === id) project.activeId = project.tabs[index]?.id ?? project.tabs[index - 1]?.id ?? null
  if (!project.tabs.length) project.visible = false
}

export function panelButtonLabel(project: Pick<ProjectTools, 'tabs' | 'visible'> | undefined): string {
  return !project?.tabs.length ? 'New tab' : project.visible ? 'Hide tabs' : 'Show tabs'
}
