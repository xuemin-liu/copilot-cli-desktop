import { parseSafeHttpUrl } from './external-targets.js'

export type CopilotProviderType = 'github' | 'openai' | 'azure' | 'anthropic'

export interface CopilotProviderConfig {
  type: CopilotProviderType
  baseUrl: string
  model: string
  offline: boolean
}

export const DEFAULT_PROVIDER_CONFIG: CopilotProviderConfig = {
  type: 'github',
  baseUrl: '',
  model: '',
  offline: false,
}

export function isCopilotProviderType(value: unknown): value is CopilotProviderType {
  return value === 'github' || value === 'openai' || value === 'azure' || value === 'anthropic'
}

export function normalizeProviderConfig(
  value: unknown,
  reportMigration?: (message: string) => void,
): CopilotProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PROVIDER_CONFIG }
  const record = value as Record<string, unknown>
  const type = isCopilotProviderType(record.type) ? record.type : 'github'
  let baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim().slice(0, 2_048) : ''
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.username || parsed.password)) {
        parsed.username = ''
        parsed.password = ''
        baseUrl = parsed.href
        reportMigration?.('Removed embedded credentials from the saved provider base URL; use the protected credential fields instead.')
      }
    } catch {
      // Leave other invalid values intact so Settings can show its usual validation error.
    }
  }
  const model = typeof record.model === 'string' ? record.model.trim().slice(0, 200) : ''
  return {
    type,
    baseUrl,
    model,
    offline: typeof record.offline === 'boolean' ? record.offline : false,
  }
}

export function validateProviderConfig(config: CopilotProviderConfig): void {
  if (config.type === 'github') return
  if (!config.baseUrl) throw new Error('A provider base URL is required for a custom model provider')
  if (!config.model) throw new Error('A model identifier is required for a custom model provider')
  parseSafeHttpUrl(config.baseUrl, 'Provider base URL')
}

export function providerEnvironment(
  config: CopilotProviderConfig,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (config.type === 'github') return {}
  validateProviderConfig(config)
  const desired: Record<string, string> = {
    COPILOT_PROVIDER_TYPE: config.type,
    COPILOT_PROVIDER_BASE_URL: config.baseUrl,
    COPILOT_MODEL: config.model,
  }
  if (config.offline) desired.COPILOT_OFFLINE = 'true'
  return Object.fromEntries(
    Object.entries(desired).filter(([name]) => !inherited[name]),
  )
}
