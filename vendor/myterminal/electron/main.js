// Desktop adapter: project-owned registrations; no second app window or AI provider.
const fs = require('fs')
const path = require('path')
const { createLocalPathAuthorizer, createOneTimeTokenAuthorizer } = require('./security-utils')
const registerSessionHandlers = require('./ipc/sessions')
const registerLoggingHandlers = require('./ipc/logging')
const registerTunnelHandlers = require('./ipc/tunnels')
const registerBackupHandlers = require('./ipc/backup')
module.exports = function registerServices({ ipcMain, dialog, Notification, safeStorage, clipboard, store, sshManager, tunnelManager, mainWindow }) {
const localPathAuthorizer = createLocalPathAuthorizer()
const dropPathTokens = createOneTimeTokenAuthorizer()

// ── IPC input validation ──────────────────────────────────────────────────────

function assertString(val, name) {
  if (typeof val !== 'string') throw new TypeError(`${name} must be a string, got ${typeof val}`)
}

function assertPlainObject(val, name) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) throw new TypeError(`${name} must be a plain object`)
}

// ── Credential encryption (safeStorage / OS keychain) ──────────────────────────
const SENSITIVE_FIELDS = ['password', 'passphrase', 'jumpPassword', 'jumpPassphrase']

function encryptField(value) {
  if (!value || typeof value !== 'string') return value
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS credential storage is unavailable')
  try { return Buffer.from(safeStorage.encryptString(value)).toString('base64') }
  catch { throw new Error('Unable to protect or unlock saved credentials') }
}

function decryptField(value) {
  if (!value || typeof value !== 'string') return value
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS credential storage is unavailable')
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
  catch { throw new Error('Unable to protect or unlock saved credentials') } // plaintext fallback (migration from old format)
}

function encryptSession(session) {
  if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.id) || typeof session.host !== 'string' || typeof session.username !== 'string') throw new Error('Invalid SSH connection')
  for (const port of ['port', 'jumpPort']) if (session[port] != null && (!Number.isInteger(session[port]) || session[port] < 1 || session[port] > 65535)) throw new Error('Invalid SSH port')
  const enc = { ...session }
  for (const field of SENSITIVE_FIELDS) if (enc[field]) enc[field] = encryptField(enc[field])
  return enc
}

function decryptSession(session) {
  const dec = { ...session }
  for (const field of SENSITIVE_FIELDS) if (dec[field]) dec[field] = decryptField(dec[field])
  return dec
}

function resolveSavedSessionConfig(config) {
  if (!config?.id) return config
  const saved = store.get('sessions', []).find((session) => session.id === config.id)
  if (!saved) return config
  const decrypted = decryptSession(saved)
  return {
    ...decrypted,
    keepaliveInterval: config.keepaliveInterval || decrypted.keepaliveInterval,
  }
}

function authorizeDialogPaths(result, options, kind) {
  if (!result || result.canceled) return
  const scope = options?.securityScope
  if (!scope || !String(scope).startsWith('sftp-')) return

  if (kind === 'saveFile' && result.filePath) {
    localPathAuthorizer.authorize(result.filePath, 'write')
    return
  }

  const paths = Array.isArray(result.filePaths) ? result.filePaths : []
  const properties = Array.isArray(options?.properties) ? options.properties : []
  const recursive = properties.includes('openDirectory')
  const access = scope.includes('download') ? 'write' : 'read'
  for (const filePath of paths) {
    localPathAuthorizer.authorize(filePath, access, { recursive })
  }
}

// ── SFTP IPC ───────────────────────────────────────────────────────────────────

ipcMain.handle('sftp:list', async (_event, channelId, remotePath) => {
  try { return await sshManager.sftpList(channelId, remotePath) }
  catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:download', async (_event, channelId, remotePath, localPath) => {
  try {
    assertString(channelId, 'channelId')
    assertString(remotePath, 'remotePath')
    assertString(localPath, 'localPath')
    localPathAuthorizer.assertAccess(localPath, 'write')
    return await sshManager.sftpDownload(channelId, remotePath, localPath)
  }
  catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:upload', async (_event, channelId, localPath, remotePath) => {
  try {
    assertString(channelId, 'channelId')
    assertString(localPath, 'localPath')
    assertString(remotePath, 'remotePath')
    localPathAuthorizer.assertAccess(localPath, 'read')
    return await sshManager.sftpUpload(channelId, localPath, remotePath)
  }
  catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:uploadDir', async (_event, channelId, localDir, remoteDir) => {
  try {
    assertString(channelId, 'channelId')
    assertString(localDir, 'localDir')
    assertString(remoteDir, 'remoteDir')
    localPathAuthorizer.assertAccess(localDir, 'read')
    return await sshManager.sftpUploadDir(channelId, localDir, remoteDir)
  }
  catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:downloadDir', async (_event, channelId, remoteDir, localDir) => {
  try {
    assertString(channelId, 'channelId')
    assertString(remoteDir, 'remoteDir')
    assertString(localDir, 'localDir')
    localPathAuthorizer.assertAccess(localDir, 'write')
    return await sshManager.sftpDownloadDir(channelId, remoteDir, localDir)
  }
  catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:rename', async (_event, channelId, oldPath, newPath) => {
  try { return await sshManager.sftpRename(channelId, oldPath, newPath) }
  catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:delete', async (_event, channelId, remotePath) => {
  try { return await sshManager.sftpDelete(channelId, remotePath) }
  catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:mkdir', async (_event, channelId, remotePath) => {
  try { return await sshManager.sftpMkdir(channelId, remotePath) }
  catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:realpath', async (_event, channelId, remotePath) => {
  try { return await sshManager.sftpRealpath(channelId, remotePath) }
  catch (err) { return { error: err.message } }
})

ipcMain.handle('sftp:readFile', async (_event, channelId, remotePath) => {
  try {
    assertString(channelId, 'channelId')
    assertString(remotePath, 'remotePath')
    return await sshManager.sftpReadFile(channelId, remotePath)
  } catch (err) { return { error: err.message } }
})
ipcMain.handle('sftp:writeFile', async (_event, channelId, remotePath, content) => {
  try {
    assertString(channelId, 'channelId')
    assertString(remotePath, 'remotePath')
    assertString(content, 'content')
    return await sshManager.sftpWriteFile(channelId, remotePath, content)
  } catch (err) { return { error: err.message } }
})

// ── File dialog ────────────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async (_event, options) => {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? { ...options }
    : {}
  delete safeOptions.securityScope
  const result = await dialog.showOpenDialog(mainWindow, safeOptions)
  authorizeDialogPaths(result, options, 'openFile')
  return result
})
ipcMain.handle('dialog:saveFile', async (_event, options) => {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? { ...options }
    : {}
  delete safeOptions.securityScope
  const result = await dialog.showSaveDialog(mainWindow, safeOptions)
  authorizeDialogPaths(result, options, 'saveFile')
  return result
})

ipcMain.on('fs:createDropAuthorizationToken', (event) => {
  event.returnValue = dropPathTokens.issue()
})

ipcMain.on('fs:authorizeDroppedPaths', (_event, payload) => {
  if (!dropPathTokens.consume(payload?.token)) return
  const paths = payload?.paths
  if (!Array.isArray(paths)) return
  for (const filePath of paths) {
    if (typeof filePath !== 'string' || !filePath) continue
    let recursive = false
    try { recursive = fs.statSync(filePath).isDirectory() } catch (_) {}
    localPathAuthorizer.authorize(filePath, 'read', { recursive })
  }
})

// ── Extracted IPC handler groups ──────────────────────────────────────────────

const getMainWindow = () => mainWindow

// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  defaultFontSize: 14,
  defaultScrollback: 10000,
  colorizeByDefault: true,
  osc52ClipboardEnabled: false,
  keepaliveInterval: 10000,
  loggingEnabled: false,
  logDirectory: '',
}
function sanitizeSettings(value) {
  const clean = {}
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const input = value?.[key]
    if (typeof input !== typeof fallback) continue
    if (key === 'defaultFontSize' && (!Number.isInteger(input) || input < 8 || input > 32)) continue
    if (key === 'defaultScrollback' && (!Number.isInteger(input) || input < 1000 || input > 100000)) continue
    if (key === 'keepaliveInterval' && (!Number.isInteger(input) || input < 1000 || input > 300000)) continue
    if (key === 'logDirectory' && (input.length > 4096 || input.includes('\0'))) continue
    clean[key] = input
  }
  return clean
}

registerSessionHandlers(store, { ipcMain, dialog, encryptSession, decryptSession, SENSITIVE_FIELDS, getMainWindow })
registerTunnelHandlers(store, { ipcMain, sshManager, tunnelManager, assertString, assertPlainObject })
const logging = registerLoggingHandlers({ ipcMain, dialog, getMainWindow })
registerBackupHandlers(store, { ipcMain, dialog, encryptSession, decryptSession, encryptField, decryptField, SENSITIVE_FIELDS, DEFAULT_SETTINGS, getMainWindow, sanitizeSettings })

ipcMain.handle('settings:get', () => {
  return { ...DEFAULT_SETTINGS, ...sanitizeSettings(store.get('settings-prefs', {})) }
})

ipcMain.handle('settings:set', (_event, newSettings) => {
  if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) {
    return { ...DEFAULT_SETTINGS, ...store.get('settings-prefs', {}) }
  }
  // Only allow known keys to be written
  const allowed = Object.keys(DEFAULT_SETTINGS)
  const sanitized = {}
  for (const key of allowed) {
    if (key in newSettings) sanitized[key] = newSettings[key]
  }
  const current = { ...DEFAULT_SETTINGS, ...store.get('settings-prefs', {}) }
  const merged = { ...DEFAULT_SETTINGS, ...sanitizeSettings(current), ...sanitizeSettings(sanitized) }
  store.set('settings-prefs', merged)
  return merged
})

// ── Workspace persistence ─────────────────────────────────────────────────────

ipcMain.handle('workspace:get', () => {
  return store.get('workspace', null)
})

ipcMain.handle('workspace:set', (_event, workspace) => {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    store.delete('workspace')
    return
  }
  store.set('workspace', workspace)
})

// ── WSL ────────────────────────────────────────────────────────────────────────

ipcMain.handle('wsl:getDistros', () => {
  if (process.platform !== 'win32') return []
  // Use async execFile with a timeout so a slow/misconfigured WSL never
  // blocks the main-process event loop.
  const { execFile } = require('child_process')
  return new Promise((resolve) => {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe'), ['--list', '--quiet'], { encoding: 'buffer', timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve([]); return }
      const distros = stdout
        .toString('utf16le')
        .split(/\r?\n/)
        .map((l) => l.replace(/\(Default\)/i, '').replace(/\x00/g, '').trim())
        .filter(Boolean)
      resolve(distros)
    })
  })
})

// ── SFTP Favorites ────────────────────────────────────────────────────────────

ipcMain.handle('favorites:get', (_event, sessionKey) => {
  const all = store.get('sftp-favorites', {})
  return all[sessionKey] || []
})

ipcMain.handle('favorites:set', (_event, sessionKey, paths) => {
  const all = store.get('sftp-favorites', {})
  all[sessionKey] = paths
  store.set('sftp-favorites', all)
})

// ── Snippets ───────────────────────────────────────────────────────────────────

ipcMain.handle('snippets:getAll', () => store.get('snippets', []))

ipcMain.handle('snippets:save', (_event, snippet) => {
  const snippets = store.get('snippets', [])
  const idx = snippets.findIndex((x) => x.id === snippet.id)
  if (idx >= 0) snippets[idx] = snippet
  else snippets.push(snippet)
  store.set('snippets', snippets)
  return snippets
})

ipcMain.handle('snippets:delete', (_event, id) => {
  const snippets = store.get('snippets', []).filter((x) => x.id !== id)
  store.set('snippets', snippets)
  return snippets
})

// ── Filter Presets ─────────────────────────────────────────────────────────────

ipcMain.handle('filterPresets:getAll', () => store.get('filter-presets', []))

ipcMain.handle('filterPresets:save', (_e, preset) => {
  const presets = store.get('filter-presets', [])
  if (presets.length >= 10) return presets
  presets.push(preset)
  store.set('filter-presets', presets)
  return presets
})

ipcMain.handle('filterPresets:delete', (_e, id) => {
  const presets = store.get('filter-presets', []).filter((x) => x.id !== id)
  store.set('filter-presets', presets)
  return presets
})

// ── Notifications ──────────────────────────────────────────────────────────────

ipcMain.handle('notify:send', (_event, title, body) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show()
  }
})

// ── File system helpers ───────────────────────────────────────────────────────

ipcMain.handle('fs:isDirectory', (_event, filePath) => {
  try {
    assertString(filePath, 'filePath')
    if (!localPathAuthorizer.canAccess(filePath, 'read')) return false
    return fs.statSync(filePath).isDirectory()
  }
  catch { return false }
})

// ── Clipboard ─────────────────────────────────────────────────────────────────

ipcMain.handle('clipboard:writeText', (_event, text) => {
  if (typeof text !== 'string') return
  clipboard.writeText(text)
})


return { resolveSavedSessionConfig, encryptSession, decryptSession, logging }
}
