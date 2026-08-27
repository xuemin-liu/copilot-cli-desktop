export interface RetainedSelectionRange {
  column: number
  row: number
  length: number
}

export type RetainedSelectionState =
  | { range: null }
  | { phase: 'active'; range: RetainedSelectionRange; text: string }
  | {
    phase: 'scroll-pending'
    range: RetainedSelectionRange
    text: string
  }
  | { phase: 'detached'; range: RetainedSelectionRange; text: string }

export const emptyRetainedSelection = (): RetainedSelectionState => ({ range: null })

export function retainSelection(range: RetainedSelectionRange, text = ''): RetainedSelectionState {
  return { phase: 'active', range, text }
}

export function captureSelectionText(
  state: RetainedSelectionState,
  expectedRange: RetainedSelectionRange,
  text: string,
): RetainedSelectionState {
  if (!text || state.range !== expectedRange || state.range === null) return state
  return { ...state, text }
}

export function beginApplicationScroll(state: RetainedSelectionState): RetainedSelectionState {
  if (state.range === null) return state
  return {
    phase: 'scroll-pending',
    range: state.range,
    text: state.text,
  }
}

export function detachSelection(state: RetainedSelectionState): RetainedSelectionState {
  if (state.range === null) return state
  return { phase: 'detached', range: state.range, text: state.text }
}

export function activateSelection(
  state: RetainedSelectionState,
  range?: RetainedSelectionRange,
): RetainedSelectionState {
  if (state.range === null) return state
  return { phase: 'active', range: range ?? state.range, text: state.text }
}

export function confirmPendingSelection(
  state: RetainedSelectionState,
  originalRangeStillMatches: boolean,
): RetainedSelectionState {
  if (state.range === null || state.phase !== 'scroll-pending') return state
  return originalRangeStillMatches ? activateSelection(state) : detachSelection(state)
}

export function retainedSelectionTextForCopy(state: RetainedSelectionState): string {
  return state.range !== null && state.phase === 'active' ? state.text : ''
}

export function mouseModeForwardsWheel(mode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'): boolean {
  return mode === 'vt200' || mode === 'drag' || mode === 'any'
}

interface TerminalKeyEventLike {
  type: string
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey?: boolean
}

export function isCopyShortcut(event: TerminalKeyEventLike): boolean {
  return event.type === 'keydown'
    && event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === 'c'
}

export function isApplicationScrollShortcut(event: TerminalKeyEventLike): boolean {
  if (event.type !== 'keydown' || event.altKey || event.shiftKey) return false
  const key = event.key.toLowerCase()
  return (!event.ctrlKey && (key === 'pageup' || key === 'pagedown'))
    || (event.ctrlKey && (key === 'u' || key === 'd'))
}

export function shouldClearSelectionForKey(event: TerminalKeyEventLike): boolean {
  return event.type === 'keydown' && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)
}
