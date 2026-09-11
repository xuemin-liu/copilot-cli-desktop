import { useState } from 'react'
import type { JSX } from 'react'
import type { DesktopSessionTab, SessionLifecycleStatus, WorkspaceProfile } from '../../main/types.js'
import { PERMISSION_PRESET_INFO } from '../../main/permission-presets.js'
import { describeSessionPermission, SESSION_PERMISSION_MODE_INFO } from '../../main/permission-modes.js'
import { isCopilotVersionOutdated } from '../../main/copilot-version.js'

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
  installedCliVersion: string | null
  activeProfileId: string | null
  activeTabId: string | null
  canOpenTab: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelectWorkspace: () => void
  onActivateProfile: (profileId: string) => void
  onActivateTab: (tabId: string) => void
  onRenameTab: (tabId: string, currentTitle: string) => void
  onCloseTab: (tabId: string) => void
  onRestartTab: (tabId: string) => void
  onCreateTab: (profileId: string) => void
  onCreateTabWithAttachments: () => void
  onResumePicker: () => void
  onConnectRemote: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  profiles,
  tabs,
  installedCliVersion,
  activeProfileId,
  activeTabId,
  canOpenTab,
  collapsed,
  onToggleCollapsed,
  onSelectWorkspace,
  onActivateProfile,
  onActivateTab,
  onRenameTab,
  onCloseTab,
  onRestartTab,
  onCreateTab,
  onCreateTabWithAttachments,
  onResumePicker,
  onConnectRemote,
  onOpenSettings,
}: SidebarProps): JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [viewOpen, setViewOpen] = useState(false)
  const [openActionsTabId, setOpenActionsTabId] = useState<string | null>(null)
  const [groupMode, setGroupMode] = useState<'workspace' | 'list'>(() => readSidebarPreference('sidebar-group-mode') === 'list' ? 'list' : 'workspace')
  const [orderMode, setOrderMode] = useState<'manual' | 'last-updated'>(() => readSidebarPreference('sidebar-order-mode') === 'last-updated' ? 'last-updated' : 'manual')
  const normalizedQuery = query.trim().toLowerCase()
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activeTabProfile = activeTab
    ? profiles.find((profile) => profile.id === activeTab.workspaceProfileId) ?? null
    : activeProfile
  const displayedPreset = activeTab?.sessionPermissionPreset ?? null
  const displayedMode = activeTab?.sessionPermissionMode ?? null
  const configuredPreset = activeTab?.sideChat ? 'read-only' : activeTabProfile?.permissionPreset ?? null
  const pendingPreset = configuredPreset && displayedPreset && configuredPreset !== displayedPreset
    ? configuredPreset
    : null
  const configuredOnly = !activeTab && configuredPreset
  const displayedAccess = displayedPreset
    ? describeSessionPermission(displayedPreset, displayedMode)
    : null
  const orderTabs = (items: DesktopSessionTab[]): DesktopSessionTab[] => orderMode === 'last-updated'
    ? [...items].sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    : items
  const workspaceName = (tab: DesktopSessionTab): string | undefined => profiles.find((profile) => profile.id === tab.workspaceProfileId)?.name
  const workspaceRow = (profile: WorkspaceProfile): JSX.Element => (
    <div key={profile.id} className="workspace-heading">
      <button type="button" className="workspace-row"
        aria-label={profile.name} title={`${profile.name} — ${profile.path}`}
        aria-current={profile.id === activeProfileId ? 'true' : undefined}
        onClick={() => onActivateProfile(profile.id)}>
        <span className="folder-icon" aria-hidden="true">▱</span>
        <span className="workspace-name">{profile.name}</span>
      </button>
      <button type="button" className="icon-button workspace-new-session"
        aria-label={`New session in ${profile.name}`} title={`New session in ${profile.name}`}
        disabled={!canOpenTab} onClick={() => onCreateTab(profile.id)}>+</button>
    </div>
  )
  const compactTabs = groupMode === 'workspace'
    ? profiles.flatMap((profile) => orderTabs(tabs.filter((tab) => tab.workspaceProfileId === profile.id)))
    : orderTabs(tabs)
  const sessionButton = (tab: DesktopSessionTab, workspaceName?: string, compactIndex?: number): JSX.Element => {
    const outdatedCli = isCopilotVersionOutdated(tab.cliVersion, installedCliVersion)
    const versionLabel = outdatedCli
      ? `Old CLI ${tab.cliVersion ?? ''}; ${tab.remote ? 'close and reconnect' : 'restart this session'} to use ${installedCliVersion ?? 'the installed version'}`
      : null
    const label = `${compactIndex !== undefined ? `${compactIndex + 1}: ` : ''}${tab.title} — ${STATUS_LABEL[tab.status]}${versionLabel ? ` — ${versionLabel}` : ''}${workspaceName ? ` — ${workspaceName}` : ''}`
    const busy = tab.status === 'starting' || tab.status === 'stopping'
    return <div key={tab.id} className="sidebar-session-row">
    <button
      type="button"
      className={`sidebar-session${compactIndex !== undefined ? ' sidebar-session-compact' : ''}${tab.id === activeTabId ? ' sidebar-session-active' : ''}`}
      aria-label={label}
      aria-current={tab.id === activeTabId ? 'true' : undefined}
      title={label}
      onClick={() => onActivateTab(tab.id)}
      onDoubleClick={() => onRenameTab(tab.id, tab.title)}
    >
      <span className={`sidebar-status-dot tab-status-${tab.status}`} aria-hidden="true" />
      <span className="sidebar-session-title">{compactIndex !== undefined ? compactIndex + 1 : tab.title}</span>
      {compactIndex === undefined && <span className={`sidebar-session-status${outdatedCli ? ' cli-version-outdated' : ''}`}>
        {outdatedCli ? 'Old CLI' : STATUS_LABEL[tab.status]}
      </span>}
    </button>
    <button type="button" className="icon-button sidebar-session-actions-toggle"
      aria-label={`Actions for ${tab.title}`} title={`Actions for ${tab.title}`}
      aria-expanded={openActionsTabId === tab.id}
      onClick={() => setOpenActionsTabId((current) => current === tab.id ? null : tab.id)}>⋯</button>
    {openActionsTabId === tab.id && <div className="sidebar-session-actions" role="group" aria-label={`Actions for ${tab.title}`}>
        {!tab.remote && <button type="button" className="icon-button session-restart" disabled={busy}
          aria-label={`Restart ${tab.title}`} title="Restart session" onClick={() => { setOpenActionsTabId(null); onRestartTab(tab.id) }}>↻</button>}
        <button type="button" className="icon-button session-close" aria-label={`Close ${tab.sideChat ? 'side chat ' : ''}${tab.title}`}
          title={tab.sideChat ? 'Close side chat — keep the main session running' : 'Close session'}
          onClick={() => { setOpenActionsTabId(null); onCloseTab(tab.id) }}>×</button>
      </div>}
    </div>
  }

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
            ☰
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
        {(collapsed || groupMode === 'list') && (
          <nav aria-label="Workspaces">
            {profiles.map(workspaceRow)}
          </nav>
        )}
        {collapsed && (
          <nav className="sidebar-compact-sessions" aria-label="All sessions">
            {compactTabs.map((tab, index) => sessionButton(tab, workspaceName(tab), index))}
          </nav>
        )}
        {profiles.length === 0 && (
          <button type="button" className="workspace-empty" onClick={onSelectWorkspace}>
            Choose a project folder to begin
          </button>
        )}
        {!collapsed && groupMode === 'list' && profiles.length > 0 && (
          <section className="workspace-group">
            <div className="workspace-sessions workspace-sessions-flat" aria-label="All sessions">
              {orderTabs(tabs.filter((tab) => {
                if (!normalizedQuery) return true
                const profile = profiles.find((item) => item.id === tab.workspaceProfileId)
                return `${tab.title}\n${profile?.name ?? ''}\n${profile?.path ?? ''}`.toLowerCase().includes(normalizedQuery)
              })).map((tab) => sessionButton(tab, workspaceName(tab)))}
            </div>
          </section>
        )}
        {!collapsed && groupMode === 'workspace' && profiles.map((profile) => {
          const allProfileTabs = tabs.filter((tab) => tab.workspaceProfileId === profile.id)
          const profileMatches = `${profile.name}\n${profile.path}`.toLowerCase().includes(normalizedQuery)
          const filteredProfileTabs = normalizedQuery && !profileMatches
            ? allProfileTabs.filter((tab) => tab.title.toLowerCase().includes(normalizedQuery))
            : allProfileTabs
          const profileTabs = orderTabs(filteredProfileTabs)
          if (normalizedQuery && !profileMatches && profileTabs.length === 0) return null
          return (
            <section key={profile.id} className="workspace-group">
              {workspaceRow(profile)}
              {profileTabs.length > 0 && (
                <div className="workspace-sessions" aria-label={`${profile.name} sessions`}>
                  {profileTabs.map((tab) => sessionButton(tab))}
                </div>
              )}
            </section>
          )
        })}
      </div>

      {activeTab?.remote && !displayedPreset ? (
        <div className="sidebar-access" title="The desktop cannot determine permissions configured by the remote session host.">
          <span className="sidebar-access-dot" aria-hidden="true" />
          <span>Remote session access unknown</span>
        </div>
      ) : displayedPreset ? (
        <div
          className={`sidebar-access sidebar-access-${displayedAccess?.tone}`}
          title={[
            PERMISSION_PRESET_INFO[displayedPreset].description,
            displayedMode ? `Current Copilot approval mode: ${SESSION_PERMISSION_MODE_INFO[displayedMode].label}.` : null,
            activeTab?.permissionWarning,
          ].filter(Boolean).join(' ')}
        >
          <span className="sidebar-access-dot" aria-hidden="true" />
          <span>
            {displayedAccess?.label}
            {activeTab?.permissionWarning && !activeTab.sideChat && ' · Legacy restricted mode'}
            {pendingPreset && ` · Profile default for new sessions: ${PERMISSION_PRESET_INFO[pendingPreset].label}`}
          </span>
        </div>
      ) : configuredOnly ? (
        <div className={`sidebar-access sidebar-access-${configuredOnly}`} title="No session is currently running with this setting.">
          <span className="sidebar-access-dot" aria-hidden="true" />
          <span>{PERMISSION_PRESET_INFO[configuredOnly].label} applies to newly created sessions</span>
        </div>
      ) : null}
      <button type="button" className="sidebar-settings" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
        <span aria-hidden="true">⚙</span>
        <span>Settings</span>
      </button>
    </aside>
  )
}
