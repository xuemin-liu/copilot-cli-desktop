import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { buildLogicalLine, scanLineForLinks, type DetectedLink } from '../terminal-links.js'
import {
  decodeOsc52ClipboardWrite,
  Osc52ClipboardSynchronizer,
  stripOsc52Commands,
} from '../osc52-clipboard.js'
import {
  ClipboardCopyStatusMatcher,
  ClipboardRedrawRecovery,
  clipboardRedrawOutput,
  isCursorHome,
  normalizeClipboardSnapshot,
} from '../terminal-redraw.js'

export interface TerminalPaneProps {
  tabId: string
  active: boolean
  sessionProcessId: number | null
}

export function TerminalPane({ tabId, active, sessionProcessId }: TerminalPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const clipboardRedrawRef = useRef<ClipboardRedrawRecovery | null>(null)
  const copyStatusMatcherRef = useRef<ClipboardCopyStatusMatcher | null>(null)

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

    const clipboardRedraw = new ClipboardRedrawRecovery({
      captureSnapshot: () => normalizeClipboardSnapshot(
        serializeAddon.serialize({ scrollback: 0, excludeModes: true }),
      ),
      completeSynchronizedOutput: (snapshot, showCopyStatus) => {
        // Ending synchronized-output mode makes xterm paint the completed
        // state once, without exposing Copilot's intermediate blank frame.
        terminal.write(clipboardRedrawOutput(terminal.rows, snapshot, showCopyStatus))
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timerId) => window.clearTimeout(timerId),
    })
    const clipboardSynchronizer = new Osc52ClipboardSynchronizer(
      () => clipboardRedraw.prepareClipboardCopy(),
    )
    const copyStatusMatcher = new ClipboardCopyStatusMatcher()
    clipboardRedrawRef.current = clipboardRedraw
    copyStatusMatcherRef.current = copyStatusMatcher
    // Copilot writes OSC 52 before trying its OS clipboard backend. On the
    // affected Windows releases its quoted cmd.exe -> clip.exe invocation
    // exits with code 1; accepting OSC 52 here gives the embedded terminal
    // the same clipboard fallback that supporting native terminals provide.
    const osc52Disposable = terminal.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52ClipboardWrite(data)
      if (text !== null) {
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

    const writePtyOutput = (data: string): void => {
      const synchronizedData = clipboardSynchronizer.push(data)
      if (synchronizedData === '') return
      terminal.write(synchronizedData, () => {
        if (!clipboardRedraw.isAwaitingCopyStatus()) {
          copyStatusMatcher.reset()
          return
        }
        const copyStatusRendered = copyStatusMatcher.push(synchronizedData)
        clipboardRedraw.onOutputParsed(copyStatusRendered)
        if (copyStatusRendered) copyStatusMatcher.reset()
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
        fitAddon.fit()
        void window.copilotDesktop.resizeTab(tabId, terminal.cols, terminal.rows)
      })
    }
    const resizeObserver = new ResizeObserver(fitTerminal)
    resizeObserver.observe(container)

    return () => {
      unsubscribe()
      cancelAnimationFrame(fitFrame)
      clipboardRedraw.dispose()
      if (clipboardRedrawRef.current === clipboardRedraw) clipboardRedrawRef.current = null
      if (copyStatusMatcherRef.current === copyStatusMatcher) copyStatusMatcherRef.current = null
      resizeObserver.disconnect()
      container.removeEventListener('keydown', handlePasteKey, true)
      container.removeEventListener('contextmenu', handleContextMenu, true)
      linkDisposable.dispose()
      osc52Disposable.dispose()
      cursorHomeDisposable.dispose()
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
    copyStatusMatcherRef.current?.reset()
    clipboardRedrawRef.current?.rearm()
  }, [sessionProcessId])

  useEffect(() => {
    if (!active) return
    fitRef.current?.fit()
    terminalRef.current?.focus()
  }, [active])

  return <div ref={containerRef} className={`terminal-pane${active ? ' terminal-pane-active' : ''}`} />
}
