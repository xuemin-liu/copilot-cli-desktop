import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { buildLogicalLine, scanLineForLinks, type DetectedLink } from '../terminal-links.js'
import { decodeOsc52ClipboardWrite } from '../osc52-clipboard.js'

export interface TerminalPaneProps {
  tabId: string
  active: boolean
}

export function TerminalPane({ tabId, active }: TerminalPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#0b1020',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    fitAddon.fit()
    terminalRef.current = terminal
    fitRef.current = fitAddon

    // Copilot writes OSC 52 before trying its OS clipboard backend. On the
    // affected Windows releases its quoted cmd.exe -> clip.exe invocation
    // exits with code 1; accepting OSC 52 here gives the embedded terminal
    // the same clipboard fallback that supporting native terminals provide.
    const osc52Disposable = terminal.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52ClipboardWrite(data)
      if (text !== null) void window.copilotDesktop.copyText(text)
      // Consume every OSC 52 command. In particular, do not answer clipboard
      // read requests from terminal output and expose desktop clipboard data.
      return true
    })

    const openLink = (link: DetectedLink): void => {
      if (link.type === 'url') void window.copilotDesktop.openExternalUrl(link.text)
      else void window.copilotDesktop.revealPath(tabId, link.text)
    }
    // Use xterm's link provider instead of capturing and replaying left-mouse
    // gestures. Copilot therefore receives native mouse selection and scroll
    // input unchanged while printed URLs and paths remain clickable.
    const linkDisposable = terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const row = bufferLineNumber - 1
        const logical = buildLogicalLine((line) => terminal.buffer.active.getLine(line), terminal.cols, row)
        const links = scanLineForLinks(logical.text).flatMap((link) => {
          const first = logical.cells[link.start]
          const last = logical.cells[link.end - 1]
          if (!first || !last) return []
          return [{
            text: link.text,
            range: {
              start: { x: first.column + 1, y: first.row + 1 },
              end: { x: last.column + last.width, y: last.row + 1 },
            },
            activate: () => openLink(link),
          }]
        })
        callback(links.length > 0 ? links : undefined)
      },
    })

    const copySelection = (): boolean => {
      if (!terminal.hasSelection()) return false
      void window.copilotDesktop.copyText(terminal.getSelection())
      terminal.clearSelection()
      return true
    }

    // Unmodified mouse gestures belong to Copilot's native TUI. A user can
    // still hold Shift to make an xterm selection; copy that fallback through
    // Electron, while Ctrl+C without an xterm selection reaches Copilot.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c') {
        return !copySelection()
      }
      return true
    })

    const handlePasteKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'v') return
      event.preventDefault()
      event.stopPropagation()
      void window.copilotDesktop.readClipboardText().then((text) => {
        if (text) terminal.paste(text)
      })
    }
    container.addEventListener('keydown', handlePasteKey, true)

    const handleContextMenu = (event: MouseEvent): void => {
      if (!terminal.hasSelection()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void window.copilotDesktop.showTerminalContextMenu(terminal.getSelection())
    }
    // Only intercept right-click for Shift/xterm selections. Otherwise the
    // mouse sequence remains Copilot-owned and its native selected-text copy
    // reaches this app through the OSC 52 handler above.
    container.addEventListener('contextmenu', handleContextMenu, true)

    terminal.onData((data) => {
      void window.copilotDesktop.writeTab(tabId, data)
    })

    // Copilot's selection-copy redraw can erase the viewport and restore the
    // same cells in one burst. xterm occasionally leaves that restored buffer
    // unpainted until a resize invalidates the viewport. Coalesce parsed PTY
    // output to one full invalidation per animation frame—the same recovery a
    // resize causes, without repainting once per transport chunk.
    let outputRefreshFrame = 0
    const writeParsedDisposable = terminal.onWriteParsed(() => {
      if (outputRefreshFrame) return
      outputRefreshFrame = requestAnimationFrame(() => {
        outputRefreshFrame = 0
        if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1)
      })
    })

    // Subscribe before fetching the backlog so startup output cannot fall in
    // the gap between those operations.
    let backlogApplied = false
    const bufferedLive: string[] = []
    const unsubscribe = window.copilotDesktop.onTabOutput((payload) => {
      if (payload.tabId !== tabId) return
      if (!backlogApplied) {
        bufferedLive.push(payload.data)
        return
      }
      terminal.write(payload.data)
    })
    void window.copilotDesktop.getTabBacklog(tabId).then((backlog) => {
      if (backlog) terminal.write(backlog)
      for (const chunk of bufferedLive) terminal.write(chunk)
      bufferedLive.length = 0
      backlogApplied = true
    })

    let fitFrame = 0
    const fitTerminal = (): void => {
      cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(() => {
        fitAddon.fit()
        void window.copilotDesktop.resizeTab(tabId, terminal.cols, terminal.rows)
      })
    }
    const resizeObserver = new ResizeObserver(fitTerminal)
    resizeObserver.observe(container)

    return () => {
      unsubscribe()
      cancelAnimationFrame(fitFrame)
      cancelAnimationFrame(outputRefreshFrame)
      resizeObserver.disconnect()
      container.removeEventListener('keydown', handlePasteKey, true)
      container.removeEventListener('contextmenu', handleContextMenu, true)
      linkDisposable.dispose()
      osc52Disposable.dispose()
      writeParsedDisposable.dispose()
      terminal.dispose()
    }
    // Intentionally only re-run when the bound tab changes: this effect owns
    // the terminal instance's full lifecycle for the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    if (!active) return
    fitRef.current?.fit()
    terminalRef.current?.focus()
  }, [active])

  return <div ref={containerRef} className={`terminal-pane${active ? ' terminal-pane-active' : ''}`} />
}
