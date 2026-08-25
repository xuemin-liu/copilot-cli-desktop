import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

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

    const copySelection = (): boolean => {
      if (!terminal.hasSelection()) return false
      void window.copilotDesktop.copyText(terminal.getSelection())
      return true
    }

    // In a terminal Ctrl+C normally sends an interrupt. Match native terminal
    // behavior by copying only when text is selected; with no selection the
    // key continues through onData to Copilot as usual.
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

    const handleRightMouse = (event: MouseEvent): void => {
      if (event.button !== 2 || !terminal.hasSelection()) return
      event.preventDefault()
      event.stopPropagation()
    }
    const handleContextMenu = (event: MouseEvent): void => {
      if (!terminal.hasSelection()) return
      event.preventDefault()
      event.stopPropagation()
      void window.copilotDesktop.showTerminalContextMenu(terminal.getSelection())
    }
    const handleSelectionMouseUp = (event: MouseEvent): void => {
      if (event.button !== 0) return
      // xterm finalizes its selection during mouseup. Run after that handler
      // and copy automatically so clipboard behavior does not depend on a
      // second gesture being interpreted consistently by the terminal TUI.
      requestAnimationFrame(copySelection)
    }
    // Copilot enables terminal mouse reporting. Consume the full right-click
    // sequence in the capture phase so xterm cannot forward it to the CLI.
    container.addEventListener('mousedown', handleRightMouse, true)
    container.addEventListener('mouseup', handleRightMouse, true)
    container.addEventListener('mouseup', handleSelectionMouseUp)
    container.addEventListener('contextmenu', handleContextMenu, true)

    terminal.onData((data) => {
      void window.copilotDesktop.writeTab(tabId, data)
    })

    // A pty can emit its startup banner or an approval prompt before this
    // component mounts and subscribes (e.g. a background tab created while
    // another tab is active). Subscribe first — buffering any output that
    // arrives while the backlog request is in flight — then fetch and
    // replay the backlog, then flush anything buffered in the meantime, so
    // no output is silently dropped regardless of timing.
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
      // Window restore/maximize can report an intermediate container size.
      // Fit on the next painted layout so xterm never keeps a fractional last
      // row calculated from the previous window dimensions.
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
      resizeObserver.disconnect()
      container.removeEventListener('keydown', handlePasteKey, true)
      container.removeEventListener('mousedown', handleRightMouse, true)
      container.removeEventListener('mouseup', handleRightMouse, true)
      container.removeEventListener('mouseup', handleSelectionMouseUp)
      container.removeEventListener('contextmenu', handleContextMenu, true)
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
