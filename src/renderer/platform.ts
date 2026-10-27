// The renderer has no `process`; its user agent names the system. Tests render in Node, whose user agent does not.
const agent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const nodePlatform = typeof process !== 'undefined' ? process.platform : undefined

/** Whether the app runs on macOS, where Cmd is the shortcut key and Ctrl belongs to the terminal (Ctrl+C, Ctrl+W). */
export const isMac = /Macintosh|Mac OS X/.test(agent) || nodePlatform === 'darwin'

/** Whether the app runs on Windows, the only platform with migration, DPAPI and an elevation check. */
export const isWindows = /Windows/.test(agent) || nodePlatform === 'win32'

/** What the platform calls the place deleted files go. */
export const TRASH_LABEL = isWindows ? 'Recycle Bin' : 'Trash'

/** The app's shortcut modifier: Cmd on macOS; Ctrl elsewhere (or the Windows key, as before). */
export function isShortcutModifier(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>, mac = isMac): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey || event.metaKey
}
