import type { CopilotResolution, DesktopSessionTab } from './types.js'

export function redactDiagnosticText(value: string): string {
  return value
    // Case-sensitive on purpose: only matches genuine SCREAMING_SNAKE_CASE
    // environment-variable-style names (e.g. GH_TOKEN=..., not a lowercase
    // "access_token=" query parameter, which the dedicated rule below handles
    // without swallowing an adjacent "&other=..." parameter).
    .replace(/\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,;&]+)/g, '$1[REDACTED]')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\bgho_[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
    .replace(/\bghp_[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
}

export interface DiagnosticsInput {
  desktopVersion: string
  resolution: CopilotResolution | null
  activeWorkspace: string | null
  tabs: readonly Pick<DesktopSessionTab, 'title' | 'status' | 'processId'>[]
  recentLogs: readonly string[]
  error: string | null
}

export function formatDesktopDiagnostics(input: DiagnosticsInput, generatedAt = new Date()): string {
  const lines = [
    'Copilot CLI Desktop diagnostics',
    `Generated: ${generatedAt.toISOString()}`,
    `Desktop version: ${input.desktopVersion}`,
    `Copilot CLI resolution: ${input.resolution
      ? `${input.resolution.kind} (${input.resolution.command}) version ${input.resolution.version ?? 'unknown'}`
      : 'not attempted yet'}`,
    ...(input.resolution?.error ? [`Resolution error: ${input.resolution.error}`] : []),
    `Active workspace: ${input.activeWorkspace ?? 'not selected'}`,
    `Error: ${input.error ?? 'none'}`,
    '',
    'Session tabs:',
    ...(input.tabs.length > 0
      ? input.tabs.map((tab) => `  - ${tab.title}: ${tab.status} (pid ${tab.processId ?? 'n/a'})`)
      : ['  (none)']),
    '',
    'Recent output:',
    ...(input.recentLogs.length > 0 ? input.recentLogs : ['(none)']),
  ]
  return `${redactDiagnosticText(lines.join('\n'))}\n`
}
