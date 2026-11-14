import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renameWithRetry } from './atomic-file.js'
import { normalizeBrowserProfileId } from './browser-profile.js'

/** DevTools settings by name, with the JSON-encoded values DevTools saves. */
export type DevtoolsPreferences = Record<string, string>
type Snapshot = DevtoolsPreferences
/** `private`: browser profiles whose sessions keep DevTools settings, Local Overrides included, to themselves. */
interface Store { values: Snapshot; seen: Record<string, Snapshot>; private: string[] }

const STORE_FILE = 'browser-devtools.json'

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const child = (parent: Json, key: string): Json => {
  if (!isRecord(parent[key])) parent[key] = {}
  return parent[key] as Json
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) as unknown }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    renameWithRetry(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}

/**
 * Electron keeps DevTools settings, such as whether Local Overrides is enabled, in the inspected page's partition
 * (`electron.devtools.preferences`). Added folders are saved by the DevTools view's own session, the default one,
 * so the Local Overrides folder is already shared by every session.
 */
function snapshotOf(prefs: unknown): Snapshot {
  const snapshot: Snapshot = {}
  const electron = isRecord(prefs) ? prefs.electron : undefined
  const preferences = isRecord(electron) && isRecord(electron.devtools) ? electron.devtools.preferences : undefined
  if (isRecord(preferences)) {
    for (const [name, value] of Object.entries(preferences)) if (typeof value === 'string') snapshot[name] = value
  }
  return snapshot
}

function applySnapshot(prefs: Json, values: Snapshot): void {
  child(child(prefs, 'electron'), 'devtools').preferences = { ...values }
}

function loadStore(file: string): Store {
  let saved: unknown
  try { saved = readJson(file) } catch { saved = undefined }
  const store: Store = { values: {}, seen: {}, private: [] }
  if (!isRecord(saved)) return store
  const strings = (value: unknown): Snapshot => isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  store.values = strings(saved.values)
  if (isRecord(saved.seen)) for (const [id, snapshot] of Object.entries(saved.seen)) if (normalizeBrowserProfileId(id) === id) store.seen[id] = strings(snapshot)
  if (Array.isArray(saved.private)) store.private = saved.private.filter((id): id is string => typeof id === 'string' && normalizeBrowserProfileId(id) === id)
  return store
}

/** Session browser partitions on disk, by browser profile id. */
function partitions(userData: string): Map<string, string> {
  const found = new Map<string, string>()
  let entries
  try { entries = readdirSync(join(userData, 'Partitions'), { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    let name: string
    try { name = decodeURIComponent(entry.name) } catch { continue }
    const id = name.startsWith('browser-debug:') ? normalizeBrowserProfileId(name.slice('browser-debug:'.length)) : undefined
    if (id) found.set(id, join(userData, 'Partitions', entry.name))
  }
  return found
}

/** Fold every setting a session changed since it was last seen into the shared values; the most recently saved change wins. */
function collect(store: Store, found: Map<string, string>): void {
  const changes: { time: number; key: string; value: string | undefined }[] = []
  for (const [id, directory] of found) {
    if (store.private.includes(id)) continue
    const file = join(directory, 'Preferences')
    let prefs: unknown, time: number
    try { prefs = readJson(file); time = statSync(file).mtimeMs } catch { continue }
    if (prefs === undefined) continue
    const current = snapshotOf(prefs)
    const previous = store.seen[id] ?? {}
    for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      if (current[key] !== previous[key]) changes.push({ time, key, value: current[key] })
    }
    store.seen[id] = current
  }
  changes.sort((a, b) => a.time - b.time)
  for (const { key, value } of changes) {
    if (value === undefined) delete store.values[key]
    else store.values[key] = value
  }
  for (const id of Object.keys(store.seen)) if (!found.has(id)) delete store.seen[id]
}

/**
 * Each terminal's browser has its own partition, and Electron keeps DevTools settings there, so a new session would
 * otherwise start with Local Overrides disabled and without its other DevTools settings. Collects changes from every
 * partition on disk and, with `profileId`, writes the shared settings into that partition. Call it before that
 * partition's session is created: Chromium reads Preferences once and later overwrites the file.
 */
export function shareDevtoolsSettings(userData: string, profileId?: string, options: { private?: boolean } = {}): void {
  const storeFile = join(userData, STORE_FILE)
  const store = loadStore(storeFile)
  const found = partitions(userData)
  collect(store, found)
  // At startup, before unused partitions are removed: a private profile whose partition is already gone is forgotten.
  // Not later, since a session just marked private may not have created its partition yet.
  if (profileId === undefined) store.private = store.private.filter(id => found.has(id))
  const id = profileId === undefined ? undefined : normalizeBrowserProfileId(profileId)
  if (profileId !== undefined && !id) throw new Error('Invalid browser profile')
  if (id && options.private) {
    // A session that keeps DevTools settings to itself starts with DevTools defaults, and its changes stay out of the
    // shared settings, now and after it closes.
    if (!store.private.includes(id)) store.private.push(id)
    delete store.seen[id]
  } else if (id) {
    if (store.private.includes(id)) throw new Error('This browser profile keeps its DevTools settings to itself')
    const file = join(found.get(id) ?? join(userData, 'Partitions', encodeURIComponent(`browser-debug:${id}`)), 'Preferences')
    // An unreadable Preferences file belongs to Chromium; leave it alone rather than replace it.
    const prefs = readJson(file) ?? {}
    if (!isRecord(prefs)) throw new Error('Browser preferences are not an object')
    applySnapshot(prefs, store.values)
    writeJsonAtomic(file, prefs)
    store.seen[id] = { ...store.values }
  }
  writeJsonAtomic(storeFile, store)
}

/** Mark privacy independently of one-time Chromium partition initialization. A transition to shared stays excluded
 * from collection until the new group's live frontend has replaced the old private preferences. */
export function prepareProjectDevtoolsSettings(userData: string, profileId: string, privateMode: boolean, initialized: boolean): Snapshot | null {
  const id = normalizeBrowserProfileId(profileId)
  if (!id) throw new Error('Invalid browser profile')
  const file = join(userData, STORE_FILE), store = loadStore(file)
  if (privateMode) {
    if (!store.private.includes(id)) store.private.push(id)
    delete store.seen[id]
    writeJsonAtomic(file, store)
    return null
  }
  if (store.private.includes(id)) {
    collect(store, partitions(userData))
    writeJsonAtomic(file, store)
    return { ...store.values }
  }
  if (!initialized) shareDevtoolsSettings(userData, id)
  return null
}

/** Called only after native preference write/readback and cache refresh succeeded. Preserve cookies and other prefs. */
export function completeProjectDevtoolsSharing(userData: string, profileId: string, values: Snapshot): void {
  const id = normalizeBrowserProfileId(profileId)
  if (!id) throw new Error('Invalid browser profile')
  const found = partitions(userData)
  const prefsFile = join(found.get(id) ?? join(userData, 'Partitions', encodeURIComponent(`browser-debug:${id}`)), 'Preferences')
  const prefs = readJson(prefsFile) ?? {}
  if (!isRecord(prefs)) throw new Error('Browser preferences are not an object')
  applySnapshot(prefs, values)
  writeJsonAtomic(prefsFile, prefs)
  const storeFile = join(userData, STORE_FILE), store = loadStore(storeFile)
  store.seen[id] = { ...values }
  store.private = store.private.filter(candidate => candidate !== id)
  writeJsonAtomic(storeFile, store)
}

/** Fixed code runs only in the trusted bundled DevTools frontend. Keep its local folder storage untouched. */
export function replaceDevtoolsPreferencesScript(values: Snapshot): string {
  return `(async () => {
    const C = await import('devtools://devtools/bundled/core/common/common.js');
    for (let i = 0; !C.Settings.Settings.hasInstance(); i++) {
      if (i > 200) throw new Error('DevTools settings did not initialize');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const H = await import('devtools://devtools/bundled/core/host/host.js');
    const host = H.InspectorFrontendHost.InspectorFrontendHostInstance;
    const values = ${JSON.stringify(values)};
    const before = await new Promise(resolve => host.getPreferences(resolve));
    for (const key of Object.keys(before)) if (!Object.hasOwn(values, key)) host.removePreference(key);
    for (const [key, value] of Object.entries(values)) host.setPreference(key, value);
    await new Promise(resolve => host.getPreferences(resolve));
    const settings = C.Settings.Settings.instance();
    for (const storage of [settings.globalStorage, settings.syncedStorage])
      await Promise.all([...new Set([...storage.keys(), ...Object.keys(values)])].map(key => storage.forceGet(key)));
    await Promise.all([...settings.getRegistry().values()].filter(setting =>
      setting.storage === settings.globalStorage || setting.storage === settings.syncedStorage).map(setting => setting.forceGet()));
    return await new Promise(resolve => host.getPreferences(resolve));
  })()`
}
