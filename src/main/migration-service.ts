import { randomUUID } from 'node:crypto'
import { mkdir, rm, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readDesktopConfig } from './desktop-config.js'
import { collectMigration, fileEntry, jsonBytes, jsonObject, optionalRead, sanitize, type MigrationFile } from './migration-inventory.js'
import { readMigrationArchive, writeMigrationArchive, type MigrationArchive } from './migration-archive.js'
import { applyMigrationImport, dismissMigrationJournal, MigrationImportFailure, planMigrationImport, recoverMigrationReport, type ImportPlan } from './migration-import.js'
import { deleteMigrationBackup, listMigrationBackups } from './migration-backups.js'
import { MIGRATION_CATEGORIES, type MigrationChoices, type MigrationInventory, type MigrationManifest, type MigrationOutcome, type MigrationProgress, type MigrationRecoveryJournal, type MigrationResult, type MigrationRoots, type MigrationSelection, type MigrationStatus } from './migration-types.js'
import { writeFileAtomic } from './atomic-file.js'

interface MigrationDependencies {
  roots: MigrationRoots
  appVersion: string
  cliVersion: () => string | null
  assertIdle: () => Promise<void>
  checkIdle?: () => void
  plugins: (signal: AbortSignal) => Promise<unknown>
  exportUsage: (path: string) => Promise<void>
  restoreUsage: (path: string) => Promise<void>
  progress: (value: MigrationProgress) => void
  reloaded: () => Promise<void>
  listBackups?: typeof listMigrationBackups
}
export class MigrationService {
  busy = false
  exclusive = false
  recoveryIssues: string[] = []
  recoveryJournals: MigrationRecoveryJournal[] = []
  private lastImport: MigrationOutcome | null = null
  private backups: MigrationStatus['backups'] = []
  private backupsLoaded = false
  private backupListFailed = false
  private backupListSequence = 0
  private publishedBackupSequence = 0
  private latestBackupList: Promise<void> | null = null
  private warnings: string[] = []
  private backupWarnings: string[] = []
  private pendingSnapshots = new Set<string>()
  private currentProgress: MigrationProgress = { phase: 'Idle', completed: 0, total: 0 }
  private abort: AbortController | null = null
  private archive: MigrationArchive | null = null
  private plan: ImportPlan | null = null
  private mappings: Record<string, string> = Object.create(null) as Record<string, string>
  constructor(private readonly deps: MigrationDependencies) {
    deps.roots = { copilot: resolve(deps.roots.copilot), agentSkills: resolve(deps.roots.agentSkills), desktop: resolve(deps.roots.desktop) }
  }
  cancel(): void { this.abort?.abort() }
  status(): MigrationStatus { return { busy: this.busy, exclusive: this.exclusive, progress: this.currentProgress, recoveryIssues: [...this.recoveryIssues], recoveryJournals: [...this.recoveryJournals], lastImport: this.lastImport, backups: this.backups, warnings: [...this.warnings, ...this.backupWarnings] } }
  loadBackups(): Promise<void> {
    const sequence = ++this.backupListSequence
    this.backupListFailed = false
    this.latestBackupList = Promise.resolve().then(() => (this.deps.listBackups ?? listMigrationBackups)(this.deps.roots.desktop)).then((listed) => {
      if (sequence > this.publishedBackupSequence) {
        this.publishedBackupSequence = sequence
        this.backups = listed.backups; this.backupWarnings = listed.warnings; this.backupsLoaded = true
      }
    }).catch((error) => {
      if (sequence === this.backupListSequence) this.backupListFailed = true
      throw error
    })
    // Each explicit scan reports its own outcome, including a superseded failure.
    return this.latestBackupList
  }
  async ensureBackups(): Promise<void> {
    if (this.backupsLoaded) return
    const pending = !this.latestBackupList || this.backupListFailed ? this.loadBackups() : this.latestBackupList
    await this.waitForBackups(pending)
  }
  private async waitForBackups(pending: Promise<void>): Promise<void> {
    // Initial status waits for the latest requested scan. Explicit refreshes
    // await only their own scan, and subsequent status reads use the cache.
    for (;;) {
      try { await pending }
      catch (error) { if (pending === this.latestBackupList) throw error }
      if (pending === this.latestBackupList) return
      if (!this.latestBackupList) throw new Error('Backup scan was not initialized')
      pending = this.latestBackupList
    }
  }
  async refreshBackups(): Promise<MigrationStatus> { await this.loadBackups(); return this.status() }
  async deleteBackup(id: string, token: string): Promise<MigrationStatus> {
    await this.run('Deleting selected backup', async () => {
      if (!this.backups.some((backup) => backup.id === id && backup.token === token)) throw new Error('Refresh and review the backup list first')
      if ([...this.pendingSnapshots].some((path) => path.startsWith(join(this.deps.roots.desktop, 'migration-backups', id).replaceAll('\\', '/') + '/'))) throw new Error('Wait for the usage snapshot to finish before deleting its backup')
      try { await deleteMigrationBackup(this.deps.roots.desktop, id, token) } finally { await this.loadBackups() }
    })
    return this.status()
  }
  private async exportUsage(path: string): Promise<void> {
    const key = path.replaceAll('\\', '/')
    this.pendingSnapshots.add(key)
    try { await this.deps.exportUsage(path) }
    finally {
      this.pendingSnapshots.delete(key)
      if (key.startsWith(join(this.deps.roots.desktop, 'migration-backups').replaceAll('\\', '/') + '/')) {
        // Bookkeeping must not extend the cancellable snapshot or replace its error.
        // A late snapshot still updates the list after cancellation.
        void Promise.resolve().then(() => this.loadBackups()).then(() => this.deps.progress(this.currentProgress)).catch(() => {})
      }
    }
  }
  private progress(value: MigrationProgress): void { this.currentProgress = value; this.deps.progress(value) }
  private async acquire(signal: AbortSignal): Promise<void> {
    await this.deps.assertIdle()
    signal.throwIfAborted()
    this.deps.checkIdle?.()
    this.exclusive = true
  }
  async recover(): Promise<MigrationStatus> {
    await this.run('Recovering interrupted imports', async (signal) => {
      await this.acquire(signal)
      await this.refreshRecovery(true)
    })
    return this.status()
  }
  private async refreshRecovery(retry = false, recoverPending = true): Promise<string[]> {
    const report = await recoverMigrationReport(this.deps.roots.desktop, retry, recoverPending)
    this.recoveryIssues = report.issues; this.recoveryJournals = report.journals
    const warnings: string[] = []
    if (recoverPending) {
      try { await this.deps.reloaded() }
      catch (error) { warnings.push(`Files on disk retain their transaction outcome, but Desktop could not refresh its state. Restart before changing settings: ${String(error)}`) }
    }
    if (recoverPending) this.warnings = warnings
    await this.loadBackups()
    return warnings
  }
  async dismissRecovery(id: string, sha256: string): Promise<MigrationStatus> {
    await this.run('Dismissing inspected recovery journal', async (signal) => {
      signal.throwIfAborted()
      if (!this.recoveryJournals.some((journal) => journal.id === id && journal.sha256 === sha256)) throw new Error('Review the recovery journal in Settings first')
      await dismissMigrationJournal(this.deps.roots.desktop, id, sha256)
      this.plan = null
      await this.refreshRecovery(false, false)
    })
    return this.status()
  }
  private async run<T>(phase: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Another migration operation is running')
    this.busy = true
    this.abort = new AbortController()
    this.progress({ phase, completed: 0, total: 0 })
    try { return await operation(this.abort.signal) }
    finally { this.abort = null; this.busy = false; this.exclusive = false; this.progress({ phase: 'Idle', completed: 0, total: 0 }) }
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
      if (selection.categories.includes('plugins')) files.push(await this.pluginInventory(manifest, signal))
      if (selection.categories.includes('usage')) manifest.warnings.push('Usage snapshot size is determined during export.')
      return { roots: this.deps.roots, entries: files.map(({ data: _data, ...entry }) => entry), projects: allProjects, warnings: manifest.warnings }
    })
  }
  private async pluginInventory(manifest: MigrationManifest, signal: AbortSignal): Promise<MigrationFile> {
    // Project known identifier/source fields only; never copy opaque resource output.
    const records: { name: string; source: string; version: string }[] = []
    try {
      const raw = await cancellable(this.deps.plugins(signal), signal)
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
    } catch { signal.throwIfAborted(); manifest.warnings.push('Plugin inventory unavailable; reconnect or install Copilot CLI, then refresh.') }
    return fileEntry('plugins/inventory.json', 'plugins', jsonBytes({ plugins: records }))
  }
  async export(path: string, selection: MigrationSelection): Promise<void> {
    validateSelection(selection)
    await this.run('Exporting archive', async (signal) => {
      await this.acquire(signal)
      const manifest = await this.manifest(), projects = manifest.projects
      manifest.projects = projects.filter((p) => selection.projectIds.includes(p.id))
      const files = await collectMigration(this.deps.roots, manifest, new Set(selection.categories), signal)
      // A second inventory catches writes and added/removed assets during the snapshot.
      const check = await collectMigration(this.deps.roots, manifest, new Set(selection.categories), signal)
      if (JSON.stringify(files.map(({ path: name, sha256 }) => [name, sha256])) !== JSON.stringify(check.map(({ path: name, sha256 }) => [name, sha256]))) throw new Error('Source files changed during export. Review files and retry.')
      manifest.projects = projects
      if (selection.categories.includes('plugins')) files.push(await this.pluginInventory(manifest, signal))
      if (selection.categories.includes('usage')) await cancellable(this.withScratch(async (directory) => {
        const usage = join(directory, 'usage.sqlite')
        await this.exportUsage(usage)
        signal.throwIfAborted()
        files.push(fileEntry('usage/usage.sqlite', 'usage', (await optionalRead(usage))!))
      }), signal)
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
      await this.acquire(signal)
      const recoveryWarnings = await this.refreshRecovery()
      if (this.recoveryIssues.length) throw new Error('Resolve migration recovery issues in Settings before importing again.')
      if (recoveryWarnings.length) throw new Error(recoveryWarnings.join('\n'))
      const plan = this.plan
      this.plan = null
      try {
        let result: MigrationResult
        try { result = await applyMigrationImport(plan, this.deps.roots, signal, (completed, total) => this.progress({ phase: 'Importing files', completed, total })) }
        catch (error) {
          await this.refreshRecovery().catch((reloadError) => { this.warnings.push(`Could not inspect recovery: ${String(reloadError)}`) })
          throw error
        }
        result.warnings.push(...await this.refreshRecovery().catch((error) => [`Could not inspect recovery after the committed import: ${String(error)}`]))
        if (plan.usage) {
          // Usage merge is deliberately separate from the file transaction.
          try {
            signal.throwIfAborted()
            const backupRoot = result.backup ?? join(this.deps.roots.desktop, 'migration-backups', randomUUID())
            await mkdir(backupRoot, { recursive: true, mode: 0o700 })
            try {
              await cancellable(this.exportUsage(join(backupRoot, 'usage-before.sqlite')), signal)
              result.backup = backupRoot
            } catch (error) {
              if (signal.aborted && error === signal.reason) result.warnings.push(`Usage snapshot may still finish in ${backupRoot}. Check retained backups before relying on this copy.`)
              else if (!result.backup) await rmdir(backupRoot).catch(() => {}) // Empty new folders only; preserve partial files and existing backups.
              throw error
            }
            signal.throwIfAborted()
            await this.withScratch(async (directory) => {
              const path = join(directory, 'usage.sqlite')
              await writeFileAtomic(path, plan.usage!)
              signal.throwIfAborted()
              this.progress({ phase: 'Committing usage merge (finishes before cancellation)', completed: 0, total: 0 })
              await this.deps.restoreUsage(path)
            })
            result.warnings.push('Usage records merged successfully.')
          } catch { result.warnings.push('Files imported, but usage merge did not complete. Retry via Monthly token usage → Restore backup using usage/usage.sqlite from the archive.') }
        }
        await this.loadBackups()
        this.lastImport = { status: 'completed', message: 'Import completed. Review the result and any warnings below.', result }
        return result
      } catch (error) {
        const cancelled = signal.aborted && (!(error instanceof MigrationImportFailure) || error.rollbackComplete)
        const detail = error instanceof MigrationImportFailure && error.rollbackComplete ? 'Uncommitted file changes were rolled back.' : 'Review the current files and recovery details.'
        this.lastImport = { status: cancelled ? 'cancelled' : 'failed', message: `${cancelled ? 'Import cancelled' : 'Import failed'}. ${detail} ${String(error)}`, result: null }
        throw error
      }
    })
  }
  private async withScratch<T>(fn: (path: string) => Promise<T>): Promise<T> {
    const path = join(this.deps.roots.desktop, `migration-staging-${randomUUID()}`)
    await mkdir(path, { recursive: true, mode: 0o700 })
    try { return await fn(path) } finally { await rm(path, { recursive: true, force: true }) }
  }
}
/** A cancelled snapshot may finish writing only its private scratch directory.
 * Its owner retains cleanup until completion; never remove a live worker's files. */
function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
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
