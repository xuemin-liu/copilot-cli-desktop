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
  /** Shown instead of permission controls when a CLI exposes none (Antigravity in v1). */
  permissionNote?: string
}

const MODEL_FIELD = 'model'
const MAX_MODEL_LENGTH = 200
const EFFORT_FIELD = 'reasoningEffort'

const effortLevels: Readonly<Record<OtherCli, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  // Antigravity's model catalog already encodes the effort in each model ID.
  antigravity: [],
}

export function otherCliReasoningEfforts(cli: OtherCli): readonly string[] {
  return effortLevels[cli]
}

export const AGENT_CLI_SETTINGS: Readonly<Record<OtherCli, AgentCliSettingsDescriptor>> = {
  claude: {
    cli: 'claude',
    selectors: [{
      key: 'approval',
      label: 'Approval mode',
      inheritLabel: 'Use CLI settings',
      levels: [
        // Plan is a startup mode the user can leave — it is not a read-only guarantee.
        { value: 'plan', label: 'Plan (start in plan mode)', args: ['--permission-mode', 'plan'] },
        { value: 'acceptEdits', label: 'Accept edits', args: ['--permission-mode', 'acceptEdits'] },
        { value: 'allow-all', label: 'Allow all (--dangerously-skip-permissions)', args: ['--dangerously-skip-permissions'] },
      ],
    }],
  },
  codex: {
    cli: 'codex',
    // Approval and sandbox are independent unless approval is "allow-all", which bypasses both approvals and sandbox.
    selectors: [
      {
        key: 'approval',
        label: 'Approval',
        inheritLabel: 'Use CLI settings',
        levels: [
          { value: 'on-request', label: 'Ask on request', args: ['--ask-for-approval', 'on-request'] },
          { value: 'never', label: 'Never prompt', args: ['--ask-for-approval', 'never'] },
          { value: 'allow-all', label: 'Allow all (--dangerously-bypass-approvals-and-sandbox)', args: ['--dangerously-bypass-approvals-and-sandbox'] },
        ],
      },
      {
        key: 'sandbox',
        label: 'Sandbox',
        inheritLabel: 'Use CLI settings',
        levels: [
          { value: 'read-only', label: 'Read only', args: ['--sandbox', 'read-only'] },
          { value: 'workspace-write', label: 'Workspace write', args: ['--sandbox', 'workspace-write'] },
          { value: 'danger-full-access', label: 'Full access (--sandbox danger-full-access)', args: ['--sandbox', 'danger-full-access'] },
        ],
      },
    ],
  },
  antigravity: {
    cli: 'antigravity',
    selectors: [{
      key: 'approval',
      label: 'Approval mode',
      inheritLabel: 'Use CLI settings',
      levels: [
        { value: 'plan', label: 'Plan (--mode plan)', args: ['--mode', 'plan'] },
        { value: 'accept-edits', label: 'Accept edits (--mode accept-edits)', args: ['--mode', 'accept-edits'] },
        { value: 'auto', label: 'Auto (--mode auto)', args: ['--mode', 'auto'] },
        { value: 'allow-all', label: 'Allow all (--dangerously-skip-permissions)', args: ['--dangerously-skip-permissions'] },
      ],
    }],
  },
}

/** A model string safe to pass as a single argv token: trimmed, no NUL, and never a flag (no leading dash). */
function boundedModel(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replaceAll('\0', '').slice(0, MAX_MODEL_LENGTH)
  return normalized.startsWith('-') ? '' : normalized
}

/**
 * What a saved selector value must look like to be kept even when this build does not know it: a plain identifier, as
 * every level id is. A value saved by a newer build, or one a CLI dropped, is kept so launch validation can name it
 * instead of the tab silently falling back to the CLI's (possibly looser) defaults.
 */
const LEVEL_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/

function knownLevel(selector: PermissionSelector, value: string): PermissionLevel | undefined {
  return selector.levels.find((level) => level.value === value)
}

/**
 * Read a saved (persisted) per-CLI config. Malformed input is dropped: a non-string, an empty value, a model that would
 * be a flag. A selector value this build does not know but that is a well-formed level id is KEPT, so it stays visible
 * and blocks launch until the user changes it — unset (inherit) and "set but unsupported" stay distinguishable.
 */
export function normalizePerCliConfig(cli: OtherCli, value: unknown): PerCliConfig {
  const descriptor = AGENT_CLI_SETTINGS[cli]
  const result: PerCliConfig = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const record = value as Record<string, unknown>
  for (const selector of descriptor.selectors) {
    const raw = record[selector.key]
    if (typeof raw === 'string' && LEVEL_ID.test(raw)) result[selector.key] = raw
  }
  const model = boundedModel(record[MODEL_FIELD])
  if (model) result[MODEL_FIELD] = model
  const effort = record[EFFORT_FIELD]
  if (effortLevels[cli].length && typeof effort === 'string' && LEVEL_ID.test(effort)) result[EFFORT_FIELD] = effort
  return result
}

/** Read a saved workspace's per-CLI map, dropping any CLI whose config ends up empty. */
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
 * Check a per-CLI map the user just submitted from Settings. Unlike reading a saved config, nothing malformed is
 * silently dropped: an unknown CLI or field, an unknown level, or a model that is not a usable argument throws, so a
 * save never reports success while losing a value. An empty string or a missing field is an intentional clear. A level
 * this build does not know is accepted only when it is the value already saved there, so an incompatible saved choice
 * can stay visible until the user changes it.
 */
export function validateOtherCliConfig(value: unknown, previous: OtherCliConfig | undefined): OtherCliConfig {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings for other CLIs')
  const result: OtherCliConfig = {}
  for (const [cliKey, perCliValue] of Object.entries(value as Record<string, unknown>)) {
    const cli = OTHER_CLIS.find((candidate) => candidate === cliKey)
    if (!cli) throw new Error(`Unknown CLI "${cliKey}"`)
    if (!perCliValue || typeof perCliValue !== 'object' || Array.isArray(perCliValue)) throw new Error(`Invalid settings for ${cli}`)
    const descriptor = AGENT_CLI_SETTINGS[cli]
    const perCli: PerCliConfig = {}
    for (const [key, raw] of Object.entries(perCliValue as Record<string, unknown>)) {
      if (raw === '' || raw === undefined || raw === null) continue
      if (typeof raw !== 'string') throw new Error(`Invalid ${cli} ${key}`)
      if (key === MODEL_FIELD) {
        const model = boundedModel(raw)
        if (!model || model !== raw.trim()) throw new Error(`The ${cli} model "${raw}" is not a usable model name`)
        perCli[MODEL_FIELD] = model
        continue
      }
      if (key === EFFORT_FIELD && effortLevels[cli].length) {
        if (!effortLevels[cli].includes(raw) && previous?.[cli]?.[key] !== raw) throw new Error(`${cli} does not support reasoning effort "${raw}"`)
        perCli[key] = raw
        continue
      }
      const selector = descriptor.selectors.find((candidate) => candidate.key === key)
      if (!selector) throw new Error(`${cli} has no setting "${key}"`)
      if (!knownLevel(selector, raw) && previous?.[cli]?.[key] !== raw) throw new Error(`${cli} does not support ${selector.label.toLowerCase()} "${raw}"`)
      perCli[key] = raw
    }
    if (Object.keys(perCli).length > 0) result[cli] = perCli
  }
  return result
}

/** One configured field of a tab's settings that cannot be applied, and why. */
export interface IncompatibleField {
  key: string
  label: string
  value: string
  reason: string
}

function fieldFlags(cli: OtherCli, key: string, value: string): { label: string; flags: string[] } | { label: string; unknown: true } {
  const descriptor = AGENT_CLI_SETTINGS[cli]
  if (key === MODEL_FIELD) return { label: 'Model', flags: ['--model'] }
  if (key === EFFORT_FIELD) {
    const label = 'Reasoning effort'
    return effortLevels[cli].includes(value) ? { label, flags: [cli === 'codex' ? '--config' : '--effort'] } : { label, unknown: true }
  }
  const selector = descriptor.selectors.find((candidate) => candidate.key === key)
  if (!selector) return { label: key, unknown: true }
  const level = knownLevel(selector, value)
  return level ? { label: selector.label, flags: level.args.filter((arg) => arg.startsWith('--')) } : { label: selector.label, unknown: true }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether the installed CLI's help text lists a flag as a whole option name, not as part of a longer one. */
export function helpListsFlag(help: string, flag: string): boolean {
  return new RegExp(`(^|[^\\w-])${escapeRegExp(flag)}(?![\\w-])`, 'm').test(help)
}

/**
 * Which configured fields a launch cannot apply: a level this build does not know, or a flag the resolved binary's
 * `--help` does not list. `help` is null when it could not be read; then every configured field is unverified and
 * blocked, so an unknown install never gets a desktop override it might reject or ignore. An empty config is always fine.
 */
export function incompatibleOtherCliFields(cli: OtherCli, config: PerCliConfig | undefined, help: string | null): IncompatibleField[] {
  const fields: IncompatibleField[] = []
  const skipCodexSandbox = cli === 'codex' && config?.approval === 'allow-all'
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!value) continue
    if (skipCodexSandbox && key === 'sandbox') continue
    const shown = fieldFlags(cli, key, value)
    if ('unknown' in shown) { fields.push({ key, label: shown.label, value, reason: 'not supported by this version of the desktop' }); continue }
    if (help === null) { fields.push({ key, label: shown.label, value, reason: `could not confirm that this ${cli} installation supports it` }); continue }
    const missing = shown.flags.filter((flag) => !helpListsFlag(help, flag))
    if (missing.length > 0) fields.push({ key, label: shown.label, value, reason: `this ${cli} installation does not list ${missing.join(', ')}` })
  }
  return fields
}

/**
 * The launch flags a CLI gets for a tab's saved config, each a separate argv token. An unset field emits nothing
 * (inherit). A saved value the descriptor no longer knows throws rather than silently launching under more permissive
 * defaults — callers check compatibility BEFORE stopping a running session so an unusable setting cannot cost a live
 * process.
 */
export function buildOtherCliLaunchArgs(cli: OtherCli, config: PerCliConfig | undefined): string[] {
  if (!config) return []
  const descriptor = AGENT_CLI_SETTINGS[cli]
  const args: string[] = []
  const skipCodexSandbox = cli === 'codex' && config.approval === 'allow-all'
  for (const selector of descriptor.selectors) {
    if (skipCodexSandbox && selector.key === 'sandbox') continue
    const value = config[selector.key]
    if (value === undefined || value === '') continue
    const level = knownLevel(selector, value)
    if (!level) throw new Error(`${cli} does not support ${selector.key} "${value}"`)
    args.push(...level.args)
  }
  const model = boundedModel(config[MODEL_FIELD])
  if (model) args.push('--model', model)
  const effort = config[EFFORT_FIELD]
  if (effort) {
    if (!effortLevels[cli].includes(effort)) throw new Error(`${cli} does not support reasoning effort "${effort}"`)
    if (cli === 'codex') args.push('--config', `model_reasoning_effort="${effort}"`)
    else args.push('--effort', effort)
  }
  return args
}

/**
 * Only each CLI's model: what an import may bring across without the user opting in to imported permission settings,
 * since an approval or sandbox choice (Codex "never", say) can loosen permissions the way a Copilot preset can.
 */
export function otherCliModelsOnly(config: OtherCliConfig): OtherCliConfig {
  const result: OtherCliConfig = {}
  for (const cli of OTHER_CLIS) {
    const selection = otherCliModelSelection(config[cli])
    if (selection) result[cli] = selection
  }
  return result
}

export function otherCliModelSelection(config: PerCliConfig | undefined): PerCliConfig | undefined {
  const model = config?.[MODEL_FIELD]
  const effort = config?.[EFFORT_FIELD]
  if (!model && !effort) return undefined
  return { ...(model ? { [MODEL_FIELD]: model } : {}), ...(effort ? { [EFFORT_FIELD]: effort } : {}) }
}
