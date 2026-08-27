import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  buildLogicalLine,
  cellIndexAt,
  findTextRow,
  isWithinScreenBounds,
  linkAtColumn,
  segmentsForLink,
  type DetectedLink,
  type LinkSegment,
} from '../terminal-links.js'
import {
  activateSelection,
  beginApplicationScroll,
  captureSelectionText,
  confirmPendingSelection,
  detachSelection,
  emptyRetainedSelection,
  isApplicationScrollShortcut,
  isCopyShortcut,
  mouseModeForwardsWheel,
  retainedSelectionTextForCopy,
  retainSelection,
  shouldClearSelectionForKey,
} from '../retained-selection.js'

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
        // xterm paints its own selection highlight independently of the
        // custom overlay below, purely from the last select() call — it has
        // no idea whether that range's content still matches what the user
        // actually selected. Two independently-driven highlight layers is
        // how you get a highlight that looks right one moment and wrong the
        // next; making this transparent leaves the carefully match-checked
        // overlay as the only thing the user ever sees. select()/
        // getSelection() still work identically with this set — it only
        // affects paint color.
        selectionBackground: 'transparent',
        selectionInactiveBackground: 'transparent',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    fitAddon.fit()
    terminalRef.current = terminal
    fitRef.current = fitAddon

    // Copilot continuously redraws its TUI, so xterm's own selection is
    // wiped on nearly every write. Retain the selected text and its buffer
    // range ourselves and treat them the way any normal app treats a
    // selection: they stay put until the user replaces or explicitly
    // discards them (a new selection, a click, a copy) — never because some
    // redraw happened to not match for a tick. What CAN change from moment
    // to moment is only whether that text is presently found on screen;
    // The phase separates an active/copyable selection from a hidden one that
    // was invalidated by an opaque alternate-screen scroll. That distinction
    // matters for Ctrl+C: detached cached text must not consume an interrupt.
    let retainedSelectionState = emptyRetainedSelection()
    let mismatchCheckFrame = 0
    let ignoredScrollTimer = 0
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
      const range = retainedSelectionState.range
      const metrics = selectionMetrics
      if (!range || !metrics || retainedSelectionState.phase !== 'active' || terminal.cols < 1 || terminal.rows < 1) return

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
    const cancelScheduledSelectionChecks = (): void => {
      if (mismatchCheckFrame) {
        cancelAnimationFrame(mismatchCheckFrame)
        mismatchCheckFrame = 0
      }
      if (ignoredScrollTimer) {
        window.clearTimeout(ignoredScrollTimer)
        ignoredScrollTimer = 0
      }
    }
    const removeSelectionPaint = (): void => {
      terminal.clearSelection()
      selectionOverlay.replaceChildren()
    }
    updateSelectionMetrics()
    const activeSelection = (): string => {
      if (retainedSelectionState.range) return retainedSelectionTextForCopy(retainedSelectionState)
      return terminal.hasSelection() ? terminal.getSelection() : ''
    }
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
      retainedSelectionState = retainSelection(range)
      cancelScheduledSelectionChecks()
      const captureText = (): void => {
        retainedSelectionState = captureSelectionText(retainedSelectionState, range, terminal.getSelection())
      }
      // xterm updates selected text after select() establishes the range.
      // Paint immediately, then capture the text on the following frame.
      captureText()
      requestAnimationFrame(captureText)
      scheduleRetainedSelectionRender()
    }
    const clearRetainedSelection = (): void => {
      retainedSelectionState = emptyRetainedSelection()
      cancelScheduledSelectionChecks()
      removeSelectionPaint()
    }
    // `range` is an absolute buffer position captured when the selection was
    // made. Copilot's TUI redraws its own content in place (a scroll in its
    // UI is just different characters landing at the same rows) and also
    // runs in the alternate screen buffer, which has no real scrollback —
    // xterm has no signal that a "scroll" happened, only that cells changed.
    // So there is no way to keep tracking the exact original cells; the only
    // thing we can do is keep checking whether the retained text is
    // currently findable on screen at all, and only show the highlight when
    // it is.
    //
    // "Not findable right now" is not treated as "gone for good". The state
    // becomes detached, preserving the text and last known range so a later
    // completed redraw can relocate and reactivate it.
    const syncRetainedSelectionVisibility = (): void => {
      mismatchCheckFrame = 0
      const range = retainedSelectionState.range
      if (!range) return
      const phase = retainedSelectionState.phase
      const retainedText = retainedSelectionState.text
      if (phase === 'active' || phase === 'scroll-pending') {
        terminal.select(range.column, range.row, range.length)
      }
      const originalRangeStillMatches = terminal.getSelection() === retainedText
      if (phase === 'active' && originalRangeStillMatches) {
        scheduleRetainedSelectionRender()
        return
      }
      if (phase === 'scroll-pending' && originalRangeStillMatches) {
        // xterm can finish this check before Copilot has processed the wheel
        // input. Do not let pre-scroll cells reactivate the overlay.
        terminal.clearSelection()
        return
      }
      if (phase === 'scroll-pending') retainedSelectionState = detachSelection(retainedSelectionState)
      // The exact original spot no longer matches — before hiding, check
      // whether the same text simply redrew somewhere else currently on
      // screen (the common case for a modest TUI scroll), so the highlight
      // keeps following it rather than flickering out and back at the old
      // position every time.
      const viewportStart = terminal.buffer.active.viewportY
      const relocated = findTextRow(
        (row) => terminal.buffer.active.getLine(row),
        terminal.cols,
        retainedText,
        range.row,
        range.column,
        viewportStart,
        terminal.rows,
      )
      if (relocated) {
        retainedSelectionState = activateSelection(retainedSelectionState, {
          column: relocated.column,
          row: relocated.row,
          length: relocated.length,
        })
        terminal.select(relocated.column, relocated.row, relocated.length)
        scheduleRetainedSelectionRender()
        return
      }
      // Genuinely not on screen anywhere right now (scrolled fully past the
      // visible area or overwritten) — hide the highlight so it never sits
      // on unrelated text. Later writes may reattach it to the nearest match.
      retainedSelectionState = detachSelection(retainedSelectionState)
      removeSelectionPaint()
    }
    const detachRetainedSelection = (reason: 'application-scroll' | 'revalidate'): void => {
      if (!retainedSelectionState.range) return
      retainedSelectionState = reason === 'application-scroll'
        ? beginApplicationScroll(retainedSelectionState)
        : detachSelection(retainedSelectionState)
      cancelScheduledSelectionChecks()
      removeSelectionPaint()
    }
    const scheduleMismatchCheck = (): void => {
      if (mismatchCheckFrame) return
      mismatchCheckFrame = requestAnimationFrame(syncRetainedSelectionVisibility)
    }
    const schedulePendingSelectionConfirmation = (): void => {
      if (!retainedSelectionState.range || retainedSelectionState.phase !== 'scroll-pending') return
      if (ignoredScrollTimer) window.clearTimeout(ignoredScrollTimer)
      // Application mouse reporting has no acknowledgement. Confirm only
      // after output has been quiet long enough for a redraw to settle; this
      // also restores an ignored/boundary wheel that produces no PTY output.
      ignoredScrollTimer = window.setTimeout(() => {
        ignoredScrollTimer = 0
        const state = retainedSelectionState
        if (!state.range || state.phase !== 'scroll-pending') return
        terminal.select(state.range.column, state.range.row, state.range.length)
        retainedSelectionState = confirmPendingSelection(state, terminal.getSelection() === state.text)
        if (retainedSelectionState.range && retainedSelectionState.phase === 'active') {
          scheduleRetainedSelectionRender()
          return
        }
        syncRetainedSelectionVisibility()
      }, 180)
    }
    const restoreRetainedSelection = (): void => {
      const range = retainedSelectionState.range
      if (!range) return
      if (retainedSelectionState.phase === 'scroll-pending') {
        // Do not inspect a partially-applied application redraw on the next
        // animation frame. Each output chunk restarts this quiet-period check.
        schedulePendingSelectionConfirmation()
        return
      }
      // Re-apply immediately so xterm's own getSelection()/copy machinery
      // stays pointed at the retained range across every write; the
      // coalesced check above is solely responsible for deciding whether
      // that range's content currently matches and should be shown.
      if (retainedSelectionState.phase === 'active') terminal.select(range.column, range.row, range.length)
      scheduleMismatchCheck()
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
    // `bufferPoint` clamps to the nearest valid cell, which is what a drag
    // selection wants when the pointer strays outside the terminal. Link
    // hit-testing wants the opposite: the container includes the `.xterm`
    // padding and scrollbar gutter around the actual character grid, and a
    // pointer there should resolve to no link at all rather than being
    // snapped onto whatever text sits at the nearest edge cell.
    const screenBufferPoint = (clientX: number, clientY: number): { column: number; row: number } | null => {
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) return null
      if (!isWithinScreenBounds(clientX, clientY, screen.getBoundingClientRect())) return null
      return bufferPoint(clientX, clientY)
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
    const linkAtClientCoordinates = (clientX: number, clientY: number): { link: DetectedLink; segments: LinkSegment[] } | null => {
      const point = screenBufferPoint(clientX, clientY)
      return point ? linkAtBufferPoint(point) : null
    }
    const linkAtClientPoint = (clientX: number, clientY: number): DetectedLink | null => {
      return linkAtClientCoordinates(clientX, clientY)?.link ?? null
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
    let lastHoverPoint: { clientX: number; clientY: number } | null = null
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
    const applyHoverSegments = (segments: LinkSegment[]): void => {
      if (segmentsEqual(segments, hoveredSegments)) return
      hoveredSegments = segments
      renderLinkHover()
    }
    const handleHoverMove = (moveEvent: MouseEvent): void => {
      // A pending click/drag gesture already owns cursor/coordinate semantics.
      if (cancelPendingLeftGesture) return
      lastHoverPoint = { clientX: moveEvent.clientX, clientY: moveEvent.clientY }
      applyHoverSegments(linkAtClientCoordinates(moveEvent.clientX, moveEvent.clientY)?.segments ?? [])
    }
    // A TUI redraw or a wrap reflow can change which link (if any) sits under
    // a *stationary* pointer, but produces no mousemove of its own — recompute
    // from the last known pointer position rather than only clearing, or the
    // underline would flicker away and never return while output streams in.
    const recomputeLinkHover = (): void => {
      if (!lastHoverPoint || cancelPendingLeftGesture) return
      applyHoverSegments(linkAtClientCoordinates(lastHoverPoint.clientX, lastHoverPoint.clientY)?.segments ?? [])
    }
    const clearLinkHover = (): void => {
      lastHoverPoint = null
      applyHoverSegments([])
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
      if (isApplicationScrollShortcut(event)) {
        detachRetainedSelection('application-scroll')
        schedulePendingSelectionConfirmation()
        return true
      }
      if (isCopyShortcut(event)) {
        const copied = copySelection()
        // A detached snapshot is deliberately not copyable: clear it while
        // allowing Ctrl+C through to Copilot as an interrupt.
        if (!copied && retainedSelectionState.range) clearRetainedSelection()
        return !copied
      }
      if (shouldClearSelectionForKey(event)) clearRetainedSelection()
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
    const writeTerminalData = (data: string): void => {
      // Output is the application's possible wheel acknowledgement. Stop the
      // no-output fallback until xterm has parsed this chunk; the write
      // callback then starts a fresh quiet-period confirmation.
      if (ignoredScrollTimer) {
        window.clearTimeout(ignoredScrollTimer)
        ignoredScrollTimer = 0
      }
      terminal.write(data, restoreRetainedSelection)
    }
    let backlogApplied = false
    const bufferedLive: string[] = []
    const unsubscribe = window.copilotDesktop.onTabOutput((payload) => {
      if (payload.tabId !== tabId) return
      if (!backlogApplied) {
        bufferedLive.push(payload.data)
        return
      }
      writeTerminalData(payload.data)
    })
    void window.copilotDesktop.getTabBacklog(tabId).then((backlog) => {
      if (backlog) writeTerminalData(backlog)
      for (const chunk of bufferedLive) writeTerminalData(chunk)
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
        const previousCols = terminal.cols
        const previousRows = terminal.rows
        fitAddon.fit()
        // Stored linear cell coordinates use the column count from capture
        // time, and xterm itself clears selections on vertical resize because
        // row changes can also invalidate them. Validate from a detached state
        // instead of briefly painting an old range elsewhere.
        if (terminal.cols !== previousCols || terminal.rows !== previousRows) {
          detachRetainedSelection('revalidate')
        }
        updateSelectionMetrics()
        restoreRetainedSelection()
        void window.copilotDesktop.resizeTab(tabId, terminal.cols, terminal.rows)
      })
    }
    const resizeObserver = new ResizeObserver(fitTerminal)
    resizeObserver.observe(container)
    // With --mouse=on, every wheel tick over the terminal is forwarded to
    // Copilot's own mouse tracking instead of scrolling xterm natively —
    // Copilot then redraws whatever it wants in response, at its own pace,
    // as ordinary PTY writes. We only find out a redraw happened (and only
    // find out it invalidated the retained selection) after those writes
    // land, which can trail the actual on-screen scrolling by a visible
    // beat if Copilot's redraw is itself gradual. Showing the highlight at
    // its old spot for that whole gap looks like a stuck, stale artifact —
    // actively wrong, not just imprecise. So treat the wheel event itself,
    // not the eventual mismatched write, as the signal to stop showing it:
    // hide immediately (state is kept, nothing is discarded — see
    // syncRetainedSelectionVisibility) and let the normal write-driven
    // check bring it back the moment matching content is confirmed again.
    const handleWheelDuringSelection = (event: WheelEvent): void => {
      const range = retainedSelectionState.range
      // With mouse tracking off, xterm owns normal scrollback and the absolute
      // buffer range remains valid. With tracking on, the wheel is application
      // input and Copilot can redraw arbitrary cells without moving viewportY.
      if (!range || event.deltaY === 0 || !mouseModeForwardsWheel(terminal.modes.mouseTrackingMode)) return
      // Remove the old rectangle synchronously. A scheduled render is one
      // frame too late during rapid wheel input and looks stuck to the screen.
      detachRetainedSelection('application-scroll')
      schedulePendingSelectionConfirmation()
    }
    // xterm stops mouse-mode wheel events on its child element after sending
    // them to Copilot. Capture on the parent so this runs before that stop.
    container.addEventListener('wheel', handleWheelDuringSelection, { capture: true, passive: true })
    terminal.onScroll(() => {
      scheduleRetainedSelectionRender()
      restoreRetainedSelection()
      // The row under the pointer changes on scroll without a mousemove;
      // recompute rather than just drop the hover, so it reappears correctly
      // once scrolling settles instead of requiring the pointer to move.
      recomputeLinkHover()
    })
    // A TUI redraw (onRender) or a reflow of wrapped rows (onResize, e.g. via
    // fitAddon.fit()) can also change the text under a stationary pointer
    // with no mousemove event of its own. onRender fires on every streamed
    // output frame, so recompute (keep the hover if the link is unchanged)
    // rather than clear — clearing here would make the underline flicker
    // away and never return while the mouse stays still during output.
    terminal.onRender(recomputeLinkHover)
    terminal.onResize(recomputeLinkHover)
    const bufferChangeDisposable = terminal.buffer.onBufferChange(() => {
      detachRetainedSelection('revalidate')
      restoreRetainedSelection()
    })

    return () => {
      unsubscribe()
      cancelAnimationFrame(fitFrame)
      cancelAnimationFrame(selectionRenderFrame)
      cancelScheduledSelectionChecks()
      bufferChangeDisposable.dispose()
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
      container.removeEventListener('wheel', handleWheelDuringSelection, true)
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
