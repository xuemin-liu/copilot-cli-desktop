/** Layout preferences are global; browser contents remain owned by their session. */
export type WorkspaceTool = 'browser' | 'git'
export interface ToolDockPreferences { open: boolean; width: number; tool: WorkspaceTool }
export const TOOL_DOCK_KEY = 'workspace-tool-dock-v1'
export const TOOL_MIN_WIDTH = 320
export const TOOL_DEFAULT_WIDTH = 420
export const TERMINAL_MIN_WIDTH = 480
export const SPLIT_DIVIDER = 6

export function readToolDockPreferences(storage: Pick<Storage, 'getItem'>): ToolDockPreferences {
  const fallback: ToolDockPreferences = { open: false, width: TOOL_DEFAULT_WIDTH, tool: 'browser' }
  try {
    const saved = storage.getItem(TOOL_DOCK_KEY)
    if (saved !== null) {
      const value: unknown = JSON.parse(saved)
      if (!value || typeof value !== 'object') return fallback
      const prefs = value as Partial<ToolDockPreferences>
      return { open: prefs.open === true, tool: prefs.tool === 'git' ? 'git' : 'browser', width: validWidth(prefs.width) }
    }
    const open = storage.getItem('git-panel-open') === 'true'
    return { open, width: validWidth(Number(storage.getItem('git-panel-width'))), tool: open ? 'git' : 'browser' }
  } catch { return fallback }
}

function validWidth(width: unknown): number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0
    ? Math.min(2400, Math.max(TOOL_MIN_WIDTH, width)) : TOOL_DEFAULT_WIDTH
}

export function sessionMinimum(twoTerminals: boolean): number {
  return twoTerminals ? 2 * TERMINAL_MIN_WIDTH + SPLIT_DIVIDER : TERMINAL_MIN_WIDTH
}

/** Clamping is only for rendering; it must never overwrite the preferred split. */
export function terminalLayout(available: number, twoTerminals: boolean, preferred: number): { single: boolean; split: number } {
  if (!twoTerminals || available <= 0) return { single: false, split: preferred }
  if (available < sessionMinimum(true)) return { single: true, split: preferred }
  const minimum = TERMINAL_MIN_WIDTH / (available - SPLIT_DIVIDER) * 100
  return { single: false, split: Math.min(100 - minimum, Math.max(minimum, preferred)) }
}
