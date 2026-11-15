const { Client } = require('ssh2')
const fs = require('fs')
const { resolveContainedChild } = require('./security-utils')

class SshManager {
  constructor() {
    this.connections = new Map()
    this.pending = new Map()
    this.mainWindow = null
  }

  setWindow(win) {
    this.mainWindow = win
  }

  _emit(event, channelId, ...args) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(event, channelId, ...args)
    }
  }

  async connect(channelId, config) {
    this.disconnect(channelId)
    const abort = new AbortController()
    this.pending.set(channelId, abort)
    const cancel = () => abort.abort()
    config.signal?.addEventListener('abort', cancel, { once: true })
    if (config.signal?.aborted) cancel()
    const scoped = { ...config, signal: abort.signal }
    let onAbort
    try {
      const canceled = new Promise((_, reject) => {
        onAbort = () => reject(new Error('SSH connection canceled'))
        abort.signal.addEventListener('abort', onAbort, { once: true })
        if (abort.signal.aborted) onAbort()
      })
      return await Promise.race([canceled, config.jumpHost?.trim() ? this._connectViaJump(channelId, scoped) : this._connectDirect(channelId, scoped)])
    } catch (error) { abort.abort(); throw error }
    finally {
      abort.signal.removeEventListener('abort', onAbort)
      config.signal?.removeEventListener('abort', cancel)
      if (this.pending.get(channelId) === abort) this.pending.delete(channelId)
    }
  }

  _watchClient(client, config) {
    const cancel = () => client.destroy()
    config.signal?.addEventListener('abort', cancel, { once: true })
    client.once('close', () => config.signal?.removeEventListener('abort', cancel))
    if (config.signal?.aborted) { cancel(); throw new Error('SSH connection canceled') }
  }

  // Async so key files are read without blocking the main process
  async _buildConnConfig(config) {
    const connConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      keepaliveInterval: config.keepaliveInterval || 10000,
      keepaliveCountMax: 3,
      hostVerifier: config.hostVerifier,
    }
    if (config.authType === 'key' && config.keyPath) {
      connConfig.privateKey = await fs.promises.readFile(config.keyPath)
      if (config.passphrase) connConfig.passphrase = config.passphrase
    } else {
      connConfig.password = config.password || ''
    }
    return connConfig
  }

  _openShell(channelId, client, jumpClient, config) {
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', rows: 24, cols: 80 }, (err, stream) => {
        if (err || config?.signal?.aborted) {
          client.end()
          if (jumpClient) jumpClient.end()
          reject(err || new Error('SSH connection canceled'))
          return
        }

        this.connections.set(channelId, { client, jumpClient: jumpClient || null, stream, sftp: null })

        stream.on('data', (data) => {
          if (this.connections.get(channelId)?.client === client) this._emit('ssh:data', channelId, data.toString('utf8'))
        })
        stream.stderr.on('data', (data) => {
          if (this.connections.get(channelId)?.client === client) this._emit('ssh:data', channelId, data.toString('utf8'))
        })
        stream.on('close', () => {
          const current = this.connections.get(channelId)?.client === client
          if (current) this.connections.delete(channelId)
          try { client.end() } catch (_) {}
          if (jumpClient) try { jumpClient.end() } catch (_) {}
          if (current) this._emit('ssh:close', channelId)
        })

        resolve({ channelId })
      })
    })
  }

  // Removed client.on('end') — stream.on('close') already emits ssh:close,
  // having both caused a double-emit that inflated reconnect attempt counts.
  async _connectDirect(channelId, config) {
    const connConfig = await this._buildConnConfig(config)
    return new Promise((resolve, reject) => {
      const client = new Client()
      this._watchClient(client, config)

      client.on('ready', () => {
        this._openShell(channelId, client, null, config).then(resolve).catch(reject)
      })
      client.on('error', (err) => {
        const current = this.connections.get(channelId)?.client === client || this.pending.get(channelId)?.signal === config.signal
        if (this.connections.get(channelId)?.client === client) this.connections.delete(channelId)
        if (current) this._emit('ssh:error', channelId, err.message)
        reject(err)
      })

      try { client.connect(connConfig) } catch (e) { reject(e) }
    })
  }

  async _connectViaJump(channelId, config) {
    // Read all key files async up-front before touching any sockets
    const jumpConfig = {
      host: config.jumpHost.trim(),
      port: parseInt(config.jumpPort, 10) || 22,
      username: config.jumpUsername || '',
      keepaliveInterval: config.keepaliveInterval || 10000,
      keepaliveCountMax: 3,
      hostVerifier: config.jumpHostVerifier,
    }
    if (config.jumpAuthType === 'key' && config.jumpKeyPath) {
      jumpConfig.privateKey = await fs.promises.readFile(config.jumpKeyPath)
      if (config.jumpPassphrase) jumpConfig.passphrase = config.jumpPassphrase
    } else {
      jumpConfig.password = config.jumpPassword || ''
    }

    const innerConfig = { username: config.username, hostVerifier: config.hostVerifier, keepaliveInterval: config.keepaliveInterval || 10000, keepaliveCountMax: 3 }
    if (config.authType === 'key' && config.keyPath) {
      innerConfig.privateKey = await fs.promises.readFile(config.keyPath)
      if (config.passphrase) innerConfig.passphrase = config.passphrase
    } else {
      innerConfig.password = config.password || ''
    }

    return new Promise((resolve, reject) => {
      const jumpClient = new Client()
      this._watchClient(jumpClient, config)

      jumpClient.on('ready', () => {
        jumpClient.forwardOut('127.0.0.1', 0, config.host, config.port || 22, (err, stream) => {
          if (err) { jumpClient.end(); reject(err); return }
          if (config.signal?.aborted) { stream.destroy(); jumpClient.destroy(); reject(new Error('SSH connection canceled')); return }

          const client = new Client()
          this._watchClient(client, config)
          client.on('ready', () => {
            this._openShell(channelId, client, jumpClient, config).then(resolve).catch(reject)
          })
          client.on('error', (err) => {
            const current = this.connections.get(channelId)?.client === client || this.pending.get(channelId)?.signal === config.signal
            if (this.connections.get(channelId)?.client === client) this.connections.delete(channelId)
            try { jumpClient.end() } catch (_) {}
            if (current) this._emit('ssh:error', channelId, err.message)
            reject(err)
          })

          try { client.connect({ sock: stream, ...innerConfig }) } catch (e) { jumpClient.end(); reject(e) }
        })
      })

      jumpClient.on('error', (err) => {
        if (this.pending.get(channelId)?.signal === config.signal || this.connections.get(channelId)?.jumpClient === jumpClient) this._emit('ssh:error', channelId, `Jump host error: ${err.message}`)
        reject(err)
      })

      try { jumpClient.connect(jumpConfig) } catch (e) { reject(e) }
    })
  }

  write(channelId, data) {
    const conn = this.connections.get(channelId)
    if (conn && conn.stream) conn.stream.write(data)
  }

  resize(channelId, cols, rows) {
    const conn = this.connections.get(channelId)
    if (conn && conn.stream) conn.stream.setWindow(rows, cols, 0, 0)
  }

  disconnect(channelId) {
    this.pending.get(channelId)?.abort()
    const conn = this.connections.get(channelId)
    if (conn) {
      try { if (conn.sftp) conn.sftp.end() } catch (_) {}
      try { conn.stream.close() } catch (_) {}
      try { conn.client.end() } catch (_) {}
      try { conn.jumpClient?.end() } catch (_) {}
      this.connections.delete(channelId)
    }
  }

  // ── SFTP ─────────────────────────────────────────────────────────────────────

  _getSftp(channelId) {
    return new Promise((resolve, reject) => {
      const conn = this.connections.get(channelId)
      if (!conn) return reject(new Error('No connection for channelId: ' + channelId))
      if (conn.sftp) return resolve(conn.sftp)
      conn.client.sftp((err, sftp) => {
        if (err) return reject(err)
        if (this.connections.get(channelId) !== conn) { sftp.end(); return reject(new Error('SSH connection closed')) }
        conn.sftp = sftp
        resolve(sftp)
      })
    })
  }

  async sftpList(channelId, remotePath) {
    const sftp = await this._getSftp(channelId)
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err)
        const items = list.map((item) => ({
          name: item.filename,
          longname: item.longname,
          type: item.attrs.isDirectory() ? 'd' : 'f',
          size: item.attrs.size,
          mtime: item.attrs.mtime,
          permissions: item.attrs.mode,
        }))
        items.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'd' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        resolve(items)
      })
    })
  }

  async sftpDownload(channelId, remotePath, localPath) {
    const sftp = await this._getSftp(channelId)
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, {}, (err) => {
        if (err) return reject(err)
        resolve({ success: true })
      })
    })
  }

  async sftpUpload(channelId, localPath, remotePath) {
    const sftp = await this._getSftp(channelId)
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {}, (err) => {
        if (err) return reject(err)
        resolve({ success: true })
      })
    })
  }

  async sftpUploadDir(channelId, localDir, remoteDir) {
    const sftp = await this._getSftp(channelId)
    // Create remote directory (ignore "already exists" errors)
    await new Promise((resolve) => {
      sftp.mkdir(remoteDir, () => resolve())
    })
    const entries = fs.readdirSync(localDir, { withFileTypes: true })
    for (const entry of entries) {
      const localChild = require('path').join(localDir, entry.name)
      const remoteChild = remoteDir + '/' + entry.name
      if (entry.isDirectory()) {
        await this.sftpUploadDir(channelId, localChild, remoteChild)
      } else {
        await this.sftpUpload(channelId, localChild, remoteChild)
      }
    }
    return { success: true }
  }

  async sftpDownloadDir(channelId, remoteDir, localDir) {
    fs.mkdirSync(localDir, { recursive: true })
    const entries = await this.sftpList(channelId, remoteDir)
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue
      const remoteChild = remoteDir.endsWith('/') ? remoteDir + entry.name : remoteDir + '/' + entry.name
      const localChild = resolveContainedChild(localDir, entry.name)
      if (entry.type === 'd') {
        await this.sftpDownloadDir(channelId, remoteChild, localChild)
      } else {
        await this.sftpDownload(channelId, remoteChild, localChild)
      }
    }
    return { success: true }
  }

  async sftpRename(channelId, oldPath, newPath) {
    const sftp = await this._getSftp(channelId)
    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) return reject(err)
        resolve({ success: true })
      })
    })
  }

  _sftpDeleteRecursive(sftp, remotePath) {
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          // Not a directory — try unlink as file
          sftp.unlink(remotePath, (err2) => {
            if (err2) reject(new Error(`Cannot delete "${remotePath}": ${err2.message}`))
            else resolve()
          })
          return
        }
        // Directory — delete all children then rmdir
        const children = list || []
        const next = (i) => {
          if (i >= children.length) {
            sftp.rmdir(remotePath, (e) => { if (e) reject(e); else resolve() })
            return
          }
          const child = remotePath.replace(/\/$/, '') + '/' + children[i].filename
          this._sftpDeleteRecursive(sftp, child).then(() => next(i + 1)).catch(reject)
        }
        next(0)
      })
    })
  }

  async sftpDelete(channelId, remotePath) {
    const sftp = await this._getSftp(channelId)
    await this._sftpDeleteRecursive(sftp, remotePath)
    return { success: true }
  }

  async sftpMkdir(channelId, remotePath) {
    const sftp = await this._getSftp(channelId)
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) return reject(err)
        resolve({ success: true })
      })
    })
  }

  async sftpRealpath(channelId, remotePath) {
    const sftp = await this._getSftp(channelId)
    return new Promise((resolve, reject) => {
      sftp.realpath(remotePath, (err, resolvedPath) => {
        if (err) return reject(err)
        resolve(resolvedPath)
      })
    })
  }

  async sftpReadFile(channelId, remotePath, maxBytes = 2 * 1024 * 1024) {
    const sftp = await this._getSftp(channelId)
    // Pre-check file size via stat
    const stats = await new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, s) => err ? reject(err) : resolve(s))
    })
    if (stats.size > maxBytes) {
      throw new Error(`File too large to edit (${(stats.size / 1024 / 1024).toFixed(1)} MB, limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB)`)
    }
    return new Promise((resolve, reject) => {
      const chunks = []
      let totalBytes = 0
      const stream = sftp.createReadStream(remotePath)
      stream.on('data', (chunk) => {
        totalBytes += chunk.length
        if (totalBytes > maxBytes) { stream.destroy(); reject(new Error('File too large')); return }
        // Binary detection: check for null bytes in first chunk
        if (chunks.length === 0 && chunk.includes && Buffer.isBuffer(chunk) && chunk.includes(0)) {
          stream.destroy()
          reject(new Error('File appears to be binary and cannot be edited as text'))
          return
        }
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      })
      stream.on('end', () => resolve(chunks.join('')))
      stream.on('error', reject)
    })
  }

  async sftpWriteFile(channelId, remotePath, content) {
    const sftp = await this._getSftp(channelId)
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath, { encoding: 'utf8' })
      stream.on('close', () => resolve({ success: true }))
      stream.on('error', reject)
      stream.end(content)
    })
  }

  ping(channelId) {
    return new Promise((resolve) => {
      const conn = this.connections.get(channelId)
      if (!conn || !conn.client) { resolve(-1); return }
      const start = Date.now()
      conn.client.exec('echo pong', (err, stream) => {
        if (err) { resolve(-1); return }
        stream.on('close', () => resolve(Date.now() - start))
        stream.on('data', () => {})
        stream.stderr.on('data', () => {})
      })
    })
  }

  disconnectAll() {
    for (const [channelId] of this.connections) {
      this.disconnect(channelId)
    }
  }
}

module.exports = new SshManager()
