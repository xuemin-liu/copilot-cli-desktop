import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { DesktopSessionTab, SessionLifecycleStatus, WorkspaceProfile } from '../../main/types.js'
import type { MeetingView } from '../../main/meeting.js'
import { PERMISSION_PRESET_INFO } from '../../main/permission-presets.js'
import { describeSessionPermission, SESSION_PERMISSION_MODE_INFO } from '../../main/permission-modes.js'
import { isCopilotVersionOutdated } from '../../main/copilot-version.js'
import { formatActivityLabel, formatElapsed } from '../../main/activity-label.js'
import { RemoveIcon } from './Icons.js'
import { workflowAttention } from '../../main/workflow-attention.js'
import { NeedsYou } from './NeedsYou.js'
import { WorkflowTasks } from './WorkflowTasks.js'
import { WorkflowAutomations } from './WorkflowAutomations.js'
import { DeliveryQueue } from './WorkflowDeliveries.js'
import type { WorkflowDelivery } from '../../main/workflow-deliveries.js'
import type { WorkflowTask } from '../../main/workflow-types.js'

const STATUS_LABEL: Record<SessionLifecycleStatus, string> = {
  dormant: 'Not running',
  starting: 'Starting',
  running: 'Open',
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

// A flyout closes on a pointer or focus outside it and its button, on Escape (focus returns
// to the button), and on resize, since its position was measured for the old window.
function useFlyoutDismiss(open: boolean, popover: RefObject<HTMLElement | null>, button: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const inside = (node: EventTarget | null): boolean => node instanceof Node && (popover.current?.contains(node) === true || button.current?.contains(node) === true)
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !inside(event.target)) close()
    }
    const focusOutside = (event: FocusEvent): void => {
      if (inside(event.target) && !inside(event.relatedTarget)) close()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
      button.current?.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusout', focusOutside, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusout', focusOutside, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', close)
    }
  }, [open, popover, button, close])
}

interface HeaderAction {
  label: string
  icon: string
  title?: string
  disabled?: boolean
  run: () => void
}

export interface SidebarProps {
  workflowAutomation?: import('../../main/types.js').DesktopState['workflowAutomation']
  workflowAutomaticPaused?:boolean
  workflowPausedProjects?:string[]
  workflowAutomationError?:string|null
  workflowFollowupDefaults?: readonly import('../../main/workflow-followups.js').FollowupDefault[]
  workflowFollowups?: readonly import('../../main/workflow-followups.js').FollowupGrant[]
  workflowFollowupError?: string | null
  workflowDeliveries?: readonly WorkflowDelivery[]
  workflowDeliveryError?: string | null
  workflowTasks?: readonly WorkflowTask[]
  workflowError?: string | null
  profiles: WorkspaceProfile[]
  tabs: DesktopSessionTab[]
  /** Open meetings show a chip on each session taking part. */
  meetings?: readonly MeetingView[]
  installedCliVersion: string | null
  activeProfileId: string | null
  activeTabId: string | null
  canOpenTab: boolean
  collapsed: boolean
  onProjectsOpenChange?: (open: boolean) => void
  onToggleCollapsed: () => void
  onSelectWorkspace: () => void
  onActivateProfile: (profileId: string) => void
  onRemoveProfile: (profile: WorkspaceProfile) => void
  onActivateTab: (tabId: string) => void
  onPopOutTab: (tabId: string) => void
  onRenameTab: (tabId: string, currentTitle: string) => void
  onCloseTab: (tabId: string) => void
  onRestartTab: (tabId: string) => void
  onUnloadTab: (tabId: string) => void
  onCreateTab: (profileId: string) => void
  onCreateTabWithAttachments: () => void
  onFanOut: () => void
  onResumePicker: () => void
  onOpenHistory: () => void
  onConnectRemote: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  workflowAutomation={rules:[],previews:[]},workflowAutomaticPaused=false,workflowPausedProjects=[],workflowAutomationError,
  workflowFollowups=[],workflowFollowupDefaults=[],workflowFollowupError,
  workflowDeliveries = [], workflowDeliveryError,
  workflowTasks = [], workflowError,
  profiles,
  tabs,
  meetings = [],
  installedCliVersion,
  activeProfileId,
  activeTabId,
  canOpenTab,
  collapsed,
  onProjectsOpenChange,
  onToggleCollapsed,
  onSelectWorkspace,
  onActivateProfile,
  onRemoveProfile,
  onActivateTab,
  onPopOutTab,
  onRenameTab,
  onCloseTab,
  onRestartTab,
  onUnloadTab,
  onCreateTab,
  onCreateTabWithAttachments,
  onFanOut,
  onResumePicker,
  onOpenHistory,
  onConnectRemote,
  onOpenSettings,
}: SidebarProps): JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [projectsOpen, setProjectsOpen] = useState(false)
  const projectsId = useId()
  const projectsPopover = useRef<HTMLDivElement>(null)
  const projectsButton = useRef<HTMLButtonElement>(null)
  const dismissProjects = useCallback(() => setProjectsOpen(false), [])
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreCovers, setMoreCovers] = useState(false)
  const moreId = useId()
  const moreMenu = useRef<HTMLDivElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const dismissMore = useCallback(() => setMoreOpen(false), [])
  const [openActionsTabId, setOpenActionsTabId] = useState<string | null>(null)
  const [groupMode, setGroupMode] = useState<'workspace' | 'list'>(() => readSidebarPreference('sidebar-group-mode') === 'list' ? 'list' : 'workspace')
  const [orderMode, setOrderMode] = useState<'manual' | 'last-updated'>(() => readSidebarPreference('sidebar-order-mode') === 'last-updated' ? 'last-updated' : 'manual')
  const normalizedQuery = query.trim().toLowerCase()
  // The View menu owns these choices now; keep it checked and apply what it picks.
  useEffect(() => {
    void window.copilotDesktop.reportSidebarView({ group: groupMode, order: orderMode }).catch(() => {})
  }, [groupMode, orderMode])
  useEffect(() => window.copilotDesktop.onSidebarViewRequest((change) => {
    if (change.group) {
      setGroupMode(change.group)
      writeSidebarPreference('sidebar-group-mode', change.group)
    }
    if (change.order) {
      setOrderMode(change.order)
      writeSidebarPreference('sidebar-order-mode', change.order)
    }
  }), [])
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null
  useEffect(() => {
    if (!collapsed) setProjectsOpen(false)
    setMoreOpen(false)
  }, [collapsed])
  // Either flyout can cover the session pane, whose native browser view would otherwise draw over it.
  useEffect(() => {
    onProjectsOpenChange?.((collapsed && projectsOpen) || moreCovers)
    return () => onProjectsOpenChange?.(false)
  }, [collapsed, projectsOpen, moreCovers, onProjectsOpenChange])
  useFlyoutDismiss(projectsOpen, projectsPopover, projectsButton, dismissProjects)
  useFlyoutDismiss(moreOpen, moreMenu, moreButton, dismissMore)
  const closeProjects = (): void => {
    setProjectsOpen(false)
    projectsButton.current?.focus()
  }
  const positionProjects = (): void => {
    const popover = projectsPopover.current
    const button = projectsButton.current
    if (!popover || !button) return
    const anchor = button.getBoundingClientRect()
    const width = Math.min(340, window.innerWidth - 24)
    const height = popover.getBoundingClientRect().height
    popover.style.left = `${Math.max(8, Math.min(anchor.right + 12, window.innerWidth - width - 8))}px`
    popover.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))}px`
  }
  useLayoutEffect(() => {
    if (!projectsOpen) return
    positionProjects()
    const popover = projectsPopover.current
    const selected = popover?.querySelector<HTMLButtonElement>('button[aria-current="true"]')
    const first = popover?.querySelector<HTMLButtonElement>('.sidebar-project-choice, .sidebar-project-add')
    const target = selected ?? first
    target?.focus()
  }, [projectsOpen])
  // Expanded, the menu drops below its button, right-aligned; collapsed, it opens beside the strip.
  useLayoutEffect(() => {
    const menu = moreMenu.current
    const button = moreButton.current
    if (!moreOpen || !menu || !button) {
      setMoreCovers(false)
      return
    }
    menu.style.maxHeight = ''
    const anchor = button.getBoundingClientRect()
    const { width, height } = menu.getBoundingClientRect()
    const left = collapsed ? anchor.right + 12 : anchor.right - width
    const placedLeft = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    menu.style.left = `${placedLeft}px`
    if (collapsed) {
      menu.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))}px`
    } else {
      // Never over its own button: below it, else above it, else below it and scrolling.
      const below = anchor.bottom + 4
      const above = anchor.top - 4 - height
      const fitsBelow = below + height <= window.innerHeight - 8
      menu.style.top = `${fitsBelow || above < 8 ? below : above}px`
      if (!fitsBelow && above < 8) menu.style.maxHeight = `${Math.max(64, window.innerHeight - below - 8)}px`
    }
    const sidebarRight = button.closest('.sidebar')?.getBoundingClientRect().right ?? 0
    setMoreCovers(placedLeft + width > sidebarRight)
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [moreOpen, collapsed])
  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (current + 1) % items.length
      : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : null
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }
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
  // The header keeps only Search, Add workspace and this menu, so new actions belong here and can never push it wider.
  const noProject = activeProfileId === null || !canOpenTab
  const moreActions: HeaderAction[] = [
    { label: 'New session with attachments', icon: '＋⃞', disabled: noProject, run: onCreateTabWithAttachments },
    { label: 'Fan out into sessions', icon: '⫶', title: 'Start the same task in several sessions, each in its own worktree', disabled: noProject, run: onFanOut },
    { label: 'Resume a session', icon: '☰', title: 'Resume a Copilot session', disabled: noProject, run: onResumePicker },
    { label: 'Session history', icon: '◷', title: 'Find a closed session by its prompts and reopen it (Ctrl+Shift+H)', run: onOpenHistory },
    { label: 'Connect to remote', icon: '⇄', title: 'Connect to a remote Copilot session', disabled: noProject, run: onConnectRemote },
  ]
  const workspaceName = (tab: DesktopSessionTab): string | undefined => profiles.find((profile) => profile.id === tab.workspaceProfileId)?.name
  const removeProfileButton = (profile: WorkspaceProfile, className = 'icon-button'): JSX.Element => {
    const open = tabs.filter((tab) => tab.workspaceProfileId === profile.id).length
    const title = open > 0
      ? `Close the ${open === 1 ? 'session' : `${open} sessions`} open in ${profile.name} to remove it`
      : `Remove ${profile.name} from the list (its folder is not changed)`
    return <button type="button" className={className} disabled={open > 0}
      aria-label={`Remove ${profile.name}`} title={title}
      onClick={() => { closeProjects(); onRemoveProfile(profile) }}><RemoveIcon /></button>
  }
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
        aria-label={`New session in ${profile.name}`} title={`New session in ${profile.name}${profile.id === activeProfileId ? ' (Ctrl+T)' : ''}`}
        disabled={!canOpenTab} onClick={() => onCreateTab(profile.id)}>+</button>
      {removeProfileButton(profile, 'icon-button workspace-remove')}
    </div>
  )
  const [now, setNow] = useState(() => Date.now())
  const ticking = tabs.some((tab) => tab.status === 'running' && tab.activityDetail)
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking])
  const compactTabs = groupMode === 'workspace'
    ? profiles.flatMap((profile) => orderTabs(tabs.filter((tab) => tab.workspaceProfileId === profile.id)))
    : orderTabs(tabs)
  const sessionButton = (tab: DesktopSessionTab, workspaceName?: string, compactIndex?: number): JSX.Element => {
    // Live detail (which tools run now) only while the process is running and no approval is pending.
    const detail = tab.status === 'running' && tab.activityDetail ? tab.activityDetail : null
    const statusLabel = detail
      ? formatActivityLabel(detail)
      : tab.status === 'running' && tab.activity ? (tab.activity === 'working' ? 'Working' : 'Idle')
        : STATUS_LABEL[tab.status]
    const elapsed = detail ? formatElapsed(detail.since, now) : null
    const statusClass = tab.status === 'running' && tab.activity ? tab.activity : tab.status
    const outdatedCli = isCopilotVersionOutdated(tab.cliVersion, installedCliVersion)
    const versionLabel = outdatedCli
      ? `Old CLI ${tab.cliVersion ?? ''}; ${tab.remote ? 'close and reconnect' : 'restart this session'} to use ${installedCliVersion ?? 'the installed version'}`
      : null
    const worktreeLabel = tab.worktree ? (tab.worktree.branch ?? tab.worktree.name) : null
    const fanOutLabel = tab.fanOutLabel ?? null
    const meeting = meetings.find((candidate) => candidate.stage !== 'closed'
      && (candidate.hostTabId === tab.id || candidate.participants.some((participant) => participant.tabId === tab.id)))
    const meetingLabel = meeting
      ? `Meeting ${meeting.id} · ${meeting.hostTabId === tab.id ? 'host' : meeting.waitingFor.includes(tab.id) ? 'reviewing' : 'reviewer'}${(() => { const role = meeting.participants.find((participant) => participant.tabId === tab.id)?.role; return role ? ` as ${role}` : '' })()} · round ${meeting.round}${meeting.stage === 'paused' ? ' · paused' : ''}`
      : null
    const label = `${compactIndex !== undefined ? `${compactIndex + 1}: ` : ''}${tab.title}${worktreeLabel ? ` (worktree ${worktreeLabel})` : ''}${fanOutLabel ? ` [${fanOutLabel}]` : ''}${meetingLabel ? ` [${meetingLabel}]` : ''} — ${statusLabel}${elapsed ? ` · ${elapsed}` : ''}${versionLabel ? ` — ${versionLabel}` : ''}${workspaceName ? ` — ${workspaceName}` : ''}`
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
      <span className={`sidebar-status-dot tab-status-${statusClass}`} aria-hidden="true" />
      <span className="sidebar-session-title">{compactIndex !== undefined ? compactIndex + 1 : tab.title}</span>
      {compactIndex === undefined && <span className={`sidebar-session-status${outdatedCli ? ' cli-version-outdated' : ''}`}>
        {outdatedCli ? 'Old CLI' : detail ? elapsed : statusLabel}
      </span>}
      {compactIndex === undefined && (detail || worktreeLabel || fanOutLabel || meetingLabel) && <span className="sidebar-session-activity">
        {meetingLabel && <span className={`session-meeting-chip${meeting?.stage === 'paused' ? ' session-meeting-paused' : ''}`} title={meetingLabel}>⇄ {meeting!.id}{meeting!.hostTabId === tab.id ? ' host' : ''} · R{meeting!.round}</span>}
        {fanOutLabel && <span className="session-fanout-chip" title={`Started together: ${fanOutLabel}`}>{fanOutLabel}</span>}
        {worktreeLabel && <span className="session-worktree-chip" title={`Worktree ${tab.worktree?.path ?? ''}`}>⎇ {worktreeLabel}</span>}
        {detail ? statusLabel : ''}
      </span>}
    </button>
    <button type="button" className="icon-button sidebar-session-actions-toggle"
      aria-label={`Actions for ${tab.title}`} title={`Actions for ${tab.title}`}
      aria-expanded={openActionsTabId === tab.id}
      onClick={() => setOpenActionsTabId((current) => current === tab.id ? null : tab.id)}>⋯</button>
    {openActionsTabId === tab.id && <div className="sidebar-session-actions" role="group" aria-label={`Actions for ${tab.title}`}>
        <button type="button" className="icon-button" aria-label={`Open ${tab.title} in new window`} title="Open in new window"
          onClick={() => { setOpenActionsTabId(null); onPopOutTab(tab.id) }}>↗</button>
        {!tab.remote && <button type="button" className="icon-button session-restart" disabled={busy}
          aria-label={`Restart ${tab.title}`} title="Restart session" onClick={() => { setOpenActionsTabId(null); onRestartTab(tab.id) }}>↻</button>}
        {!tab.remote && tab.status !== 'dormant' && <button type="button" className="icon-button session-unload" disabled={busy}
          aria-label={`Unload ${tab.title}`} title="Unload session: stop it to free its memory and keep the tab to resume later"
          onClick={() => { setOpenActionsTabId(null); onUnloadTab(tab.id) }}>☾</button>}
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
            title="Add workspace"
            aria-label="Add workspace"
            onClick={onSelectWorkspace}
          >
            ＋
          </button>
          <button
            type="button"
            className="icon-button"
            ref={moreButton}
            title="More workspace actions"
            aria-label="More workspace actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? moreId : undefined}
            onClick={() => setMoreOpen((open) => !open)}
          >
            ⋯
          </button>
        </div>
      </div>
      {moreOpen && createPortal(<div id={moreId} ref={moreMenu} className="sidebar-more-menu" role="menu"
        aria-label="More workspace actions" onKeyDown={moveMenuFocus}>
        {moreActions.map((action) => (
          <button key={action.label} type="button" role="menuitem" className="sidebar-more-item"
            title={action.title} disabled={action.disabled}
            onClick={() => { setMoreOpen(false); action.run() }}>
            <span className="sidebar-more-icon" aria-hidden="true">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
      </div>, document.body)}

      <NeedsYou items={workflowAttention(tabs, meetings, workflowTasks,workflowFollowups,workflowDeliveries)} compact={collapsed} onExpand={onToggleCollapsed} onActivate={onActivateTab} />
      {!collapsed && <WorkflowTasks tasks={workflowTasks} tabs={tabs} installedCliVersion={installedCliVersion} onRestart={onRestartTab} followups={workflowFollowups} defaults={workflowFollowupDefaults} error={workflowError ?? workflowFollowupError ?? null} />}
      {!collapsed && <WorkflowAutomations profiles={profiles} rules={workflowAutomation.rules} previews={workflowAutomation.previews} paused={workflowAutomaticPaused} pausedProjects={workflowPausedProjects} error={workflowAutomationError??null} />}
      {!collapsed && <DeliveryQueue deliveries={workflowDeliveries} error={workflowDeliveryError ?? null} />}
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


      {collapsed && <>
        <button type="button" className="sidebar-projects-button" ref={projectsButton}
          aria-label="Projects" title={`Projects${activeProfile ? ` — ${activeProfile.name}` : ''}`}
          aria-expanded={projectsOpen} aria-haspopup="dialog" aria-controls={projectsOpen ? projectsId : undefined}
          onClick={() => setProjectsOpen((open) => !open)}>
          <svg className="folder-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H9l3 3h7.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V7Z" />
          </svg>
        </button>
        {projectsOpen && createPortal(<div id={projectsId} ref={projectsPopover} className="sidebar-projects-popover"
          role="dialog" aria-label="Projects" tabIndex={-1}>
          <div className="sidebar-projects-header">
            <strong>Projects</strong>
            <button type="button" className="icon-button" aria-label="Close projects" title="Close projects" onClick={closeProjects}>×</button>
          </div>
          <nav className="sidebar-projects-list" aria-label="Projects">
            {profiles.map((profile) => <div key={profile.id} className="sidebar-project-row">
              <button type="button" className="sidebar-project-choice" aria-label={profile.name}
                title={`${profile.name} — ${profile.path}`} aria-current={profile.id === activeProfileId ? 'true' : undefined}
                onClick={() => { closeProjects(); onActivateProfile(profile.id) }}>
                <span className="sidebar-project-name">{profile.name}</span>
                <span className="sidebar-project-path">{profile.path}</span>
              </button>
              <button type="button" className="icon-button" disabled={!canOpenTab}
                aria-label={`New session in ${profile.name}`} title={`New session in ${profile.name}`}
                onClick={() => { closeProjects(); onCreateTab(profile.id) }}>+</button>
              {removeProfileButton(profile)}
            </div>)}
            {profiles.length === 0 && <p className="sidebar-projects-empty">No projects yet.</p>}
          </nav>
          <button type="button" className="sidebar-project-add"
            onClick={() => { closeProjects(); onSelectWorkspace() }}>+ Add project</button>
        </div>, document.body)}
      </>}

      <div className="workspace-list">
        {!collapsed && groupMode === 'list' && (
          <nav aria-label="Workspaces">
            {profiles.map(workspaceRow)}
          </nav>
        )}
        {collapsed && (
          <nav className="sidebar-compact-sessions" aria-label="All sessions">
            {compactTabs.map((tab, index) => sessionButton(tab, workspaceName(tab), index))}
          </nav>
        )}
        {!collapsed && profiles.length === 0 && (
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
