import { useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { Splitter } from './Splitter.js'
import { sessionMinimum } from '../tool-dock-state.js'

export const GIT_PANEL_MIN_WIDTH = 320
export const GIT_PANEL_DEFAULT_WIDTH = 420
/** The session area never gets narrower than this: Copilot's TUI reflows and corrupts scrollback in a very narrow terminal. */
export const SESSION_MIN_WIDTH = 480
const DIVIDER = 6

export interface DockLayout {
  /** Width in pixels the panel gets, or null when it replaces the session area. */
  panelWidth: number | null
  takeover: boolean
}

/** Pure layout rule, so it can be tested: clamp the panel, or let it take over a window too narrow for both. */
export function dockLayout(available: number, wanted: number, twoTerminals = false): DockLayout {
  const minimum = sessionMinimum(twoTerminals)
  if (available > 0 && available < GIT_PANEL_MIN_WIDTH + minimum + DIVIDER) return { panelWidth: null, takeover: true }
  const most = Math.max(GIT_PANEL_MIN_WIDTH, available - minimum - DIVIDER)
  return { panelWidth: Math.min(most, Math.max(GIT_PANEL_MIN_WIDTH, wanted)), takeover: false }
}

export interface ProjectDockProps {
  children: ReactNode
  open: boolean
  width: number
  onWidthChange(width: number): void
  twoTerminals?: boolean
  /** Always mounted. Tool hosts decide when to lazy-mount their contents. */
  panel(layout: { takeover: boolean; mainWidth: number }): ReactNode
}

/**
 * Hosts workspace tools beside the session area. The session area stays mounted under the same parent while the
 * panel opens, closes or takes over, so no terminal is ever remounted.
 */
export function ProjectDock({ children, open, width, onWidthChange, panel, twoTerminals = false }: ProjectDockProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const measure = (): void => setAvailable(Math.round(element.getBoundingClientRect().width))
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])
  const layout = dockLayout(available, width, twoTerminals)
  const showPanel = open
  const split = showPanel && !layout.takeover && layout.panelWidth !== null
  const columns = split ? `minmax(0, 1fr) ${DIVIDER}px ${layout.panelWidth}px` : 'minmax(0, 1fr)'
  const most = Math.max(GIT_PANEL_MIN_WIDTH, available - sessionMinimum(twoTerminals) - DIVIDER)
  return (
    <div ref={rootRef} className="project-dock" style={{ gridTemplateColumns: columns }}>
      {/* Hidden, not unmounted, when the panel takes over a narrow window. */}
      <div className="project-dock-main" style={{ display: showPanel && layout.takeover ? 'none' : undefined }}>{children}</div>
      {split && (
        <Splitter label="Resize tools panel" value={layout.panelWidth!} min={GIT_PANEL_MIN_WIDTH} max={most} step={16} growKey="ArrowLeft"
          containerRef={rootRef} fromPointer={(clientX, bounds) => bounds.right - clientX}
          onChange={onWidthChange} style={{ gridColumn: 2 }} />
      )}
      <div className="project-dock-panel" style={{ display: open ? undefined : 'none', gridColumn: split ? 3 : 1 }}>
        {panel({ takeover: open && layout.takeover, mainWidth: split ? available - layout.panelWidth! - DIVIDER : available })}
      </div>
    </div>
  )
}
