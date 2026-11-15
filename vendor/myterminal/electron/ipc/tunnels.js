const electron = require('electron')
const { normalizeRemoteBindAddress } = require('../security-utils')

function normalizePort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RangeError(`${name} must be an integer from 1 to 65535`)
  }
  return value
}

function normalizeHost(value, fallback, name) {
  const host = value || fallback
  if (typeof host !== 'string' || !host.trim() || /[\r\n\0]/.test(host)) {
    throw new TypeError(`${name} must be a host string`)
  }
  return host.trim()
}

function normalizeTunnelConfig(config) {
  const normalized = { ...config }
  if (normalized.type === 'local') {
    normalized.localPort = normalizePort(normalized.localPort, 'localPort')
    normalized.remotePort = normalizePort(normalized.remotePort, 'remotePort')
    normalized.remoteHost = normalizeHost(normalized.remoteHost, 'localhost', 'remoteHost')
  } else if (normalized.type === 'remote') {
    normalized.localPort = normalizePort(normalized.localPort, 'localPort')
    normalized.remotePort = normalizePort(normalized.remotePort, 'remotePort')
    normalized.localHost = normalizeHost(normalized.localHost, '127.0.0.1', 'localHost')
    normalized.remoteBindAddress = normalizeRemoteBindAddress(normalized.remoteBindAddress)
  } else if (normalized.type === 'dynamic') {
    normalized.localPort = normalizePort(normalized.localPort, 'localPort')
  }
  return normalized
}

module.exports = function registerTunnelHandlers(store, { ipcMain = electron.ipcMain, sshManager, tunnelManager, assertString, assertPlainObject }) {
  ipcMain.handle('tunnel:start', async (_event, channelId, tunnelId, tunnelConfig) => {
    try {
      assertString(channelId, 'channelId')
      assertString(tunnelId, 'tunnelId')
      assertPlainObject(tunnelConfig, 'tunnelConfig')
      assertString(tunnelConfig.type, 'tunnelConfig.type')
      if (!['local', 'remote', 'dynamic'].includes(tunnelConfig.type)) {
        return { error: 'Unknown tunnel type' }
      }
      const safeTunnelConfig = normalizeTunnelConfig(tunnelConfig)
      const conn = sshManager.connections.get(channelId)
      if (!conn) return { error: 'No SSH connection' }
      const client = conn.client

      if (safeTunnelConfig.type === 'local') {
        return await tunnelManager.startLocal(tunnelId, channelId, client, safeTunnelConfig)
      } else if (safeTunnelConfig.type === 'remote') {
        return await tunnelManager.startRemote(tunnelId, channelId, client, safeTunnelConfig)
      } else if (safeTunnelConfig.type === 'dynamic') {
        return await tunnelManager.startDynamic(tunnelId, channelId, client, safeTunnelConfig)
      }
      return { error: 'Unknown tunnel type' }
    } catch (err) { return { error: err.message } }
  })

  ipcMain.handle('tunnel:stop', (_event, tunnelId) => {
    tunnelManager.stop(tunnelId)
    return { success: true }
  })

  ipcMain.handle('tunnel:stopByChannel', (_event, channelId) => {
    return tunnelManager.stopByChannel(channelId)
  })

  ipcMain.handle('tunnel:list', () => tunnelManager.list())

  ipcMain.handle('tunnelConfigs:get', (_event, sessionId) => {
    return store.get(`tunnel-configs.${sessionId}`, [])
  })

  ipcMain.handle('tunnelConfigs:set', (_event, sessionId, configs) => {
    store.set(`tunnel-configs.${sessionId}`, configs)
  })
}
