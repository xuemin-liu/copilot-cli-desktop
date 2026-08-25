import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CopilotResolution } from './types.js'
import { withCopilotPathAdditions } from './resolve-copilot.js'

const execFileAsync = promisify(execFile)

export interface CopilotCommandResult {
  stdout: string
  stderr: string
}

export async function runCopilotCommand(
  resolution: CopilotResolution,
  args: readonly string[],
  options: { timeout?: number | undefined; cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): Promise<CopilotCommandResult> {
  if (resolution.version === null) throw new Error('Copilot CLI is not installed')
  const env = withCopilotPathAdditions(options.env ?? process.env, resolution.pathAdditions)
  const result = await execFileAsync(
    resolution.command,
    [...resolution.prefixArgs, ...args],
    {
      env,
      timeout: options.timeout ?? 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
  )
  return { stdout: result.stdout, stderr: result.stderr }
}

export interface CopilotCapabilities {
  sessionIdentity: boolean
  toolAllowlist: boolean
  launchProfiles: boolean
  remoteSessions: boolean
  plugins: boolean
  acp: boolean
  supportedOptions: string[]
}

export const EMPTY_COPILOT_CAPABILITIES: CopilotCapabilities = {
  sessionIdentity: false,
  toolAllowlist: false,
  launchProfiles: false,
  remoteSessions: false,
  plugins: false,
  acp: false,
  supportedOptions: [],
}

export function parseCopilotCapabilities(helpText: string): CopilotCapabilities {
  const supportedOptions = [...new Set([...helpText.matchAll(/--[a-z][a-z0-9-]*/g)].map((match) => match[0]!))].sort()
  return {
    sessionIdentity: helpText.includes('--session-id') && helpText.includes('--name'),
    toolAllowlist: helpText.includes('--available-tools'),
    launchProfiles: helpText.includes('--model') && helpText.includes('--mode') && helpText.includes('--effort'),
    remoteSessions: helpText.includes('--remote') && helpText.includes('--connect'),
    plugins: /\bcopilot plugins?\b|--plugin-dir|\/plugins/.test(helpText),
    acp: helpText.includes('--acp'),
    supportedOptions,
  }
}

export async function discoverCopilotCapabilities(resolution: CopilotResolution): Promise<CopilotCapabilities> {
  try {
    const result = await runCopilotCommand(resolution, ['help'])
    return parseCopilotCapabilities(`${result.stdout}\n${result.stderr}`)
  } catch {
    return { ...EMPTY_COPILOT_CAPABILITIES }
  }
}
