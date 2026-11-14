import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { X } from 'lucide-react'
import { registerOsc52ClipboardHandler } from '../utils/terminalClipboardUtils'
import useSessionStore from '../store/useSessionStore'

const TERMINAL_THEME = {
  background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff',
  selectionBackground: '#264f78',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
}

const MAX_RECONNECT = 5

export default function SplitTerminalPane({ channelId, config, onClose, termInstanceRef, onFocused }) {
  const termRef = useRef(null)
  const osc52ClipboardEnabled = useSessionStore((state) => state.settings.osc52ClipboardEnabled === true)

  useEffect(() => {
    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    const osc52ClipboardDisposer = registerOsc52ClipboardHandler(
      term,
      (text) => window.electronAPI.clipboard.writeText(text),
      { enabled: osc52ClipboardEnabled }
    )
    term.open(termRef.current)
    fitAddon.fit()

    // Let the parent focus this pane and know when the user last focused it
    if (termInstanceRef) termInstanceRef.current = term
    const handleFocus = () => onFocused?.()
    term.textarea?.addEventListener('focus', handleFocus)

    let isMounted = true
    let attempt = 0
    let reconnectTimer = null

    const connect = () => {
      if (!isMounted) return
      term.write('\r\n\x1b[90mConnecting split pane to ' + config.host + '...\x1b[0m\r\n')
      window.electronAPI.ssh.connect(channelId, config).then((result) => {
        if (!isMounted) return
        if (result?.error) {
          term.write('\r\n\x1b[31mError: ' + result.error + '\x1b[0m\r\n')
          scheduleReconnect()
          return
        }
        attempt = 0
        fitAddon.fit()
        window.electronAPI.ssh.resize(channelId, term.cols, term.rows)
      })
    }

    const scheduleReconnect = () => {
      if (!isMounted) return
      clearInterval(reconnectTimer)
      reconnectTimer = null
      attempt++
      if (attempt > MAX_RECONNECT) {
        term.write('\r\n\x1b[31m[Max reconnect attempts reached — close pane to dismiss]\x1b[0m\r\n')
        return
      }
      let remaining = Math.min(30, attempt * 5)
      term.write(`\r\n\x1b[33m[Reconnecting in ${remaining}s… attempt ${attempt}/${MAX_RECONNECT}]\x1b[0m\r\n`)
      reconnectTimer = setInterval(() => {
        if (!isMounted) { clearInterval(reconnectTimer); return }
        remaining--
        if (remaining <= 0) { clearInterval(reconnectTimer); connect() }
      }, 1000)
    }

    const inputDisposer = term.onData((data) => {
      window.electronAPI.ssh.write(channelId, data)
    })

    const removeData = window.electronAPI.ssh.onData((cid, data) => {
      if (cid === channelId) term.write(data)
    })
    const removeClose = window.electronAPI.ssh.onClose((cid) => {
      if (cid === channelId) {
        term.write('\r\n\x1b[90m[Split pane disconnected]\x1b[0m\r\n')
        scheduleReconnect()
      }
    })
    const removeError = window.electronAPI.ssh.onError((cid, msg) => {
      if (cid === channelId) term.write('\r\n\x1b[31mError: ' + msg + '\x1b[0m\r\n')
    })

    const resizeObs = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        window.electronAPI.ssh.resize(channelId, term.cols, term.rows)
      } catch (_) {}
    })
    if (termRef.current) resizeObs.observe(termRef.current.parentElement)

    connect()

    return () => {
      isMounted = false
      clearInterval(reconnectTimer)
      term.textarea?.removeEventListener('focus', handleFocus)
      if (termInstanceRef) termInstanceRef.current = null
      inputDisposer.dispose()
      osc52ClipboardDisposer?.dispose()
      removeData(); removeClose(); removeError()
      resizeObs.disconnect()
      window.electronAPI.ssh.disconnect(channelId)
      term.dispose()
    }
  }, [channelId, osc52ClipboardEnabled])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <button
        className="icon-btn"
        style={{ position: 'absolute', top: 4, right: 4, zIndex: 10 }}
        onClick={onClose}
        title="Close split pane"
      >
        <X size={14} />
      </button>
      <div ref={termRef} style={{ width: '100%', height: '100%', padding: 4 }} />
    </div>
  )
}
