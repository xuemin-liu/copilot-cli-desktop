import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  buildLogicalLine,
  cellIndexAt,
  linkAtColumn,
  segmentsForLink,
  type DetectedLink,
  type LinkSegment,
} from '../terminal-links.js'

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

    // Copilot continuously redraws its TUI. Retain both the selected text and
    // its buffer range so the highlight can be restored after a redraw; only
    // an explicit copy command should modify the clipboard.
    let retainedSelection = ''
    let retainedSelectionRange: { column: number; row: number; length: number } | null = null
    let selectionRenderFrame = 0
    let selectionMetrics: { left: number; top: number; cellWidth: number; cellHeight: number } | null = null
    const selectionOverlay = document.createElement('div')
    selectionOverlay.className = 'terminal-retained-selection-overlay'
    Object.assign(selectionOverlay.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '10',
    })
    // Keep this outside xterm's managed DOM. Its renderer may replace screen
    // layers during a TUI repaint, which would otherwise remove the overlay.
    container.appendChild(selectionOverlay)
    const updateSelectionMetrics = (): void => {
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      if (!screen || terminal.cols < 1 || terminal.rows < 1) {
        selectionMetrics = null
        return
      }
      const screenBounds = screen.getBoundingClientRect()
      const containerBounds = container.getBoundingClientRect()
      selectionMetrics = {
        left: screenBounds.left - containerBounds.left,
        top: screenBounds.top - containerBounds.top,
        cellWidth: screenBounds.width / terminal.cols,
        cellHeight: screenBounds.height / terminal.rows,
      }
    }
    const renderRetainedSelection = (): void => {
      selectionOverlay.replaceChildren()
      const range = retainedSelectionRange
      const metrics = selectionMetrics
      if (!range || !metrics || terminal.cols < 1 || terminal.rows < 1) return

      const viewportStart = terminal.buffer.active.viewportY
      const viewportEnd = viewportStart + terminal.rows - 1
      const startOffset = range.row * terminal.cols + range.column
      const endOffset = startOffset + range.length
      const firstRow = Math.floor(startOffset / terminal.cols)
      const lastRow = Math.floor((endOffset - 1) / terminal.cols)
      for (let row = Math.max(firstRow, viewportStart); row <= Math.min(lastRow, viewportEnd); row++) {
        const firstColumn = row === firstRow ? startOffset % terminal.cols : 0
        const lastColumn = row === lastRow ? ((endOffset - 1) % terminal.cols) + 1 : terminal.cols
        const highlight = document.createElement('div')
        Object.assign(highlight.style, {
          position: 'absolute',
          left: `${metrics.left + firstColumn * metrics.cellWidth}px`,
          top: `${metrics.top + (row - viewportStart) * metrics.cellHeight}px`,
          width: `${Math.max(1, lastColumn - firstColumn) * metrics.cellWidth}px`,
          height: `${metrics.cellHeight}px`,
          background: 'rgba(88, 166, 255, 0.42)',
        })
        selectionOverlay.appendChild(highlight)
      }
    }
    const scheduleRetainedSelectionRender = (): void => {
      if (selectionRenderFrame) return
      selectionRenderFrame = requestAnimationFrame(() => {
        selectionRenderFrame = 0
        renderRetainedSelection()
      })
    }
    updateSelectionMetrics()
    const activeSelection = (): string => retainedSelection || (terminal.hasSelection() ? terminal.getSelection() : '')
    const retainCurrentSelection = (): void => {
      const position = terminal.getSelectionPosition()
      if (!position) return
      const startOffset = position.start.y * terminal.cols + position.start.x
      const endOffset = position.end.y * terminal.cols + position.end.x
      const range = {
        column: startOffset % terminal.cols,
        row: Math.floor(startOffset / terminal.cols),
        length: Math.max(1, endOffset - startOffset),
      }
      retainedSelectionRange = range
      const captureText = (): void => {
        if (retainedSelectionRange !== range) return
        const selection = terminal.getSelection()
        if (selection) retainedSelection = selection
      }
      // xterm updates selected text after select() establishes the range.
      // Paint immediately, then capture the text on the following frame.
      captureText()
      requestAnimationFrame(captureText)
      scheduleRetainedSelectionRender()
    }
    const clearRetainedSelection = (): void => {
      retainedSelection = ''
      retainedSelectionRange = null
      terminal.clearSelection()
      scheduleRetainedSelectionRender()
    }
    const restoreRetainedSelection = (): void => {
      const range = retainedSelectionRange
      if (!range) return
      const viewportStart = terminal.buffer.active.viewportY
      const viewportEnd = viewportStart + terminal.rows - 1
      const startOffset = range.row * terminal.cols + range.column
      const endOffset = startOffset + range.length
      const firstRow = Math.floor(startOffset / terminal.cols)
      const lastRow = Math.floor((endOffset - 1) / terminal.cols)
      if (lastRow < viewportStart || firstRow > viewportEnd) {
        clearRetainedSelection()
        return
      }
      const applySelection = (): void => {
        if (retainedSelectionRange !== range) return
        terminal.select(range.column, range.row, range.length)
        // A TUI repaint can replace the cells under a retained range. Keep the
        // copied value synchronized with the text currently highlighted.
        retainedSelection = terminal.getSelection()
        scheduleRetainedSelectionRender()
      }
      applySelection()
      // xterm applies mouse-mode and TUI render updates after the originating
      // event. Reapply on the following paint so that late work cannot erase
      // the visual highlight while the retained selection still exists.
      requestAnimationFrame(applySelection)
    }
    const copySelection = (): boolean => {
      const selection = activeSelection()
      if (!selection) return false
      void window.copilotDesktop.copyText(selection)
      // Match native terminals: copying consumes the selection, so a second
      // Ctrl+C reaches the PTY instead of repeatedly copying stale text.
      clearRetainedSelection()
      return true
    }

    const bufferPoint = (clientX: number, clientY: number): { column: number; row: number } => {
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) return { column: 0, row: terminal.buffer.active.viewportY }
      const bounds = screen.getBoundingClientRect()
      const viewportColumn = Math.max(0, Math.min(
        terminal.cols - 1,
        Math.floor((clientX - bounds.left) / (bounds.width / terminal.cols)),
      ))
      const viewportRow = Math.max(0, Math.min(
        terminal.rows - 1,
        Math.floor((clientY - bounds.top) / (bounds.height / terminal.rows)),
      ))
      return {
        column: viewportColumn,
        row: terminal.buffer.active.viewportY + viewportRow,
      }
    }
    // `point.column` is a display-cell coordinate; `DetectedLink` ranges are
    // string indices into the reassembled logical line (which may span
    // multiple wrapped rows and account for wide characters) — resolve one
    // into the other via the buffer's actual cells rather than assuming a
    // 1:1 column-to-character mapping.
    const linkAtBufferPoint = (point: { row: number; column: number }): { link: DetectedLink; segments: LinkSegment[] } | null => {
      const logical = buildLogicalLine((row) => terminal.buffer.active.getLine(row), terminal.cols, point.row)
      const index = cellIndexAt(logical.cells, point.row, point.column)
      if (index === -1) return null
      const link = linkAtColumn(logical.text, index)
      if (!link) return null
      return { link, segments: segmentsForLink(logical.cells, link) }
    }
    const linkAtClientPoint = (clientX: number, clientY: number): DetectedLink | null => {
      return linkAtBufferPoint(bufferPoint(clientX, clientY))?.link ?? null
    }
    const openLink = (link: DetectedLink): void => {
      if (link.type === 'url') void window.copilotDesktop.openExternalUrl(link.text)
      else void window.copilotDesktop.revealPath(tabId, link.text)
    }

    // Underlines the link under the cursor so file paths and URLs the CLI
    // prints read as clickable, without touching xterm's own DOM (a redraw
    // could remove a decoration attached there).
    const linkOverlay = document.createElement('div')
    linkOverlay.className = 'terminal-link-hover-overlay'
    Object.assign(linkOverlay.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '11',
    })
    container.appendChild(linkOverlay)
    let hoveredSegments: LinkSegment[] = []
    const renderLinkHover = (): void => {
      linkOverlay.replaceChildren()
      container.style.cursor = hoveredSegments.length > 0 ? 'pointer' : ''
      if (!selectionMetrics) return
      const viewportStart = terminal.buffer.active.viewportY
      for (const segment of hoveredSegments) {
        const viewportRow = segment.row - viewportStart
        if (viewportRow < 0 || viewportRow >= terminal.rows) continue
        const underline = document.createElement('div')
        Object.assign(underline.style, {
          position: 'absolute',
          left: `${selectionMetrics.left + segment.startColumn * selectionMetrics.cellWidth}px`,
          top: `${selectionMetrics.top + (viewportRow + 1) * selectionMetrics.cellHeight - 2}px`,
          width: `${(segment.endColumn - segment.startColumn) * selectionMetrics.cellWidth}px`,
          height: '1px',
          background: '#e6edf3',
        })
        linkOverlay.appendChild(underline)
      }
    }
    const segmentsEqual = (left: LinkSegment[], right: LinkSegment[]): boolean => left.length === right.length
      && left.every((segment, index) => {
        const other = right[index]
        return other !== undefined && segment.row === other.row && segment.startColumn === other.startColumn && segment.endColumn === other.endColumn
      })
    const handleHoverMove = (moveEvent: MouseEvent): void => {
      // A pending click/drag gesture already owns cursor/coordinate semantics.
      if (cancelPendingLeftGesture) return
      const point = bufferPoint(moveEvent.clientX, moveEvent.clientY)
      const segments = linkAtBufferPoint(point)?.segments ?? []
      if (segmentsEqual(segments, hoveredSegments)) return
      hoveredSegments = segments
      renderLinkHover()
    }
    const clearLinkHover = (): void => {
      if (hoveredSegments.length === 0) return
      hoveredSegments = []
      renderLinkHover()
    }
    container.addEventListener('mousemove', handleHoverMove)
    container.addEventListener('mouseleave', clearLinkHover)

    // Copilot needs terminal mouse reporting for clickable TUI controls such
    // as Sessions, while xterm normally reserves an unmodified left drag for
    // the application whenever that mode is active. Delay forwarding the
    // press until we know whether this is a click or a drag: clicks go to
    // Copilot, while drags select the corresponding buffer range directly.
    const replayedMouseEvents = new WeakSet<MouseEvent>()
    let cancelPendingLeftGesture: (() => void) | null = null

    const replayMouseEvent = (target: EventTarget, type: 'mousedown' | 'mouseup', init: MouseEventInit): void => {
      const replayed = new MouseEvent(type, init)
      replayedMouseEvents.add(replayed)
      target.dispatchEvent(replayed)
    }

    const handleLeftMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0 || replayedMouseEvents.has(event)) return

      cancelPendingLeftGesture?.()
      clearLinkHover()
      event.preventDefault()
      event.stopImmediatePropagation()
      terminal.focus()

      const startX = event.clientX
      const startY = event.clientY
      const downInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: event.detail,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        button: 0,
        buttons: 1,
      }
      let dragging = false
      const selectionStart = bufferPoint(startX, startY)
      const updateSelection = (clientX: number, clientY: number): void => {
        const selectionEnd = bufferPoint(clientX, clientY)
        const startOffset = selectionStart.row * terminal.cols + selectionStart.column
        const endOffset = selectionEnd.row * terminal.cols + selectionEnd.column
        const firstOffset = Math.min(startOffset, endOffset)
        const lastOffset = Math.max(startOffset, endOffset)
        terminal.select(firstOffset % terminal.cols, Math.floor(firstOffset / terminal.cols), Math.max(1, lastOffset - firstOffset))
        retainCurrentSelection()
      }
      const selectWord = (clientX: number, clientY: number): void => {
        const point = bufferPoint(clientX, clientY)
        const text = terminal.buffer.active.getLine(point.row)?.translateToString(false) ?? ''
        const isSeparator = (character: string | undefined): boolean => !character
          || /\s/.test(character)
          || (terminal.options.wordSeparator ?? '').includes(character)
        let firstColumn = point.column
        let lastColumn = point.column
        while (firstColumn > 0 && !isSeparator(text[firstColumn - 1])) firstColumn--
        while (lastColumn < text.length && !isSeparator(text[lastColumn])) lastColumn++
        terminal.select(firstColumn, point.row, Math.max(1, lastColumn - firstColumn))
        retainCurrentSelection()
      }

      const cleanup = (): void => {
        document.removeEventListener('mousemove', handleMouseMove, true)
        document.removeEventListener('mouseup', handleMouseUp, true)
        if (cancelPendingLeftGesture === cleanup) cancelPendingLeftGesture = null
      }
      const handleMouseMove = (moveEvent: MouseEvent): void => {
        if (dragging) {
          moveEvent.preventDefault()
          moveEvent.stopImmediatePropagation()
          updateSelection(moveEvent.clientX, moveEvent.clientY)
          return
        }
        const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY)
        if (moved < 4) {
          moveEvent.preventDefault()
          moveEvent.stopImmediatePropagation()
          return
        }

        dragging = true
        moveEvent.preventDefault()
        moveEvent.stopImmediatePropagation()
        updateSelection(moveEvent.clientX, moveEvent.clientY)
      }
      const handleMouseUp = (upEvent: MouseEvent): void => {
        cleanup()
        if (dragging) {
          // Keep xterm's mouse-reporting handler from consuming the release
          // after our app-owned drag selection and clearing its highlight.
          upEvent.preventDefault()
          upEvent.stopImmediatePropagation()
          updateSelection(upEvent.clientX, upEvent.clientY)
          restoreRetainedSelection()
          return
        }

        clearRetainedSelection()
        upEvent.preventDefault()
        upEvent.stopImmediatePropagation()
        if ((downInit.detail ?? 1) >= 2) {
          if ((downInit.detail ?? 1) >= 3) {
            const point = bufferPoint(upEvent.clientX, upEvent.clientY)
            terminal.selectLines(point.row, point.row)
            retainCurrentSelection()
          } else {
            selectWord(upEvent.clientX, upEvent.clientY)
          }
          return
        }
        // A plain click on a file path or URL the CLI printed opens it locally
        // instead of forwarding the click to Copilot's TUI as a button press.
        const clickedLink = linkAtClientPoint(upEvent.clientX, upEvent.clientY)
        if (clickedLink) {
          openLink(clickedLink)
          return
        }
        // xterm may replace row elements while a gesture is pending. Resolve a
        // live target at replay time rather than dispatching to a detached node.
        const replayTarget = document.elementFromPoint(upEvent.clientX, upEvent.clientY)
          ?? terminal.element
          ?? container
        replayMouseEvent(replayTarget, 'mousedown', downInit)
        replayMouseEvent(replayTarget, 'mouseup', {
          ...downInit,
          detail: upEvent.detail,
          screenX: upEvent.screenX,
          screenY: upEvent.screenY,
          clientX: upEvent.clientX,
          clientY: upEvent.clientY,
          buttons: 0,
        })
      }

      cancelPendingLeftGesture = cleanup
      document.addEventListener('mousemove', handleMouseMove, true)
      document.addEventListener('mouseup', handleMouseUp, true)
    }
    container.addEventListener('mousedown', handleLeftMouseDown, true)

    // In a terminal Ctrl+C normally sends an interrupt. Match native terminal
    // behavior by copying only when text is selected; with no selection the
    // key continues through onData to Copilot as usual.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c') {
        return !copySelection()
      }
      if (event.type === 'keydown' && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
        clearRetainedSelection()
      }
      return true
    })

    const handlePasteKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'v') return
      event.preventDefault()
      event.stopPropagation()
      clearRetainedSelection()
      void window.copilotDesktop.readClipboardText().then((text) => {
        if (text) terminal.paste(text)
      })
    }
    container.addEventListener('keydown', handlePasteKey, true)

    const handleNonPrimaryMouse = (event: MouseEvent): void => {
      if (event.button !== 1 && event.button !== 2) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const handleContextMenu = (event: MouseEvent): void => {
      const selection = activeSelection()
      event.preventDefault()
      event.stopImmediatePropagation()
      if (selection) void window.copilotDesktop.showTerminalContextMenu(selection)
    }
    // Copilot enables terminal mouse reporting. Consume right- and middle-click
    // sequences in the capture phase so xterm cannot forward them to the CLI.
    container.addEventListener('mousedown', handleNonPrimaryMouse, true)
    container.addEventListener('mouseup', handleNonPrimaryMouse, true)
    container.addEventListener('auxclick', handleNonPrimaryMouse, true)
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
      terminal.write(payload.data, restoreRetainedSelection)
    })
    void window.copilotDesktop.getTabBacklog(tabId).then((backlog) => {
      if (backlog) terminal.write(backlog, restoreRetainedSelection)
      for (const chunk of bufferedLive) terminal.write(chunk, restoreRetainedSelection)
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
        updateSelectionMetrics()
        restoreRetainedSelection()
        void window.copilotDesktop.resizeTab(tabId, terminal.cols, terminal.rows)
      })
    }
    const resizeObserver = new ResizeObserver(fitTerminal)
    resizeObserver.observe(container)
    terminal.onScroll(() => {
      restoreRetainedSelection()
      // The row under the pointer changes on scroll without a mousemove; drop
      // the stale hover rather than leave an underline over the wrong text.
      clearLinkHover()
    })

    return () => {
      unsubscribe()
      cancelAnimationFrame(fitFrame)
      cancelAnimationFrame(selectionRenderFrame)
      resizeObserver.disconnect()
      cancelPendingLeftGesture?.()
      container.removeEventListener('mousedown', handleLeftMouseDown, true)
      container.removeEventListener('keydown', handlePasteKey, true)
      container.removeEventListener('mousedown', handleNonPrimaryMouse, true)
      container.removeEventListener('mouseup', handleNonPrimaryMouse, true)
      container.removeEventListener('auxclick', handleNonPrimaryMouse, true)
      container.removeEventListener('contextmenu', handleContextMenu, true)
      container.removeEventListener('mousemove', handleHoverMove)
      container.removeEventListener('mouseleave', clearLinkHover)
      selectionOverlay.remove()
      linkOverlay.remove()
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
