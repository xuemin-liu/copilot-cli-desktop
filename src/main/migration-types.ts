export const MIGRATION_CATEGORIES = ['settings', 'knowledge', 'skills', 'tools', 'desktop', 'projects', 'plugins', 'usage'] as const
export type MigrationCategory = typeof MIGRATION_CATEGORIES[number]
export const DEFAULT_MIGRATION_CATEGORIES: MigrationCategory[] = ['settings', 'knowledge', 'skills', 'desktop', 'plugins']
export interface MigrationEntry {
  path: string
  category: MigrationCategory
  size: number
  sha256: string
}
export interface MigrationProject { id: string; name: string; sourcePath: string }
export interface MigrationManifest {
  version: 1
  createdAt: string
  platform: string
  appVersion: string
  cliVersion: string | null
  projects: MigrationProject[]
  entries: MigrationEntry[]
  warnings: string[]
}
export interface MigrationRoots { copilot: string; agentSkills: string; desktop: string }
export interface MigrationInventory {
  entries: MigrationEntry[]
  projects: MigrationProject[]
  warnings: string[]
  roots: MigrationRoots
}
export interface MigrationSelection { categories: MigrationCategory[]; projectIds: string[] }
export interface MigrationChoices {
  categories: MigrationCategory[]
  replace: string[]
  allowPermissions: boolean
}
export interface MigrationChange {
  id: string
  path: string
  category: MigrationCategory
  status: 'Add' | 'Conflict' | 'Identical' | 'Skipped'
  action: 'import' | 'keep'
  detail: string
}
export interface MigrationPreview {
  id: string
  changes: MigrationChange[]
  projects: MigrationProject[]
  mappings: Record<string, string>
  warnings: string[]
}
export interface MigrationResult { imported: number; skipped: number; backup: string | null; warnings: string[] }
export interface MigrationProgress { phase: string; completed: number; total: number }
export interface MigrationRecoveryJournal { id: string; path: string; sha256: string }
export interface MigrationOutcome { status: 'completed' | 'failed' | 'cancelled'; message: string; result: MigrationResult | null }
export interface MigrationBackup { id: string; path: string; status: 'complete' | 'rolled-back' | 'dismissed' | 'prepared'; bytes: number; token: string }
export interface MigrationStatus {
  busy: boolean; exclusive: boolean; progress: MigrationProgress; recoveryIssues: string[]
  recoveryJournals: MigrationRecoveryJournal[]; lastImport: MigrationOutcome | null
  backups: MigrationBackup[]; warnings: string[]
}
