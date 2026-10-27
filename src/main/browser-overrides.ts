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

/**
 * A popup's first response waits for the native override project and its Fetch patterns, not just a loaded DevTools UI.
 * Chromium populates large folders in chunks. Its explicit pattern-refresh barrier also awaits Fetch.enable, including
 * asynchronous .headers parsing; the pinned Electron DevTools exposes that barrier as updateInterceptionPatternsForTests.
 */
export const POPUP_OVERRIDES_READY_SCRIPT = `(async () => {
  const Common = await import('devtools://devtools/bundled/core/common/common.js');
  if (!Common.Settings.Settings.hasInstance()) return null;
  const enabled = Common.Settings.Settings.instance().moduleSetting(${JSON.stringify(ENABLED_SETTING)}).get() === true;
  if (!enabled) return { enabled: false, folders: [] };
  const Persistence = await import('devtools://devtools/bundled/models/persistence/persistence.js');
  const fileSystems = Persistence.IsolatedFileSystemManager.IsolatedFileSystemManager.instance();
  await fileSystems.waitForFileSystems();
  if (!fileSystems.fileSystems().some(fileSystem => fileSystem.type() === 'overrides')) return { enabled, folders: [] };
  let manager;
  try { manager = Persistence.NetworkPersistenceManager.NetworkPersistenceManager.instance(); } catch { return null; }
  const project = manager.project();
  if (!project || (enabled && !manager.active())) return null;
  if (Array.from(project.uiSourceCodes()).length < project.fileSystem().initialFilePaths().length) return null;
  await manager.updateInterceptionPatternsForTests();
  return { enabled, folders: [project.fileSystem().path()] };
})()`

/** Route an already-started popup response through Chromium's own URL mapping, header rules and response encoder. */
export function popupOverrideResponseScript(event: unknown, body?: unknown): string {
  return `(async () => {
    const event = ${JSON.stringify(event)};
    event.responseHeaders ??= [];
    const body = ${JSON.stringify(body) ?? 'null'};
    const Persistence = await import('devtools://devtools/bundled/models/persistence/persistence.js');
    const SDK = await import('devtools://devtools/bundled/core/sdk/sdk.js');
    const persistence = Persistence.NetworkPersistenceManager.NetworkPersistenceManager.instance();
    const continued = { method: 'Fetch.continueRequest', params: { requestId: event.requestId } };
    if (!persistence.active() || event.request.method === 'OPTIONS') return continued;
    const file = persistence.project()?.uiSourceCodeForURL(persistence.fileUrlFromNetworkUrl(event.request.url));
    const headers = persistence.handleHeaderInterception(event);
    if (!file && headers === event.responseHeaders) return continued;
    const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400;
    if (!file && !body && !redirect) return { method: 'Fetch.getResponseBody', params: { requestId: event.requestId } };
    let respond;
    const action = new Promise(resolve => { respond = resolve; });
    const agent = {
      // A content override must not wait for an original streaming response to finish. Its original-content preview
      // is unavailable for this early request; header-only overrides still retrieve and preserve the network body.
      invoke_getResponseBody: async () => ({ ...body, getError: () => body ? body.error : 'Original response unavailable during popup activation' }),
      invoke_fulfillRequest: async params => { respond({ method: 'Fetch.fulfillRequest', params }); return {}; },
      invoke_continueRequest: async params => { respond({ method: 'Fetch.continueRequest', params }); return {}; },
    };
    const network = SDK.NetworkManager.MultitargetNetworkManager.instance();
    const request = new SDK.NetworkManager.InterceptedRequest(network, agent, event.request, event.resourceType,
      event.requestId, null, event.responseStatusCode, event.responseHeaders);
    await network.requestIntercepted(request);
    let timer;
    try { return await Promise.race([action, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Popup override response timed out')), 10000);
    })]); } finally { clearTimeout(timer); }
  })()`
}

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
