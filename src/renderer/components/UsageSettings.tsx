import { useEffect, useState, useCallback } from 'react'
import type { JSX } from 'react'
import type { UsageCounts, UsageGroup, UsageReport, UsageScope } from '../../main/usage-types.js'

const format = (value: number): string => value.toLocaleString()
const total = (value: UsageCounts): number => value.input + value.cacheRead + value.cacheWrite + value.output
function UsageTable({ label, rows }: { label: string; rows: UsageGroup[] }): JSX.Element {
  return <details className="usage-breakdown"><summary>{label} ({rows.length})</summary>
    <div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>{label}</th><th>Total</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Requests</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.name}><th scope="row">{row.name}{row.source === 'reconciled' ? ' (provisional)' : ''}</th>
        <td>{format(total(row))}</td><td>{format(row.input)}</td><td>{format(row.output)}</td><td>{format(row.cacheRead)}</td><td>{format(row.cacheWrite)}</td><td>{format(row.requests)}</td></tr>)}</tbody></table></div>
  </details>
}
export function UsageSettings(): JSX.Element {
  const [month, setMonth] = useState(() => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)
  const [scope, setScope] = useState<UsageScope>('all')
  const [report, setReport] = useState<UsageReport | null>(null)
  const [timezone, setTimezone] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const value = await window.copilotDesktopSettings.usageReport(month, scope)
    setReport(value)
    setTimezone(value.timezone)
    setError('')
  }, [month, scope])
  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const value = await window.copilotDesktopSettings.usageReport(month, scope)
        if (active) { setReport(value); setTimezone((current) => current || value.timezone); setError('') }
      } catch (reason) { if (active) setError(String(reason)) }
    }
    setReport(null)
    void load()
    const visibleLoad = (): void => { if (!document.hidden) void load() }
    const timer = setInterval(visibleLoad, 30_000)
    document.addEventListener('visibilitychange', visibleLoad)
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visibleLoad) }
  }, [month, scope])
  const run = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true); setMessage('')
    try { const result = await action(); await refresh(); if (result !== false) setMessage(success) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  return <section className="settings-section" aria-label="Monthly token usage">
    <h2>Monthly token usage</h2>
    <p className="settings-disclaimer">Usage is saved independently of session history and retained across updates. Collection runs every 30 seconds while the desktop app is open.</p>
    <div className="settings-form-grid">
      <label>Month<input type="month" value={month} disabled={busy} onChange={(event) => { if (event.target.value) setMonth(event.target.value) }} /></label>
      <label>Sessions<select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as UsageScope)}><option value="all">All local Copilot sessions</option><option value="app">Sessions observed in this app</option></select></label>
      <label>Reporting timezone<input type="text" value={timezone} disabled={busy} onChange={(event) => setTimezone(event.target.value)} placeholder="America/Chicago" /></label>
    </div>
    <div className="usage-actions">
      <button disabled={busy || !timezone} onClick={() => void run(() => window.copilotDesktopSettings.usageReport(month, scope, timezone), 'Reporting timezone saved.')}>Save timezone</button>
      <button disabled={busy} onClick={() => void run(() => window.copilotDesktopSettings.refreshUsage(), 'Usage refreshed.')}>Refresh usage</button>
      <button disabled={busy} onClick={() => void run(() => window.copilotDesktopSettings.exportUsage(), 'Usage backup exported.')}>Export backup</button>
      <button disabled={busy} onClick={() => void run(() => window.copilotDesktopSettings.restoreUsage(), 'Backup merged with saved usage.')}>Restore backup</button>
    </div>
    {error && <p role="alert" className="usage-warning">{error}</p>}
    {message && <p role="status">{message}</p>}
    {report && <>
      <div className="usage-cards">
        {([['Total tokens', total(report.totals)], ['Uncached input', report.totals.input], ['Output', report.totals.output], ['Cache read', report.totals.cacheRead], ['Cache write', report.totals.cacheWrite]] as const).map(([label, value]) => <div className="settings-card" key={label}><span>{label}</span><strong>{format(value)}</strong></div>)}
      </div>
      <p className="settings-disclaimer">Reported reasoning: {format(report.totals.reasoning)} tokens, shown separately and not added to the total because overlap with output is unverified. Tokens are not a billing estimate.</p>
      {report.models.length === 0 && <p>No recorded usage for this month and session filter.</p>}
      <UsageTable label="Models" rows={report.models} /><UsageTable label="Sessions" rows={report.sessions} />
      {total(report.unallocated) > 0 && <p className="usage-warning">Unallocated across all months: {format(total(report.unallocated))} tokens. These are excluded from the monthly total.</p>}
      <details><summary>Collection and backup status</summary>
        <p>Last successful request collection: {report.lastCollected ? new Date(report.lastCollected).toLocaleString() : 'Not yet completed'}</p>
        <p>Last verified backup: {report.lastBackup ? new Date(report.lastBackup).toLocaleString() : 'Not yet completed'}</p>
        <p className="profile-path">Storage: {report.databasePath}</p>
        <p>Automatic backups retain 30 daily and 12 monthly copies. Export a backup to another folder to protect against loss of the entire app-data folder.</p>
      </details>
      <ul className="usage-warning">{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </>}
  </section>
}
