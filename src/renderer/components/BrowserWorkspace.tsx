import { useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { BrowserDebugState } from '../../main/browser-debug-types.js'
import { errorMessage } from '../errors.js'
import { BrowserActivity } from './BrowserActivity.js'
import { BrowserIcon, PickElementIcon } from './Icons.js'
import { insertIntoPrompt } from '../prompt-insert.js'

const EMPTY_BROWSER: BrowserDebugState = {
  activePageId: 0, pages: [], zoomFactor: 1, view: 'page',
  recordingConsole: true, recordingNetwork: true, preserveConsole: true, preserveNetwork: true,
  url: '', loading: false, canGoBack: false, canGoForward: false,
  devtools: false, error: null, console: [], network: [], sitePermissions: [],
}

function BrowserPanel({ tabId, obscured, active }: { tabId: string; obscured: boolean; active: boolean }): JSX.Element {
  const [state, setState] = useState(EMPTY_BROWSER)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const lastUrl = useRef('')
  const lastPageId = useRef(0)
  const accept = (next: BrowserDebugState): void => {
    setState(next)
    const switchedPage = lastPageId.current !== next.activePageId
    lastPageId.current = next.activePageId
    if (switchedPage || lastUrl.current !== next.url) {
      const previous = lastUrl.current
      lastUrl.current = next.url
      setUrl(value => switchedPage || document.activeElement !== urlInput.current || value === previous ? next.url : value)
    }
  }
  const run = (promise: Promise<BrowserDebugState>, focusAddress = false): void => {
    setError(null)
    void promise.then(next => {
      accept(next)
      if (focusAddress) urlInput.current?.focus()
    }).catch(error => setError(errorMessage(error)))
  }
  useEffect(() => {
    if (!active) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try { const next = await window.copilotDesktop.browserState(tabId); if (!disposed) accept(next) }
      catch (error) { if (!disposed) setError(errorMessage(error)) }
      if (!disposed) timer = setTimeout(() => { void poll() }, 1000)
    }
    void window.copilotDesktop.browserOpen(tabId).then(next => { if (!disposed) { accept(next); void poll() } })
      .catch(error => { if (!disposed) setError(errorMessage(error)) })
    return () => { disposed = true; clearTimeout(timer); void window.copilotDesktop.browserBounds(tabId, null).catch(() => {}) }
  }, [tabId, active])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    let disposed = false
    const resize = (): void => {
      if (disposed) return
      const b = element.getBoundingClientRect()
      void window.copilotDesktop.browserBounds(tabId, active && !obscured && b.width > 0 && b.height > 0
        ? { x: b.x, y: b.y, width: b.width, height: b.height } : null).catch(error => setError(errorMessage(error)))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    window.addEventListener('resize', resize)
    resize()
    return () => { disposed = true; observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [tabId, active, obscured, error, state.error])
  const pickElement = (): void => {
    if (picking) { void window.copilotDesktop.browserPickCancel(tabId).catch(() => {}); return }
    setError(null); setNotice(null); setPicking(true)
    void window.copilotDesktop.browserPick(tabId).then(text => {
      if (text) { insertIntoPrompt(tabId, text); setNotice('Element added to the prompt box. Review it and press Enter to send.') }
    }).catch(error => setError(errorMessage(error))).finally(() => setPicking(false))
  }
  const report = (promise: Promise<void>): void => { setError(null); void promise.catch(error => setError(errorMessage(error))) }
  const testingMessage = state.testing?.running ? `Step ${state.testing.step}/${state.testing.total}: ${state.testing.label}`
    : state.testing?.enabled ? 'Describe the steps and expected results to the assistant.' : 'Enable to let the assistant run your test in this page.'
  return <aside className="browser-panel" aria-label="Debug browser" style={{ display: active ? undefined : 'none' }}>
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); run(window.copilotDesktop.browserNavigate(tabId, url.trim())) }}>
      <button type="button" title="Back" aria-label="Browser back" disabled={!state.canGoBack} onClick={() => run(window.copilotDesktop.browserAction(tabId, 'back'))}>←</button>
      <button type="button" title="Forward" aria-label="Browser forward" disabled={!state.canGoForward} onClick={() => run(window.copilotDesktop.browserAction(tabId, 'forward'))}>→</button>
      <button type="button" title="Reload (Shift+click or Ctrl+Shift+R: hard reload that bypasses the cache)" aria-label="Reload browser" aria-keyshortcuts="Control+Shift+R" disabled={!state.url}
        onClick={event => run(window.copilotDesktop.browserAction(tabId, event.shiftKey || event.ctrlKey || event.metaKey ? 'hard-reload' : 'reload'))}>↻</button>
      <input ref={urlInput} aria-label="Web app URL" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={8192} placeholder="localhost:3000 or example.com" value={url} onChange={event => setUrl(event.target.value)} />
      <button type="submit">Go</button>
      <button type="button" className="browser-pick" title="Select an element on the page and add it to the prompt (Esc cancels)" aria-label="Select element to add to the prompt"
        aria-pressed={picking} disabled={!state.url || (state.view !== 'page' && !picking)} onClick={pickElement}><PickElementIcon /></button>
      <output className="browser-zoom" aria-label="Browser zoom" title="Selected page zoom">{Math.round(state.zoomFactor * 100)}%</output>
    </form>
    <div className="browser-pages" role="tablist" aria-label="Browser pages">
      {state.pages.map(page => <div className="browser-page" key={page.id}>
        <button type="button" role="tab" aria-selected={state.activePageId === page.id} title={page.url}
          onClick={() => run(window.copilotDesktop.browserAction(tabId, `select-page:${page.id}`))}>{page.title}</button>
        <button type="button" aria-label={`Close browser page ${page.title}`} disabled={state.pages.length <= 1}
          onClick={() => run(window.copilotDesktop.browserAction(tabId, `close-page:${page.id}`))}>×</button>
      </div>)}
      <button type="button" className="browser-new-page" aria-label="New browser page" title="New page" disabled={state.pages.length >= 32}
        onClick={() => run(window.copilotDesktop.browserAction(tabId, 'new-page'), true)}>+</button>
    </div>
    <div className="browser-tabs" role="tablist" aria-label="Browser views">
      {(['page', 'console', 'network', 'devtools', 'activity'] as const).map(name => <button type="button" key={name} className={name === 'devtools' ? 'browser-tools-toggle' : undefined} role="tab" aria-selected={state.view === name}
        onClick={() => run(window.copilotDesktop.browserAction(tabId, `view:${name}`))}>
        {name === 'page' ? 'Page' : name === 'console' ? 'Console' : name === 'network' ? 'Network' : name === 'devtools' ? 'DevTools / Overrides' : `Activity (${state.console.length + state.network.length})`}
      </button>)}
    </div>
    <div className="browser-testing">
      <button type="button" aria-pressed={state.testing?.enabled ?? false}
        onClick={() => run(window.copilotDesktop.browserAction(tabId, `testing:${state.testing?.enabled ? 'off' : 'on'}`))}>
        {state.testing?.enabled ? 'Stop testing' : 'Testing mode'}</button>
      <span role="status" title={testingMessage}>{testingMessage}</span>
    </div>
    {(error || state.error) && <p className="browser-error" role="alert">{error || state.error}</p>}
    {!error && !state.error && (picking ? <p className="browser-notice" role="status">Click an element in the page. Press Esc to cancel.</p>
      : notice && <p className="browser-notice" role="status">{notice}</p>)}
    <div className="browser-viewport" ref={viewport}>
      {state.view === 'page' && !state.url && <p className="browser-hint">Enter your web app URL above.</p>}
      {state.view === 'activity' && <BrowserActivity state={state} tabId={tabId} run={run} report={report} />}
    </div>
    <footer className="browser-footer">{state.loading ? 'Loading…' : 'This session’s browser activity is available to Copilot CLI.'}
      {state.testing?.report && <details className="browser-test-report"><summary>Last test: {state.testing.report.status}</summary>
        <p>{state.testing.report.description}</p><p>Expected: {state.testing.report.expected}</p>
        <ol>{state.testing.report.steps.map((step, index) => <li key={index}>{step.status}: {step.label}{step.reason ? ` — ${step.reason}` : ''}</li>)}</ol>
      </details>}
      <div className="browser-footer-details">
        <details className="browser-permissions"><summary>Site permissions ({state.sitePermissions.length})</summary>
          {state.sitePermissions.length === 0
            ? <p>Pages are asked before they can copy to or read from your clipboard or show notifications. Your answers appear here for this session; camera, microphone, location and other permissions are always blocked.</p>
            : <><ul>{state.sitePermissions.map(entry => <li key={entry.id}>
                <span><strong>{entry.decision === 'allow' ? 'Allowed' : 'Blocked'}</strong> {entry.origin}: {entry.label}</span>
                <button type="button" aria-label={`Forget ${entry.decision === 'allow' ? 'allowed' : 'blocked'} permission for ${entry.origin}: ${entry.label}`}
                  onClick={() => run(window.copilotDesktop.browserAction(tabId, `forget-permission:${entry.id}`))}>Forget</button></li>)}</ul>
                <button type="button" onClick={() => run(window.copilotDesktop.browserAction(tabId, 'forget-permissions'))}>Forget all</button></>}
        </details>
        <details><summary>Local Overrides setup</summary><p>Open DevTools / Overrides → Sources → Overrides, select your existing Chrome overrides folder, and enable Local Overrides. Save local edits and reload the page to test them.</p></details>
      </div>
    </footer>
  </aside>
}

export function BrowserWorkspace({ children, tabId, active = true, obscured = false, renderHeader }: {
  children: ReactNode; tabId: string; active?: boolean; obscured?: boolean;
  renderHeader?: (browserToggle: ReactNode) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [split, setSplit] = useState(50)
  const root = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const changeSplit = (value: number): void => setSplit(Math.min(75, Math.max(25, value)))
  const toggleLabel = open ? 'Hide browser' : 'Open browser'
  const toggle = <button type="button" className="icon-button session-browser-toggle" aria-expanded={open} aria-label={toggleLabel} title={toggleLabel} disabled={!active} onClick={() => setOpen(value => !value)}><BrowserIcon /></button>
  return <div className="browser-workspace">
    {renderHeader ? renderHeader(toggle) : <div className="browser-workspace-toolbar">{toggle}</div>}
    <div ref={root} className="browser-workspace-content" style={{ gridTemplateColumns: open && active ? `minmax(0, ${split}fr) 6px minmax(0, ${100 - split}fr)` : 'minmax(0, 1fr)' }}>
      <div className="browser-terminal-workspace">{children}</div>
      {open && <><div className="side-chat-divider" style={{ display: active ? undefined : 'none' }} role="separator" tabIndex={0} aria-label="Resize browser" aria-orientation="vertical" aria-valuenow={split} aria-valuemin={25} aria-valuemax={75}
        onPointerDown={event => { event.preventDefault(); dragging.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => { if (dragging.current !== event.pointerId) return; const b = root.current?.getBoundingClientRect(); if (b?.width) changeSplit((event.clientX - b.left) / b.width * 100) }}
        onPointerUp={event => { dragging.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
        onLostPointerCapture={() => { dragging.current = null }}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); changeSplit(event.key === 'Home' ? 25 : event.key === 'End' ? 75 : split + (event.key === 'ArrowLeft' ? -2 : 2)) } }} />
        <BrowserPanel tabId={tabId} active={active} obscured={obscured} /></>}
    </div>
  </div>
}
