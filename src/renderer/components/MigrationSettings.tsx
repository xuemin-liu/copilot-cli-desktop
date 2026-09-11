import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { DEFAULT_MIGRATION_CATEGORIES, MIGRATION_CATEGORIES, type MigrationCategory, type MigrationInventory, type MigrationPreview, type MigrationProgress, type MigrationResult } from '../../main/migration-types.js'
import type { CopilotDesktopSettingsBridge, DesktopSettingsSnapshot } from '../global.js'

const LABELS: Record<MigrationCategory, string> = {
  settings: 'CLI settings', knowledge: 'Personal instructions', skills: 'Skills and agents', desktop: 'Desktop preferences and workspaces',
  tools: 'Tools, hooks, and extensions (can execute commands)', projects: 'Selected project instructions and skills', plugins: 'Plugin inventory', usage: 'Token usage records',
}
export function MigrationSettings({ onSaved }: { onSaved: (snapshot: DesktopSettingsSnapshot) => void }): JSX.Element {
  const bridge = window.copilotDesktopSettings
  const [categories, setCategories] = useState<MigrationCategory[]>([...DEFAULT_MIGRATION_CATEGORIES])
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [inventory, setInventory] = useState<MigrationInventory | null>(null)
  const [inventoryKey, setInventoryKey] = useState('')
  const [archive, setArchive] = useState<Awaited<ReturnType<CopilotDesktopSettingsBridge['migrationOpen']>>>(null)
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<MigrationPreview | null>(null)
  const [replace, setReplace] = useState<string[]>([])
  const [permissions, setPermissions] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [localBusy, setBusy] = useState(false)
  const [serverBusy, setServerBusy] = useState(false)
  const [recoveryIssues, setRecoveryIssues] = useState<string[]>([])
  const busy = localBusy || serverBusy
  const [progress, setProgress] = useState<MigrationProgress | null>(null)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<MigrationResult | null>(null)
  useEffect(() => {
    let mounted = true
    const refresh = (): void => { void bridge.migrationStatus().then((status) => {
      if (mounted) { setServerBusy(status.busy); setProgress(status.progress); setRecoveryIssues(status.recoveryIssues) }
    }).catch((error) => { if (mounted) setMessage(String(error)) }) }
    const unsubscribe = bridge.onMigrationProgress(() => refresh())
    refresh()
    return () => { mounted = false; unsubscribe() }
  }, [bridge])
  const key = JSON.stringify({ categories, projectIds })
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage('')
    try { await fn() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const toggle = <T,>(items: T[], item: T): T[] => items.includes(item) ? items.filter((value) => value !== item) : [...items, item]
  return <section aria-labelledby="migration-title">
    <h2 id="migration-title">Migration</h2>
    {recoveryIssues.length > 0 && <div className="settings-warning" role="alert">
      <p>An interrupted import needs attention. Your backups are preserved. Inspect the listed files before retrying recovery.</p>
      <ul>{recoveryIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
      <button disabled={busy} onClick={() => void run(async () => { const status = await bridge.migrationRecover(); setRecoveryIssues(status.recoveryIssues); onSaved(await bridge.get()) })}>Retry recovery</button>
    </div>}
    <p>Move your Copilot setup to another Windows computer using one ZIP file. Choose what to include, then review the destination changes before importing.</p>
    <p className="settings-disclaimer">Close all Desktop and external Copilot sessions before exporting or importing. Stop the background controller with <code>copilot-desktop stop</code>. Sign in and reconnect credentials on the new computer. Archives may contain private instructions and scripts.</p>
    <fieldset disabled={busy} className="settings-card">
      <legend>What to transfer</legend>
      <div className="settings-form-grid">
        {MIGRATION_CATEGORIES.map((category) => <label key={category} className="settings-checkbox">
          <input type="checkbox" checked={categories.includes(category)} onChange={() => { setCategories(toggle(categories, category)); setReviewed(false) }} />{LABELS[category]}
        </label>)}
      </div>
      <p>Conversation history: unavailable until CLI restore compatibility is verified. Account-level knowledge, passwords, and saved directory approvals are excluded.</p>
    </fieldset>
    <div className="settings-card">
      <h3>Export from this computer</h3>
      <div className="settings-actions">
        <button disabled={busy} onClick={() => void run(async () => { setInventory(await bridge.migrationInventory({ categories, projectIds })); setInventoryKey(key) })}>Review export files</button>
        <button disabled={busy || !inventory || inventoryKey !== key} onClick={() => void run(async () => { if (await bridge.migrationExport({ categories, projectIds })) setMessage('Archive exported and shown in its folder.') })}>Export ZIP…</button>
      </div>
      {inventory && <>
        {categories.includes('projects') && <fieldset disabled={busy}>
          <legend>Repositories to include</legend>
          {inventory.projects.length === 0 && <p>Add a workspace in the main window to export its project instructions.</p>}
          {inventory.projects.map((project) => <label key={project.id} className="settings-checkbox">
            <input type="checkbox" checked={projectIds.includes(project.id)} onChange={() => setProjectIds(toggle(projectIds, project.id))} />{project.name} — {project.sourcePath}
          </label>)}
        </fieldset>}
        <p>{inventory.entries.length} files · {(inventory.entries.reduce((sum, entry) => sum + entry.size, 0) / 1024 / 1024).toFixed(2)} MiB{inventoryKey !== key ? ' · Selection changed: review files again.' : ''}</p>
        <details><summary>Files and source folders</summary><pre className="resource-output">{Object.entries(inventory.roots).map(([name, path]) => `${name}: ${path}`).join('\n')}{'\n\n'}{inventory.entries.map((file) => `${file.path} (${file.size} bytes)`).join('\n')}</pre></details>
        <details><summary>Exclusions and items to review</summary><ul>{inventory.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
      </>}
    </div>
    <div className="settings-card">
      <h3>Import on this computer</h3>
      <button disabled={busy} onClick={() => void run(async () => {
        const opened = await bridge.migrationOpen()
        if (opened) { setArchive(opened); setMappings({}); setPreview(null); setReplace([]); setReviewed(false); setResult(null) }
      })}>Choose archive…</button>
      {archive && <>
        <h4>Workspace folders</h4>
        <p>Map only the workspaces you want to import. Existing files are kept unless you select a replacement below.</p>
        {archive.projects.map((project) => <div className="settings-card" key={project.id}>
          <strong>{project.name}</strong><p className="profile-path">{project.sourcePath}</p>
          <button disabled={busy} onClick={() => void run(async () => { const path = await bridge.migrationMap(project.id); if (path) { setMappings({ ...mappings, [project.id]: path }); setReviewed(false) } })}>Choose destination folder…</button>
          <p className="profile-path">{mappings[project.id] ?? 'Unmapped — skipped'}</p>
        </div>)}
        <label className="settings-checkbox"><input disabled={busy} type="checkbox" checked={permissions} onChange={(event) => { setPermissions(event.target.checked); setReviewed(false) }} />Include imported permission settings and workspace autopilot/remote choices</label>
        <div className="settings-actions">
          <button disabled={busy} onClick={() => void run(async () => { setPreview(await bridge.migrationPreview({ categories, replace, allowPermissions: permissions })); setReviewed(true) })}>Review import changes</button>
          <button disabled={busy || !preview || !reviewed || !!result} onClick={() => void run(async () => {
            if (!preview) return
            setReviewed(false)
            setResult(await bridge.migrationApply(preview.id))
            onSaved(await bridge.get())
          })}>Import selected</button>
        </div>
        {preview && <>
          <p>{preview.changes.filter((change) => change.action === 'import').length} changes selected. {!reviewed && 'Choices changed: review again before importing.'}</p>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            {preview.changes.map((change) => <div className="settings-card" key={change.id}>
              <strong>{change.status} · {change.action === 'import' ? 'Import' : 'Keep / skip'}</strong>
              <p className="profile-path">{change.path}</p>
              {change.detail && <p>{change.detail}</p>}
              {change.status === 'Conflict' && <label className="settings-checkbox"><input type="checkbox" disabled={busy} checked={replace.includes(change.id)} onChange={() => { setReplace(toggle(replace, change.id)); setReviewed(false) }} />Use imported version (existing version is backed up)</label>}
            </div>)}
          </div>
          <details><summary>Compatibility and reconnection notes</summary><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
        </>}
      </>}
    </div>
    {busy && <p role="status">{progress?.phase ?? 'Working…'}{progress && progress.total > 0 ? ` ${progress.completed}/${progress.total}` : ''} <button onClick={() => void bridge.migrationCancel()}>Cancel</button></p>}
    {message && <p role="status" className="settings-warning">{message}</p>}
    {result && <div className="settings-card" role="status">
      <h3>Import completed</h3>
      <p>{result.imported} file changes applied · {result.skipped} items kept or skipped.</p>
      {result.backup && <p className="profile-path">Recovery backups: {result.backup}</p>}
      <ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      <p>Use Protected credential vault below to reconnect API credentials, and sign in through Copilot for GitHub access. Review tool commands and machine-specific paths before starting a session.</p>
      {archive?.plugins.map((plugin, index) => <div key={index} className="settings-card">
        <strong>{plugin.name} {plugin.version}</strong><p>{plugin.source || 'Source unavailable — reinstall manually in Copilot extensions.'}</p>
        {plugin.source && <button disabled={busy} onClick={() => void run(async () => { onSaved(await bridge.installCopilotPlugin(plugin.source)); setMessage(`Installed ${plugin.name}.`) })}>Install this plugin</button>}
      </div>)}
    </div>}
  </section>
}
