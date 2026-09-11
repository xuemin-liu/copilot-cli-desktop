import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readDesktopConfig } from './desktop-config.js'
import { collectMigration, fileEntry, jsonBytes, jsonObject, optionalRead, sanitize, type MigrationFile } from './migration-inventory.js'
import { readMigrationArchive, writeMigrationArchive, type MigrationArchive } from './migration-archive.js'
import { applyMigrationImport, planMigrationImport, recoverMigrationImports, type ImportPlan } from './migration-import.js'
import { MIGRATION_CATEGORIES, type MigrationChoices, type MigrationInventory, type MigrationManifest, type MigrationProgress, type MigrationResult, type MigrationRoots, type MigrationSelection } from './migration-types.js'
import { writeFileAtomic } from './atomic-file.js'

interface MigrationDependencies {
  roots: MigrationRoots
  appVersion: string
  cliVersion: () => string | null
  assertIdle: () => Promise<void>
  plugins: () => Promise<unknown>
  exportUsage: (path: string) => Promise<void>
  restoreUsage: (path: string) => Promise<void>
  progress: (value: MigrationProgress) => void
  reloaded: () => Promise<void>
}
export class MigrationService {
  busy = false
  private abort: AbortController | null = null
  private archive: MigrationArchive | null = null
  private plan: ImportPlan | null = null
  private mappings: Record<string, string> = Object.create(null) as Record<string, string>
  constructor(private readonly deps: MigrationDependencies) {
    deps.roots = { copilot: resolve(deps.roots.copilot), agentSkills: resolve(deps.roots.agentSkills), desktop: resolve(deps.roots.desktop) }
  }
  cancel(): void { this.abort?.abort() }
  private async run<T>(phase: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Another migration operation is running')
    this.busy = true
    this.abort = new AbortController()
    this.deps.progress({ phase, completed: 0, total: 0 })
    try { return await operation(this.abort.signal) }
    finally { this.abort = null; this.busy = false; this.deps.progress({ phase: 'Idle', completed: 0, total: 0 }) }
  }
  private async manifest(): Promise<MigrationManifest> {
    await optionalRead(join(this.deps.roots.desktop, 'desktop.json'))
    const config = await readDesktopConfig(join(this.deps.roots.desktop, 'desktop.json'))
    return { version: 1, createdAt: new Date().toISOString(), platform: process.platform, appVersion: this.deps.appVersion,
      cliVersion: this.deps.cliVersion(), projects: config.profiles.map((p) => ({ id: p.id, name: p.name, sourcePath: p.path })), entries: [],
      warnings: ['ZIP archives can contain private instructions, source material, and scripts. Review the file list before sharing.', 'History migration is unavailable until CLI restore formats are verified. Credentials, cached plugins, approvals, and account-level state are excluded.'] }
  }
  async inventory(selection: MigrationSelection): Promise<MigrationInventory> {
    validateSelection(selection)
    return this.run('Discovering files', async (signal) => {
      const manifest = await this.manifest()
      const allProjects = manifest.projects
      // Profiles need all source path labels, while repository traversal is explicitly selected.
      manifest.projects = allProjects.filter((p) => selection.projectIds.includes(p.id))
      const files = await collectMigration(this.deps.roots, manifest, new Set(selection.categories), signal)
      if (selection.categories.includes('plugins')) files.push(await this.pluginInventory(manifest))
      if (selection.categories.includes('usage')) manifest.warnings.push('Usage snapshot size is determined during export.')
      return { roots: this.deps.roots, entries: files.map(({ data: _data, ...entry }) => entry), projects: allProjects, warnings: manifest.warnings }
    })
  }
  private async pluginInventory(manifest: MigrationManifest): Promise<MigrationFile> {
    // Project known identifier/source fields only; never copy opaque resource output.
    const records: { name: string; source: string; version: string }[] = []
    try {
      const raw = await this.deps.plugins()
      const warnings: string[] = []
      const cleaned = sanitize(raw, warnings)
      function visit(value: unknown, depth: number): void {
        if (depth > 8 || records.length >= 200) return
        if (Array.isArray(value)) { value.forEach((v) => visit(v, depth + 1)); return }
        if (!value || typeof value !== 'object') return
        const record = value as Record<string, unknown>
        // The unified command also returns built-in skills and MCP servers.
        if (typeof record.kind === 'string' && record.kind !== 'plugin') return
        if (typeof record.name === 'string' && (typeof record.source === 'string' || typeof record.version === 'string')) {
          const source = typeof record.source === 'string' && !/^(builtin|built-in|user|project|global|local|marketplace)$/i.test(record.source) ? record.source.slice(0, 2048) : ''
          records.push({ name: record.name.slice(0, 300), source, version: typeof record.version === 'string' ? record.version.slice(0, 100) : '' })
        } else Object.values(record).forEach((v) => visit(v, depth + 1))
      }
      visit(cleaned, 0)
      if (!records.length) manifest.warnings.push('No supported plugin inventory was discovered. Reinstall plugins manually in Copilot extensions.')
    } catch { manifest.warnings.push('Plugin inventory unavailable; reconnect or install Copilot CLI, then refresh.') }
    return fileEntry('plugins/inventory.json', 'plugins', jsonBytes({ plugins: records }))
  }
  async export(path: string, selection: MigrationSelection): Promise<void> {
    validateSelection(selection)
    await this.run('Exporting archive', async (signal) => {
      await this.deps.assertIdle()
      const manifest = await this.manifest(), projects = manifest.projects
      manifest.projects = projects.filter((p) => selection.projectIds.includes(p.id))
      const files = await collectMigration(this.deps.roots, manifest, new Set(selection.categories), signal)
      // A second inventory catches writes and added/removed assets during the snapshot.
      const check = await collectMigration(this.deps.roots, manifest, new Set(selection.categories), signal)
      if (JSON.stringify(files.map(({ path: name, sha256 }) => [name, sha256])) !== JSON.stringify(check.map(({ path: name, sha256 }) => [name, sha256]))) throw new Error('Source files changed during export. Review files and retry.')
      manifest.projects = projects
      if (selection.categories.includes('plugins')) files.push(await this.pluginInventory(manifest))
      if (selection.categories.includes('usage')) await this.withScratch(async (directory) => {
        const usage = join(directory, 'usage.sqlite')
        await this.deps.exportUsage(usage)
        files.push(fileEntry('usage/usage.sqlite', 'usage', (await optionalRead(usage))!))
      })
      await writeMigrationArchive(path, manifest, files, signal)
    })
  }
  async open(path: string): Promise<{ projects: MigrationManifest['projects']; warnings: string[]; plugins: { name: string; source: string; version: string }[] }> {
    return this.run('Validating archive', async (signal) => {
      this.archive = null; this.plan = null; this.mappings = Object.create(null) as Record<string, string>
      const archive = await readMigrationArchive(path, signal)
      const plugins: { name: string; source: string; version: string }[] = []
      const inventory = archive.files.find((file) => file.path === 'plugins/inventory.json')
      if (inventory) {
        const data = jsonObject(inventory.data)
        if (Array.isArray(data.plugins)) for (const value of data.plugins.slice(0, 200)) {
          if (value && typeof value === 'object' && typeof value.name === 'string' && typeof value.source === 'string' && typeof value.version === 'string') plugins.push({ name: value.name.slice(0, 300), source: value.source.slice(0, 2048), version: value.version.slice(0, 100) })
        }
      }
      this.archive = archive
      return { projects: archive.manifest.projects, warnings: archive.manifest.warnings, plugins }
    })
  }
  mapProject(id: string, path: string): void {
    if (this.busy || !this.archive?.manifest.projects.some((p) => p.id === id)) throw new Error('Invalid source project')
    this.mappings[id] = path
    this.plan = null
  }
  async preview(choices: MigrationChoices): Promise<ImportPlan['preview']> {
    validateChoices(choices)
    return this.run('Preparing import preview', async (signal) => {
      if (!this.archive) throw new Error('Select an archive first')
      this.plan = null
      this.plan = await planMigrationImport(this.archive, this.deps.roots, this.mappings, choices, signal)
      return this.plan.preview
    })
  }
  async apply(id: string): Promise<MigrationResult> {
    return this.run('Importing files', async (signal) => {
      if (!this.plan || this.plan.preview.id !== id) throw new Error('Refresh the import preview')
      await this.deps.assertIdle()
      await recoverMigrationImports(this.deps.roots.desktop)
      const plan = this.plan
      this.plan = null
      const result = await applyMigrationImport(plan, this.deps.roots, signal, (completed, total) => this.deps.progress({ phase: 'Importing files', completed, total }))
      await this.deps.reloaded()
      if (plan.usage) {
        // Usage merge is deliberately separate from the file transaction.
        try {
          signal.throwIfAborted()
          const backupRoot = result.backup ?? join(this.deps.roots.desktop, 'migration-backups', randomUUID())
          await mkdir(backupRoot, { recursive: true, mode: 0o700 })
          await this.deps.exportUsage(join(backupRoot, 'usage-before.sqlite'))
          result.backup = backupRoot
          await this.withScratch(async (directory) => {
            const path = join(directory, 'usage.sqlite')
            await writeFileAtomic(path, plan.usage!)
            await this.deps.restoreUsage(path)
          })
          result.warnings.push('Usage records merged successfully.')
        } catch { result.warnings.push('Files imported, but usage merge did not complete. Retry via Monthly token usage → Restore backup using usage/usage.sqlite from the archive.') }
      }
      return result
    })
  }
  private async withScratch<T>(fn: (path: string) => Promise<T>): Promise<T> {
    const path = join(this.deps.roots.desktop, `migration-staging-${randomUUID()}`)
    await mkdir(path, { recursive: true, mode: 0o700 })
    try { return await fn(path) } finally { await rm(path, { recursive: true, force: true }) }
  }
}
function validateSelection(value: MigrationSelection): void {
  if (!value || !Array.isArray(value.categories) || value.categories.some((category) => !MIGRATION_CATEGORIES.includes(category))
    || value.categories.length > MIGRATION_CATEGORIES.length || !Array.isArray(value.projectIds) || value.projectIds.length > 20
    || value.projectIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id))) throw new Error('Invalid migration selection')
}
function validateChoices(value: MigrationChoices): void {
  validateSelection({ categories: value?.categories, projectIds: [] })
  if (typeof value.allowPermissions !== 'boolean' || !Array.isArray(value.replace) || value.replace.length > 10_000 || value.replace.some((id) => typeof id !== 'string' || id.length > 2048)) throw new Error('Invalid import choices')
}
