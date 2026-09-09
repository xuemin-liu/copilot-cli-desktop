export interface UsageCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export interface UsageGroup extends UsageCounts {
  name: string
  requests: number
  source: 'requests' | 'reconciled'
}

export interface UsageReport {
  month: string
  timezone: string
  totals: UsageCounts
  models: UsageGroup[]
  sessions: UsageGroup[]
  unallocated: UsageCounts
  lastCollected: string | null
  lastBackup: string | null
  warnings: string[]
  databasePath: string
}

export type UsageScope = 'all' | 'app'
export interface UsageFlushResult { backupWarning: string | null }
export const emptyUsage = (): UsageCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
