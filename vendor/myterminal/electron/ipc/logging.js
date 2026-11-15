const electron = require('electron')
const path = require('path')
const fs = require('fs')

module.exports = function registerLoggingHandlers({ ipcMain = electron.ipcMain, dialog = electron.dialog, getMainWindow }) {
  const logStreams = new Map()
  const errors = new Map()

  ipcMain.handle('logging:start', (_event, channelId, logDir) => {
    if (typeof channelId !== 'string') return { error: 'Invalid channelId' }
    if (logDir != null && typeof logDir !== 'string') return { error: 'Invalid logDir' }
    if (logStreams.has(channelId)) return { success: true, filePath: logStreams.get(channelId).filePath }
    const os = require('os')
    const dir = logDir || path.join(os.homedir(), 'MyTerminal-logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = path.join(dir, `session-${timestamp}-${channelId.slice(0, 8)}.log`)
    const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
    stream.on('error', (error) => { errors.set(channelId, error.message); logStreams.delete(channelId) })
    errors.delete(channelId)
    logStreams.set(channelId, { stream, filePath })
    return { success: true, filePath }
  })

  const write = (channelId, data) => {
    if (typeof channelId !== 'string' || typeof data !== 'string') return
    const entry = logStreams.get(channelId)
    if (entry) entry.stream.write(data)
  }
  ipcMain.on('logging:write', (_event, channelId, data) => write(channelId, data))

  const stop = (channelId) => {
    const entry = logStreams.get(channelId)
    if (entry) { entry.stream.end(); logStreams.delete(channelId) }
    return { success: true }
  }
  ipcMain.handle('logging:stop', (_event, channelId) => stop(channelId))
  ipcMain.handle('logging:status', (_event, channelId) => ({ logging: logStreams.has(channelId), error: errors.get(channelId) }))

  ipcMain.handle('logging:export', async (_event, content) => {
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export Terminal Output',
      defaultPath: `terminal-output-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
    })
    if (result.canceled) return { canceled: true }
    fs.writeFileSync(result.filePath, content, 'utf8')
    return { success: true }
  })
  return { write, stop, dispose: () => { for (const id of logStreams.keys()) stop(id) } }
}
