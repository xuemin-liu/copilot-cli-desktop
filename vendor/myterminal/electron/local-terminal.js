const os = require('os')
const { normalizeLocalSpawnOptions } = require('./security-utils')

// node-pty gives proper PTY semantics (arrow keys, Ctrl+C, resize, TUIs).
// Fall back to child_process.spawn if node-pty is unavailable or fails to load.
let pty = null
try { pty = require('node-pty') } catch (_) {}

class LocalTerminalManager {
  constructor() {
    this.processes = new Map()
    this.mainWindow = null
  }

  setWindow(win) { this.mainWindow = win }

  _emit(event, channelId, ...args) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(event, channelId, ...args)
    }
  }

  _resolveShell(shell) {
    if (process.platform !== 'win32') return shell
    const path = require('path')
    // If already absolute, use as-is
    if (path.isAbsolute(shell)) return shell
    // Search PATH ourselves — node-pty's conpty can fail to resolve relative names
    // when System32 is missing from the Electron process PATH
    const fs = require('fs')
    const dirs = (process.env.Path || process.env.PATH || '').split(';')
    // Also check common Windows dirs that may be absent from PATH
    const extra = [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
    ]
    // Try the name as-is, then with PATHEXT extensions (e.g. pwsh → pwsh.exe)
    const hasExt = path.extname(shell) !== ''
    const exts = hasExt ? [''] : ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
    for (const dir of [...dirs, ...extra]) {
      if (!dir) continue
      for (const ext of exts) {
        const full = path.join(dir, shell + ext)
        try { if (fs.statSync(full).isFile()) return full } catch (_) {}
      }
    }
    return shell // fallback to original, let node-pty try
  }

  async spawn(channelId, options = {}, host = {}) {
      let safeOptions
      try {
        safeOptions = normalizeLocalSpawnOptions(options)
      } catch (err) {
        throw err
      }
      const isWin = process.platform === 'win32'
      let shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
      let args = isWin ? [] : []
      if (safeOptions.mode === 'wsl') {
        shell = 'wsl.exe'
        args = safeOptions.distro ? ['-d', safeOptions.distro] : []
      }
      // Trusted desktop adapter only; renderer options still use upstream validation.
      if (host.launch) { shell = host.launch.file; args = host.launch.args }
      if (isWin) shell = this._resolveShell(shell)
      const env = { ...(host.env || process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      const cwd = host.cwd || os.homedir()

      if (host.spawn || pty) {
        // PTY path — full terminal semantics
        let ptyProcess
        try {
          ptyProcess = await (host.spawn || pty.spawn.bind(pty))(shell, args, {
            name: 'xterm-256color',
            cols: safeOptions.cols,
            rows: safeOptions.rows,
            cwd,
            env,
          })
        } catch (err) {
          throw err
        }

        this.processes.set(channelId, { kind: 'pty', proc: ptyProcess })

        ptyProcess.onData((data) => this._emit('ssh:data', channelId, data))
        ptyProcess.onExit((event) => {
          this.processes.delete(channelId)
          this._emit('ssh:close', channelId, event)
        })

        return { channelId }
      } else {
        // Pipe fallback — limited (no resize, no interactive TUIs)
        const { spawn } = require('child_process')
        let proc
        try {
          proc = spawn(shell, safeOptions.mode === 'default' && isWin ? ['-NoLogo'] : args, {
            env, cwd, windowsHide: true,
          })
        } catch (err) {
          throw err
        }

        this.processes.set(channelId, { kind: 'spawn', proc })

        proc.stdout.on('data', (d) => this._emit('ssh:data', channelId, d.toString('utf8')))
        proc.stderr.on('data', (d) => this._emit('ssh:data', channelId, d.toString('utf8')))
        proc.on('close', () => { this.processes.delete(channelId); this._emit('ssh:close', channelId) })
        proc.on('error', (err) => { this.processes.delete(channelId); this._emit('ssh:error', channelId, err.message) })

        return { channelId }
      }
  }

  write(channelId, data) {
    const entry = this.processes.get(channelId)
    if (!entry) return
    if (entry.kind === 'pty') entry.proc.write(data)
    else if (entry.proc.stdin.writable) entry.proc.stdin.write(data)
  }

  resize(channelId, cols, rows) {
    const entry = this.processes.get(channelId)
    if (entry?.kind === 'pty') {
      try { entry.proc.resize(cols, rows) } catch (_) {}
    }
  }

  disconnect(channelId, signal) {
    const entry = this.processes.get(channelId)
    if (!entry) return
    try {
      if (entry.kind === 'pty') entry.proc.kill(signal)
      else { try { entry.proc.stdin.end() } catch (_) {}; entry.proc.kill(signal) }
    } catch (_) {}
    this.processes.delete(channelId)
  }

  disconnectAll() {
    for (const [id] of this.processes) this.disconnect(id)
  }
}

module.exports = new LocalTerminalManager()
