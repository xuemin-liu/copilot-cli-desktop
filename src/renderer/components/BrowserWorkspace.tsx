import { useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { BrowserDebugState } from '../../main/browser-debug-types.js'
import { errorMessage } from '../errors.js'

const EMPTY_BROWSER: BrowserDebugState = {
  url: '', loading: false, canGoBack: false, canGoForward: false,
  devtools: false, error: null, console: [], network: [],
}

function BrowserPanel({ obscured }: { obscured: boolean }): JSX.Element {
  const [state, setState] = useState(EMPTY_BROWSER)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'page' | 'console' | 'network'>('page')
  const [requestId, setRequestId] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const lastUrl = useRef('')
  const accept = (next: BrowserDebugState): void => {
    setState(next)
    if (lastUrl.current !== next.url) {
      const previous = lastUrl.current
      lastUrl.current = next.url
      setUrl(value => document.activeElement !== urlInput.current || value === previous ? next.url : value)
    }
  }
  const run = (promise: Promise<BrowserDebugState>): void => {
    setError(null)
    void promise.then(accept).catch(error => setError(errorMessage(error)))
  }
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try { const next = await window.copilotDesktop.browserState(); if (!disposed) accept(next) }
      catch (error) { if (!disposed) setError(errorMessage(error)) }
      if (!disposed) timer = setTimeout(() => { void poll() }, 1000)
    }
    void window.copilotDesktop.browserOpen().then(next => { if (!disposed) { accept(next); void poll() } })
      .catch(error => { if (!disposed) setError(errorMessage(error)) })
    return () => { disposed = true; clearTimeout(timer); void window.copilotDesktop.browserBounds(null).catch(() => {}) }
  }, [])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    let disposed = false
    const resize = (): void => {
      if (disposed) return
      const b = element.getBoundingClientRect()
      void window.copilotDesktop.browserBounds(tab === 'page' && !obscured && b.width > 0 && b.height > 0
        ? { x: b.x, y: b.y, width: b.width, height: b.height } : null).catch(error => setError(errorMessage(error)))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    window.addEventListener('resize', resize)
    resize()
    return () => { disposed = true; observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [tab, obscured, error, state.error])
  const request = state.network.find(entry => entry.id === requestId)
  return <aside className="browser-panel" aria-label="Debug browser">
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); run(window.copilotDesktop.browserNavigate(url.trim())) }}>
      <button type="button" title="Back" aria-label="Browser back" disabled={!state.canGoBack} onClick={() => run(window.copilotDesktop.browserAction('back'))}>←</button>
      <button type="button" title="Forward" aria-label="Browser forward" disabled={!state.canGoForward} onClick={() => run(window.copilotDesktop.browserAction('forward'))}>→</button>
      <button type="button" title="Reload" aria-label="Reload browser" disabled={!state.url} onClick={() => run(window.copilotDesktop.browserAction('reload'))}>↻</button>
      <input ref={urlInput} aria-label="Web app URL" type="url" required maxLength={8192} placeholder="http://localhost:3000" value={url} onChange={event => setUrl(event.target.value)} />
      <button type="submit">Go</button>
    </form>
    <div className="browser-tabs" role="tablist" aria-label="Browser views">
      {(['page', 'console', 'network'] as const).map(name => <button type="button" key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
        {name === 'page' ? 'Page' : name === 'console' ? `Console (${state.console.length})` : `Network (${state.network.length})`}
      </button>)}
      <button type="button" className="browser-tools-toggle" aria-pressed={state.devtools} onClick={() => { setTab('page'); run(window.copilotDesktop.browserAction('devtools')) }}>DevTools / Overrides</button>
    </div>
    {(error || state.error) && <p className="browser-error" role="alert">{error || state.error}</p>}
    <div className="browser-viewport" ref={viewport}>
      {tab === 'page' && !state.url && <p className="browser-hint">Enter your web app URL above.</p>}
      {tab === 'console' && <div className="browser-activity" role="tabpanel" aria-label="Console activity">
        <button type="button" onClick={() => run(window.copilotDesktop.browserAction('clear'))}>Clear activity</button>
        {state.console.length === 0 && <p>No console messages captured yet.</p>}
        {state.console.map(entry => <div key={entry.id} className={`browser-console-entry browser-console-${entry.level}`}>
          <small>{entry.level} · {entry.timestamp.slice(11, 19)} · {entry.source}:{entry.line}</small><pre>{entry.message}</pre>
        </div>)}
      </div>}
      {tab === 'network' && <div className="browser-activity" role="tabpanel" aria-label="Network activity">
        <button type="button" onClick={() => { setRequestId(null); run(window.copilotDesktop.browserAction('clear')) }}>Clear activity</button>
        {state.network.length === 0 && <p>No network requests captured yet.</p>}
        <table className="browser-network"><thead><tr><th>Status</th><th>Method / URL</th><th>Time</th></tr></thead><tbody>
          {state.network.map(entry => <tr key={entry.id}><td>{entry.error || entry.status || '…'}</td>
            <td><button type="button" onClick={() => setRequestId(entry.id)}>{entry.method} {entry.url}</button></td>
            <td>{entry.durationMs === null ? '…' : `${entry.durationMs} ms`}</td></tr>)}
        </tbody></table>
        {request && <pre className="browser-request-detail">{JSON.stringify(request, null, 2)}</pre>}
      </div>}
    </div>
    <footer className="browser-footer">{state.loading ? 'Loading…' : 'Browser activity available to Copilot CLI.'}
      <details><summary>Local Overrides setup</summary><p>Open DevTools / Overrides → Sources → Overrides, select your existing Chrome overrides folder, and enable Local Overrides. Save local edits and reload the page to test them.</p></details>
    </footer>
  </aside>
}

export function BrowserWorkspace({ children, obscured }: { children: ReactNode; obscured: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [split, setSplit] = useState(50)
  const root = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const changeSplit = (value: number): void => setSplit(Math.min(75, Math.max(25, value)))
  return <div className="browser-workspace">
    <div className="browser-workspace-toolbar"><button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide browser' : 'Open browser'}</button></div>
    <div ref={root} className="browser-workspace-content" style={{ gridTemplateColumns: open ? `minmax(0, ${split}fr) 6px minmax(0, ${100 - split}fr)` : 'minmax(0, 1fr)' }}>
      <div className="browser-terminal-workspace">{children}</div>
      {open && <><div className="side-chat-divider" role="separator" tabIndex={0} aria-label="Resize browser" aria-orientation="vertical" aria-valuenow={split} aria-valuemin={25} aria-valuemax={75}
        onPointerDown={event => { event.preventDefault(); dragging.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => { if (dragging.current !== event.pointerId) return; const b = root.current?.getBoundingClientRect(); if (b?.width) changeSplit((event.clientX - b.left) / b.width * 100) }}
        onPointerUp={event => { dragging.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
        onLostPointerCapture={() => { dragging.current = null }}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); changeSplit(event.key === 'Home' ? 25 : event.key === 'End' ? 75 : split + (event.key === 'ArrowLeft' ? -2 : 2)) } }} />
        <BrowserPanel obscured={obscured} /></>}
    </div>
  </div>
}
