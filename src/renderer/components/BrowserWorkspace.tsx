import type { JSX } from 'react'
import type { DesktopSessionTab } from '../../main/types.js'
import { BrowserIcon } from './Icons.js'
import { BrowserPanel } from './BrowserPanel.js'

/** A session's browser alone in its own window. Returning it (or closing the window) shows it beside the terminal again. */
export function BrowserOnlyWindow({ tab, onReturn }: { tab: DesktopSessionTab; onReturn: () => void }): JSX.Element {
  return <main className="browser-only-window" aria-label={`Browser window: ${tab.title}`}>
    <header className="session-pane-header">
      <span className="session-pane-title" title={tab.title}><BrowserIcon /> {tab.title}</span>
      <button type="button" onClick={onReturn} title="Show the browser beside the session's terminal again (Ctrl+W)">Return browser to session</button>
    </header>
    <BrowserPanel tabId={tab.id} active={tab.status !== 'dormant'} unloaded={tab.status === 'dormant'} obscured={false} detached />
  </main>
}
