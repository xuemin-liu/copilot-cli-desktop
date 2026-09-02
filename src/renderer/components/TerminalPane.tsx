import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { buildLogicalLine, scanLineForLinks, type DetectedLink } from '../terminal-links.js'
import { ClipboardWriteGate, decodeOsc52ClipboardWrite, stripOsc52Commands } from '../osc52-clipboard.js'
import {
  ClipboardRedrawRecovery,
  NativeCopyGestureTracker,
  clipboardRedrawOutput,
  isClipboardOnlyViewport,
  isCursorHome,
  normalizeClipboardSnapshot,
} from '../terminal-redraw.js'

export interface TerminalPaneProps {
  tabId: string
  active: boolean
  focused?: boolean
  sessionProcessId: number | null
}

export function TerminalPane({ tabId, active, focused = active, sessionProcessId }: TerminalPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const clipboardRedrawRef = useRef<ClipboardRedrawRecovery | null>(null)

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
    const serializeAddon = new SerializeAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(serializeAddon)
    terminal.open(container)
    fitAddon.fit()
    terminalRef.current = terminal
    fitRef.current = fitAddon

    const copyStatusElement = document.createElement('div')
    copyStatusElement.className = 'terminal-copy-status'
    copyStatusElement.textContent = 'copied to clipboard'
    container.appendChild(copyStatusElement)
    let copyStatusTimer = 0
    const showCopyConfirmation = (): void => {
      window.clearTimeout(copyStatusTimer)
      copyStatusElement.classList.add('terminal-copy-status-visible')
      copyStatusTimer = window.setTimeout(() => {
        copyStatusElement.classList.remove('terminal-copy-status-visible')
      }, 1_800)
    }

    const clipboardRedraw = new ClipboardRedrawRecovery({
      captureSnapshot: () => normalizeClipboardSnapshot(
        serializeAddon.serialize({ scrollback: 0, excludeModes: true }),
      ),
      beginSynchronizedOutput: () => {
        // This runs during the input event, before the gesture reaches the PTY.
        // Incoming process output is therefore queued after the mode change.
        terminal.write('\u001b[?2026h')
      },
      isViewportCollapsed: () => {
        const lines: string[] = []
        for (let row = 0; row < terminal.rows; row += 1) {
          lines.push(terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? '')
        }
        return isClipboardOnlyViewport(lines)
      },
      completeSynchronizedOutput: (snapshot, showCopyStatus) => {
        // Ending synchronized-output mode makes xterm paint the completed
        // state once, without exposing Copilot's intermediate blank frame.
        terminal.write(clipboardRedrawOutput(snapshot), () => {
          if (showCopyStatus) showCopyConfirmation()
        })
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timerId) => window.clearTimeout(timerId),
    })
    clipboardRedrawRef.current = clipboardRedraw
    const nativeCopyGesture = new NativeCopyGestureTracker()
    const clipboardWriteGate = new ClipboardWriteGate()
    // Copilot writes OSC 52 before trying its OS clipboard backend. On the
    // affected Windows releases its quoted cmd.exe -> clip.exe invocation
    // exits with code 1; accepting OSC 52 here gives the embedded terminal
    // the same clipboard fallback that supporting native terminals provide.
    const osc52Disposable = terminal.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52ClipboardWrite(data)
      if (clipboardWriteGate.consumeDecodedWrite(text)) {
        void window.copilotDesktop.copyText(text)

        // Hold xterm rendering across Copilot's first-copy update. Recovery is
        // completed from the actual cursor-home redraw below, not a fixed delay
        // from OSC 52: Copilot 1.0.81 can spend more than 100 ms trying its
        // native clipboard backend before it emits the destructive TUI frame.
        clipboardRedraw.onClipboardCopy()
      }
      // Consume every OSC 52 command. In particular, do not answer clipboard
      // read requests from terminal output and expose desktop clipboard data.
      return true
    })

    // Copilot's top-left cursor move confirms that its destructive first-copy
    // redraw has begun. The healthy snapshot was already captured at OSC 52;
    // Copilot 1.0.81 can mutate cells before this parser boundary is observed.
    const cursorHomeDisposable = terminal.parser.registerCsiHandler({ final: 'H' }, (params) => {
      if (isCursorHome(params)) clipboardRedraw.onCursorHome()
      return false
    })
    const eraseLineDisposable = terminal.parser.registerCsiHandler({ final: 'K' }, () => {
      clipboardRedraw.onEraseLine(terminal.rows)
      return false
    })

    const writePtyOutput = (data: string): void => {
      terminal.write(data, () => {
        let copyStatusRendered = false
        if (clipboardRedraw.isAwaitingCopyStatus()) {
          for (let row = 0; row < terminal.rows; row += 1) {
            const line = terminal.buffer.active
              .getLine(terminal.buffer.active.viewportY + row)
              ?.translateToString(true)
              .trim()
            if (line?.toLowerCase() === 'copied to clipboard') {
              copyStatusRendered = true
              break
            }
          }
        }
        clipboardRedraw.onOutputParsed(copyStatusRendered)
      })
    }

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
        if (copySelection()) return false
        // Ctrl+C is Copilot's interrupt key unless a recent native mouse or
        // keyboard selection identifies this invocation as selected-text copy.
        // Never arm the render guard without that bounded evidence.
        if (nativeCopyGesture.consumeSelection()) {
          clipboardWriteGate.authorize()
          clipboardRedraw.onCopyGesture()
        }
      } else if (event.type === 'keydown') {
        nativeCopyGesture.onKeyDown(event.key, event.shiftKey)
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
    const handleMouseDown = (event: MouseEvent): void => {
      nativeCopyGesture.onMouseDown(event.button, event.shiftKey, event.clientX, event.clientY)
      if (event.button === 2 && !terminal.hasSelection()) {
        // Right-click is Copilot's explicit native copy command, unlike the
        // ambiguous Ctrl+C interrupt. Arm it unconditionally so coalesced or
        // off-element drag events cannot leave the first copy unprotected.
        nativeCopyGesture.consumeSelection()
        clipboardWriteGate.authorize()
        clipboardRedraw.onCopyGesture()
      }
    }
    const handleMouseMove = (event: MouseEvent): void => {
      nativeCopyGesture.onMouseMove(event.buttons, event.clientX, event.clientY)
    }
    const handleMouseUp = (event: MouseEvent): void => {
      nativeCopyGesture.onMouseUp(event.button, event.clientX, event.clientY)
    }
    // Only intercept right-click for Shift/xterm selections. Otherwise the
    // mouse sequence remains Copilot-owned and its native selected-text copy
    // reaches this app through the OSC 52 handler above.
    container.addEventListener('mousedown', handleMouseDown, true)
    container.addEventListener('mousemove', handleMouseMove, true)
    container.addEventListener('mouseup', handleMouseUp, true)
    container.addEventListener('contextmenu', handleContextMenu, true)

    terminal.onData((data) => {
      void window.copilotDesktop.writeTab(tabId, data)
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
      writePtyOutput(payload.data)
    })
    void window.copilotDesktop.getTabBacklog(tabId).then((backlog) => {
      // Backlog is terminal history, not a new command stream. Remove old OSC
      // 52 writes so replay cannot overwrite today's clipboard or consume the
      // first-live-copy recovery before the user copies anything in this pane.
      if (backlog) terminal.write(stripOsc52Commands(backlog))
      for (const chunk of bufferedLive) writePtyOutput(chunk)
      bufferedLive.length = 0
      backlogApplied = true
    })

    let fitFrame = 0
    const fitTerminal = (): void => {
      cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(() => {
        // display:none panes have no usable geometry. Preserve their last
        // viewport instead of sending hidden/placeholder sizes to Copilot.
        if (container.clientWidth === 0 || container.clientHeight === 0) return
        fitAddon.fit()
        void window.copilotDesktop.resizeTab(tabId, terminal.cols, terminal.rows)
      })
    }
    const resizeObserver = new ResizeObserver(fitTerminal)
    resizeObserver.observe(container)

    return () => {
      unsubscribe()
      cancelAnimationFrame(fitFrame)
      window.clearTimeout(copyStatusTimer)
      clipboardRedraw.dispose()
      clipboardWriteGate.clear()
      if (clipboardRedrawRef.current === clipboardRedraw) clipboardRedrawRef.current = null
      resizeObserver.disconnect()
      container.removeEventListener('keydown', handlePasteKey, true)
      container.removeEventListener('mousedown', handleMouseDown, true)
      container.removeEventListener('mousemove', handleMouseMove, true)
      container.removeEventListener('mouseup', handleMouseUp, true)
      container.removeEventListener('contextmenu', handleContextMenu, true)
      linkDisposable.dispose()
      osc52Disposable.dispose()
      cursorHomeDisposable.dispose()
      eraseLineDisposable.dispose()
      copyStatusElement.remove()
      terminal.dispose()
    }
    // Intentionally only re-run when the bound tab changes: this effect owns
    // the terminal instance's full lifecycle for the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    // A restart replaces the Copilot process without replacing this keyed
    // TerminalPane. Re-arm its per-process first-copy workaround whenever the
    // process id changes (including the intermediate null starting state).
    clipboardRedrawRef.current?.rearm()
  }, [sessionProcessId])

  useEffect(() => {
    if (!active) return
    fitRef.current?.fit()
    if (focused) terminalRef.current?.focus()
  }, [active, focused])

  return <div ref={containerRef} className={`terminal-pane${active ? ' terminal-pane-active' : ''}`} />
}
