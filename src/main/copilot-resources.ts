import { parseSafeHttpUrl } from './external-targets.js'

export type CopilotResourceKind = 'plugin' | 'mcp' | 'skill'
export type CopilotResourceAction = 'enable' | 'disable' | 'remove'

export interface CopilotResourcesState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  output: string
  message: string
}

export const DEFAULT_COPILOT_RESOURCES_STATE: CopilotResourcesState = {
  status: 'idle',
  output: '',
  message: 'Refresh to inspect plugins, MCP servers, skills, instructions, and language servers.',
}

export function isCopilotResourceKind(value: unknown): value is CopilotResourceKind {
  return value === 'plugin' || value === 'mcp' || value === 'skill'
}

export function isCopilotResourceAction(value: unknown): value is CopilotResourceAction {
  return value === 'enable' || value === 'disable' || value === 'remove'
}

function normalizedValue(value: string, label: string, maxLength = 2_048): string {
  const normalized = value.trim().replaceAll('\0', '').slice(0, maxLength)
  if (!normalized) throw new Error(`${label} is required`)
  if (normalized.startsWith('-')) throw new Error(`${label} cannot start with a dash`)
  return normalized
}

export function buildResourceMutationArgs(
  action: CopilotResourceAction,
  kind: CopilotResourceKind,
  name: string,
): string[] {
  const normalizedName = normalizedValue(name, 'Resource name', 300)
  const kindFlag = kind === 'plugin' ? [] : [`--${kind}`]
  return ['plugins', action, normalizedName, ...kindFlag]
}

export function buildPluginInstallArgs(source: string): string[] {
  return ['plugins', 'install', normalizedValue(source, 'Plugin source')]
}

export function buildSkillInstallArgs(source: string, project: boolean): string[] {
  return ['plugins', 'install', '--skill', ...(project ? ['--project'] : []), normalizedValue(source, 'Skill source')]
}

export function buildRemoteMcpAddArgs(name: string, url: string, transport: 'http' | 'sse'): string[] {
  const parsed = parseSafeHttpUrl(normalizedValue(url, 'MCP server URL'), 'MCP server URL')
  return ['mcp', 'add', '--transport', transport, normalizedValue(name, 'MCP server name', 100), parsed.href]
}
