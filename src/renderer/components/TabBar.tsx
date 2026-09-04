import type { JSX } from 'react'
import type { DesktopSessionTab, SessionLifecycleStatus } from '../../main/types.js'
import { isCopilotVersionOutdated } from '../../main/copilot-version.js'

const STATUS_LABEL: Record<SessionLifecycleStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  'approval-needed': 'Needs approval',
  stopping: 'Stopping',
  completed: 'Completed',
  crashed: 'Crashed',
}

export interface TabBarProps {
  tabs: DesktopSessionTab[]
  installedCliVersion: string | null
  activeTabId: string | null
  canOpenTab: boolean
  onActivate: (tabId: string) => void
  onRename: (tabId: string, currentTitle: string) => void
  onClose: (tabId: string) => void
  onRestart: (tabId: string) => void
  onCreate: () => void
}

export function TabBar({ tabs, installedCliVersion, activeTabId, canOpenTab, onActivate, onRename, onClose, onRestart, onCreate }: TabBarProps): JSX.Element {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => {
        // ARIA tabs are themselves the interactive selector, and assistive
        // tech can flatten a role="tab" element's descendants to
        // presentation-only — nesting the restart/close buttons inside it
        // would make them unreliable for screen-reader and keyboard users.
        // Keep the tab selector and the action buttons as siblings instead,
        // with only the selector owning the tab role.
        const busy = tab.status === 'starting' || tab.status === 'stopping'
        const outdatedCli = isCopilotVersionOutdated(tab.cliVersion, installedCliVersion)
        const versionTitle = outdatedCli
          ? `This session uses Copilot CLI ${tab.cliVersion ?? 'unknown'}; ${tab.remote ? 'close and reconnect' : 'restart it'} to use ${installedCliVersion ?? 'the installed version'}.`
          : undefined
        return (
          <div key={tab.id} className={`tab-group${tab.id === activeTabId ? ' tab-active' : ''}`}>
            <div
              role="tab"
              aria-selected={tab.id === activeTabId}
              className="tab"
              onClick={() => onActivate(tab.id)}
              onDoubleClick={() => onRename(tab.id, tab.title)}
            >
              <span className={`tab-status-dot tab-status-${tab.status}`} title={STATUS_LABEL[tab.status]} />
              <span className="tab-title">{tab.title}</span>
              {outdatedCli && <span className="cli-version-badge" title={versionTitle}>Old CLI</span>}
            </div>
            {!tab.remote && (
              <button
                type="button"
                className="tab-restart"
                aria-label={`Restart ${tab.title}`}
                title="Restart this session with its saved session settings, keeping the same conversation"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  onRestart(tab.id)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                ↻
              </button>
            )}
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              ×
            </button>
          </div>
        )
      })}
      <button type="button" className="tab-new" title="New session tab (Ctrl+T)" disabled={!canOpenTab} onClick={onCreate}>
        +
      </button>
    </div>
  )
}
