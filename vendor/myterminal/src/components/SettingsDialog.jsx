import React, { useState, useEffect } from 'react'
import { X, Download, Upload } from 'lucide-react'
import useSessionStore from '../store/useSessionStore'

export default function SettingsDialog({ host, onClose }) {
  const api = host?.api || window.electronAPI
  const sessionStore = host?.store || useSessionStore
  const { settings, updateSettings, exportBackup, importBackup } = sessionStore()
  const [local, setLocal] = useState({ ...settings })
  const [backupStatus, setBackupStatus] = useState('')
  const [credPrompt, setCredPrompt] = useState(false)

  // Escape closes whichever dialog is on top: credentials prompt first,
  // otherwise the settings dialog itself.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return
      if (credPrompt) setCredPrompt(false)
      else onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [credPrompt, onClose])

  const runExport = async (includeCredentials) => {
    setCredPrompt(false)
    setBackupStatus('')
    const result = await exportBackup({ includeCredentials })
    if (result?.canceled) return
    if (result?.error) setBackupStatus('Export failed: ' + result.error)
    else setBackupStatus(result?.includesCredentials ? 'Backup saved (with credentials)' : 'Backup saved (no credentials)')
  }

  const handleExportBackup = () => {
    setBackupStatus('')
    setCredPrompt(true)
  }

  const handleImportBackup = async () => {
    setBackupStatus('')
    const result = await importBackup()
    if (result?.canceled) return
    if (result?.error) { setBackupStatus('Import failed: ' + result.error); return }
    // importBackup refreshes the global store; resync local state so that
    // clicking Save afterward doesn't overwrite the just-imported preferences.
    setLocal({ ...sessionStore.getState().settings })
    const s = result?.summary || {}
    const parts = []
    if (s.sessions) parts.push(`${s.sessions} connections`)
    if (s.snippets) parts.push(`${s.snippets} snippets`)
    if (s.sftpFavorites) parts.push(`${s.sftpFavorites} favorites`)
    if (s.filterPresets) parts.push(`${s.filterPresets} filter presets`)
    if (s.tunnelConfigs) parts.push(`${s.tunnelConfigs} tunnel configs`)
    if (s.settingsPrefs) parts.push(`${s.settingsPrefs} settings`)
    if (s.anthropicApiKey) parts.push('AI API key')
    setBackupStatus(parts.length ? 'Merged: ' + parts.join(', ') : 'Nothing to merge')
  }

  const handleChange = (key, value) => {
    setLocal((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    try { await updateSettings(local); onClose() }
    catch (error) { setBackupStatus(error.message) }
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog" style={{ width: 480 }}>
        <div className="dialog-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="dialog-body">
          <div className="form-group">
            <label>Default Font Size</label>
            <input
              type="number"
              min={8}
              max={32}
              value={local.defaultFontSize}
              onChange={(e) => handleChange('defaultFontSize', parseInt(e.target.value) || 14)}
            />
          </div>
          <div className="form-group">
            <label>Default Scrollback Lines</label>
            <input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={local.defaultScrollback}
              onChange={(e) => handleChange('defaultScrollback', parseInt(e.target.value) || 10000)}
            />
          </div>
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={local.colorizeByDefault}
                onChange={(e) => handleChange('colorizeByDefault', e.target.checked)}
                style={{ width: 'auto', marginRight: 8 }}
              />
              Colorize output by default
            </label>
          </div>
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={local.osc52ClipboardEnabled === true}
                onChange={(e) => handleChange('osc52ClipboardEnabled', e.target.checked)}
                style={{ width: 'auto', marginRight: 8 }}
              />
              Allow OSC 52 clipboard writes
            </label>
          </div>
          <div className="form-group">
            <label>SSH Keepalive Interval (ms)</label>
            <input
              type="number"
              min={0}
              max={300000}
              step={1000}
              value={local.keepaliveInterval}
              onChange={(e) => handleChange('keepaliveInterval', parseInt(e.target.value) || 10000)}
            />
          </div>
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={local.loggingEnabled}
                onChange={(e) => handleChange('loggingEnabled', e.target.checked)}
                style={{ width: 'auto', marginRight: 8 }}
              />
              Enable session logging
            </label>
          </div>
          <div className="form-group">
            <label>Log Directory</label>
            <div className="input-row">
              <input
                type="text"
                placeholder="Leave empty for default"
                value={local.logDirectory}
                onChange={(e) => handleChange('logDirectory', e.target.value)}
              />
              <button
                className="browse-btn"
                onClick={async () => {
                  const result = await api.dialog.openFile({ properties: ['openDirectory'] })
                  if (!result.canceled && result.filePaths[0]) handleChange('logDirectory', result.filePaths[0])
                }}
              >
                Browse
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>Backup & Restore</label>
            <div className="input-row">
              <button className="browse-btn" onClick={handleExportBackup}>
                <Download size={13} /> Export backup
              </button>
              <button className="browse-btn" onClick={handleImportBackup}>
                <Upload size={13} /> Import (merge)
              </button>
            </div>
            <div className="form-hint">
              Exports SSH connections, snippets, SFTP favorites, filter presets, tunnel configs, and preferences. You'll be asked whether to include SSH passwords / passphrases (default: exclude, for safety).
            </div>
            {backupStatus && <div className="form-hint" style={{ marginTop: 6 }}>{backupStatus}</div>}
          </div>
        </div>
        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>

      {credPrompt && (
        <div className="dialog-overlay" onClick={() => setCredPrompt(false)} style={{ zIndex: 1000 }}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
            <div className="dialog-header">
              <h2>Include credentials?</h2>
              <button className="icon-btn" onClick={() => setCredPrompt(false)}><X size={16} /></button>
            </div>
            <div className="dialog-body">
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
                Include SSH passwords / key passphrases in the backup?
              </p>
              <div className="form-hint" style={{ marginTop: 10 }}>
                <strong>Include:</strong> migration is one click — sessions connect right away on the destination. The file contains plaintext credentials and must be guarded like a password manager export.
              </div>
              <div className="form-hint" style={{ marginTop: 6 }}>
                <strong>Exclude:</strong> safer — backup file has no secrets. You re-enter passwords on the destination.
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn-secondary" onClick={() => setCredPrompt(false)}>Cancel</button>
              <button className="btn-secondary" onClick={() => runExport(true)}>Include credentials</button>
              <button className="btn-primary" onClick={() => runExport(false)}>Exclude credentials</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
