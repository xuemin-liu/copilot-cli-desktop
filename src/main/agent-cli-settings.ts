// No Node imports: the renderer bundles this file for the workspace settings editor,
// so it must stay pure like session-cli.ts and permission-presets.ts.

import { OTHER_CLIS, type OtherCli } from './session-cli.js'

/**
 * Per-CLI launch settings a workspace can configure for a non-Copilot CLI. Unlike Copilot — whose approval mode the
 * desktop observes from an event stream — the other CLIs expose no such stream, so "permission" here is a set of
 * launch flags only. Every field is optional; an absent field means "inherit": emit no flag and let the CLI use its
 * own default. A tab snapshots the workspace's config at creation (see RestoredTab.otherCliConfig) so a later profile
 * edit never changes how an already-created tab relaunches.
 */
export type PerCliConfig = Record<string, string>
export type OtherCliConfig = Partial<Record<OtherCli, PerCliConfig>>

/** One option of a permission selector, and the launch flags it maps to. */
export interface PermissionLevel {
  value: string
  label: string
  /** The launch flags this level adds. Empty for the implicit inherit level, which is not listed here. */
  args: string[]
}

/** A single permission control a CLI exposes (Codex has two: approval and sandbox). */
export interface PermissionSelector {
  /** Field name under the CLI's PerCliConfig, e.g. 'approval' or 'sandbox'. */
  key: string
  label: string
  /** The label of the implicit, always-present inherit choice. */
  inheritLabel: string
  levels: readonly PermissionLevel[]
}

/** What one non-Copilot CLI lets a workspace configure. */
export interface AgentCliSettingsDescriptor {
  cli: OtherCli
  selectors: readonly PermissionSelector[]
  supportsModel: boolean
  modelLabel: string
  modelPlaceholder: string
  /** Shown instead of permission controls when a CLI exposes none (Antigravity in v1). */
  permissionNote?: string
}

const MODEL_FIELD = 'model'
const MAX_MODEL_LENGTH = 200

export const AGENT_CLI_SETTINGS: Readonly<Record<OtherCli, AgentCliSettingsDescriptor>> = {
  claude: {
    cli: 'claude',
    supportsModel: true,
    modelLabel: 'Model',
    modelPlaceholder: 'Claude default (e.g. claude-sonnet-5)',
    selectors: [{
      key: 'approval',
      label: 'Approval mode',
      inheritLabel: 'Use CLI settings',
      levels: [
        // Plan is a startup mode the user can leave — it is not a read-only guarantee.
        { value: 'plan', label: 'Plan (start in plan mode)', args: ['--permission-mode', 'plan'] },
        { value: 'acceptEdits', label: 'Accept edits', args: ['--permission-mode', 'acceptEdits'] },
      ],
    }],
  },
  codex: {
    cli: 'codex',
    supportsModel: true,
    modelLabel: 'Model',
    modelPlaceholder: 'Codex default (e.g. gpt-5-codex)',
    // Approval and sandbox are independent: "Never" only stops escalation prompts; only an explicit sandbox
    // narrows filesystem access, and choosing one replaces Codex's native default_permissions.
    selectors: [
      {
        key: 'approval',
        label: 'Approval',
        inheritLabel: 'Use CLI settings',
        levels: [
          { value: 'on-request', label: 'Ask on request', args: ['--ask-for-approval', 'on-request'] },
          { value: 'never', label: 'Never prompt', args: ['--ask-for-approval', 'never'] },
        ],
      },
      {
        key: 'sandbox',
        label: 'Sandbox',
        inheritLabel: 'Use CLI settings',
        levels: [
          { value: 'read-only', label: 'Read only', args: ['--sandbox', 'read-only'] },
          { value: 'workspace-write', label: 'Workspace write', args: ['--sandbox', 'workspace-write'] },
        ],
      },
    ],
  },
  antigravity: {
    cli: 'antigravity',
    supportsModel: true,
    modelLabel: 'Model',
    modelPlaceholder: 'Antigravity default',
    selectors: [],
    permissionNote: 'Approvals are managed by Antigravity.',
  },
}

/** A model string safe to pass as a single argv token: trimmed, no NUL, and never a flag (no leading dash). */
function boundedModel(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replaceAll('\0', '').slice(0, MAX_MODEL_LENGTH)
  return normalized.startsWith('-') ? '' : normalized
}

function levelValue(selector: PermissionSelector, value: unknown): string | null {
  return typeof value === 'string' && selector.levels.some((level) => level.value === value) ? value : null
}

/**
 * Keep only the fields the CLI understands, dropping malformed input. A selector value must be one of the descriptor's
 * known levels; an unknown string is malformed and dropped (so "unset = inherit" stays distinguishable from a real
 * choice). Absent fields are omitted entirely rather than stored as empty.
 */
export function normalizePerCliConfig(cli: OtherCli, value: unknown): PerCliConfig {
  const descriptor = AGENT_CLI_SETTINGS[cli]
  const result: PerCliConfig = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const record = value as Record<string, unknown>
  for (const selector of descriptor.selectors) {
    const level = levelValue(selector, record[selector.key])
    if (level) result[selector.key] = level
  }
  if (descriptor.supportsModel) {
    const model = boundedModel(record[MODEL_FIELD])
    if (model) result[MODEL_FIELD] = model
  }
  return result
}

/** Normalize a whole workspace's per-CLI map, dropping any CLI whose config ends up empty. */
export function normalizeOtherCliConfig(value: unknown): OtherCliConfig {
  const result: OtherCliConfig = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const record = value as Record<string, unknown>
  for (const cli of OTHER_CLIS) {
    const perCli = normalizePerCliConfig(cli, record[cli])
    if (Object.keys(perCli).length > 0) result[cli] = perCli
  }
  return result
}

/**
 * The launch flags a CLI gets for a tab's saved config, each a separate argv token. An unset field emits nothing
 * (inherit). A saved value the descriptor no longer knows throws rather than silently launching under more permissive
 * defaults — callers build this BEFORE stopping a running session so an unusable setting cannot cost a live process.
 */
export function buildOtherCliLaunchArgs(cli: OtherCli, config: PerCliConfig | undefined): string[] {
  if (!config) return []
  const descriptor = AGENT_CLI_SETTINGS[cli]
  const args: string[] = []
  for (const selector of descriptor.selectors) {
    const value = config[selector.key]
    if (value === undefined || value === '') continue
    const level = selector.levels.find((candidate) => candidate.value === value)
    if (!level) throw new Error(`${cli} does not support ${selector.key} "${value}"`)
    args.push(...level.args)
  }
  if (descriptor.supportsModel) {
    const model = boundedModel(config[MODEL_FIELD])
    if (model) args.push('--model', model)
  }
  return args
}
