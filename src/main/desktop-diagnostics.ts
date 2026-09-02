import type { CopilotResolution, DesktopSessionTab } from './types.js'

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b((?:[A-Z][A-Z0-9_]*_)?(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY)\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,;&]+)/gi, '$1[REDACTED]')
    .replace(/((?:^|\s)--?(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|private[-_]?key|access[-_]?key)(?:=|\s+))("[^"]*"|'[^']*'|[^\s]+)/gim, '$1[REDACTED]')
    .replace(/("(?:apiKey|accessToken|token|secret|password|privateKey)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(authorization\s*[:=]\s*basic\s+)[A-Za-z0-9+/=]+/gi, '$1[REDACTED]')
    .replace(/\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\bgh[opsur]_[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
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
