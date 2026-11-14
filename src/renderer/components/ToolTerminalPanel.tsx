import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { TerminalSnapshot } from '../../main/tool-terminal.js'
import { insertIntoPrompt } from '../prompt-insert.js'
import { isMac } from '../platform.js'

type Snapshot = Omit<TerminalSnapshot, 'status'> & { status: TerminalSnapshot['status'] | 'disconnected' }
export function ToolTerminalPanel({ profileId, id, active, promptTargetId }: { profileId: string; id: string; active: boolean; promptTargetId: string | null }): JSX.Element {
  const container = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null), search = useRef<SearchAddon | null>(null)
  const cursor = useRef(0), generation = useRef(''), epoch = useRef(0), connecting = useRef(false), activeRef = useRef(active), running = useRef(false)
  activeRef.current = active
  const [state, setState] = useState<Snapshot | null>(null), [error, setError] = useState(''), [query, setQuery] = useState('')
  const call = (request: Record<string, unknown>): Promise<unknown> => window.copilotDesktop.toolTerminal(profileId, { ...request, id })
  const report = (error: unknown): void => setError(error instanceof Error ? error.message : String(error))
  useEffect(() => {
    if (!container.current) return
    const term = new Terminal({ fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 10000,
      theme: { background: '#0b1020', foreground: '#e6edf3', cursor: '#58a6ff' } })
    const fitAddon = new FitAddon(), searchAddon = new SearchAddon()
    term.loadAddon(fitAddon); term.loadAddon(searchAddon); term.open(container.current)
    terminal.current = term; fit.current = fitAddon; search.current = searchAddon
    const data = term.onData(text => { if (activeRef.current && running.current) void call({ action: 'write', text }).catch(report) })
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true
      const modifier = isMac ? event.metaKey : event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(report); return false
      }
      if (modifier && event.key.toLowerCase() === 'v') return false // Chromium paste event → xterm's bracketed paste handling.
      return true
    })
    const resize = (): void => {
      if (!activeRef.current || !container.current?.clientHeight) return
      fitAddon.fit()
      if (running.current) void call({ action: 'resize', cols: term.cols, rows: term.rows }).catch(report)
    }
    const observer = new ResizeObserver(resize); observer.observe(container.current)
    return () => { observer.disconnect(); data.dispose(); term.dispose(); terminal.current = null; cursor.current = 0 }
  }, [profileId, id])
  useEffect(() => {
    if (!active) return
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const requestEpoch = epoch.current
      try {
        if (connecting.current) return
        const next = await call({ action: 'read', cursor: cursor.current, generation: generation.current }) as Snapshot
        if (disposed || requestEpoch !== epoch.current) return
        if (next.generation !== generation.current) { terminal.current?.reset(); cursor.current = 0; running.current = false; generation.current = next.generation }
        if (next.start > cursor.current) { terminal.current?.reset(); terminal.current?.writeln('[Older terminal output was discarded]') }
        if (next.output) terminal.current?.write(next.output)
        cursor.current = next.cursor; setState(next)
        const started = !running.current && next.status === 'running'; running.current = next.status === 'running'
        if (started) { fit.current?.fit(); const term = terminal.current; if (term) await call({ action: 'resize', cols: term.cols, rows: term.rows }) }
      } catch (error) { if (!disposed && requestEpoch === epoch.current) report(error) }
      finally { if (!disposed) timer = setTimeout(() => { void poll() }, 200) }
    }
    fit.current?.fit(); terminal.current?.focus(); void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [active, profileId, id])
  const connect = async (): Promise<void> => {
    if (connecting.current) return
    connecting.current = true; epoch.current++
    try {
      setError(''); cursor.current = 0; terminal.current?.reset()
      setState(await call({ action: state?.status === 'disconnected' ? 'start' : 'restart' }) as Snapshot)
      terminal.current?.focus()
    } catch (error) { report(error) }
    finally { connecting.current = false }
  }
  const addToPrompt = (): void => {
    const term = terminal.current; if (!term || !promptTargetId) return
    let text = term.getSelection()
    if (!text) {
      const buffer = term.buffer.active, lines: string[] = []
      for (let row = Math.max(0, buffer.length - 80); row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
      text = lines.join('\n').trim()
    }
    if (!text) { setError('No terminal output to add'); return }
    if (!insertIntoPrompt(promptTargetId, `Terminal ${id}:\n${text.slice(-11000)}`)) setError('The current session is unavailable')
  }
  return <section className="tool-terminal-panel" aria-label="Terminal">
    <div className="tool-terminal-toolbar">
      <input aria-label="Find in terminal" placeholder="Find…" value={query} onChange={event => { setQuery(event.target.value); search.current?.findNext(event.target.value) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); search.current?.findNext(query) } }} />
      <button type="button" title="Find previous" onClick={() => search.current?.findPrevious(query)}>↑</button>
      <button type="button" title="Find next" onClick={() => search.current?.findNext(query)}>↓</button>
      <button type="button" title="Add selected text, or recent output, to the current session" disabled={!promptTargetId} onClick={addToPrompt}>Add to prompt</button>
    </div>
    <div className="tool-terminal-screen" ref={container} onKeyDown={event => event.stopPropagation()} />
    {error && <div className="tool-terminal-error" role="alert">{error}<button type="button" aria-label="Dismiss terminal error" onClick={() => setError('')}>×</button></div>}
    <footer className="tool-terminal-footer">
      <span>{state?.status === 'running' ? 'Connected' : state?.status === 'exited' ? `Exited (${state.exitCode})` : state?.status === 'error' ? state.error : state?.status === 'disconnected' ? 'Disconnected — connect to start this terminal' : 'Starting…'}</span>
      {state?.status === 'running' && <button type="button" onClick={() => { void call({ action: 'interrupt' }).catch(report) }}>Ctrl+C</button>}
      {state && ['disconnected', 'exited', 'error'].includes(state.status) && <button type="button" onClick={() => { void connect() }}>{state.status === 'disconnected' ? 'Connect' : 'Reconnect'}</button>}
    </footer>
  </section>
}
