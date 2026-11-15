const net = require('net')

class TunnelManager {
  constructor() {
    this.tunnels = new Map() // key: tunnelId → { server, type, config, connections, channelId }
    this.mainWindow = null
  }

  setWindow(win) {
    this.mainWindow = win
  }

  _emit(event, ...args) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(event, ...args)
    }
  }

  startLocal(tunnelId, channelId, sshClient, config) {
    // config: { localPort, remoteHost, remotePort }
    return new Promise((resolve, reject) => {
      const connections = new Set()
      const server = net.createServer((socket) => {
        connections.add(socket)
        socket.on('error', () => socket.destroy())
        socket.on('close', () => connections.delete(socket))
        sshClient.forwardOut('127.0.0.1', config.localPort, config.remoteHost, config.remotePort, (err, stream) => {
          if (err) { socket.end(); return }
          if (socket.destroyed) { stream.destroy(); return }
          stream.on('error', () => socket.destroy())
          socket.pipe(stream).pipe(socket)
          stream.on('close', () => socket.end())
          socket.on('close', () => stream.end())
        })
      })

      server.on('error', (err) => reject(err))

      server.listen(config.localPort, '127.0.0.1', () => {
        this.tunnels.set(tunnelId, { server, type: 'local', config, connections, channelId })
        resolve({ tunnelId, localPort: config.localPort })
      })
    })
  }

  startRemote(tunnelId, channelId, sshClient, config) {
    // config: { remotePort, localHost, localPort }
    return new Promise((resolve, reject) => {
      const remoteBindAddress = config.remoteBindAddress || '127.0.0.1'
      sshClient.forwardIn(remoteBindAddress, config.remotePort, (err) => {
        if (err) { reject(err); return }

        const connections = new Set()
        const onTcpConnection = (details, accept) => {
          if (details.destPort !== config.remotePort || details.destIP !== remoteBindAddress) return
          const stream = accept()
          const socket = net.connect(config.localPort, config.localHost || '127.0.0.1')
          connections.add(socket)
          socket.on('error', () => { socket.destroy(); stream.destroy() })
          stream.on('error', () => socket.destroy())
          socket.on('close', () => connections.delete(socket))
          socket.pipe(stream).pipe(socket)
          stream.on('close', () => socket.end())
          socket.on('close', () => stream.end())
        }

        sshClient.on('tcp connection', onTcpConnection)
        this.tunnels.set(tunnelId, {
          type: 'remote',
          config: { ...config, remoteBindAddress },
          connections,
          sshClient,
          onTcpConnection,
          channelId,
        })
        resolve({ tunnelId, remotePort: config.remotePort })
      })
    })
  }

  startDynamic(tunnelId, channelId, sshClient, config) {
    // config: { localPort } — SOCKS5 proxy
    return new Promise((resolve, reject) => {
      const connections = new Set()
      const server = net.createServer((socket) => {
        connections.add(socket)
        socket.on('error', () => socket.destroy())
        socket.on('close', () => connections.delete(socket))
        // TCP may fragment or coalesce SOCKS messages. Retain incomplete frames.
        let buffer = Buffer.alloc(0), greeting = false
        const read = data => {
          buffer = Buffer.concat([buffer, data])
          if (buffer.length > 65536) { socket.destroy(); return }
          if (!greeting) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          const data = buffer.subarray(0, 2 + buffer[1])
          buffer = buffer.subarray(data.length)
          // SOCKS5 greeting
          if (data[0] !== 0x05) { socket.end(); return }
          if (!data.subarray(2).includes(0)) { socket.end(Buffer.from([5, 255])); return }
          socket.write(Buffer.from([0x05, 0x00])) // no auth
          greeting = true
          }
            if (buffer.length < 5) return
            const length = buffer[3] === 1 ? 10 : buffer[3] === 3 ? 7 + buffer[4] : 0
            if (!length) { socket.end(); return }
            if (buffer.length < length) return
            const req = buffer.subarray(0, length), payload = buffer.subarray(length)
            socket.removeListener('data', read)
            socket.pause()
            if (req[0] !== 0x05 || req[1] !== 0x01) { socket.end(); return }
            const atyp = req[3]
            let host, port
            if (atyp === 0x01) { // IPv4
              host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`
              port = req.readUInt16BE(8)
            } else if (atyp === 0x03) { // Domain
              const len = req[4]
              host = req.slice(5, 5 + len).toString()
              port = req.readUInt16BE(5 + len)
            } else { socket.end(); return }

            sshClient.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
              if (err) {
                const reply = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                socket.write(reply)
                socket.end()
                return
              }
              if (socket.destroyed) { stream.destroy(); return }
              stream.on('error', () => socket.destroy())
              const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
              socket.write(reply)
              if (payload.length) stream.write(payload)
              socket.pipe(stream).pipe(socket)
              socket.resume()
              stream.on('close', () => socket.end())
              socket.on('close', () => stream.end())
            })
        }
        socket.on('data', read)
      })

      server.on('error', (err) => reject(err))

      server.listen(config.localPort, '127.0.0.1', () => {
        this.tunnels.set(tunnelId, { server, type: 'dynamic', config, connections, channelId })
        resolve({ tunnelId, localPort: config.localPort })
      })
    })
  }

  stop(tunnelId) {
    const tunnel = this.tunnels.get(tunnelId)
    if (!tunnel) return
    if (tunnel.server) {
      tunnel.server.close()
    }
    if (tunnel.connections) tunnel.connections.forEach((s) => { try { s.destroy() } catch (_) {} })
    if (tunnel.type === 'remote' && tunnel.sshClient && tunnel.onTcpConnection) {
      tunnel.sshClient.removeListener('tcp connection', tunnel.onTcpConnection)
      try { tunnel.sshClient.unforwardIn(tunnel.config.remoteBindAddress || '127.0.0.1', tunnel.config.remotePort) } catch (_) {}
    }
    this.tunnels.delete(tunnelId)
  }

  // Stop all tunnels belonging to a specific SSH channel
  stopByChannel(channelId) {
    const stopped = []
    for (const [id, t] of this.tunnels) {
      if (t.channelId === channelId) {
        this.stop(id)
        stopped.push(id)
      }
    }
    return stopped
  }

  list() {
    const result = []
    for (const [id, t] of this.tunnels) {
      result.push({ id, type: t.type, config: t.config, channelId: t.channelId })
    }
    return result
  }

  stopAll() {
    for (const [id] of this.tunnels) this.stop(id)
  }
}

module.exports = new TunnelManager()
