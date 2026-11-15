import { createBellNotifier, createReconnectController } from '../../lifecycle.cjs'
import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import {
  PanelRight, Highlighter, Sparkles, ListFilter, Search,
  Code2, SplitSquareHorizontal, Regex, Copy, Check, Bookmark,
  FileText, Download, Network,
} from 'lucide-react'
import SftpPanel from './SftpPanel'
import AiBar from './AiBar'
import SnippetPanel from './SnippetPanel'
import SplitTerminalPane from './SplitTerminalPane'
import TunnelPanel from './TunnelPanel'
import FileEditor from './FileEditor'
import useSessionStore from '../store/useSessionStore'
import { FILTER_PRESETS, parseFilter, matchesFilter, colorizeOutput, stripAnsi } from '../utils/terminalUtils'
import { appendOutputLines, updateCwdDetection } from '../utils/terminalSessionUtils'
import { resizeTerminalChannel, writeToBroadcastTargets, writeToTerminalChannel } from '../utils/terminalChannels'
import { registerOsc52ClipboardHandler, updateOscSequenceState } from '../utils/terminalClipboardUtils'

export default function TerminalTab({ tab, isActive, host }) {
  // Desktop supplies scoped transport/settings; standalone MyTerminal keeps its original defaults.
  const api = host?.api || window.electronAPI
  const sessionStore = host?.store || useSessionStore
  const { addSplitPane, removeSplitPane, settings } = sessionStore()
  const standalone = !host
  const remoteTools = !tab.isLocal && (standalone || host?.remoteTools)
  const extraTools = standalone || host?.features

  const termRef = useRef(null)
  const terminalInstanceRef = useRef(null)
  const fitAddonRef = useRef(null)
  const searchAddonRef = useRef(null)
  const cleanupRef = useRef([])

  // State
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)
  const [showSftp, setShowSftp] = useState(false)
  const [cwd, setCwd] = useState(null)
  const [sftpWidth, setSftpWidth] = useState(380)
  const [showAi, setShowAi] = useState(false)
  const [colorize, setColorize] = useState(settings.colorizeByDefault)
  const [ctxMenu, setCtxMenu] = useState(null)
  const [showFilter, setShowFilter] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [filterLines, setFilterLines] = useState([])
  const [activePreset, setActivePreset] = useState(null)
  const [isRegexMode, setIsRegexMode] = useState(false)
  const [regexError, setRegexError] = useState(null)
  const [copyFeedback, setCopyFeedback] = useState(false)
  const [customPresets, setCustomPresets] = useState([])
  const [ctrlCDialog, setCtrlCDialog] = useState(null) // null | { hasSelection: boolean }
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [fontSize, setFontSize] = useState(settings.defaultFontSize || 14)
  const [reconnectCountdown, setReconnectCountdown] = useState(null)
  useEffect(() => { if (host?.backgroundLifecycle) setReconnectCountdown(host.reconnectCountdown ?? null) }, [host?.reconnectCountdown])
  const [showSnippets, setShowSnippets] = useState(false)
  const [stickyCmd, setStickyCmd] = useState(null) // { text, line } or null
  const [showStickyCmd, setShowStickyCmd] = useState(false)
  const [latency, setLatency] = useState(null)
  const [logging, setLogging] = useState(false)
  const [showTunnels, setShowTunnels] = useState(false)
  const [editingFile, setEditingFile] = useState(null)

  // Refs for async-safe access
  const colorizeRef = useRef(true)
  const filterTextRef = useRef('')
  const showAiRef = useRef(false)
  const showSearchRef = useRef(false)
  const showFilterRef = useRef(false)
  const filterInputRef = useRef(null)
  const filterResultsRef = useRef(null)
  const searchInputRef = useRef(null)
  const outputLinesRef = useRef([])
  const pendingLineRef = useRef('')
  const reconnectTimerRef = useRef(null)
  const isMountedRef = useRef(true)
  const localReconnectAttemptRef = useRef(0)
  const reconnectAttemptRef = host?.reconnectAttempts || localReconnectAttemptRef
  const isRegexModeRef = useRef(false)
  const stickyCmdRef = useRef(null)
  const loggingRef = useRef(false)
  const cwdRawBufferRef = useRef('')
  const cwdPlainBufferRef = useRef('')
  const oscSequenceActiveRef = useRef(false)
  const aiInputRef = useRef(null)
  const editorTextareaRef = useRef(null)
  const editingFileRef = useRef(null)
  const splitTermRef = useRef(null)
  const focusedPaneRef = useRef('main') // 'main' | 'split' — last pane that had keyboard focus

  // Sync refs
  useEffect(() => { colorizeRef.current = colorize }, [colorize])
  useEffect(() => { filterTextRef.current = filterText }, [filterText])
  useEffect(() => { showAiRef.current = showAi }, [showAi])
  useEffect(() => { showSearchRef.current = showSearch }, [showSearch])
  useEffect(() => { showFilterRef.current = showFilter }, [showFilter])
  useEffect(() => { isRegexModeRef.current = isRegexMode }, [isRegexMode])
  useEffect(() => { loggingRef.current = logging }, [logging])
  useEffect(() => { editingFileRef.current = editingFile }, [editingFile])

  // Font size → update live terminal
  useEffect(() => {
    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.options.fontSize = fontSize
      setTimeout(() => { try { fitAddonRef.current?.fit() } catch (_) {} }, 50)
    }
  }, [fontSize])

  useEffect(() => { setFontSize(settings.defaultFontSize || 14) }, [settings.defaultFontSize])
  useEffect(() => { setColorize(settings.colorizeByDefault) }, [settings.colorizeByDefault])
  useEffect(() => {
    if (terminalInstanceRef.current) terminalInstanceRef.current.options.scrollback = settings.defaultScrollback || 10000
  }, [settings.defaultScrollback])
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  useEffect(() => {
    if (!host?.backgroundLogging || !isActive) return
    let disposed = false
    const update = () => api.logging.status(tab.channelId).then(result => { if (!disposed) { setLogging(result.logging); if (result.error) setError(result.error) } }).catch(error => { if (!disposed && host.isActive()) setError(error.message) })
    void update()
    const timer = setInterval(update, 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [isActive, tab.channelId])

  // Auto-focus search input
  useEffect(() => {
    if (showSearch) setTimeout(() => searchInputRef.current?.focus(), 50)
  }, [showSearch])

  // Auto-focus filter input
  useEffect(() => {
    if (showFilter) setTimeout(() => filterInputRef.current?.focus(), 50)
  }, [showFilter])

  // Re-run filter
  useEffect(() => {
    const { includeRe, excludeRe, error } = parseFilter(filterText, isRegexMode)
    setRegexError(error)
    setFilterLines(filterText.trim() ? outputLinesRef.current.filter((l) => matchesFilter(l, includeRe, excludeRe)) : [])
  }, [filterText, isRegexMode])

  // Scroll filter to bottom
  useEffect(() => {
    const el = filterResultsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [filterLines])

  // Latency polling for SSH connections
  useEffect(() => {
    if (!remoteTools || !connected || !isActive) { setLatency(null); return }
    let active = true
    const poll = async () => {
      if (!active) return
      const ms = await api.ssh.ping(tab.channelId).catch(() => -1)
      if (active) setLatency(ms >= 0 ? ms : null)
    }
    poll()
    const timer = setInterval(poll, 30000)
    return () => { active = false; clearInterval(timer) }
  }, [tab.isLocal, connected, tab.channelId, isActive])

  // Load custom presets on mount
  useEffect(() => {
    api.filterPresets.getAll().then((p) => setCustomPresets(p || []))
  }, [])

  // Keyboard shortcuts — fallback for when xterm does NOT have focus (e.g. toolbar, search bar)
  // Primary handling (when xterm IS focused) is done via attachCustomKeyEventHandler below.
  useEffect(() => {
    if (!isActive) return
    const handler = (e) => {
      // Skip if xterm textarea has focus — attachCustomKeyEventHandler handles it there
      if (document.activeElement?.classList.contains('xterm-helper-textarea')) return
      if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); setShowSearch((v) => !v) }
      if (standalone && e.ctrlKey && !e.shiftKey && e.key === 'k') { e.preventDefault(); setShowAi((v) => !v) }
      if (e.ctrlKey && !e.shiftKey && e.key === 'f') { e.preventDefault(); setShowFilter((v) => !v) }
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); setFontSize((s) => Math.min(32, s + 1)) }
      if (e.ctrlKey && e.key === '-') { e.preventDefault(); setFontSize((s) => Math.max(8, s - 1)) }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); setFontSize(14) }
      if (e.key === 'Escape') { setShowAi(false); setShowSearch(false); setShowFilter(false) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isActive])

  // Context menu for copy/paste
  const handleContextMenu = (e) => {
    e.preventDefault()
    // Clamp so menu (≈120×70) doesn't overflow the window
    const x = Math.min(e.clientX, window.innerWidth - 130)
    const y = Math.min(e.clientY, window.innerHeight - 80)
    setCtxMenu({ x, y, hasSelection: !!terminalInstanceRef.current?.getSelection()?.length })
  }
  // Menu/dialog clicks steal focus from xterm's hidden textarea, so the next
  // keystroke (e.g. Enter) wouldn't reach the terminal until refocused.
  // Always targets the primary pane: every caller (AI run, snippets, copy/
  // paste, Ctrl+C dialog, search/filter close) acts on the primary channel,
  // so focus must land where the action's output goes — not the split pane.
  const focusTerminal = () => terminalInstanceRef.current?.focus()
  const handleCopy = () => {
    const sel = terminalInstanceRef.current?.getSelection()
    if (sel) navigator.clipboard.writeText(sel)
    setCtxMenu(null)
    focusTerminal()
  }
  const handlePaste = async () => {
    const text = await navigator.clipboard.readText()
    if (text) terminalInstanceRef.current?.paste(text)
    setCtxMenu(null)
    focusTerminal()
  }

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [ctxMenu])

  const handleCtrlCCopy = () => {
    const sel = terminalInstanceRef.current?.getSelection()
    if (sel) navigator.clipboard.writeText(sel)
    setCtrlCDialog(null)
    focusTerminal()
  }
  const handleCtrlCBreak = () => {
    writeToChannel('\x03')
    setCtrlCDialog(null)
    focusTerminal()
  }

  // Helper: write to the right channel type
  const writeToChannel = (data, channelId = tab.channelId) => {
    writeToTerminalChannel(tab, data, channelId, api)
  }

  // Broadcast write
  const broadcastWrite = (data) => {
    const { broadcastMode, tabs } = sessionStore.getState()
    if (broadcastMode && host?.broadcast) {
      host.broadcast(data)
    } else if (broadcastMode) {
      writeToBroadcastTargets(tabs, data, api)
    } else {
      writeToChannel(data)
    }
  }

  // Main terminal useEffect
  useEffect(() => {
    isMountedRef.current = true
    reconnectAttemptRef.current = 0

    isMountedRef.current = true
    const term = new Terminal({
      theme: {
        background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
      },
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      fontSize: settings.defaultFontSize || 14,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: settings.defaultScrollback || 10000,
      allowProposedApi: true,
      bellStyle: 'sound',
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(searchAddon)
    // A font zoom changes the grid without resizing its container. Keep the PTY
    // synchronized for every xterm fit, including the upstream zoom shortcuts.
    const gridResizeDisposer = term.onResize(({ cols, rows }) => resizeTerminalChannel(tab, cols, rows, tab.channelId, api))
    const osc52ClipboardDisposer = registerOsc52ClipboardHandler(
      term,
      (text) => api.clipboard.writeText(text),
      { enabled: () => settingsRef.current.osc52ClipboardEnabled === true }
    )

    terminalInstanceRef.current = term
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    term.open(termRef.current)
    host?.onTerminal?.(term)
    if (termRef.current.clientWidth && termRef.current.clientHeight) fitAddon.fit()

    // Track pane focus so tab activation can restore it to the right terminal
    const handleTermFocus = () => { focusedPaneRef.current = 'main' }
    term.textarea?.addEventListener('focus', handleTermFocus)

    // Sticky command overlay: track scroll to show/hide
    const checkStickyVisibility = () => {
      const cmd = stickyCmdRef.current
      if (!cmd) { setShowStickyCmd(false); return }
      const viewportTop = term.buffer.active.viewportY
      const viewportBottom = viewportTop + term.rows - 1
      const isVisible = cmd.line >= viewportTop && cmd.line <= viewportBottom
      setShowStickyCmd(!isVisible)
    }
    const scrollDisposer = term.onScroll(() => checkStickyVisibility())
    const xtermViewport = termRef.current.querySelector('.xterm-viewport')
    const handleViewportScroll = () => checkStickyVisibility()
    if (xtermViewport) xtermViewport.addEventListener('scroll', handleViewportScroll)

    // Handle shortcuts before xterm sends them to the PTY/SSH channel.
    // Returning false prevents xterm from processing the key further.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (standalone && e.key === 'k') { setShowAi((v) => !v); return false }
        if (e.key === 'f') { setShowFilter((v) => !v); return false }
        if (e.key === '=' || e.key === '+') { setFontSize((s) => Math.min(32, s + 1)); return false }
        if (e.key === '-') { setFontSize((s) => Math.max(8, s - 1)); return false }
        if (e.key === '0') { setFontSize(14); return false }
        if (e.key === 'c') {
          const isLinux = !tab.isLocal || !!tab.wslDistro || api.platform !== 'win32'
          if (isLinux && !!term.getSelection()) {
            setCtrlCDialog({ hasSelection: true })
            return false
          }
        }
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === 'F') { setShowSearch((v) => !v); return false }
      if (e.key === 'Escape' && (showAiRef.current || showSearchRef.current || showFilterRef.current)) {
        setShowAi(false); setShowSearch(false); setShowFilter(false)
        return false
      }
      return true
    })

    // Original policy shared with the desktop's process-owned background lifecycle.
    const reconnect = createReconnectController({
      attempts: reconnectAttemptRef,
      changed: setReconnectCountdown,
      exhausted: () => term.write('\r\n\x1b[31m[Max reconnect attempts reached]\x1b[0m\r\n'),
      connect: () => { if (host) void host.connect(); else connectSSH() },
    })
    reconnectTimerRef.current = reconnect
    const scheduleReconnect = () => {
      if (!isMountedRef.current || tab.isLocal || host?.backgroundLifecycle || (host && !host.remoteTools)) return
      reconnect.schedule()
    }
    const notifyBell = createBellNotifier({ focused: () => document.hasFocus(),
      notify: (title, body) => api.notify.send(title, body), label: () => tab.label })

    const autoStartLogging = () => {
      if (settings.loggingEnabled && !loggingRef.current) {
        const logDir = settings.logDirectory || ''
        api.logging.start(tab.channelId, logDir).then((res) => {
          if (res?.success) { setLogging(true) }
        })
      }
    }

    const connectSSH = () => {
      if (!isMountedRef.current || (host && !host.isActive())) return
      if (tab.isLocal) {
        const localLabel = tab.wslDistro ? `WSL: ${tab.wslDistro}` : 'local terminal'
        term.write(`\r\n\x1b[90mStarting ${localLabel}...\x1b[0m\r\n`)
        const spawnOpts = tab.wslDistro
          ? { mode: 'wsl', distro: tab.wslDistro }
          : { mode: 'default' }
        api.local.spawn(tab.channelId, spawnOpts).then((result) => {
          if (!isMountedRef.current || (host && !host.isActive())) return
          if (result?.error) { setError(result.error); term.write('\r\n\x1b[31mError: ' + result.error + '\x1b[0m\r\n'); return }
          setConnected(true)
          autoStartLogging()
          if (termRef.current?.clientWidth && termRef.current?.clientHeight) fitAddon.fit()
        })
      } else {
        term.write('\r\n\x1b[90mConnecting to ' + tab.config.host + '...\x1b[0m\r\n')
        const connConfig = { ...tab.config, keepaliveInterval: settings.keepaliveInterval || 10000 }
        api.ssh.connect(tab.channelId, connConfig).then((result) => {
          if (!isMountedRef.current || (host && !host.isActive())) return
          if (result?.error) {
            setError(result.error)
            term.write('\r\n\x1b[31mError: ' + result.error + '\x1b[0m\r\n')
            scheduleReconnect()
            return
          }
          setConnected(true)
          reconnectAttemptRef.current = 0
          reconnect.connected()
          setReconnectCountdown(null)
          autoStartLogging()
          if (termRef.current?.clientWidth && termRef.current?.clientHeight) fitAddon.fit()
          resizeTerminalChannel(tab, term.cols, term.rows, tab.channelId, api)
        })
      }
    }

    connectSSH()

    // Font zoom via Ctrl+scroll
    const handleWheel = (e) => {
      if (e.ctrlKey) {
        e.preventDefault()
        setFontSize((s) => e.deltaY < 0 ? Math.min(32, s + 1) : Math.max(8, s - 1))
      }
    }
    const termContainer = termRef.current?.parentElement
    if (termContainer) termContainer.addEventListener('wheel', handleWheel, { passive: false })

    const inputDisposer = term.onData((data) => {
      if (data === '\r') {
        // Capture the current line for sticky command overlay
        const curLine = term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)
        if (curLine) {
          const raw = curLine.translateToString().trim()
          // Strip common prompt prefixes (e.g. "user@host:~$", "$ ", "# ")
          const cmdText = raw.replace(/^.*?[$#>]\s*/, '')
          if (cmdText && cmdText.length > 0) {
            const cmdObj = { text: cmdText, line: term.buffer.active.baseY + term.buffer.active.cursorY }
            setStickyCmd(cmdObj)
            stickyCmdRef.current = cmdObj
            setShowStickyCmd(false)
          }
        }
      }
      broadcastWrite(data)
    })

    // SSH/local data → terminal
    let cwdTimer = null
    const removeData = api.ssh.onData((channelId, data) => {
      if (channelId !== tab.channelId) return

      if (!host?.backgroundLifecycle) notifyBell(data)

      const wasInsideOsc = oscSequenceActiveRef.current
      oscSequenceActiveRef.current = updateOscSequenceState(wasInsideOsc, data)
      const hasOscSequenceStart = data.includes('\x1b]')
      const shouldColorize = colorizeRef.current && !wasInsideOsc && !hasOscSequenceStart
      term.write(shouldColorize ? colorizeOutput(data) : data)

      // Session logging — fire-and-forget
      if (loggingRef.current && !host?.backgroundLogging) {
        api.logging.write(tab.channelId, stripAnsi(data))
      }

      const plain = stripAnsi(data)

      const { pendingLine, changed } = appendOutputLines(outputLinesRef.current, pendingLineRef.current, plain)
      pendingLineRef.current = pendingLine
      if (changed && filterTextRef.current) {
        const { includeRe, excludeRe } = parseFilter(filterTextRef.current, isRegexModeRef.current)
        if (includeRe || excludeRe) setFilterLines(outputLinesRef.current.filter((l) => matchesFilter(l, includeRe, excludeRe)))
      }

      // CWD detection — prefer OSC 7 (shell integration), fall back to prompt regex
      // Enable in shell: printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"  (bash/zsh)
      const cwdState = updateCwdDetection(cwdRawBufferRef.current, cwdPlainBufferRef.current, data, plain)
      cwdRawBufferRef.current = cwdState.rawBuffer
      cwdPlainBufferRef.current = cwdState.plainBuffer
      if (cwdState.cwd) {
        clearTimeout(cwdTimer)
        cwdTimer = setTimeout(() => setCwd(cwdState.cwd), 300)
      }
    })

    const removeClose = api.ssh.onClose((channelId) => {
      if (channelId === tab.channelId) {
        term.write('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n')
        setConnected(false)
        // Tear down any tunnels tied to this channel — the SSH client
        // they depend on is gone, so ports/forwards would be stale.
        api.tunnel.stopByChannel(tab.channelId)
        scheduleReconnect()
      }
    })

    const removeError = api.ssh.onError((channelId, message) => {
      if (channelId === tab.channelId) {
        setError(message)
        term.write('\r\n\x1b[31mError: ' + message + '\x1b[0m\r\n')
        setConnected(false)
      }
    })

    const resizeObs = new ResizeObserver((entries) => {
      try {
        // Skip fitting when the container is not measurable
        // to prevent xterm from reflowing content to a tiny column count.
        const { width, height } = entries[0].contentRect
        if (width === 0 || height === 0) return
        fitAddon.fit()
        const { cols, rows } = term
        resizeTerminalChannel(tab, cols, rows, tab.channelId, api)
      } catch (_) {}
    })
    if (termRef.current) resizeObs.observe(termRef.current.parentElement)

    cleanupRef.current = [
      () => gridResizeDisposer.dispose(),
      () => inputDisposer.dispose(),
      () => scrollDisposer.dispose(),
      () => term.textarea?.removeEventListener('focus', handleTermFocus),
      () => { if (xtermViewport) xtermViewport.removeEventListener('scroll', handleViewportScroll) },
      () => osc52ClipboardDisposer?.dispose(),
      removeData, removeClose, removeError,
      () => resizeObs.disconnect(),
      () => { if (termContainer) termContainer.removeEventListener('wheel', handleWheel) },
      () => reconnect.dispose(),
      () => {
        isMountedRef.current = false
        if (loggingRef.current && !host?.backgroundLogging) api.logging.stop(tab.channelId)
        api.tunnel.stopByChannel(tab.channelId)
        if (tab.isLocal) api.local.disconnect(tab.channelId)
        else api.ssh.disconnect(tab.channelId)
        host?.onTerminal?.(null)
        term.dispose()
      },
    ]

    return () => cleanupRef.current.forEach((fn) => { try { fn() } catch (_) {} })
  }, [tab.channelId])

  // Refit when tab becomes active or panels toggle
  useEffect(() => {
    if (!isActive) return
    // Use rAF to wait for the browser to complete layout after tab/panel changes,
    // then fit the terminal and notify the PTY of the new size.
    const rafId = window.requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit()
        const term = terminalInstanceRef.current
        if (term) {
          const { cols, rows } = term
          resizeTerminalChannel(tab, cols, rows, tab.channelId, api)
        }
      } catch (_) {}
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [isActive, showSftp, showSnippets, showTunnels])

  // Restore keyboard focus when this tab becomes active. Panes are hidden with
  // visibility:hidden, so focus otherwise stays on the previous tab's hidden
  // xterm textarea and keystrokes never reach this tab (hollow cursor).
  // Overlays survive tab switches but their autofocus hooks only run on mount,
  // so an open overlay gets focus back explicitly; otherwise the last-focused
  // pane (main or split) does.
  useEffect(() => {
    if (!isActive) return
    // rAF: wait until the pane is visible — hidden elements can't take focus.
    const rafId = window.requestAnimationFrame(() => {
      if (editingFileRef.current) { editorTextareaRef.current?.focus(); return }
      if (showSearchRef.current) { searchInputRef.current?.focus(); return }
      if (showFilterRef.current) { filterInputRef.current?.focus(); return }
      if (showAiRef.current) { aiInputRef.current?.focus(); return }
      // Only tab activation follows the last-focused pane; direct actions on
      // the primary channel use focusTerminal() and always focus the primary.
      if (focusedPaneRef.current === 'split' && splitTermRef.current) splitTermRef.current.focus()
      else terminalInstanceRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [isActive])

  const doSearch = (direction = 'next') => {
    if (!searchQuery) return
    const opts = { caseSensitive, wholeWord }
    if (direction === 'next') searchAddonRef.current?.findNext(searchQuery, opts)
    else searchAddonRef.current?.findPrevious(searchQuery, opts)
  }

  const applyFilter = (text) => {
    setFilterText(text)
    filterTextRef.current = text
    const { includeRe, excludeRe, error } = parseFilter(text, isRegexModeRef.current)
    setRegexError(error)
    setFilterLines(text.trim() ? outputLinesRef.current.filter((l) => matchesFilter(l, includeRe, excludeRe)) : [])
  }

  const handleSavePreset = async () => {
    if (!filterText.trim() || customPresets.length >= 10) return
    const newPreset = { id: crypto.randomUUID(), label: filterText.trim().slice(0, 24), pattern: filterText.trim(), color: '#8b949e' }
    setCustomPresets(await api.filterPresets.save(newPreset))
  }

  const handleDeletePreset = async (id) => {
    setCustomPresets(await api.filterPresets.delete(id))
    if (activePreset === id) { setActivePreset(null); applyFilter('') }
  }

  const toggleLogging = async () => {
    try {
    if (logging) {
      await api.logging.stop(tab.channelId)
      setLogging(false)
    } else {
      const logDir = settings.logDirectory || ''
      const result = await api.logging.start(tab.channelId, logDir)
      if (result?.success) setLogging(true)
    }
    } catch (error) { setError(error.message) }
  }

  const handleExport = async () => {
    const content = outputLinesRef.current.join('\n')
    await api.logging.export(content)
  }

  const handleEditFile = async (remotePath) => {
    const content = await api.sftp.readFile(tab.channelId, remotePath)
    if (content?.error) {
      // Show error to user for binary/size rejections
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.write(`\r\n\x1b[33m[Editor] ${content.error}\x1b[0m\r\n`)
      }
      return
    }
    setEditingFile({ remotePath, content, original: content })
  }

  const handleSaveFile = async () => {
    if (!editingFile) return
    const result = await api.sftp.writeFile(tab.channelId, editingFile.remotePath, editingFile.content)
    if (result?.error) return
    setEditingFile((prev) => prev ? { ...prev, original: prev.content } : null)
  }

  const handleCloseEditor = () => {
    if (editingFile && editingFile.content !== editingFile.original) {
      if (!confirm('You have unsaved changes. Discard them?')) return
    }
    setEditingFile(null)
  }

  const handleCopyMatches = () => {
    if (!filterLines.length) return
    navigator.clipboard.writeText(filterLines.join('\n'))
    setCopyFeedback(true)
    setTimeout(() => setCopyFeedback(false), 1500)
  }

  return (
    <div className="terminal-tab-root">
      {/* Toolbar */}
      <div className="terminal-toolbar">
        <span className="terminal-status">
          <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
          {connected ? 'Connected' : error ? 'Error' : 'Connecting...'}
        </span>

        {latency !== null && (
          <span className={`latency-badge ${latency < 100 ? 'good' : latency < 500 ? 'warn' : 'bad'}`}>
            {latency}ms
          </span>
        )}

        {reconnectCountdown !== null && (
          <span className="reconnect-badge">
            Reconnecting in {reconnectCountdown}s…
            <button onClick={() => { host?.backgroundLifecycle ? host.cancelReconnect() : reconnectTimerRef.current?.cancel(); setReconnectCountdown(null) }}>Cancel</button>
          </span>
        )}

        <div className="terminal-toolbar-actions">
          {standalone && <button className={`icon-btn ${showAi ? 'active' : ''}`} onClick={() => setShowAi((v) => !v)} title="AI assistant (Ctrl+K)">
            <Sparkles size={16} />
          </button>}
          {host?.toolbar}
          <button className={`icon-btn ${showSearch ? 'active' : ''}`} onClick={() => setShowSearch((v) => !v)} title="Search terminal (Ctrl+Shift+F)">
            <Search size={16} />
          </button>
          <button className={`icon-btn ${showFilter ? 'active' : ''}`} onClick={() => setShowFilter((v) => !v)} title="Filter output (Ctrl+F)">
            <ListFilter size={16} />
          </button>
          <button className={`icon-btn ${colorize ? 'active' : ''}`} onClick={() => setColorize((v) => !v)} title="Toggle keyword colorization">
            <Highlighter size={16} />
          </button>
          {extraTools && <button className={`icon-btn ${logging ? 'active' : ''}`} onClick={toggleLogging} title={logging ? 'Stop logging' : 'Start logging'}>
            <FileText size={16} />
          </button>}
          {extraTools && <button className="icon-btn" onClick={handleExport} title="Export terminal output">
            <Download size={16} />
          </button>}
          {extraTools && <button className={`icon-btn ${showSnippets ? 'active' : ''}`} onClick={() => setShowSnippets((v) => !v)} title="Snippets">
            <Code2 size={16} />
          </button>}
          {extraTools && (<>
              <button
                className={`icon-btn ${tab.splitChannelId ? 'active' : ''}`}
                onClick={() => tab.splitChannelId ? removeSplitPane(tab.id) : addSplitPane(tab.id)}
                title="Split pane"
              >
                <SplitSquareHorizontal size={16} />
              </button>
          </>)}
          {remoteTools && (
            <>
              <button
                className={`icon-btn ${showTunnels ? 'active' : ''}`}
                onClick={() => setShowTunnels((v) => !v)}
                title="Port forwarding"
              >
                <Network size={16} />
              </button>
              <button className={`icon-btn ${showSftp ? 'active' : ''}`} onClick={() => setShowSftp((v) => !v)} title="Toggle SFTP panel">
                <PanelRight size={16} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* AI bar */}
      {showAi && (
        <AiBar
          inputRef={aiInputRef}
          onRun={(cmd) => { writeToChannel(cmd); focusTerminal() }}
          onClose={() => { setShowAi(false); focusTerminal() }}
          getSelection={() => terminalInstanceRef.current?.getSelection() || ''}
          getRecentOutput={() => outputLinesRef.current.slice(-150).join('\n')}
          osHint={
            tab.wslDistro
              ? `Linux (WSL: ${tab.wslDistro})`
              : tab.isLocal && api.platform === 'win32' ? 'Windows PowerShell' : 'Linux'
          }
        />
      )}

      {/* xterm Search bar */}
      {showSearch && (
        <div className="search-bar">
          <Search size={13} />
          <input
            ref={searchInputRef}
            className="search-input"
            placeholder="Search terminal…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSearch(e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape') { setShowSearch(false); searchAddonRef.current?.clearDecorations() }
            }}
          />
          <label title="Case sensitive"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Aa</label>
          <label title="Whole word"><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> W</label>
          <button onClick={() => doSearch('prev')} title="Previous">↑</button>
          <button onClick={() => doSearch('next')} title="Next">↓</button>
          <button onClick={() => { setShowSearch(false); searchAddonRef.current?.clearDecorations(); focusTerminal() }}>✕</button>
        </div>
      )}

      {/* Snippets panel */}
      {showSnippets && (
        <SnippetPanel host={host}
          onInsert={(cmd) => { writeToChannel(cmd + '\r'); focusTerminal() }}
          onClose={() => setShowSnippets(false)}
        />
      )}

      {/* Tunnel panel */}
      {showTunnels && !tab.isLocal && connected && (
        <TunnelPanel host={host}
          channelId={tab.channelId}
          sessionId={tab.sessionId || tab.channelId}
          onClose={() => setShowTunnels(false)}
        />
      )}

      {/* Terminal split area */}
      <div className="terminal-split">
        <div className="terminal-wrapper">
          <div ref={termRef} onContextMenu={handleContextMenu} />

          {/* Sticky command overlay */}
          {showStickyCmd && stickyCmd && (
            <div className="sticky-cmd-overlay" onClick={() => {
              terminalInstanceRef.current?.scrollToLine(stickyCmd.line)
            }}>
              <span className="sticky-cmd-text">{stickyCmd.text}</span>
            </div>
          )}

          {/* Filter overlay */}
          {showFilter && (
            <div className="filter-overlay">
              <div className="filter-bar">
                <ListFilter size={14} />
                <input
                  ref={filterInputRef}
                  className={`filter-input${regexError ? ' filter-input-error' : ''}`}
                  placeholder={isRegexMode ? 'Regex filter… (use | for OR, -pattern to exclude)' : 'Filter… (use | for OR, -pattern or !pattern to exclude)'}
                  value={filterText}
                  onChange={(e) => { setActivePreset(null); applyFilter(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setShowFilter(false); applyFilter(''); setActivePreset(null) } }}
                />
                {regexError && <span className="filter-regex-error" title={regexError}>!</span>}
                <span className="filter-count">{filterText ? `${filterLines.length} match${filterLines.length !== 1 ? 'es' : ''}` : ''}</span>
                <button
                  className={`icon-btn${isRegexMode ? ' active' : ''}`}
                  title="Regex mode"
                  onClick={() => setIsRegexMode((v) => !v)}
                >
                  <Regex size={14} />
                </button>
                <button
                  className="icon-btn"
                  title="Copy matched lines"
                  onClick={handleCopyMatches}
                  disabled={!filterLines.length}
                >
                  {copyFeedback ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button
                  className="icon-btn"
                  title="Save as preset"
                  onClick={handleSavePreset}
                  disabled={!filterText.trim() || customPresets.length >= 10}
                >
                  <Bookmark size={14} />
                </button>
                <button className="icon-btn" onClick={() => { setShowFilter(false); applyFilter(''); setActivePreset(null); focusTerminal() }}>✕</button>
              </div>
              <div className="filter-presets">
                {FILTER_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className={`filter-preset-chip ${activePreset === p.label ? 'active' : ''}`}
                    style={{ '--chip-color': p.color }}
                    onClick={() => {
                      if (activePreset === p.label) { setActivePreset(null); applyFilter('') }
                      else { setActivePreset(p.label); applyFilter(p.pattern) }
                    }}
                  >
                    {p.label}
                  </button>
                ))}
                {customPresets.map((p) => (
                  <span key={p.id} className="filter-preset-chip-wrapper" style={{ '--chip-color': p.color }}>
                    <button
                      className={`filter-preset-chip ${activePreset === p.id ? 'active' : ''}`}
                      style={{ '--chip-color': p.color }}
                      onClick={() => {
                        if (activePreset === p.id) { setActivePreset(null); applyFilter('') }
                        else { setActivePreset(p.id); applyFilter(p.pattern) }
                      }}
                    >
                      {p.label}
                    </button>
                    <button className="filter-preset-delete" onClick={() => handleDeletePreset(p.id)} title="Delete preset">×</button>
                  </span>
                ))}
              </div>
              <div className="filter-results" ref={filterResultsRef}>
                {regexError ? (
                  <div className="filter-empty" style={{ color: 'var(--danger)' }}>Invalid regex: {regexError}</div>
                ) : !filterText ? (
                  <div className="filter-empty">Type to filter, or pick a preset above</div>
                ) : filterLines.length === 0 ? (
                  <div className="filter-empty">No matches</div>
                ) : filterLines.map((line, i) => {
                  const { includeRe } = parseFilter(filterText, isRegexMode)
                  const safe = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  const html = includeRe ? safe.replace(includeRe, (m) => `<mark class="filter-match">${m}</mark>`) : safe
                  return <div key={i} className="filter-line" dangerouslySetInnerHTML={{ __html: html }} />
                })}
              </div>
            </div>
          )}

          {/* Ctrl+C dialog */}
          {ctrlCDialog && (
            <div className="ctrlc-backdrop" onClick={handleCtrlCBreak}>
              <div className="ctrlc-dialog" onClick={(e) => e.stopPropagation()}>
                <span className="ctrlc-label">Ctrl+C — Copy or Break?</span>
                <div className="ctrlc-buttons">
                  <button autoFocus className="ctrlc-btn primary" onClick={handleCtrlCCopy}>Copy</button>
                  <button className="ctrlc-btn" onClick={handleCtrlCBreak}>Break</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Split pane */}
        {tab.splitChannelId && tab.splitConfig && (
          <>
            <div
              className="split-divider"
              onMouseDown={(e) => {
                e.preventDefault()
                const container = e.currentTarget.parentElement
                const totalW = container.offsetWidth
                const onMove = (ev) => {
                  const ratio = Math.max(0.2, Math.min(0.8, (ev.clientX - container.getBoundingClientRect().left) / totalW))
                  container.children[0].style.flex = ratio
                  container.children[2].style.flex = 1 - ratio
                }
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                  setTimeout(() => { try { fitAddonRef.current?.fit() } catch (_) {} }, 50)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
            />
            <div className="terminal-wrapper" style={{ flex: 1 }}>
              <SplitTerminalPane host={host}
                key={tab.splitChannelId}
                channelId={tab.splitChannelId}
                config={tab.splitConfig}
                termInstanceRef={splitTermRef}
                onFocused={() => { focusedPaneRef.current = 'split' }}
                onClose={() => { removeSplitPane(tab.id); focusedPaneRef.current = 'main' }}
              />
            </div>
          </>
        )}

        {/* SFTP panel */}
        {showSftp && connected && !tab.isLocal && (
          <>
            <div
              className="split-divider"
              onMouseDown={(e) => {
                e.preventDefault()
                const startX = e.clientX
                const startW = sftpWidth
                const onMove = (ev) => setSftpWidth(Math.max(200, Math.min(800, startW + (startX - ev.clientX))))
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                  setTimeout(() => { try { fitAddonRef.current?.fit() } catch (_) {} }, 50)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
            />
            <SftpPanel host={host}
              channelId={tab.channelId}
              cwd={cwd}
              width={sftpWidth}
              sessionKey={tab.config ? `${tab.config.host}:${tab.config.port || 22}` : tab.channelId}
              onEditFile={handleEditFile}
            />
          </>
        )}
      </div>

      {/* Remote file editor overlay */}
      {editingFile && (
        <FileEditor host={host}
          editingFile={editingFile}
          textareaRef={editorTextareaRef}
          onSave={handleSaveFile}
          onClose={handleCloseEditor}
          onChange={(value) => setEditingFile((prev) => prev ? { ...prev, content: value } : null)}
        />
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div className="context-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={handleCopy} disabled={!ctxMenu.hasSelection}>Copy</button>
          <button onClick={handlePaste}>Paste</button>
        </div>
      )}
    </div>
  )
}
