const { ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

function makeSessionRedactor(decryptSession, SENSITIVE_FIELDS) {
  return (session) => {
    const clean = decryptSession(session)
    for (const field of SENSITIVE_FIELDS) {
      clean[`has${field[0].toUpperCase()}${field.slice(1)}`] = !!clean[field]
      delete clean[field]
    }
    return clean
  }
}

function mergeExistingSensitiveFields(session, existingEncrypted, decryptSession, SENSITIVE_FIELDS) {
  if (!existingEncrypted) return session
  const existing = decryptSession(existingEncrypted)
  const merged = { ...session }
  for (const field of SENSITIVE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(merged, field) && existing[field]) {
      merged[field] = existing[field]
    }
  }
  return merged
}

function registerSessionHandlers(store, { encryptSession, decryptSession, SENSITIVE_FIELDS, getMainWindow }) {
  const redactSession = makeSessionRedactor(decryptSession, SENSITIVE_FIELDS)
  const redactSessions = (sessions) => sessions.map(redactSession)

  ipcMain.handle('sessions:getAll', () => redactSessions(store.get('sessions', [])))

  ipcMain.handle('sessions:save', (_event, session) => {
    const sessions = store.get('sessions', [])
    const idx = sessions.findIndex((x) => x.id === session.id)
    const merged = mergeExistingSensitiveFields(session, idx >= 0 ? sessions[idx] : null, decryptSession, SENSITIVE_FIELDS)
    const encrypted = encryptSession(merged)
    if (idx >= 0) sessions[idx] = encrypted
    else sessions.push(encrypted)
    store.set('sessions', sessions)
    return redactSessions(sessions)
  })

  ipcMain.handle('sessions:delete', (_event, id) => {
    const sessions = store.get('sessions', []).filter((x) => x.id !== id)
    store.set('sessions', sessions)
    return redactSessions(sessions)
  })

  ipcMain.handle('sessions:export', async (_event, _sessions) => {
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export Sessions',
      defaultPath: 'myterminal-sessions.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled) return { canceled: true }
    const exportable = store.get('sessions', []).map((s) => {
      const clean = decryptSession(s)
      for (const field of SENSITIVE_FIELDS) delete clean[field]
      return clean
    })
    fs.writeFileSync(result.filePath, JSON.stringify(exportable, null, 2), 'utf8')
    return { success: true }
  })

  ipcMain.handle('sessions:import', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Import Sessions',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled) return { canceled: true }
    try {
      const raw = fs.readFileSync(result.filePaths[0], 'utf8')
      const imported = JSON.parse(raw)
      if (!Array.isArray(imported)) return { error: 'Invalid file format' }
      const existing = store.get('sessions', [])
      const map = new Map(existing.map((s) => [s.id, s]))
      for (const s of imported) {
        if (s.id && s.host && s.username) map.set(s.id, encryptSession(s))
      }
      const merged = Array.from(map.values())
      store.set('sessions', merged)
      return redactSessions(merged)
    } catch (e) {
      return { error: e.message }
    }
  })

  // ── SSH Config Import ─────────────────────────────────────────────────────────

  ipcMain.handle('sshconfig:import', async () => {
    try {
      const os = require('os')
      const configPath = path.join(os.homedir(), '.ssh', 'config')
      if (!fs.existsSync(configPath)) return { error: 'No ~/.ssh/config found' }
      const raw = fs.readFileSync(configPath, 'utf8')
      const lines = raw.split(/\r?\n/)
      const hosts = []
      let current = null

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const match = trimmed.match(/^(\S+)\s+(.+)$/)
        if (!match) continue
        const [, key, value] = match
        const keyLower = key.toLowerCase()

        if (keyLower === 'host') {
          if (value.includes('*') || value.includes('?')) { current = null; continue }
          current = { host: value, hostname: '', user: '', port: 22, identityFile: '', proxyJump: '' }
          hosts.push(current)
        } else if (current) {
          if (keyLower === 'hostname') current.hostname = value
          else if (keyLower === 'user') current.user = value
          else if (keyLower === 'port') current.port = parseInt(value, 10) || 22
          else if (keyLower === 'identityfile') {
            current.identityFile = value.replace(/^~/, os.homedir())
          }
          else if (keyLower === 'proxyjump') current.proxyJump = value
        }
      }

      const sessions = store.get('sessions', [])
      const existingHosts = new Set(sessions.map((s) => `${s.host}:${s.port || 22}:${s.username}`))
      let imported = 0

      for (const h of hosts) {
        const hostname = h.hostname || h.host
        const user = h.user || 'root'
        const key = `${hostname}:${h.port}:${user}`
        if (existingHosts.has(key)) continue

        const session = {
          id: require('crypto').randomUUID(),
          name: h.host,
          host: hostname,
          port: h.port,
          username: user,
          authType: h.identityFile ? 'key' : 'password',
          keyPath: h.identityFile || '',
          password: '',
          passphrase: '',
          group: 'SSH Config',
        }

        if (h.proxyJump) {
          session.jumpHost = h.proxyJump
          session.jumpPort = 22
          session.jumpUsername = ''
          session.jumpAuthType = 'password'
        }

        sessions.push(encryptSession(session))
        existingHosts.add(key)
        imported++
      }

      store.set('sessions', sessions)
      return { imported, total: hosts.length }
    } catch (e) {
      return { error: e.message }
    }
  })
}

module.exports = registerSessionHandlers
module.exports.makeSessionRedactor = makeSessionRedactor
module.exports.mergeExistingSensitiveFields = mergeExistingSensitiveFields
