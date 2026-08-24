import type { JSX } from 'react'
import type { DesktopSessionTab, SessionLifecycleStatus } from '../../main/types.js'

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
  activeTabId: string | null
  canOpenTab: boolean
  onActivate: (tabId: string) => void
  onRename: (tabId: string, currentTitle: string) => void
  onClose: (tabId: string) => void
  onCreate: () => void
}

export function TabBar({ tabs, activeTabId, canOpenTab, onActivate, onRename, onClose, onCreate }: TabBarProps): JSX.Element {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTabId}
          className={`tab${tab.id === activeTabId ? ' tab-active' : ''}`}
          onClick={() => onActivate(tab.id)}
          onDoubleClick={() => onRename(tab.id, tab.title)}
        >
          <span className={`tab-status-dot tab-status-${tab.status}`} title={STATUS_LABEL[tab.status]} />
          <span className="tab-title">{tab.title}</span>
          <button
            type="button"
            className="tab-close"
            aria-label={`Close ${tab.title}`}
            onClick={(event) => {
              event.stopPropagation()
              onClose(tab.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="tab-new" title="New session tab (Ctrl+T)" disabled={!canOpenTab} onClick={onCreate}>
        +
      </button>
    </div>
  )
}
