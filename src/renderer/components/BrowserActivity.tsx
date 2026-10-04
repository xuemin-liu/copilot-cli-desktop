import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { BrowserConsoleEntry, BrowserDebugState } from '../../main/browser-debug-types.js'

export function BrowserActivity({ state, tabId, run, report }: {
  state: BrowserDebugState; tabId: string;
  run: (promise: Promise<BrowserDebugState>) => void;
  report: (promise: Promise<void>) => void;
}): JSX.Element {
  const [kind, setKind] = useState<'console' | 'network'>('console')
  const [query, setQuery] = useState('')
  const [pageId, setPageId] = useState('all')
  const [level, setLevel] = useState('all')
  const [type, setType] = useState('all')
  const [failed, setFailed] = useState(false)
  const [group, setGroup] = useState(true)
  const [follow, setFollow] = useState(true)
  const [sort, setSort] = useState('time')
  const [requestId, setRequestId] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const needle = query.toLowerCase()
  const matchesPage = (id: number): boolean => pageId === 'all' || id === Number(pageId)
  const consoleEntries = state.console.filter(entry => matchesPage(entry.pageId) && (level === 'all' || entry.level === level)
    && `${entry.message} ${entry.source}`.toLowerCase().includes(needle))
  const networkEntries = state.network.filter(entry => matchesPage(entry.pageId)
    && (type === 'all' || (type === 'xhr' ? ['xhr', 'fetch'].includes(entry.resourceType) : entry.resourceType === type))
    && (!failed || Boolean(entry.error) || (entry.status ?? 0) >= 400)
    && `${entry.method} ${entry.url} ${entry.status ?? ''} ${entry.error ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => sort === 'duration' ? (b.durationMs ?? -1) - (a.durationMs ?? -1)
      : sort === 'status' ? (b.status ?? 0) - (a.status ?? 0) : a.timestamp.localeCompare(b.timestamp))
  const groups: { entry: BrowserConsoleEntry; count: number }[] = []
  for (const entry of consoleEntries) {
    const previous = groups.at(-1)
    if (group && previous && ['pageId', 'level', 'message', 'source', 'line'].every(key =>
      previous.entry[key as keyof BrowserConsoleEntry] === entry[key as keyof BrowserConsoleEntry])) previous.count++
    else groups.push({ entry, count: 1 })
  }
  const request = networkEntries.find(entry => entry.id === requestId)
  const pageIds = [...new Set([...state.pages.map(page => page.id), ...state.console.map(entry => entry.pageId), ...state.network.map(entry => entry.pageId)])]
  const pageLabel = (id: number): string => `Page ${id}${state.pages.some(page => page.id === id) ? '' : ' (closed)'}`
  const recording = kind === 'console' ? state.recordingConsole : state.recordingNetwork
  const preserved = kind === 'console' ? state.preserveConsole : state.preserveNetwork
  const visible = kind === 'console' ? consoleEntries : networkEntries
  useEffect(() => {
    if (follow && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [follow, kind, state.console.at(-1)?.id, state.network.at(-1)?.id])
  useEffect(() => { if (requestId && !state.network.some(entry => entry.id === requestId)) setRequestId(null) }, [state.network, requestId])
  const copy = (value: unknown): void => report(window.copilotDesktop.copyText(typeof value === 'string' ? value : JSON.stringify(value, null, 2)))
  return <div className="browser-activity" role="tabpanel" aria-label="Captured activity">
    <div className="browser-activity-controls">
      <label>Log <select aria-label="Activity log" value={kind} onChange={event => { setKind(event.target.value as 'console' | 'network'); setQuery(''); setRequestId(null) }}>
        <option value="console">Console</option><option value="network">Network</option>
      </select></label>
      <button type="button" onClick={() => { setRequestId(null); run(window.copilotDesktop.browserAction(tabId, `clear-${kind}`)) }}>Clear {kind}</button>
      <button type="button" aria-pressed={!recording} onClick={() => run(window.copilotDesktop.browserAction(tabId, `record-${kind}:${recording ? 'off' : 'on'}`))}>{recording ? 'Pause capture' : 'Resume capture'}</button>
      <label><input type="checkbox" checked={preserved} onChange={event => run(window.copilotDesktop.browserAction(tabId, `preserve-${kind}:${event.target.checked ? 'on' : 'off'}`))} />Preserve log</label>
      <button type="button" onClick={() => copy(visible)}>Copy visible log</button>
      <button type="button" onClick={() => report(window.copilotDesktop.browserExport(tabId, kind))}>Save log…</button>
    </div>
    <div className="browser-activity-controls">
      <input type="search" aria-label="Filter activity" placeholder="Filter text or URL" value={query} maxLength={2048} onChange={event => setQuery(event.target.value)} />
      <select aria-label="Activity page" value={pageId} onChange={event => setPageId(event.target.value)}>
        <option value="all">All pages</option>{pageIds.map(id => <option key={id} value={id}>{pageLabel(id)}</option>)}
      </select>
      {kind === 'console' ? <>
        <select aria-label="Console level" value={level} onChange={event => setLevel(event.target.value)}>
          <option value="all">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option><option value="debug">Verbose</option>
        </select>
        <label><input type="checkbox" checked={group} onChange={event => setGroup(event.target.checked)} />Group repeats</label>
      </> : <>
        <select aria-label="Request type" value={type} onChange={event => setType(event.target.value)}>
          <option value="all">All types</option><option value="xhr">Fetch/XHR</option><option value="script">JS</option><option value="stylesheet">CSS</option><option value="image">Images</option><option value="font">Fonts</option><option value="mainFrame">Document</option><option value="webSocket">WebSocket</option><option value="other">Other</option>
        </select>
        <label><input type="checkbox" checked={failed} onChange={event => setFailed(event.target.checked)} />Failed only</label>
        <select aria-label="Sort requests" value={sort} onChange={event => setSort(event.target.value)}><option value="time">Start time</option><option value="duration">Slowest first</option><option value="status">Status</option></select>
      </>}
      <label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />Auto-scroll</label>
      <small>{visible.length} of {state[kind].length} captured {recording ? '' : '· paused'}</small>
    </div>
    <div className="browser-activity-list" ref={list}>
      {visible.length === 0 && <p>No matching {kind === 'console' ? 'messages' : 'requests'}.</p>}
      {kind === 'console' ? groups.map(({ entry, count }) => <div key={entry.id} className={`browser-console-entry browser-console-${entry.level}`}>
        <small>{entry.level} · {entry.timestamp.slice(11, 19)} · {pageLabel(entry.pageId)} · {entry.source}:{entry.line}{count > 1 ? ` · ×${count}` : ''}</small>
        <pre>{entry.message}</pre><button type="button" onClick={() => copy(entry)}>Copy message</button>
      </div>) : <>
        <table className="browser-network"><thead><tr><th>Status</th><th>Method / URL</th><th>Page</th><th>Type</th><th>Time</th></tr></thead><tbody>
          {networkEntries.map(entry => <tr key={entry.id}><td>{entry.error || entry.status || '…'}</td>
            <td><button type="button" onClick={() => setRequestId(entry.id)}>{entry.method} {entry.url}</button></td>
            <td>{entry.pageId}</td><td>{entry.resourceType}</td><td>{entry.durationMs === null ? '…' : `${entry.durationMs} ms`}</td></tr>)}
        </tbody></table>
        {request && <section aria-label="Captured request details"><button type="button" onClick={() => copy(request)}>Copy request</button><pre className="browser-request-detail">{JSON.stringify(request, null, 2)}</pre></section>}
      </>}
    </div>
    <p className="browser-activity-note">Captured logs include every page in this terminal and retain the latest 300 entries. Use Console or Network for native inspection, response bodies and exports.</p>
  </div>
}
