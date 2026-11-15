import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import TerminalTab from '../../../vendor/myterminal/renderer.mjs'
import type { ToolTab } from '../../main/tool-tabs.js'
import { createMyTerminalHost } from '../myterminal-host.js'
import type { Snapshot } from '../myterminal-host.js'
import { insertIntoPrompt } from '../prompt-insert.js'
import { SettingsDialog } from '../../../vendor/myterminal/desktop-renderer.mjs'

/** Desktop lifecycle and current-session action; terminal behavior comes from MyTerminal. */
export function ToolTerminalPanel({ profileId, tab, active, promptTargetId }: { profileId: string; tab: ToolTab; active: boolean; promptTargetId: string | null }): JSX.Element {
  const [state, setState] = useState<Snapshot | null>(null), [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const host = useMemo(() => createMyTerminalHost(profileId, tab.id, setState, setError), [profileId, tab.id])
  host.setActive(active)
  useEffect(() => { host.start(); return () => host.stop() }, [host])
  const descriptor = useMemo(() => ({ id: tab.id, channelId: tab.id, sessionId: tab.terminal?.connectionId, label: tab.label || tab.title, isLocal: tab.kind !== 'ssh',
    splitChannelId: state?.splitId, splitConfig: state?.splitId ? { ...tab.terminal, host: tab.title } : null,
    wslDistro: tab.kind === 'wsl' ? tab.terminal?.distro || 'Default' : null, config: tab.terminal ?? {} }), [tab.id, tab.kind, tab.title, tab.label, tab.terminal, state?.splitId])
  const addToPrompt = (): void => {
    const terminal = host.getTerminal(); if (!terminal || !promptTargetId) return
    let text = terminal.getSelection()
    if (!text) {
      const buffer = terminal.buffer.active, lines: string[] = []
      for (let row = Math.max(0, buffer.length - 80); row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
      text = lines.join('\n').trim()
    }
    if (!text) { setError('No terminal output to add'); return }
    if (!insertIntoPrompt(promptTargetId, `Terminal ${tab.id}:\n${text.slice(-11000)}`)) setError('The current session is unavailable')
  }
  return <section className="tool-terminal-panel myterminal-embedded" aria-label="Terminal">
    {state && !['disconnected', 'starting'].includes(state.status) && <div className="tool-terminal-screen">
      <TerminalTab key={state.generation} tab={descriptor} isActive={active} host={{ ...host, remoteTools: tab.terminal?.transport === 'managed', toolbar: <>
        <button type="button" title="Terminal settings and backup" onClick={() => setSettingsOpen(true)}>⚙</button>
        <button type="button" title="Add selected text, or recent output, to the current session" disabled={!promptTargetId} onClick={addToPrompt}>Add to prompt</button></> }} />
    </div>}
    {settingsOpen && active && <SettingsDialog host={host} onClose={() => setSettingsOpen(false)} />}
    {error && <div className="tool-terminal-error" role="alert">{error}<button type="button" aria-label="Dismiss terminal error" onClick={() => setError('')}>×</button></div>}
    {state?.status !== 'running' && <footer className="tool-terminal-footer">
      <span>{state?.status === 'exited' ? `Exited (${state.exitCode})` : state?.status === 'error' ? state.error : state?.status === 'disconnected' ? 'Disconnected — connect to start this terminal' : 'Starting…'}</span>
      {state && ['disconnected', 'exited', 'error'].includes(state.status) && <button type="button" onClick={() => { setError(''); void host.connect() }}>{state.status === 'disconnected' ? 'Connect' : 'Reconnect'}</button>}
    </footer>}
  </section>
}
