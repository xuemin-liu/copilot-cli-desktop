import { useRef } from 'react'
import type { CSSProperties, JSX, RefObject } from 'react'

export interface SplitterProps {
  label: string
  value: number
  min: number
  max: number
  /** Convert a pointer's position (x for a vertical divider, y for a horizontal one) to a value, given the container's bounds. */
  fromPointer(position: number, bounds: DOMRect): number
  containerRef: RefObject<HTMLElement | null>
  onChange(value: number): void
  /** Value change per arrow-key press. */
  step?: number
  /** Which arrow key makes `value` larger. A panel on the right grows when the divider moves left. */
  growKey?: 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp'
  /** A vertical divider sits between side-by-side panes; a horizontal one between stacked panes. */
  orientation?: 'vertical' | 'horizontal'
  style?: CSSProperties
}

const OPPOSITE = { ArrowRight: 'ArrowLeft', ArrowLeft: 'ArrowRight', ArrowDown: 'ArrowUp', ArrowUp: 'ArrowDown' } as const

/**
 * A divider that can be dragged or moved with the keyboard. A vertical one renders the same markup as the existing
 * side-chat and browser dividers, so `.side-chat-divider` styles it; a horizontal one is styled by `.splitter-horizontal`.
 */
export function Splitter({ label, value, min, max, fromPointer, containerRef, onChange, step = 2, orientation = 'vertical', growKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown', style }: SplitterProps): JSX.Element {
  const dragging = useRef<number | null>(null)
  const clamp = (next: number): number => Math.min(max, Math.max(min, next))
  const shrinkKey = OPPOSITE[growKey]
  const vertical = orientation === 'vertical'
  return (
    <div className={vertical ? 'side-chat-divider' : 'splitter-horizontal'} role="separator" aria-label={label} aria-orientation={orientation}
      aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} tabIndex={0} style={style}
      onPointerDown={(event) => {
        event.preventDefault()
        dragging.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (dragging.current !== event.pointerId) return
        const bounds = containerRef.current?.getBoundingClientRect()
        if (vertical ? bounds?.width : bounds?.height) onChange(clamp(fromPointer(vertical ? event.clientX : event.clientY, bounds!)))
      }}
      onPointerUp={(event) => {
        dragging.current = null
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onLostPointerCapture={() => { dragging.current = null }}
      onKeyDown={(event) => {
        if (![growKey, shrinkKey, 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        onChange(clamp(event.key === 'Home' ? min : event.key === 'End' ? max : value + (event.key === growKey ? step : -step)))
      }} />
  )
}
