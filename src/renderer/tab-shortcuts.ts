/** What Ctrl/Cmd+W and Ctrl/Cmd+T act on, from where the key was pressed. */
export type TabShortcutOwner = 'session' | 'tools' | 'terminal'

/**
 * A key pressed inside the workspace tools belongs to the tool tabs, never to the Copilot session beside them: closing a
 * running session because the browser's address field had focus loses work. A tool terminal keeps the key for its shell.
 */
export function tabShortcutOwner(target: unknown): TabShortcutOwner {
  const element = target as { closest?: (selector: string) => unknown } | null
  if (typeof element?.closest !== 'function') return 'session'
  if (!element.closest('.workspace-tools')) return 'session'
  return element.closest('.tool-terminal-panel') ? 'terminal' : 'tools'
}
