import { useState } from 'react'
import type { JSX } from 'react'
import type { DesktopSessionTab, SessionLifecycleStatus, WorkspaceProfile } from '../../main/types.js'
import { PERMISSION_PRESET_INFO } from '../../main/permission-presets.js'

const STATUS_LABEL: Record<SessionLifecycleStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  'approval-needed': 'Needs approval',
  stopping: 'Stopping',
  completed: 'Completed',
  crashed: 'Crashed',
}

function readSidebarPreference(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSidebarPreference(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // A locked-down renderer can refuse storage; the in-memory choice still works.
  }
}

export interface SidebarProps {
  profiles: WorkspaceProfile[]
  tabs: DesktopSessionTab[]
  activeProfileId: string | null
  activeTabId: string | null
  canOpenTab: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelectWorkspace: () => void
  onActivateProfile: (profileId: string) => void
  onActivateTab: (tabId: string) => void
  onRenameTab: (tabId: string, currentTitle: string) => void
  onCreateTab: () => void
  onCreateTabWithAttachments: () => void
  onResumePicker: () => void
  onConnectRemote: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  profiles,
  tabs,
  activeProfileId,
  activeTabId,
  canOpenTab,
  collapsed,
  onToggleCollapsed,
  onSelectWorkspace,
  onActivateProfile,
  onActivateTab,
  onRenameTab,
  onCreateTab,
  onCreateTabWithAttachments,
  onResumePicker,
  onConnectRemote,
  onOpenSettings,
}: SidebarProps): JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [viewOpen, setViewOpen] = useState(false)
  const [groupMode, setGroupMode] = useState<'workspace' | 'list'>(() => readSidebarPreference('sidebar-group-mode') === 'list' ? 'list' : 'workspace')
  const [orderMode, setOrderMode] = useState<'manual' | 'last-updated'>(() => readSidebarPreference('sidebar-order-mode') === 'last-updated' ? 'last-updated' : 'manual')
  const normalizedQuery = query.trim().toLowerCase()
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activeTabProfile = activeTab
    ? profiles.find((profile) => profile.id === activeTab.workspaceProfileId) ?? null
    : activeProfile
  const sessionIsLive = activeTab
    ? activeTab.status === 'starting' || activeTab.status === 'running' || activeTab.status === 'approval-needed'
    : false
  const displayedPreset = sessionIsLive ? activeTab?.permissionPreset ?? null : null
  const configuredPreset = activeTabProfile?.permissionPreset ?? null
  const pendingPreset = configuredPreset && displayedPreset && configuredPreset !== displayedPreset
    ? configuredPreset
    : null
  const configuredOnly = !sessionIsLive && configuredPreset
  const startSession = (): void => {
    if (activeProfileId === null) onSelectWorkspace()
    else onCreateTab()
  }
  const orderTabs = (items: DesktopSessionTab[]): DesktopSessionTab[] => orderMode === 'last-updated'
    ? [...items].sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    : items
  const sessionButton = (tab: DesktopSessionTab, workspaceName?: string): JSX.Element => (
    <button
      key={tab.id}
      type="button"
      className={`sidebar-session${tab.id === activeTabId ? ' sidebar-session-active' : ''}`}
      title={`${tab.title} — ${STATUS_LABEL[tab.status]}${workspaceName ? ` — ${workspaceName}` : ''}`}
      onClick={() => onActivateTab(tab.id)}
      onDoubleClick={() => onRenameTab(tab.id, tab.title)}
    >
      <span className={`sidebar-status-dot tab-status-${tab.status}`} aria-hidden="true" />
      <span className="sidebar-session-title">{tab.title}</span>
      <span className="sidebar-session-status">{STATUS_LABEL[tab.status]}</span>
    </button>
  )

  return (
    <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`} aria-label="Copilot navigation">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">C</span>
        <span className="brand-name">copilot</span>
        <span className="brand-product">CLI</span>
        <button
          type="button"
          className="sidebar-collapse-button"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      <button type="button" className="new-session-button" disabled={!canOpenTab && activeProfileId !== null} onClick={startSession}>
        <span aria-hidden="true">✦</span>
        <span>New Session</span>
      </button>

      <div className="sidebar-section-heading">
        <span>Workspaces</span>
        <div className="sidebar-heading-actions">
          <button
            type="button"
            className="icon-button"
            title="Search workspaces and sessions"
            aria-label="Search workspaces and sessions"
            aria-pressed={searchOpen}
            onClick={() => {
              if (collapsed) {
                onToggleCollapsed()
                setSearchOpen(true)
              } else {
                setSearchOpen((open) => !open)
                if (searchOpen) setQuery('')
              }
            }}
          >
            ⌕
          </button>
          <button
            type="button"
            className="icon-button"
            title="New session with attachments"
            aria-label="New session with attachments"
            disabled={activeProfileId === null || !canOpenTab}
            onClick={onCreateTabWithAttachments}
          >
            ＋⃞
          </button>
          <button
            type="button"
            className="icon-button"
            title="Resume a Copilot session"
            aria-label="Resume a Copilot session"
            disabled={activeProfileId === null || !canOpenTab}
            onClick={onResumePicker}
          >
            ↻
          </button>
          <button
            type="button"
            className="icon-button"
            title="Connect to a remote Copilot session"
            aria-label="Connect to a remote Copilot session"
            disabled={activeProfileId === null || !canOpenTab}
            onClick={onConnectRemote}
          >
            ⇄
          </button>
          <button
            type="button"
            className="icon-button"
            title="View options"
            aria-label="View options"
            aria-expanded={viewOpen}
            onClick={() => setViewOpen((open) => !open)}
          >
            ☷
          </button>
          <button
            type="button"
            className="icon-button"
            title="Add workspace"
            aria-label="Add workspace"
            onClick={onSelectWorkspace}
          >
            ＋
          </button>
        </div>
      </div>

      {searchOpen && (
        <input
          className="sidebar-search"
          type="search"
          autoFocus
          value={query}
          placeholder="Search"
          aria-label="Search workspaces and sessions"
          onChange={(event) => setQuery(event.target.value)}
        />
      )}

      {viewOpen && !collapsed && (
        <div className="sidebar-view-menu" role="menu" aria-label="Session view options">
          <span>Group by</span>
          <button type="button" className={groupMode === 'workspace' ? 'selected' : ''} onClick={() => {
            setGroupMode('workspace')
            writeSidebarPreference('sidebar-group-mode', 'workspace')
          }}>Workspace</button>
          <button type="button" className={groupMode === 'list' ? 'selected' : ''} onClick={() => {
            setGroupMode('list')
            writeSidebarPreference('sidebar-group-mode', 'list')
          }}>In one list</button>
          <span>Order by</span>
          <button type="button" className={orderMode === 'manual' ? 'selected' : ''} onClick={() => {
            setOrderMode('manual')
            writeSidebarPreference('sidebar-order-mode', 'manual')
          }}>Manual</button>
          <button type="button" className={orderMode === 'last-updated' ? 'selected' : ''} onClick={() => {
            setOrderMode('last-updated')
            writeSidebarPreference('sidebar-order-mode', 'last-updated')
          }}>Last updated</button>
        </div>
      )}

      <div className="workspace-list">
        {profiles.length === 0 && (
          <button type="button" className="workspace-empty" onClick={onSelectWorkspace}>
            Choose a project folder to begin
          </button>
        )}
        {groupMode === 'list' && profiles.length > 0 && (
          <section className="workspace-group workspace-group-active">
            <div className="workspace-sessions workspace-sessions-flat" aria-label="All sessions">
              {orderTabs(tabs.filter((tab) => {
                if (!normalizedQuery) return true
                const profile = profiles.find((item) => item.id === tab.workspaceProfileId)
                return `${tab.title}\n${profile?.name ?? ''}\n${profile?.path ?? ''}`.toLowerCase().includes(normalizedQuery)
              })).map((tab) => sessionButton(tab, profiles.find((profile) => profile.id === tab.workspaceProfileId)?.name))}
            </div>
          </section>
        )}
        {groupMode === 'workspace' && profiles.map((profile) => {
          const allProfileTabs = tabs.filter((tab) => tab.workspaceProfileId === profile.id)
          const profileMatches = `${profile.name}\n${profile.path}`.toLowerCase().includes(normalizedQuery)
          const filteredProfileTabs = normalizedQuery && !profileMatches
            ? allProfileTabs.filter((tab) => tab.title.toLowerCase().includes(normalizedQuery))
            : allProfileTabs
          const profileTabs = orderTabs(filteredProfileTabs)
          if (normalizedQuery && !profileMatches && profileTabs.length === 0) return null
          const active = profile.id === activeProfileId
          return (
            <section key={profile.id} className={`workspace-group${active ? ' workspace-group-active' : ''}`}>
              <button
                type="button"
                className="workspace-row"
                title={profile.path}
                aria-current={active ? 'true' : undefined}
                onClick={() => onActivateProfile(profile.id)}
              >
                <span className="folder-icon" aria-hidden="true">▱</span>
                <span className="workspace-name">{profile.name}</span>
              </button>
              {profileTabs.length > 0 && (
                <div className="workspace-sessions" aria-label={`${profile.name} sessions`}>
                  {profileTabs.map((tab) => sessionButton(tab))}
                </div>
              )}
            </section>
          )
        })}
      </div>

      {activeTab?.remote && sessionIsLive ? (
        <div className="sidebar-access" title="The desktop cannot determine permissions configured by the remote session host.">
          <span className="sidebar-access-dot" aria-hidden="true" />
          <span>Remote session access unknown</span>
        </div>
      ) : displayedPreset ? (
        <div
          className={`sidebar-access sidebar-access-${displayedPreset}`}
          title={[PERMISSION_PRESET_INFO[displayedPreset].description, activeTab?.permissionWarning].filter(Boolean).join(' ')}
        >
          <span className="sidebar-access-dot" aria-hidden="true" />
          <span>
            {PERMISSION_PRESET_INFO[displayedPreset].label}
            {activeTab?.permissionWarning && ' · Legacy restricted mode'}
            {pendingPreset && ` · ${PERMISSION_PRESET_INFO[pendingPreset].label} applies to newly created sessions (Restart keeps current access)`}
          </span>
        </div>
      ) : configuredOnly ? (
        <div className={`sidebar-access sidebar-access-${configuredOnly}`} title="No session is currently running with this setting.">
          <span className="sidebar-access-dot" aria-hidden="true" />
          <span>{PERMISSION_PRESET_INFO[configuredOnly].label} applies to newly created sessions</span>
        </div>
      ) : null}
      <button type="button" className="sidebar-settings" onClick={onOpenSettings}>
        <span aria-hidden="true">⚙</span>
        <span>Settings</span>
      </button>
    </aside>
  )
}
