import { useState } from 'react'
import type { JSX } from 'react'
import type { DesktopControlTabView, DesktopSessionTab } from '../../main/types.js'
import { errorMessage } from '../errors.js'
import { DesktopControlIcon } from './Icons.js'

const STOP_KEY = 'Ctrl+Alt+Shift+X'

export interface DesktopControlProps {
  tab: DesktopSessionTab
  /** Settings allows desktop control on this computer. */
  allowed: boolean
  /** The session started with desktop control's helper. */
  ready: boolean
  view: DesktopControlTabView | undefined
}

/** The header button: shows whether desktop control is on for this session and opens its panel. */
export function DesktopControlToggle({ view, open, onToggle }: { view: DesktopControlTabView | undefined; open: boolean; onToggle: () => void }): JSX.Element {
  const state = view?.enabled ? (view.paused ? 'paused' : 'on') : 'off'
  const label = state === 'on' ? 'Desktop control is on' : state === 'paused' ? 'Desktop control is paused' : 'Desktop control'
  return <button type="button" className={`icon-button session-desktop-toggle session-desktop-${state}`} aria-expanded={open} aria-label={label}
    title={`${label}: let Copilot use the mouse and keyboard in apps you approve`} onClick={onToggle}><DesktopControlIcon /></button>
}

function time(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function DesktopControlPanel({ tab, allowed, ready, view }: DesktopControlProps): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (operation: () => Promise<unknown>): void => {
    setPending(true)
    setError(null)
    void operation().catch(failure => setError(errorMessage(failure))).finally(() => setPending(false))
  }
  const enabled = view?.enabled === true
  const log = [...(view?.log ?? [])].reverse().slice(0, 20)
  const unavailable = !allowed
    ? 'Allow desktop control in Settings → Desktop control first. It is off by default.'
    : tab.remote ? 'A remote session runs on another computer, so it can’t control this one.'
      : tab.sideChat ? 'Side chats can’t use desktop control.'
        : !ready ? 'This session started before desktop control was allowed, or it has no shell access. Restart it to use desktop control.'
          : null
  return <section className="desktop-control-panel" aria-label="Desktop control">
    <div className="desktop-control-row">
      <strong>Desktop control</strong>
      <span className={`desktop-control-state desktop-control-state-${enabled ? (view!.paused ? 'paused' : 'on') : 'off'}`}>{enabled ? (view!.paused ? 'Paused' : 'On') : 'Off'}</span>
      <span className="desktop-control-spacer" />
      {enabled && view!.paused && <button type="button" disabled={pending} onClick={() => run(() => window.copilotDesktop.desktopControlResume(tab.id))}>Resume</button>}
      <button type="button" className={enabled ? 'danger-button' : ''} disabled={pending || (!enabled && unavailable !== null)}
        onClick={() => run(() => window.copilotDesktop.desktopControlSet(tab.id, !enabled))}>{enabled ? 'Turn off' : 'Turn on'}</button>
    </div>
    {unavailable && !enabled
      ? <p className="desktop-control-note">{unavailable}</p>
      : <p className="desktop-control-note">
        Copilot can see and use apps you approve, one at a time. It can never control this app, terminals, File Explorer,
        Start, sign-in or password windows, or administrator windows, and it never types into password fields.
        Press <kbd>{STOP_KEY}</kbd> anywhere to stop it.
      </p>}
    {error && <p className="desktop-control-error" role="alert">{error}</p>}
    {enabled && <>
      <label className="desktop-control-check">
        <input type="checkbox" checked={view!.fullScreen} disabled={pending}
          onChange={event => run(() => window.copilotDesktop.desktopControlFullScreen(tab.id, event.target.checked))} />
        Allow full-screen screenshots without asking (blocked windows are still painted over)
      </label>
      <div className="desktop-control-apps">
        <span>Approved apps:</span>
        {view!.approvedApps.length === 0 ? <span className="desktop-control-muted">none yet; you are asked the first time</span>
          : view!.approvedApps.map(app => <span key={app.key} className="desktop-control-app">{app.name}
            <button type="button" className="icon-button" aria-label={`Stop allowing ${app.name}`} title={`Stop allowing ${app.name}`}
              onClick={() => run(() => window.copilotDesktop.desktopControlRevoke(tab.id, app.key))}>×</button></span>)}
      </div>
    </>}
    {log.length > 0 && <ol className="desktop-control-log" aria-label="Recent desktop actions">
      {log.map((entry, index) => <li key={`${entry.at}-${index}`} className={`desktop-control-log-${entry.result}`}>
        <span className="desktop-control-muted">{time(entry.at)}</span> <span>{entry.command}</span>
        {entry.app && <span className="desktop-control-muted"> · {entry.app}</span>} <span>— {entry.message}</span>
      </li>)}
    </ol>}
  </section>
}
