import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import { MAX_PROFILES, normalizeDesktopConfig, workspaceProfileId } from './desktop-config.js'
import { normalizeSessionLaunchConfig } from './session-launch.js'
import { assertNoLinks, digest, executableSetting, isCliSettingsPath, isToolConfigPath, isToolJsonPath, jsonBytes, jsonObject, migrationAssetGroup, optionalRead, permissionSetting, portableSettings, PROJECT_FILES, safeRelative, sanitize, transformToolJson } from './migration-inventory.js'
import type { MigrationArchive } from './migration-archive.js'
import type { MigrationChange, MigrationChoices, MigrationPreview, MigrationRecoveryJournal, MigrationResult, MigrationRoots } from './migration-types.js'

interface Write { target: string; before: string | null; data: Buffer | null }
export interface ImportPlan { preview: MigrationPreview; writes: Write[]; fingerprints: Map<string, string | null>; directoryFingerprints: Map<string, string>; usage: Buffer | null }
const fingerprint = async (path: string): Promise<string | null> => { const bytes = await optionalRead(path); return bytes === null ? null : digest(bytes) }
function within(root: string, target: string): boolean { const rel = relative(resolve(root), resolve(target)); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) }
export function routeEntry(path: string, category: string, roots: MigrationRoots, mappings: Record<string, string>): string | null {
  safeRelative(path)
  if (category === 'settings' && path === 'copilot/settings.json') return join(roots.copilot, 'settings.json')
  if (category === 'knowledge' && /^copilot\/(copilot-instructions\.md|instructions\/[^]+)$/.test(path)) return join(roots.copilot, path.slice(8))
  if (category === 'skills' && /^copilot\/(skills|agents)\/[^]+$/.test(path)) return join(roots.copilot, path.slice(8))
  if (category === 'skills' && path.startsWith('agents-home/skills/')) return join(roots.agentSkills, path.slice(19))
  if (category === 'tools' && /^copilot\/(mcp-config\.json|lsp-config\.json|hooks\/[^]+|extensions\/[^]+)$/.test(path)) return join(roots.copilot, path.slice(8))
  if (category === 'desktop' && path === 'desktop/preferences.json') return join(roots.desktop, 'desktop.json')
  if (category === 'plugins' && path === 'plugins/inventory.json') return null
  if (category === 'usage' && path === 'usage/usage.sqlite') return null
  if (category === 'projects') {
    const [, id, ...parts] = path.split('/')
    const rel = parts.join('/')
    if (!id || !path.startsWith('projects/') || !/^[a-f0-9]{16}$/.test(id)
      || !PROJECT_FILES.some((base) => rel === base || (!base.endsWith('.json') && !base.endsWith('.md') && rel.startsWith(`${base}/`))) && !/(^|\/)AGENTS\.md$/.test(rel)) throw new Error('Unsupported project archive path')
    const root = mappings[id]
    return root ? join(root, rel) : null
  }
  throw new Error('Archive path does not match its category')
}

async function directoryFiles(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>()
  let visited = 0, bytes = 0
  async function visit(path: string): Promise<void> {
    if (++visited > 10_000) throw new Error('Destination directory exceeds migration limit')
    await assertNoLinks(path)
    let info
    try { info = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (info.isDirectory()) { for (const name of (await readdir(path)).sort()) await visit(join(path, name)) }
    else {
      const data = await optionalRead(path)
      if (data) { bytes += data.length; if (bytes > 256 * 1024 * 1024) throw new Error('Destination assets exceed migration limit'); result.set(path, data) }
    }
  }
  await visit(root)
  return result
}
async function directoryHash(root: string): Promise<string> {
  const files = await directoryFiles(root)
  let exists = true
  try { await lstat(root) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false }
  return digest(jsonBytes({ exists, files: [...files].map(([path, data]) => [relative(root, path), digest(data)]) }))
}

function mapStructuredPaths(value: unknown, archive: MigrationArchive, mappings: Record<string, string>, warnings: string[], key = '', depth = 0): unknown {
  if (depth > 40) throw new Error('Configuration nesting exceeds migration limit')
  if (Array.isArray(value)) return value.map((entry) => mapStructuredPaths(entry, archive, mappings, warnings, key, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, mapStructuredPaths(entry, archive, mappings, warnings, name, depth + 1)]))
  if (typeof value !== 'string') return value
  if (key === 'command') warnings.push(`Required tool command: ${value.slice(0, 300)}`)
  if (!['command', 'args', 'cwd', 'path', 'workingDirectory', 'skillDirectories', 'customInstructionsDirectories'].includes(key) || !isAbsolute(value)) return value
  const source = archive.manifest.projects.filter((project) => mappings[project.id] && (resolve(project.sourcePath).toLowerCase() === resolve(value).toLowerCase() || within(project.sourcePath, value))).sort((a, b) => b.sourcePath.length - a.sourcePath.length)[0]
  if (source) return join(mappings[source.id]!, relative(source.sourcePath, value))
  warnings.push(`Review unmapped ${key}: ${value.slice(0, 300)}`)
  return value
}

export async function planMigrationImport(archive: MigrationArchive, roots: MigrationRoots, mappings: Record<string, string>, choices: MigrationChoices, signal?: AbortSignal): Promise<ImportPlan> {
  const plan: ImportPlan = { preview: { id: randomUUID(), changes: [], projects: archive.manifest.projects, mappings: { ...mappings }, warnings: [...archive.manifest.warnings] }, writes: [], fingerprints: new Map(), directoryFingerprints: new Map(), usage: null }
  const selected = new Set(choices.categories), replace = new Set(choices.replace)
  const groups = new Set<string>()
  const targets = new Set<string>()
  const addChange = (id: string, path: string, category: MigrationChange['category'], before: Buffer | null, after: Buffer, detail = '', structured = false): boolean => {
    const identical = before !== null && (structured ? isDeepStrictEqual(JSON.parse(before.toString('utf8')), JSON.parse(after.toString('utf8'))) : digest(before) === digest(after))
    const action = !identical && (before === null || replace.has(id)) ? 'import' : 'keep'
    plan.preview.changes.push({ id, path, category, status: identical ? 'Identical' : before === null ? 'Add' : 'Conflict', action, detail })
    return action === 'import'
  }
  for (const [id, root] of Object.entries(mappings)) {
    if (!archive.manifest.projects.some((p) => p.id === id) || !isAbsolute(root) || !(await lstat(root)).isDirectory()) throw new Error('Choose an existing destination workspace folder')
    await assertNoLinks(root)
  }
  for (const file of archive.files) {
    signal?.throwIfAborted()
    // Validate even unselected entries; an archive cannot smuggle arbitrary destinations.
    const target = routeEntry(file.path, file.category, roots, mappings)
    if (!selected.has(file.category)) continue
    if (file.category === 'usage') { plan.usage = file.data; plan.preview.changes.push({ id: file.path, path: file.path, category: 'usage', status: 'Add', action: 'import', detail: 'Merge usage after file import; existing records are retained.' }); continue }
    if (file.category === 'plugins') { plan.preview.warnings.push('Plugin inventory is included below; reinstall selected sources using Copilot extensions after import.'); continue }
    if (!target) { plan.preview.changes.push({ id: file.path, path: file.path, category: file.category, status: 'Skipped', action: 'keep', detail: 'Map the source workspace before importing.' }); continue }
    await assertNoLinks(target)
    const normalizedTarget = resolve(target).toLowerCase()
    if (targets.has(normalizedTarget)) throw new Error('Multiple archive entries map to the same destination')
    targets.add(normalizedTarget)
    if (file.path.includes('/.github/hooks/') && !selected.has('tools')) { plan.preview.warnings.push('Project hooks require Tools selection.'); continue }
    const group = migrationAssetGroup(file.path)
    if (group) {
      if (groups.has(group)) continue
      groups.add(group)
      const root = target.slice(0, target.length - (file.path.length - group.length))
      const existing = await directoryFiles(root)
      const existingNames = new Map([...existing.keys()].map((name) => [resolve(name).toLowerCase(), name]))
      const incoming = archive.files.filter((candidate) => candidate.path.startsWith(`${group}/`))
      const oldHash = await directoryHash(root)
      plan.directoryFingerprints.set(root, oldHash)
      const identical = existing.size === incoming.length && incoming.every((candidate) => {
        const dest = join(root, candidate.path.slice(group.length + 1)); const name = existingNames.get(resolve(dest).toLowerCase()); const old = name ? existing.get(name) : undefined
        return old !== undefined && digest(old) === candidate.sha256
      })
      const hasExisting = existing.size > 0
      const take = !identical && (!hasExisting || replace.has(group))
      plan.preview.changes.push({ id: group, path: root, category: file.category, status: identical ? 'Identical' : hasExisting ? 'Conflict' : 'Add', action: take ? 'import' : 'keep', detail: 'Whole asset directory; replacement removes old files within this directory only.' })
      if (take) {
        for (const candidate of incoming) {
          const dest = join(root, candidate.path.slice(group.length + 1))
          const name = existingNames.get(resolve(dest).toLowerCase())
          plan.writes.push({ target: name ?? dest, before: name ? digest(existing.get(name)!) : null, data: candidate.data })
          if (name) existing.delete(name)
        }
        for (const [dest, data] of existing) plan.writes.push({ target: dest, before: digest(data), data: null })
      }
      continue
    }
    const before = await optionalRead(target)
    plan.fingerprints.set(target, before === null ? null : digest(before))
    if (file.category === 'desktop') {
      const changeStart = plan.preview.changes.length
      const rawIncoming = jsonObject(file.data)
      const incoming = normalizeDesktopConfig(rawIncoming)
      const current = normalizeDesktopConfig(before ? jsonObject(before) : null)
      const merged = { ...current }
      for (const key of ['closeBehavior', 'trayEnabled', 'notifications', 'automaticUpdateChecks'] as const) {
        if (!(key in rawIncoming)) continue
        const value = incoming[key]
        if (addChange(`${file.path}#${key}`, `${target} → ${key}`, 'desktop', before ? jsonBytes(current[key]) : null, jsonBytes(value), `Incoming: ${JSON.stringify(value)}`, true)) Object.assign(merged, { [key]: value })
      }
      merged.provider = { ...current.provider }
      if (rawIncoming.provider && typeof rawIncoming.provider === 'object') for (const key of ['type', 'model', 'offline'] as const) {
        if (!(key in rawIncoming.provider)) continue
        const value = incoming.provider[key]
        if (addChange(`${file.path}#provider.${key}`, `${target} → provider.${key}`, 'desktop', before ? jsonBytes(current.provider[key]) : null, jsonBytes(value), `Incoming: ${JSON.stringify(value)}`, true)) Object.assign(merged.provider, { [key]: value })
      }
      if (merged.provider.type !== 'github' && !merged.provider.baseUrl) plan.preview.warnings.push('Configure a provider base URL on this computer before starting a custom-provider session.')
      // Shortcuts and OS integration stay on this computer's existing setting.
      const profiles = Array.isArray(current.profiles) ? [...current.profiles] : []
      if (Array.isArray(rawIncoming.profiles)) for (const value of rawIncoming.profiles) {
        if (!value || typeof value !== 'object') continue
        const profile = value as Record<string, unknown>
        const project = archive.manifest.projects.find((p) => p.sourcePath === profile.path)
        const mapped = project ? mappings[project.id] : undefined
        if (!mapped) { plan.preview.warnings.push('An unmapped Desktop workspace profile was skipped.'); continue }
        const id = workspaceProfileId(mapped)
        const index = profiles.findIndex((candidate) => candidate.id === id)
        const launch = normalizeSessionLaunchConfig(profile.launch)
        if (!choices.allowPermissions) { launch.mode = 'interactive'; launch.remoteControl = 'inherit'; launch.remoteExport = 'inherit' }
        const next = normalizeDesktopConfig({ profiles: [{ name: profile.name, path: mapped, permissionPreset: choices.allowPermissions ? profile.permissionPreset : 'default', defaultResumeMode: 'new', launch, tabs: [] }] }).profiles[0]!
        if (addChange(`${file.path}#profile:${project!.id}`, mapped, 'desktop', index < 0 ? null : jsonBytes(profiles[index]), jsonBytes(next), `Incoming profile: ${JSON.stringify(next)}. History is unavailable; tabs are not restored.`, true)) {
          if (index < 0) { if (profiles.length >= MAX_PROFILES) throw new Error('Destination already has 20 workspace profiles'); profiles.push(next) } else profiles[index] = next
        }
      }
      merged.profiles = profiles
      // Normalize with the same parser as startup without introducing temporary source files.
      if (plan.preview.changes.slice(changeStart).some((change) => change.action === 'import')) {
        const normalized = normalizeDesktopConfig(merged)
        const data = jsonBytes(normalized)
        if (!before || digest(before) !== digest(data)) plan.writes.push({ target, before: before === null ? null : digest(before), data })
      }
    } else if (isCliSettingsPath(file.path)) {
      const incoming = mapStructuredPaths(jsonObject(portableSettings(file.data, plan.preview.warnings, selected.has('tools'))), archive, mappings, plan.preview.warnings) as Record<string, unknown>
      const current = before ? jsonObject(before) : {}
      const merged = { ...current }
      for (const [key, value] of Object.entries(incoming)) {
        if (permissionSetting(key) && !choices.allowPermissions || executableSetting(key) && !selected.has('tools')) { plan.preview.warnings.push(`Skipped setting requiring selection: ${key}`); continue }
        if (addChange(`${file.path}#${key}`, `${target} → ${key}`, file.category, key in current ? jsonBytes(current[key]) : null, jsonBytes(value), `${permissionSetting(key) ? 'Permission setting. ' : ''}Incoming: ${JSON.stringify(value).slice(0, 1000)}`, true)) merged[key] = value
      }
      if (JSON.stringify(merged) !== JSON.stringify(current)) plan.writes.push({ target, before: before === null ? null : digest(before), data: jsonBytes(merged) })
    } else {
      const transform = (value: unknown): unknown => mapStructuredPaths(sanitize(value, plan.preview.warnings), archive, mappings, plan.preview.warnings)
      const data = isToolConfigPath(file.path) ? jsonBytes(transform(jsonObject(file.data))) : isToolJsonPath(file.path) ? transformToolJson(file.data, file.path, plan.preview.warnings, transform) : file.data
      if (addChange(file.path, target, file.category, before, data, file.category === 'tools' ? 'Review commands and local dependencies before starting Copilot.' : '')) plan.writes.push({ target, before: before === null ? null : digest(before), data })
    }
  }
  plan.preview.warnings.push('Sign in to GitHub and reconnect MCP/API credentials on this computer. Review machine-specific paths in scripts and instructions.', 'Conversation history and account-level knowledge are not imported. Global shortcuts and login startup retain this computer’s settings.')
  plan.preview.warnings = [...new Set(plan.preview.warnings)]
  return plan
}

interface Journal { version: 1; status: 'pending' | 'complete' | 'rolled-back' | 'needs-attention'; error?: string; roots: string[]; writes: { target: string; before: string | null; after: string | null }[] }
async function durableWrite(path: string, data: Buffer): Promise<void> {
  await assertNoLinks(path)
  await writeFileAtomic(path, data)
  const handle = await open(path, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}
async function rollback(directory: string, journal: Journal): Promise<void> {
  for (let i = journal.writes.length - 1; i >= 0; i--) {
    const item = journal.writes[i]!
    if (!journal.roots.some((root) => within(root, item.target))) throw new Error('Recovery target outside migration roots')
    const current = await fingerprint(item.target)
    if (current === item.before) continue
    if (current !== item.after) throw new Error(`Recovery stopped: destination changed after import. Backups: ${directory}`)
    if (item.before === null) await rm(item.target, { force: true })
    else {
      const backup = await optionalRead(join(directory, `${i}.bak`))
      if (!backup || digest(backup) !== item.before) throw new Error(`Recovery backup is missing or damaged: ${directory}`)
      await durableWrite(item.target, backup)
    }
  }
  journal.status = 'rolled-back'
  await durableWrite(join(directory, 'journal.json'), jsonBytes(journal))
}
export async function recoverMigrationReport(desktopRoot: string, retry = false, recoverPending = true): Promise<{ issues: string[]; journals: MigrationRecoveryJournal[] }> {
  const root = join(desktopRoot, 'migration-backups')
  const issues: string[] = []
  const journals: MigrationRecoveryJournal[] = []
  const report = { issues, journals }
  async function recordIssue(id: string, directory: string, message: string): Promise<void> {
    issues.push(message)
    // Only readable journals can be acknowledged, bound to the reviewed bytes.
    const data = await optionalRead(join(directory, 'journal.json')).catch(() => null)
    if (data) journals.push({ id, path: directory, sha256: digest(data) })
  }
  let names: string[]
  try {
    names = await readdir(root)
    await assertNoLinks(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report
    issues.push(`Migration recovery needs attention at ${root}: ${String(error)}`)
    return report
  }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}$/.test(name)) continue
    const directory = join(root, name)
    let journal: Journal | undefined
    try {
      const data = await optionalRead(join(directory, 'journal.json'))
      if (!data) continue
      const parsed = JSON.parse(data.toString('utf8')) as Journal
      if (!parsed || parsed.version !== 1 || !['pending', 'complete', 'rolled-back', 'needs-attention'].includes(parsed.status)
        || !Array.isArray(parsed.writes) || parsed.writes.length > 20_000
        || parsed.writes.some((w) => !w || typeof w.target !== 'string' || !isAbsolute(w.target) || [w.before, w.after].some((hash) => hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))))
        || !Array.isArray(parsed.roots) || parsed.roots.some((value) => typeof value !== 'string' || !isAbsolute(value))) throw new Error('Invalid migration recovery journal')
      journal = parsed
      if ((journal.status === 'needs-attention' && !retry) || (journal.status === 'pending' && !recoverPending)) {
        await recordIssue(name, directory, `${directory}: ${journal.error ?? 'Recovery needs attention; inspect the backups before retrying.'}`)
      } else if (journal.status === 'pending' || journal.status === 'needs-attention') await rollback(directory, journal)
    } catch (error) {
      if (journal) {
        journal.status = 'needs-attention'; journal.error = String(error)
        await durableWrite(join(directory, 'journal.json'), jsonBytes(journal)).catch(() => {})
      }
      await recordIssue(name, directory, `Migration recovery needs attention at ${directory}: ${String(error)}`)
    }
  }
  return report
}
export class MigrationImportFailure extends Error {
  constructor(message: string, cause: unknown, readonly rollbackComplete: boolean) { super(message, { cause }) }
}
/** Acknowledgement preserves both current destination files and all evidence. */
export async function dismissMigrationJournal(desktopRoot: string, id: string, sha256: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid recovery journal selection')
  const source = join(desktopRoot, 'migration-backups', id, 'journal.json')
  await assertNoLinks(source)
  if (await fingerprint(source) !== sha256) throw new Error('Recovery journal changed; use Retry recovery to refresh it before dismissing it')
  await rename(source, join(desktopRoot, 'migration-backups', id, `journal.dismissed-${randomUUID()}.json`))
}
export async function applyMigrationImport(plan: ImportPlan, roots: MigrationRoots, signal?: AbortSignal, progress?: (completed: number, total: number) => void): Promise<MigrationResult> {
  for (const [path, hash] of plan.fingerprints) if (await fingerprint(path) !== hash) throw new Error('Destination changed; refresh the import preview')
  for (const [path, hash] of plan.directoryFingerprints) if (await directoryHash(path) !== hash) throw new Error('Destination assets changed; refresh the import preview')
  for (const item of plan.writes) if (await fingerprint(item.target) !== item.before) throw new Error('Destination changed; refresh the import preview')
  signal?.throwIfAborted()
  const directory = join(roots.desktop, 'migration-backups', randomUUID())
  const journal: Journal = { version: 1, status: 'pending', roots: [roots.copilot, roots.agentSkills, roots.desktop, ...Object.values(plan.preview.mappings)].map((value) => resolve(value)), writes: plan.writes.map((item) => ({ target: item.target, before: item.before, after: item.data === null ? null : digest(item.data) })) }
  if (plan.writes.length) {
    await assertNoLinks(directory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (let i = 0; i < plan.writes.length; i++) {
      signal?.throwIfAborted()
      const item = plan.writes[i]!
      if (item.before !== null) {
        const data = await optionalRead(item.target)
        if (!data || digest(data) !== item.before) throw new Error('Destination changed during backup; refresh preview')
        await durableWrite(join(directory, `${i}.bak`), data)
      }
    }
    await durableWrite(join(directory, 'journal.json'), jsonBytes(journal))
    try {
      for (let i = 0; i < plan.writes.length; i++) {
        signal?.throwIfAborted()
        const item = plan.writes[i]!
        if (await fingerprint(item.target) !== item.before) throw new Error('Destination changed during import')
        if (item.data === null) await rm(item.target)
        else await durableWrite(item.target, item.data)
        if (await fingerprint(item.target) !== journal.writes[i]!.after) throw new Error('Import readback failed')
        progress?.(i + 1, plan.writes.length)
      }
      journal.status = 'complete'
      await durableWrite(join(directory, 'journal.json'), jsonBytes(journal))
    } catch (error) {
      try { await rollback(directory, journal) }
      catch (recoveryError) {
        journal.status = 'needs-attention'; journal.error = String(recoveryError)
        await durableWrite(join(directory, 'journal.json'), jsonBytes(journal)).catch(() => {})
        throw new MigrationImportFailure(`Import failed: ${String(error)}. Rollback needs attention: ${String(recoveryError)}. Backups: ${directory}`, error, false)
      }
      throw new MigrationImportFailure(String(error), error, true)
    }
  }
  return { imported: plan.writes.length, skipped: plan.preview.changes.filter((change) => change.action === 'keep').length, backup: plan.writes.length ? directory : null, warnings: [...plan.preview.warnings] }
}
