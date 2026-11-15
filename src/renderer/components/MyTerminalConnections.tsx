import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { projectTerminal, SessionDialog, SettingsDialog } from '../../../vendor/myterminal/desktop-renderer.mjs'
import type { TerminalConfig } from '../../main/tool-tabs.js'

/** Connection configuration UI; the CLI destination remains the current session. */
export function MyTerminalConnections({ profileId, connect }: { profileId: string; connect(config: TerminalConfig): void }): JSX.Element {
  const project = useMemo(() => projectTerminal(profileId), [profileId])
  const { sessions } = project.store() as { sessions: { id: string; name?: string; host: string; username: string }[] }
  const [editing, setEditing] = useState<object | null | undefined>(undefined)
  const [settings, setSettings] = useState(false), [error, setError] = useState('')
  const run = (fn: () => Promise<unknown>): void => { setError(''); void fn().catch(value => setError(String(value))) }
  useEffect(() => { run(() => project.load()) }, [project])
  return <div className="myterminal-connections myterminal-embedded">
    <h3>Saved SSH connections</h3>
    <p>SFTP, remote editing, jump hosts and port forwarding.</p>
    <div className="myterminal-connection-actions">
      <button type="button" onClick={() => setEditing(null)}>New SSH connection</button>
      <button type="button" onClick={() => setSettings(true)}>Settings & backup</button>
      <button type="button" onClick={() => run(async () => { await project.store.getState().importSessions(); await project.load() })}>Import connections</button>
      <button type="button" onClick={() => run(async () => { const result = await project.importSshConfig() as { error?: string }; if (result?.error) throw new Error(result.error); await project.load() })}>Import SSH config</button>
    </div>
    {sessions.map(connection => <div key={connection.id} className="myterminal-connection-row">
      <button type="button" onClick={() => connect({ transport: 'managed', connectionId: connection.id, host: connection.host })}>{connection.name || `${connection.username}@${connection.host}`}</button>
      <button type="button" onClick={() => setEditing(connection)}>Edit</button>
      <button type="button" onClick={() => run(() => project.store.getState().deleteSession(connection.id))}>Delete</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
    {editing !== undefined && <SessionDialog host={project} session={editing ?? undefined} onClose={() => setEditing(undefined)} />}
    {settings && <SettingsDialog host={project} onClose={() => setSettings(false)} />}
  </div>
}
