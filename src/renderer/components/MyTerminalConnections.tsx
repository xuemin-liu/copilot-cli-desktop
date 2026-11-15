import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { projectTerminal, ConnectionSidebar } from '../../../vendor/myterminal/desktop-renderer.mjs'
import type { TerminalConfig } from '../../main/tool-tabs.js'

/** Reuse MyTerminal's connection search, grouping, copy, import/export and dialogs. */
export function MyTerminalConnections({ profileId, connect }: { profileId: string; connect(config: TerminalConfig): void }): JSX.Element {
  const project = useMemo(() => projectTerminal(profileId), [profileId])
  const [error, setError] = useState('')
  useEffect(() => { void project.load().catch(error => setError(String(error))) }, [project])
  return <div className="myterminal-connections myterminal-embedded">
    {error && <p role="alert">{error}</p>}
    <ConnectionSidebar host={{ ...project, openSaved: (connection: {id: string; host: string}) => connect({ transport: 'managed', connectionId: connection.id, host: connection.host }) }} />
  </div>
}
