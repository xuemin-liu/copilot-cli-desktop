// Desktop ownership adapter. Feature implementations remain in the pinned electron sources.
const { createHash, randomUUID } = require('node:crypto')
const path = require('node:path')
const { stripAnsi } = require('./src/utils/terminalUtils.js')
const registerServices = require('./electron/main')
const SshManager = require('./electron/ssh-manager').constructor
const TunnelManager = require('./electron/tunnel-manager').constructor

const METHODS = new Set([
  'wsl:getDistros', 'sessions:duplicate',
  'sessions:getAll', 'sessions:save', 'sessions:delete', 'sessions:import', 'sessions:export', 'sshconfig:import',
  'settings:get', 'settings:set', 'snippets:getAll', 'snippets:save', 'snippets:delete',
  'backup:import', 'backup:export', 'favorites:get', 'favorites:set',
  'filterPresets:getAll', 'filterPresets:save', 'filterPresets:delete',
  'logging:start', 'logging:stop', 'logging:status', 'logging:export',
  'sftp:list', 'sftp:download', 'sftp:upload', 'sftp:uploadDir', 'sftp:downloadDir',
  'sftp:rename', 'sftp:delete', 'sftp:mkdir', 'sftp:realpath', 'sftp:readFile', 'sftp:writeFile',
  'tunnel:start', 'tunnel:stop', 'tunnel:stopByChannel', 'tunnel:list', 'tunnelConfigs:get', 'tunnelConfigs:set',
  'dialog:openFile', 'dialog:saveFile', 'fs:isDirectory', 'clipboard:writeText', 'notify:send', 'ssh:ping',
])
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

module.exports = class MyTerminalServices {
  constructor(directory, owner, dependencies = {}) {
    const electron = dependencies.electron || require('electron')
    const Store = dependencies.Store || require('electron-store')
    this.store = new Store({ cwd: directory, name: 'myterminal', accessPropertiesByDotNotation: false })
    // The original tunnel registrar uses dotted per-connection keys; translate into the same backup object.
    const rawStore = this.store, service = this
    const store = {
      get(key, fallback) {
        if (key.startsWith('tunnel-configs.')) return rawStore.get('tunnel-configs', {})[key.slice(15)] || fallback
        return rawStore.get(key, fallback)
      },
      set(key, value) {
        if (service.disposed) throw new Error('Terminal project closed')
        if (key.startsWith('tunnel-configs.')) { const all = rawStore.get('tunnel-configs', {}); all[key.slice(15)] = value; rawStore.set('tunnel-configs', all) }
        else rawStore.set(key, value)
      },
      delete: key => rawStore.delete(key),
    }
    this.ssh = new SshManager()
    this.tunnels = new TunnelManager()
    this.handlers = new Map()
    this.outputs = new Map()
    this.temporary = new Map()
    this.pendingTunnels = new Set()
    this.disposed = false
    this.owner = owner
    this.electron = electron
    const registry = { handle: (key, fn) => this.handlers.set(key, fn), on: (key, fn) => this.handlers.set(key, fn) }
    this.services = registerServices({ ...electron, ipcMain: registry, store, sshManager: this.ssh, tunnelManager: this.tunnels, mainWindow: owner() })
    this.ssh._emit = (event, id, data) => {
      const output = this.outputs.get(id)
      if (event === 'ssh:data') output?.data(data)
      if (event === 'ssh:close' || event === 'ssh:error') {
        this.tunnels.stopByChannel(id)
        this.services.logging.stop(id)
        output?.exit(event === 'ssh:error' ? 1 : 0)
      }
    }
  }
  async invoke(method, args = [], owns = () => false) {
    if (this.disposed) throw new Error('Terminal project closed')
    if (!METHODS.has(method) || !Array.isArray(args) || args.length > 8) throw new Error('Unsupported MyTerminal operation')
    if (/^(sftp:|logging:(start|stop|status)|tunnel:(start|stopByChannel)|ssh:ping)/.test(method) && (!validId(args[0]) || !owns(args[0]))) throw new Error('Terminal does not belong to this project')
    if (method.startsWith('tunnelConfigs:') && !validId(args[0])) throw new Error('Invalid connection ID')
    if (method === 'tunnel:stop') {
      const tunnel = this.tunnels.tunnels.get(args[0])
      if (tunnel && !owns(tunnel.channelId)) throw new Error('Tunnel does not belong to this terminal')
    }
    if (method === 'sessions:duplicate') {
      const saved = this.services.resolveSavedSessionConfig({ id: args[0] })
      if (!saved?.host) throw new Error('SSH connection no longer exists')
      if (typeof args[1] !== 'string' || !args[1].trim() || args[1].length > 256) throw new Error('Invalid connection name')
      return this.handlers.get('sessions:save')({}, { ...saved, id: randomUUID(), name: args[1] })
    }
    if (method === 'sessions:save') {
      const config = args[0]
      if (!config || !validId(config.id) || typeof config.host !== 'string' || !config.host.trim() || typeof config.username !== 'string') throw new Error('Invalid SSH connection')
    }
    if (method === 'snippets:save' && (!args[0] || !validId(args[0].id) || typeof args[0].command !== 'string')) throw new Error('Invalid snippet')
    if (method === 'ssh:ping') return this.ssh.ping(args[0])
    if (method === 'logging:start' && !args[1]) args[1] = path.join(this.store.path ? path.dirname(this.store.path) : '.', 'logs')
    const handler = this.handlers.get(method)
    if (!handler) throw new Error('Unsupported MyTerminal operation')
    if (method === 'tunnel:start') {
      const [channel, id] = args, connection = this.ssh.connections.get(channel)
      if (!validId(id) || this.pendingTunnels.has(id) || this.tunnels.tunnels.has(id)) return { error: 'Tunnel is already running or starting' }
      this.pendingTunnels.add(id)
      try {
        const result = await handler({}, ...args)
        if (this.disposed || !owns(channel) || this.ssh.connections.get(channel) !== connection) {
          this.tunnels.stop(id); return { error: 'Terminal closed while starting tunnel' }
        }
        return result
      } finally { this.pendingTunnels.delete(id) }
    }
    return await handler({}, ...args)
  }
  authorizeDrop(paths) {
    const event = {}
    this.handlers.get('fs:createDropAuthorizationToken')(event)
    this.handlers.get('fs:authorizeDroppedPaths')({}, { token: event.returnValue, paths })
  }
  verifier(host, port, signal) {
    return (key, accept) => {
      const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
      const id = `${host}:${port || 22}`
      const known = this.store.get('known-hosts', {})
      if (signal.aborted || this.disposed) { accept(false); return }
      if (known[id] === fingerprint) { accept(true); return }
      const options = { type: 'warning', title: known[id] ? 'SSH host key changed' : 'Trust SSH host?',
        message: `${id}\n${fingerprint}`, detail: known[id] ? `Previous fingerprint: ${known[id]}\nVerify this change with the server administrator before trusting it.` : 'Verify this fingerprint with the server administrator.',
        buttons: ['Cancel', 'Trust host'], defaultId: 0, cancelId: 0, noLink: true }
      const win = this.owner()
      Promise.resolve(win ? this.electron.dialog.showMessageBox(win, options) : this.electron.dialog.showMessageBox(options)).then(result => {
        if (signal.aborted || this.disposed || result.response !== 1) { accept(false); return }
        const updated = this.store.get('known-hosts', {}); updated[id] = fingerprint; this.store.set('known-hosts', updated); accept(true)
      }, () => accept(false))
    }
  }
  createTemporary(config) {
    if (this.disposed) throw new Error('Terminal project closed')
    const existing = this.services.resolveSavedSessionConfig({ id: config?.id })
    const id = randomUUID()
    const encrypted = this.services.encryptSession({ ...existing, ...config, id })
    this.temporary.set(id, encrypted)
    return { transport: 'managed', connectionId: id, host: encrypted.host, temporary: true }
  }
  connectionMetadata(id) {
    const config = this.temporary.get(id) || this.services.resolveSavedSessionConfig({ id })
    if (!config?.host) return {}
    // Only display metadata crosses the bridge; credentials stay in MyTerminal's store.
    return { host: config.host, port: config.port || 22, username: config.username, name: config.name }
  }
  forgetTemporary(id) { this.temporary.delete(id) }
  saveTemporary(id) {
    const config = this.temporary.get(id)
    if (!config || this.disposed) throw new Error('Temporary connection no longer exists')
    this.handlers.get('sessions:save')({}, this.services.decryptSession(config))
    this.temporary.delete(id)
  }
  async spawn(id, connectionId, signal) {
    const config = this.temporary.has(connectionId) ? this.services.decryptSession(this.temporary.get(connectionId)) : this.services.resolveSavedSessionConfig({ id: connectionId })
    if (!config?.host || !config.username) throw new Error('Saved SSH connection is missing; open SSH connections to edit it')
    let dataListener, exitListener, ended, buffer = ''
    const data = value => { if (dataListener) dataListener(value); else buffer = (buffer + value).slice(-524288) }
    const exit = code => { ended = code; exitListener?.({ exitCode: code }) }
    this.outputs.set(id, { data, exit })
    const cleanup = () => { this.outputs.delete(id); this.ssh.disconnect(id); this.tunnels.stopByChannel(id); this.services.logging.stop(id) }
    try {
      await this.ssh.connect(id, { ...config, signal,
        keepaliveInterval: this.store.get('settings-prefs', {}).keepaliveInterval || 10000,
        hostVerifier: this.verifier(config.host, config.port, signal), jumpHostVerifier: this.verifier(config.jumpHost, config.jumpPort, signal) })
    } catch (error) { cleanup(); throw error }
    return { pid: undefined, onData(fn) { dataListener = fn; if (buffer) { fn(buffer); buffer = '' } },
      onExit(fn) { exitListener = fn; if (ended !== undefined) fn({ exitCode: ended }) },
      write: value => this.ssh.write(id, value), resize: (cols, rows) => this.ssh.resize(id, cols, rows), kill: cleanup, dispose: cleanup }
  }
  started(id) {
    const settings = this.store.get('settings-prefs', {})
    if (settings.loggingEnabled) return this.invoke('logging:start', [id, settings.logDirectory || ''], () => true)
  }
  output(id, data) { this.services.logging.write(id, stripAnsi(data)) }
  closed(id) { this.services.logging.stop(id); this.tunnels.stopByChannel(id) }
  async dispose() {
    this.disposed = true
    for (const id of this.ssh.pending.keys()) this.ssh.disconnect(id)
    this.ssh.disconnectAll(); this.tunnels.stopAll(); this.outputs.clear(); this.temporary.clear()
    await this.services.logging.dispose()
  }
}
