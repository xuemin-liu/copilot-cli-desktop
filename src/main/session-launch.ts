export type SessionMode = 'interactive' | 'plan' | 'autopilot' | 'plan-autopilot'
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ContextTier = 'default' | 'long_context'
export type RemotePreference = 'inherit' | 'enable' | 'disable'

export interface SessionLaunchConfig {
  model: string
  reasoningEffort: ReasoningEffort
  contextTier: ContextTier
  mode: SessionMode
  maxAutopilotContinues: number | null
  maxAiCredits: number | null
  agent: string
  worktree: boolean
  screenReader: boolean
  remoteControl: RemotePreference
  remoteExport: RemotePreference
}

export const DEFAULT_SESSION_LAUNCH_CONFIG: SessionLaunchConfig = {
  model: '',
  reasoningEffort: 'default',
  contextTier: 'default',
  mode: 'interactive',
  maxAutopilotContinues: null,
  maxAiCredits: null,
  agent: '',
  worktree: false,
  screenReader: false,
  remoteControl: 'inherit',
  remoteExport: 'inherit',
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max']
const CONTEXT_TIERS: readonly ContextTier[] = ['default', 'long_context']
const SESSION_MODES: readonly SessionMode[] = ['interactive', 'plan', 'autopilot', 'plan-autopilot']
const REMOTE_PREFERENCES: readonly RemotePreference[] = ['inherit', 'enable', 'disable']

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().replaceAll('\0', '').slice(0, maxLength) : ''
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null
}

export function normalizeSessionLaunchConfig(value: unknown): SessionLaunchConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SESSION_LAUNCH_CONFIG }
  const record = value as Record<string, unknown>
  const reasoningEffort = REASONING_EFFORTS.includes(record.reasoningEffort as ReasoningEffort)
    ? record.reasoningEffort as ReasoningEffort
    : 'default'
  const contextTier = CONTEXT_TIERS.includes(record.contextTier as ContextTier)
    ? record.contextTier as ContextTier
    : 'default'
  const mode = SESSION_MODES.includes(record.mode as SessionMode)
    ? record.mode as SessionMode
    : 'interactive'
  const remoteControl = REMOTE_PREFERENCES.includes(record.remoteControl as RemotePreference)
    ? record.remoteControl as RemotePreference
    : 'inherit'
  const remoteExport = REMOTE_PREFERENCES.includes(record.remoteExport as RemotePreference)
    ? record.remoteExport as RemotePreference
    : 'inherit'
  return {
    model: boundedText(record.model, 200),
    reasoningEffort,
    contextTier,
    mode,
    maxAutopilotContinues: optionalInteger(record.maxAutopilotContinues, 0, 10_000),
    maxAiCredits: optionalInteger(record.maxAiCredits, 1, 100_000),
    agent: boundedText(record.agent, 200),
    worktree: record.worktree === true,
    screenReader: record.screenReader === true,
    remoteControl,
    remoteExport,
  }
}

export function buildSessionLaunchArgs(config: SessionLaunchConfig, freshSession: boolean): string[] {
  const normalized = normalizeSessionLaunchConfig(config)
  const args: string[] = []
  if (normalized.model) args.push('--model', normalized.model)
  if (normalized.reasoningEffort !== 'default') args.push('--effort', normalized.reasoningEffort)
  if (normalized.contextTier !== 'default') args.push('--context', normalized.contextTier)
  if (normalized.agent) args.push('--agent', normalized.agent)
  if (normalized.mode === 'plan-autopilot') args.push('--plan', '--mode', 'autopilot')
  else if (normalized.mode !== 'interactive') args.push('--mode', normalized.mode)
  if (normalized.maxAutopilotContinues !== null) {
    args.push('--max-autopilot-continues', String(normalized.maxAutopilotContinues))
  }
  if (normalized.maxAiCredits !== null) args.push('--max-ai-credits', String(normalized.maxAiCredits))
  if (normalized.worktree && freshSession) args.push('--worktree')
  if (normalized.screenReader) args.push('--screen-reader')
  if (normalized.remoteControl === 'enable') args.push('--remote')
  else if (normalized.remoteControl === 'disable') args.push('--no-remote')
  if (normalized.remoteExport === 'enable') args.push('--remote-export')
  else if (normalized.remoteExport === 'disable') args.push('--no-remote-export')
  return args
}
