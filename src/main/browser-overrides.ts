import { fileURLToPath } from 'node:url'
import type { BrowserOverridesState } from './browser-debug-types.js'

/** What the selected page's DevTools, or failing that the saved preferences, say about Local Overrides. */
export type OverridesSetting = Omit<BrowserOverridesState, 'devtools' | 'scope'>

const ENABLED_SETTING = 'persistence-network-overrides-enabled'

/**
 * Read-only query run in the native DevTools frontend, never in the inspected page. It returns null until DevTools has
 * created its settings, so it never creates DevTools singletons itself, and gives up rather than wait on the folders.
 */
export const OVERRIDES_SCRIPT = `(async () => {
  const Common = await import('devtools://devtools/bundled/core/common/common.js');
  if (!Common.Settings.Settings.hasInstance()) return null;
  const Persistence = await import('devtools://devtools/bundled/models/persistence/persistence.js');
  const manager = Persistence.IsolatedFileSystemManager.IsolatedFileSystemManager.instance();
  const loaded = await Promise.race([manager.waitForFileSystems().then(() => true), new Promise(accept => setTimeout(() => accept(false), 2000))]);
  if (!loaded) return null;
  return {
    enabled: Common.Settings.Settings.instance().moduleSetting(${JSON.stringify(ENABLED_SETTING)}).get() === true,
    folders: manager.fileSystems().filter(fileSystem => fileSystem.type() === 'overrides').map(fileSystem => fileSystem.path()),
  };
})()`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** DevTools names folders by file URL; show the local path. */
function folderPath(folder: string): string {
  try { return folder.startsWith('file:') ? fileURLToPath(folder) : folder } catch { return folder }
}

/** The result of OVERRIDES_SCRIPT, or null when DevTools was not ready to answer. */
export function overridesFromDevtools(value: unknown): OverridesSetting | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.folders)) return null
  const folder = value.folders.find((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return { enabled: value.enabled, folder: folder === undefined ? null : folderPath(folder) }
}

/**
 * The saved settings, for a page whose DevTools has not started: the toggle is in the page partition's Preferences and
 * the folders DevTools added are in the default session's, where each folder maps to its type.
 */
export function overridesFromPreferences(partition: unknown, defaults: unknown): OverridesSetting {
  const electron = isRecord(partition) ? partition.electron : undefined
  const preferences = isRecord(electron) && isRecord(electron.devtools) ? electron.devtools.preferences : undefined
  const enabled = isRecord(preferences) && preferences[ENABLED_SETTING] === 'true'
  const devtools = isRecord(defaults) ? defaults.devtools : undefined
  const paths = isRecord(devtools) ? devtools.file_system_paths : undefined
  const folder = isRecord(paths) ? Object.keys(paths).find(path => path && paths[path] === 'overrides') : undefined
  return { enabled, folder: folder === undefined ? null : folderPath(folder) }
}
