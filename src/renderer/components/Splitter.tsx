import { useRef } from 'react'
import type { CSSProperties, JSX, RefObject } from 'react'

export interface SplitterProps {
  label: string
  value: number
  min: number
  max: number
  /** Convert a pointer's x position to a value, given the container's bounds. */
  fromPointer(clientX: number, bounds: DOMRect): number
  containerRef: RefObject<HTMLElement | null>
  onChange(value: number): void
  /** Value change per arrow-key press. */
  step?: number
  /** Which arrow key makes `value` larger. A panel on the right grows when the divider moves left. */
  growKey?: 'ArrowRight' | 'ArrowLeft'
  style?: CSSProperties
}

/**
 * A vertical divider that can be dragged or moved with the keyboard. It renders the same markup as the existing
 * side-chat and browser dividers, so `.side-chat-divider` styles it.
 */
export function Splitter({ label, value, min, max, fromPointer, containerRef, onChange, step = 2, growKey = 'ArrowRight', style }: SplitterProps): JSX.Element {
  const dragging = useRef<number | null>(null)
  const clamp = (next: number): number => Math.min(max, Math.max(min, next))
  const shrinkKey = growKey === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight'
  return (
    <div className="side-chat-divider" role="separator" aria-label={label} aria-orientation="vertical"
      aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} tabIndex={0} style={style}
      onPointerDown={(event) => {
        event.preventDefault()
        dragging.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (dragging.current !== event.pointerId) return
        const bounds = containerRef.current?.getBoundingClientRect()
        if (bounds?.width) onChange(clamp(fromPointer(event.clientX, bounds)))
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
