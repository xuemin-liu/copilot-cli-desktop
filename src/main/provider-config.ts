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

export function normalizeProviderConfig(value: unknown): CopilotProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PROVIDER_CONFIG }
  const record = value as Record<string, unknown>
  const type = isCopilotProviderType(record.type) ? record.type : 'github'
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim().slice(0, 2_048) : ''
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
  let url: URL
  try {
    url = new URL(config.baseUrl)
  } catch {
    throw new Error('Provider base URL must be a valid HTTP or HTTPS URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Provider base URL must use HTTP or HTTPS')
  }
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
