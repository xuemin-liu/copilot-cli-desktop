const electron = require('electron')
const fs = require('fs')

const BACKUP_VERSION = 1

module.exports = function registerBackupHandlers(store, { ipcMain = electron.ipcMain, dialog = electron.dialog, encryptSession, decryptSession, encryptField, decryptField, SENSITIVE_FIELDS, DEFAULT_SETTINGS, getMainWindow, sanitizeSettings = value => value }) {
  ipcMain.handle('backup:export', async (_event, options) => {
    const includeCredentials = !!(options && options.includeCredentials)

    const save = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export Backup',
      defaultPath: `myterminal-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (save.canceled) return { canceled: true }

    const sessions = store.get('sessions', []).map((s) => {
      const clean = decryptSession(s)
      if (!includeCredentials) for (const f of SENSITIVE_FIELDS) delete clean[f]
      return clean
    })

    let anthropicApiKey = ''
    if (includeCredentials) {
      const rawKey = store.get('settings.anthropicApiKey', '')
      anthropicApiKey = rawKey ? decryptField(rawKey) : ''
    }

    const payload = {
      app: 'MyTerminal',
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      includesCredentials: includeCredentials,
      ...(includeCredentials && { _warning: 'This file contains plaintext SSH passwords, passphrases, and the Anthropic API key. Handle like a password manager export.' }),
      sessions,
      snippets: store.get('snippets', []),
      sftpFavorites: store.get('sftp-favorites', {}),
      filterPresets: store.get('filter-presets', []),
      tunnelConfigs: store.get('tunnel-configs', {}),
      settingsPrefs: store.get('settings-prefs', {}),
      anthropicApiKey,
    }

    try {
      fs.writeFileSync(save.filePath, JSON.stringify(payload, null, 2), 'utf8')
      return { success: true, path: save.filePath, includesCredentials: includeCredentials }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('backup:import', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Import Backup',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled) return { canceled: true }

    let data
    try {
      const raw = fs.readFileSync(result.filePaths[0], 'utf8')
      data = JSON.parse(raw)
    } catch (e) {
      return { error: 'Failed to read file: ' + e.message }
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { error: 'Invalid backup file: not an object' }
    }
    if (data.version && data.version > BACKUP_VERSION) {
      return { error: `Backup version ${data.version} is newer than supported (${BACKUP_VERSION})` }
    }

    const summary = { sessions: 0, snippets: 0, sftpFavorites: 0, filterPresets: 0, tunnelConfigs: 0, settingsPrefs: 0, anthropicApiKey: false }

    // Sessions — by id, incoming wins on non-sensitive fields. Sensitive
    // fields absent from the backup are preserved from the existing entry, so
    // importing a no-credentials backup never silently wipes saved passwords.
    if (Array.isArray(data.sessions)) {
      const existing = store.get('sessions', [])
      const map = new Map(existing.map((s) => [s.id, s]))
      for (const s of data.sessions) {
        if (!s || !s.id || !s.host || !s.username) continue
        const existingEncrypted = map.get(s.id)
        const merged = { ...s }
        if (existingEncrypted) {
          const existingDecrypted = decryptSession(existingEncrypted)
          for (const f of SENSITIVE_FIELDS) {
            if (!merged[f] && existingDecrypted[f]) merged[f] = existingDecrypted[f]
          }
        }
        map.set(s.id, encryptSession(merged))
        summary.sessions++
      }
      store.set('sessions', Array.from(map.values()))
    }

    // Snippets — by id, incoming wins
    if (Array.isArray(data.snippets)) {
      const existing = store.get('snippets', [])
      const map = new Map(existing.map((x) => [x.id, x]))
      for (const x of data.snippets) {
        if (x && x.id) { map.set(x.id, x); summary.snippets++ }
      }
      store.set('snippets', Array.from(map.values()))
    }

    // SFTP favorites — per session key, union of paths
    if (data.sftpFavorites && typeof data.sftpFavorites === 'object' && !Array.isArray(data.sftpFavorites)) {
      const existing = store.get('sftp-favorites', {})
      for (const [key, paths] of Object.entries(data.sftpFavorites)) {
        if (!Array.isArray(paths)) continue
        const merged = new Set(Array.isArray(existing[key]) ? existing[key] : [])
        for (const p of paths) if (typeof p === 'string') merged.add(p)
        existing[key] = Array.from(merged)
        summary.sftpFavorites += paths.length
      }
      store.set('sftp-favorites', existing)
    }

    // Filter presets — by id, incoming wins, cap at 10
    if (Array.isArray(data.filterPresets)) {
      const existing = store.get('filter-presets', [])
      const map = new Map(existing.map((x) => [x.id, x]))
      for (const x of data.filterPresets) {
        if (x && x.id) { map.set(x.id, x); summary.filterPresets++ }
      }
      const merged = Array.from(map.values()).slice(0, 10)
      store.set('filter-presets', merged)
    }

    // Tunnel configs — per session id, by config id within array
    if (data.tunnelConfigs && typeof data.tunnelConfigs === 'object' && !Array.isArray(data.tunnelConfigs)) {
      const existing = store.get('tunnel-configs', {})
      for (const [sessionId, configs] of Object.entries(data.tunnelConfigs)) {
        if (!Array.isArray(configs)) continue
        const existingList = Array.isArray(existing[sessionId]) ? existing[sessionId] : []
        const map = new Map(existingList.map((c) => [c.id, c]))
        for (const c of configs) {
          if (c && c.id) { map.set(c.id, c); summary.tunnelConfigs++ }
        }
        existing[sessionId] = Array.from(map.values())
      }
      store.set('tunnel-configs', existing)
    }

    // App settings preferences — shallow merge, restricted to the same key
    // allowlist enforced by settings:set so a malformed backup can't persist
    // unknown or unexpected fields.
    if (data.settingsPrefs && typeof data.settingsPrefs === 'object' && !Array.isArray(data.settingsPrefs)) {
      const allowed = Object.keys(DEFAULT_SETTINGS || {})
      const sanitized = {}
      for (const key of allowed) {
        if (key in data.settingsPrefs) sanitized[key] = data.settingsPrefs[key]
      }
      const current = store.get('settings-prefs', {})
      const merged = { ...sanitizeSettings(current), ...sanitizeSettings(sanitized) }
      store.set('settings-prefs', merged)
      summary.settingsPrefs = Object.keys(sanitized).length
    }

    // Anthropic API key — re-encrypt with the destination machine's safeStorage
    if (typeof data.anthropicApiKey === 'string' && data.anthropicApiKey) {
      store.set('settings.anthropicApiKey', encryptField(data.anthropicApiKey))
      summary.anthropicApiKey = true
    }

    return { success: true, summary }
  })
}
