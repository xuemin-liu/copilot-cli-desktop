import { otherCliReasoningEfforts, type OtherCliConfig, type PerCliConfig } from './agent-cli-settings.js'
import type { CliModelOption } from './cli-model-catalog.js'
import type { PermissionPreset } from './permission-presets.js'
import { MAX_TEMP_REVIEWER_TABS } from './session-tab-limit.js'
import { REASONING_EFFORTS, type ReasoningEffort, type SessionLaunchConfig } from './session-launch.js'
import { isReviewerCli, normalizeReviewerClis, sessionCliLabel, type OtherCli, type ReviewerCli } from './session-cli.js'
import type { WorkspaceProfile } from './types.js'

export const MAX_REVIEWER_ENTRIES = MAX_TEMP_REVIEWER_TABS

export interface ReviewerEntry {
  id: string
  cli: ReviewerCli
  model?: string
  /** Absent follows the workspace. 'default' lets the selected model choose its effort. */
  reasoningEffort?: string
}

export function reviewerEfforts(cli: ReviewerCli): readonly string[] {
  return cli === 'copilot' ? REASONING_EFFORTS.filter((effort) => effort !== 'default') : otherCliReasoningEfforts(cli)
}

function validReviewerEntry(value: unknown): ReviewerEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { id, cli, model: rawModel, reasoningEffort } = value as Partial<ReviewerEntry>
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !isReviewerCli(cli)) return null
  if (rawModel !== undefined && (typeof rawModel !== 'string' || /[\x00-\x1f\x7f]/.test(rawModel))) return null
  const model = rawModel?.trim() || undefined
  if (model && (model.length > 200 || model.startsWith('-'))) return null
  const efforts = reviewerEfforts(cli)
  if (reasoningEffort !== undefined && (!efforts.length || (reasoningEffort !== 'default' && !efforts.includes(reasoningEffort)))) return null
  return { id, cli, ...(model === undefined ? {} : { model }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

export function normalizeReviewerEntries(value: unknown, legacy: unknown, fallback: readonly ReviewerCli[]): ReviewerEntry[] {
  if (Array.isArray(value)) {
    const rows = new Map<string, ReviewerEntry>()
    for (const item of value) {
      const row = validReviewerEntry(item)
      if (row && !rows.has(row.id)) rows.set(row.id, row)
      if (rows.size >= MAX_REVIEWER_ENTRIES) break
    }
    if (rows.size) return [...rows.values()]
  }
  return normalizeReviewerClis(legacy, fallback).map((cli) => ({ id: `legacy-${cli}`, cli }))
}

export function validateReviewerEntries(value: unknown): ReviewerEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REVIEWER_ENTRIES) {
    throw new Error(`Choose between 1 and ${MAX_REVIEWER_ENTRIES} reviewers.`)
  }
  const ids = new Set<string>()
  return value.map((item, index) => {
    const row = validReviewerEntry(item)
    if (!row || ids.has(row.id)) throw new Error(`Invalid settings for reviewer ${index + 1}.`)
    ids.add(row.id)
    return row
  })
}

export function reviewerModelEffortError(
  model: string | undefined,
  effort: string | undefined,
  catalog: readonly CliModelOption[] | undefined,
): string | null {
  if (!model || !effort || effort === 'default') return null
  const supported = catalog?.find((option) => option.id === model.trim())?.efforts
  return supported && !supported.includes(effort) ? `${model} does not support ${effort} reasoning effort.` : null
}

export function reviewerWorkspaceModels(
  launch: Pick<SessionLaunchConfig, 'model'>,
  otherCli: OtherCliConfig | undefined,
): Record<ReviewerCli, string> {
  return {
    copilot: launch.model,
    claude: otherCli?.claude?.model ?? '',
    codex: otherCli?.codex?.model ?? '',
    antigravity: otherCli?.antigravity?.model ?? '',
  }
}

export type ReviewerModelCatalogs = Partial<Record<ReviewerCli, readonly CliModelOption[]>>

export async function prefetchReviewerCatalogs(
  entries: readonly ReviewerEntry[],
  getCatalog: (cli: ReviewerCli) => Promise<readonly CliModelOption[]>,
): Promise<void> {
  const clis = new Set(entries.filter(({ reasoningEffort }) => reasoningEffort && reasoningEffort !== 'default').map(({ cli }) => cli))
  await Promise.all([...clis].map((cli) => getCatalog(cli)))
}

export function validateReviewerModelOverrides(
  entries: readonly ReviewerEntry[],
  catalogs: ReviewerModelCatalogs,
  workspaceModels?: Readonly<Record<ReviewerCli, string>>,
  listLabel?: string,
): void {
  for (const [index, { cli, model, reasoningEffort }] of entries.entries()) {
    const error = reviewerModelEffortError(model ?? workspaceModels?.[cli], reasoningEffort, catalogs[cli])
    if (error) throw new Error(`Reviewer ${index + 1}${listLabel ? ` in ${listLabel}` : ''}: ${error}`)
  }
}

export function validateDesktopReviewerModels(
  entries: readonly ReviewerEntry[],
  profiles: readonly Pick<WorkspaceProfile, 'name' | 'launch' | 'otherCli' | 'reviewerEntries' | 'general'>[],
  catalogs: ReviewerModelCatalogs,
): void {
  validateReviewerModelOverrides(entries, catalogs)
  if (!entries.some(({ model, reasoningEffort }) => !model && reasoningEffort && reasoningEffort !== 'default')) return
  for (const profile of profiles) {
    if (profile.general || profile.reviewerEntries) continue
    const models = reviewerWorkspaceModels(profile.launch, profile.otherCli)
    validateReviewerModelOverrides(entries, catalogs, models, `the Desktop list for workspace "${profile.name}"`)
  }
}

export type ResolvedReviewer = { id: string; name: string; label: string } & (
  | { cli: 'copilot'; launch: SessionLaunchConfig; permissionPreset: PermissionPreset }
  | { cli: OtherCli; config: PerCliConfig }
)

export async function resolveReviewerEntries(
  entries: readonly ReviewerEntry[],
  profile: Pick<WorkspaceProfile, 'launch' | 'otherCli' | 'permissionPreset'>,
  getCatalog: (cli: ReviewerCli) => Promise<readonly CliModelOption[]>,
): Promise<ResolvedReviewer[]> {
  const { permissionPreset, otherCli } = profile
  const launch = { ...profile.launch }
  const counts = new Map<ReviewerCli, number>()
  for (const entry of entries) counts.set(entry.cli, (counts.get(entry.cli) ?? 0) + 1)
  const ordinals = new Map<ReviewerCli, number>()
  return Promise.all(entries.map(async (entry): Promise<ResolvedReviewer> => {
    const { cli } = entry
    const ordinal = (ordinals.get(cli) ?? 0) + 1
    ordinals.set(cli, ordinal)
    const name = sessionCliLabel(cli) + ((counts.get(cli) ?? 0) > 1 ? ` ${ordinal}` : '')
    const otherConfig = cli === 'copilot' ? undefined : { ...otherCli?.[cli] }
    const workspace = otherConfig ?? launch
    const model = entry.model ?? workspace?.model
    let effort = entry.reasoningEffort ?? workspace?.reasoningEffort
    let inheritedEffortUnavailable = false
    if (model && effort && effort !== 'default') {
      const error = reviewerModelEffortError(model, effort, await getCatalog(cli))
      if (error) {
        if (entry.reasoningEffort) throw new Error(`${name}: ${error} Edit this reviewer in Settings.`)
        effort = 'default'
        inheritedEffortUnavailable = true
      }
    }
    const details = [
      model,
      effort && effort !== 'default' ? `${effort} effort` : undefined,
      inheritedEffortUnavailable ? 'model default effort (workspace effort unavailable)' : entry.reasoningEffort === 'default' ? 'model default effort' : undefined,
    ].filter(Boolean)
    const label = details.length ? `${name} (${details.join(', ')})` : name
    if (cli === 'copilot') {
      const config = { ...launch, model: model ?? '', reasoningEffort: (effort ?? 'default') as ReasoningEffort, worktree: false }
      return { id: entry.id, cli, name, label, launch: config, permissionPreset }
    }
    const config = otherConfig ?? {}
    if (model) config.model = model
    if (effort && effort !== 'default') config.reasoningEffort = effort
    else delete config.reasoningEffort
    return { id: entry.id, cli, name, label, config }
  }))
}
