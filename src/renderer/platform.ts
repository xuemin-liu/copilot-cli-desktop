/** Whether the app runs on macOS, where Cmd is the shortcut key and Ctrl belongs to the terminal (Ctrl+C, Ctrl+W). */
export const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)

/** The app's shortcut modifier: Cmd on macOS; Ctrl elsewhere (or the Windows key, as before). */
export function isShortcutModifier(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>, mac = isMac): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey || event.metaKey
}
